import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Doc } from "../../_generated/dataModel";
import { stableUserId } from "../auth";
import { callOrganicModel, averageEmbeddings, cosineSimilarity, embedText, parseGeminiJson } from "./utils";
import { getModelPreset } from "./models";

const FAILED_QUERY_LIMIT = 100;
const SUCCESSFUL_QUERY_LIMIT = 50;
const RECALL_QUERY_WINDOW = 220;
const FOLLOW_UP_WINDOW_MS = 30 * 60 * 1000;
const CLUSTER_SIMILARITY_THRESHOLD = 0.75;
const CLUSTER_MIN_SIZE = 3;
const DEDUP_SIMILARITY_THRESHOLD = 0.82;

const shouldScheduleSkillEmbedding = () =>
  !(typeof process !== "undefined" && process.env.VITEST);

type RecallLogDoc = Doc<"organicRecallLog">;
type ActivityLogDoc = Doc<"organicActivityLog">;
type SkillSuggestionDoc = Doc<"organicSkillSuggestions">;
type SkillEvidence = SkillSuggestionDoc["evidence"][number];
const skillSuggestionsApi = ((internal as any).crystal.organic.skillSuggestions) as any;

export type FailedQueryEmbedding = {
  query: string;
  embedding: number[];
  createdAt?: number;
};

export type SkillGapCluster = {
  queries: string[];
  embeddings: number[][];
  centroid: number[];
  createdAts: number[];
};

type GeneratedSkillSuggestion = {
  skillName: string;
  description: string;
  content: string;
};

type SkillMemoryMetadata = {
  skillFormat: true;
  triggerConditions: string[];
  steps: Array<{ order: number; action: string; command?: string }>;
  pitfalls: string[];
  verification: string;
  patternType: "workflow";
  observationCount: number;
  lastObserved: number;
  approvedAt: number;
  skillName: string;
  suggestionId: string;
  ideaId?: string;
};

const dedupeStrings = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const titleCase = (value: string) =>
  value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const stripListMarker = (value: string) => value.replace(/^[-*+]\s+/, "").trim();

const stripOrderedMarker = (value: string) => value.replace(/^\d+\.\s+/, "").trim();

const getMarkdownSectionBody = (content: string, headings: string[]) => {
  const headingPattern = headings.map(escapeRegExp).join("|");
  const match = content.match(new RegExp(`^##\\s+(?:${headingPattern})\\s*$\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, "im"));
  return match?.[1]?.trim() ?? "";
};

const parseBulletSection = (content: string, headings: string[]) =>
  dedupeStrings(
    getMarkdownSectionBody(content, headings)
      .split("\n")
      .map((line) => stripListMarker(line.trim()))
  );

const parseStepsSection = (content: string) => {
  const sectionBody = getMarkdownSectionBody(content, ["Steps", "Procedure", "Workflow"]);
  const body = sectionBody || content;
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && (/^\d+\.\s+/.test(line) || /^[-*+]\s+/.test(line)));

  return lines
    .map((line, index) => {
      const action = stripOrderedMarker(stripListMarker(line));
      if (!action) return null;
      const commandMatch = action.match(/`([^`]+)`/);
      return {
        order: index + 1,
        action: action.replace(/`([^`]+)`/g, "$1").trim(),
        ...(commandMatch ? { command: commandMatch[1] } : {}),
      };
    })
    .filter((step): step is NonNullable<typeof step> => step !== null);
};

const parseVerification = (content: string) =>
  getMarkdownSectionBody(content, ["Verification", "Success Criteria"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => stripListMarker(stripOrderedMarker(line)))
    .find(Boolean) ?? "Confirm the expected outcome is visible before concluding the task.";

export const ensureSkillMarkdownFormat = (
  skillName: string,
  description: string,
  content: string
) => {
  const heading = `# ${titleCase(skillName)}`;
  let normalized = content.trim();

  if (!normalized) {
    normalized = description.trim();
  }

  if (/^#\s+/m.test(normalized)) {
    normalized = normalized.replace(/^#\s+.*$/m, heading);
  } else {
    normalized = `${heading}\n\n${normalized}`;
  }

  if (!/##\s+(Trigger Conditions|When to Use|Activation)/i.test(normalized)) {
    normalized += `\n\n## Trigger Conditions\n- ${description.trim() || `Use when ${titleCase(skillName).toLowerCase()} is needed.`}`;
  }

  if (!/##\s+(Steps|Procedure|Workflow)/i.test(normalized)) {
    normalized += `\n\n## Steps\n1. Review the relevant context for ${titleCase(skillName).toLowerCase()}.\n2. Execute the documented process and verify the result.`;
  }

  if (!/##\s+Pitfalls/i.test(normalized)) {
    normalized += "\n\n## Pitfalls\n- Do not apply this skill before confirming the trigger conditions match.";
  }

  if (!/##\s+(Verification|Success Criteria)/i.test(normalized)) {
    normalized += "\n\n## Verification\nConfirm the expected outcome is visible before concluding the task.";
  }

  return normalized.trim();
};

export const buildSkillMemoryMetadata = (params: {
  skillName: string;
  content: string;
  evidenceCount: number;
  approvedAt: number;
  suggestionId: string;
  ideaId?: string;
}): SkillMemoryMetadata => ({
  skillFormat: true,
  triggerConditions: parseBulletSection(params.content, ["Trigger Conditions", "When to Use", "Activation"]),
  steps: parseStepsSection(params.content),
  pitfalls: parseBulletSection(params.content, ["Pitfalls", "Warnings"]),
  verification: parseVerification(params.content),
  patternType: "workflow",
  observationCount: Math.max(1, params.evidenceCount),
  lastObserved: params.approvedAt,
  approvedAt: params.approvedAt,
  skillName: params.skillName,
  suggestionId: params.suggestionId,
  ...(params.ideaId ? { ideaId: params.ideaId } : {}),
});

const activateApprovedSkillMemory = async (
  ctx: any,
  params: {
    userId: string;
    suggestion: SkillSuggestionDoc;
    content: string;
    approvedAt: number;
  }
) => {
  const metadata = buildSkillMemoryMetadata({
    skillName: params.suggestion.skillName,
    content: params.content,
    evidenceCount: params.suggestion.evidence.length,
    approvedAt: params.approvedAt,
    suggestionId: String(params.suggestion._id),
    ideaId: params.suggestion.ideaId ? String(params.suggestion.ideaId) : undefined,
  });
  const tags = dedupeStrings([
    "organic",
    "skill",
    "approved",
    `skill-suggestion:${params.suggestion._id}`,
    ...(params.suggestion.ideaId ? [`idea:${params.suggestion.ideaId}`] : []),
  ]);

  const existingMemory = params.suggestion.activatedMemoryId
    ? await ctx.db.get(params.suggestion.activatedMemoryId)
    : null;

  if (existingMemory && existingMemory.userId === params.userId) {
    await ctx.db.patch(existingMemory._id, {
      title: titleCase(params.suggestion.skillName),
      content: params.content,
      metadata: JSON.stringify(metadata),
      confidence: Math.max(existingMemory.confidence, params.suggestion.confidence),
      strength: Math.max(existingMemory.strength, 0.95),
      lastAccessedAt: params.approvedAt,
      tags: dedupeStrings([...(existingMemory.tags ?? []), ...tags]),
      archived: false,
      archivedAt: undefined,
    });
    return existingMemory._id;
  }

  return ctx.runMutation(internal.crystal.memories.createMemoryInternal, {
    userId: params.userId,
    store: "procedural",
    category: "skill",
    title: titleCase(params.suggestion.skillName),
    content: params.content,
    metadata: JSON.stringify(metadata),
    embedding: [],
    strength: 0.95,
    confidence: Math.max(params.suggestion.confidence, 0.75),
    valence: 0,
    arousal: 0.15,
    source: "inference",
    tags,
    archived: false,
  });
};

export const getRecallInputsForSkillGaps = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const recallLogs = await ctx.db
      .query("organicRecallLog")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(RECALL_QUERY_WINDOW);

    const earliestCreatedAt = recallLogs.reduce(
      (earliest, log) => Math.min(earliest, log.createdAt),
      Number.POSITIVE_INFINITY
    );

    const activities = Number.isFinite(earliestCreatedAt)
      ? await ctx.db
          .query("organicActivityLog")
          .withIndex("by_user_time", (q) =>
            q.eq("userId", args.userId).gte("timestamp", earliestCreatedAt)
          )
          .take(2000)
      : [];

    return { recallLogs, activities };
  },
});

export const getExistingSkillSuggestions = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicSkillSuggestions")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(200)
      .then((rows) => rows.filter((row) => row.status !== "dismissed"));
  },
});

export const createSkillSuggestionRecord = internalMutation({
  args: {
    userId: v.string(),
    tickId: v.string(),
    skillName: v.string(),
    description: v.string(),
    content: v.string(),
    evidence: v.array(v.object({
      type: v.union(
        v.literal("recall_failure"),
        v.literal("pattern_cluster"),
        v.literal("procedural_gap")
      ),
      memoryId: v.optional(v.string()),
      query: v.optional(v.string()),
      detail: v.string(),
    })),
    confidence: v.float64(),
    generation: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const evidenceLine = args.evidence
      .slice(0, 3)
      .map((item) => item.query ?? item.detail)
      .join(" | ");

    const ideaId = await ctx.db.insert("organicIdeas", {
      userId: args.userId,
      title: `Skill suggestion: ${args.skillName}`,
      summary: `${args.description} Based on ${args.evidence.length} evidence point${args.evidence.length === 1 ? "" : "s"}${evidenceLine ? `: ${evidenceLine}` : ""}`,
      ideaType: "skill_suggestion",
      sourceMemoryIds: [],
      confidence: args.confidence,
      status: "pending_notification",
      pulseId: args.tickId,
      fiberId: "skill_suggestion",
      createdAt: now,
      updatedAt: now,
    });

    const suggestionId = await ctx.db.insert("organicSkillSuggestions", {
      userId: args.userId,
      skillName: args.skillName,
      description: args.description,
      content: args.content,
      evidence: args.evidence,
      confidence: args.confidence,
      status: "pending",
      generation: args.generation,
      ideaId,
      createdAt: now,
    });

    return { suggestionId, ideaId };
  },
});

export const getMySkillSuggestions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);

    return ctx.db
      .query("organicSkillSuggestions")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);
  },
});

export const updateSkillSuggestionStatus = mutation({
  args: {
    suggestionId: v.id("organicSkillSuggestions"),
    status: v.union(
      v.literal("accepted"),
      v.literal("modified"),
      v.literal("dismissed")
    ),
    modifiedContent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = stableUserId(identity.subject);

    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion || suggestion.userId !== userId) {
      throw new Error("Skill suggestion not found");
    }

    const now = Date.now();
    const patch: Partial<SkillSuggestionDoc> = {
      status: args.status,
    };
    let activeMemoryId = suggestion.activatedMemoryId;

    if (args.status === "accepted" || args.status === "modified") {
      patch.acceptedAt = now;
    }
    if (args.status === "dismissed") {
      patch.dismissedAt = now;
    }
    if (args.status === "modified") {
      if (!args.modifiedContent?.trim()) {
        throw new Error("modifiedContent is required when status is modified");
      }
      patch.content = ensureSkillMarkdownFormat(
        suggestion.skillName,
        suggestion.description,
        args.modifiedContent
      );
    }

    if (args.status === "accepted" || args.status === "modified") {
      const content = ensureSkillMarkdownFormat(
        suggestion.skillName,
        suggestion.description,
        args.status === "modified" ? args.modifiedContent ?? suggestion.content : suggestion.content
      );
      if (patch.content === undefined) {
        patch.content = content;
      }
      activeMemoryId = await activateApprovedSkillMemory(ctx, {
        userId,
        suggestion,
        content,
        approvedAt: now,
      });
      patch.activatedMemoryId = activeMemoryId;
    }

    await ctx.db.patch(args.suggestionId, patch);

    if (suggestion.ideaId) {
      const linkedIdea = await ctx.db.get(suggestion.ideaId);
      if (linkedIdea && linkedIdea.userId === userId) {
        await ctx.db.patch(suggestion.ideaId, {
          status: args.status === "dismissed" ? "dismissed" : "read",
          updatedAt: now,
          ...(args.status === "dismissed"
            ? { dismissedAt: now }
            : { readAt: linkedIdea.readAt ?? now }),
        });
      }
    }

    if ((args.status === "accepted" || args.status === "modified") && activeMemoryId && shouldScheduleSkillEmbedding()) {
      try {
        await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, {
          memoryId: activeMemoryId,
        });
      } catch {
        // scheduler is best-effort in tests
      }
    }

    return { success: true };
  },
});

export const analyzeSkillGaps = internalAction({
  args: {
    userId: v.string(),
    tickId: v.string(),
    organicModel: v.optional(v.string()),
    openrouterApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { recallLogs, activities } = await ctx.runQuery(
      skillSuggestionsApi.getRecallInputsForSkillGaps,
      { userId: args.userId }
    );

    const outcomes = classifyRecallOutcomes(recallLogs, activities);
    const failedQueries = outcomes.failed.slice(0, FAILED_QUERY_LIMIT);
    const successfulQueries = outcomes.successful
      .slice(0, SUCCESSFUL_QUERY_LIMIT)
      .map((row) => row.query);

    if (failedQueries.length < CLUSTER_MIN_SIZE) {
      return { created: 0, examined: failedQueries.length };
    }

    const embeddedFailures: ({ query: string; embedding: number[]; createdAt: number } | null)[] = [];
    for (let i = 0; i < failedQueries.length; i += 10) {
      const batch = failedQueries.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (row) => {
          const embedding = await embedText(row.query);
          if (!embedding?.length) return null;
          return {
            query: row.query,
            embedding,
            createdAt: row.createdAt,
          };
        })
      );
      embeddedFailures.push(...results);
    }

    const validFailures: FailedQueryEmbedding[] = embeddedFailures.filter(
      (row): row is NonNullable<typeof row> => row !== null
    ) as FailedQueryEmbedding[];
    const clusters = clusterFailedQueries(validFailures);

    if (clusters.length === 0) {
      return { created: 0, examined: failedQueries.length };
    }

    const existingSuggestions = await ctx.runQuery(
      skillSuggestionsApi.getExistingSkillSuggestions,
      { userId: args.userId }
    );

    const existingEmbeddings = await Promise.all(
      existingSuggestions.map(async (suggestion: { skillName: string; description: string }) => {
        const embedding = await embedText(`${suggestion.skillName}\n${suggestion.description}`);
        return embedding ?? [];
      })
    );

    let generation = existingSuggestions.reduce(
      (max: number, suggestion: { generation: number }) => Math.max(max, suggestion.generation),
      0
    );
    let created = 0;
    const preset = getModelPreset(args.organicModel);
    const apiKeyOverride = args.openrouterApiKey;

    for (const cluster of clusters) {
      if (findMatchingSuggestionByEmbedding(cluster.centroid, existingSuggestions, existingEmbeddings)) {
        continue;
      }

      const generated = await generateSkillSuggestion(cluster, successfulQueries, preset, apiKeyOverride);
      if (!generated) continue;

      generation += 1;
      const normalizedSkillName = normalizeSkillName(generated.skillName, generation);
      const normalizedContent = ensureSkillMarkdownFormat(
        normalizedSkillName,
        generated.description,
        generated.content
      );
      const result = await ctx.runMutation(
        skillSuggestionsApi.createSkillSuggestionRecord,
        {
          userId: args.userId,
          tickId: args.tickId,
          skillName: normalizedSkillName,
          description: generated.description.trim().slice(0, 280),
          content: normalizedContent,
          evidence: buildEvidence(cluster),
          confidence: estimateClusterConfidence(cluster),
          generation,
        }
      );

      existingSuggestions.unshift({
        _id: result.suggestionId,
        _creationTime: Date.now(),
        userId: args.userId,
        skillName: normalizedSkillName,
        description: generated.description,
        content: normalizedContent,
        evidence: buildEvidence(cluster),
        confidence: estimateClusterConfidence(cluster),
        status: "pending",
        generation,
        ideaId: result.ideaId,
        createdAt: Date.now(),
      });
      existingEmbeddings.unshift(cluster.centroid);
      created += 1;
    }

    return { created, examined: failedQueries.length };
  },
});

export function classifyRecallOutcomes(recallLogs: RecallLogDoc[], activities: ActivityLogDoc[]) {
  const failed: RecallLogDoc[] = [];
  const successful: RecallLogDoc[] = [];

  for (const log of recallLogs) {
    const hadFollowUp = hadFollowUpRecall(log, activities);
    if (log.resultCount === 0) {
      failed.push(log);
    } else if (hadFollowUp || log.resultCount > 0) {
      successful.push(log);
    }
  }

  return { failed, successful };
}

function hadFollowUpRecall(log: RecallLogDoc, activities: ActivityLogDoc[]) {
  if (!log.topResultIds.length) {
    return false;
  }

  return activities.some((activity) => {
    if (activity.eventType !== "memory_recalled") return false;
    if (activity.timestamp < log.createdAt) return false;
    if (activity.timestamp > log.createdAt + FOLLOW_UP_WINDOW_MS) return false;
    return log.topResultIds.some((memoryId) => String(memoryId) === String(activity.memoryId));
  });
}

export function clusterFailedQueries(items: FailedQueryEmbedding[]): SkillGapCluster[] {
  const clusters: SkillGapCluster[] = [];

  for (const item of items) {
    let bestClusterIndex = -1;
    let bestSimilarity = -1;

    for (let index = 0; index < clusters.length; index += 1) {
      const similarity = cosineSimilarity(item.embedding, clusters[index].centroid);
      if (similarity > CLUSTER_SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestClusterIndex = index;
      }
    }

    if (bestClusterIndex === -1) {
      clusters.push({
        queries: [item.query],
        embeddings: [item.embedding],
        centroid: item.embedding,
        createdAts: [item.createdAt ?? Date.now()],
      });
      continue;
    }

    const cluster = clusters[bestClusterIndex];
    cluster.queries.push(item.query);
    cluster.embeddings.push(item.embedding);
    cluster.createdAts.push(item.createdAt ?? Date.now());
    cluster.centroid = averageEmbeddings(cluster.embeddings);
  }

  return clusters.filter((cluster) => cluster.queries.length >= CLUSTER_MIN_SIZE);
}

export function findMatchingSuggestionByEmbedding(
  clusterEmbedding: number[],
  suggestions: Array<Pick<SkillSuggestionDoc, "_id" | "skillName" | "description" | "content" | "evidence" | "confidence" | "status" | "generation" | "createdAt" | "ideaId">>,
  suggestionEmbeddings: number[][]
) {
  for (let index = 0; index < suggestions.length; index += 1) {
    const suggestionEmbedding = suggestionEmbeddings[index];
    if (!suggestionEmbedding?.length) continue;
    if (cosineSimilarity(clusterEmbedding, suggestionEmbedding) >= DEDUP_SIMILARITY_THRESHOLD) {
      return suggestions[index];
    }
  }
  return null;
}

async function generateSkillSuggestion(
  cluster: SkillGapCluster,
  successfulQueries: string[],
  preset: ReturnType<typeof getModelPreset>,
  apiKeyOverride?: string,
): Promise<GeneratedSkillSuggestion | null> {
  const prompt = `You are a skill architect for an AI memory system. Based on the following cluster of failed memory recall queries, design a SKILL.md file that would help the AI handle these situations better.

Failed queries in this cluster:
${cluster.queries.join("\n")}

Successful queries for contrast (what the system handles well):
${successfulQueries.slice(0, 15).join("\n")}

Design a skill that:
1. Has a clear, specific name (kebab-case, e.g. "deployment-troubleshooting")
2. Describes when the skill should activate
3. Provides structured guidance for handling these situations
4. References the patterns that indicate this skill is needed

Output JSON:
{
  "skillName": "deployment-troubleshooting",
  "description": "Brief description of what this skill covers",
  "content": "Full SKILL.md content with markdown formatting"
}`;

  const response = await callOrganicModel(prompt, preset, apiKeyOverride);
  if (!response) return null;
  const parsed = parseGeminiJson<GeneratedSkillSuggestion>(response);
  if (!parsed) return null;
  if (!parsed.skillName || !parsed.description || !parsed.content) return null;
  return {
    skillName: parsed.skillName,
    description: parsed.description,
    content: parsed.content,
  };
}

function buildEvidence(cluster: SkillGapCluster): SkillEvidence[] {
  const failures = cluster.queries.map((query) => ({
    type: "recall_failure" as const,
    query,
    detail: `Recall query returned no durable follow-up signal: ${query}`,
  }));

  return [
    {
      type: "pattern_cluster",
      detail: `${cluster.queries.length} related recall failures clustered around the same topic.`,
    },
    ...failures,
  ];
}

function estimateClusterConfidence(cluster: SkillGapCluster) {
  const averageSimilarity = cluster.embeddings.length > 1
    ? cluster.embeddings.reduce((sum, embedding) => sum + cosineSimilarity(embedding, cluster.centroid), 0) / cluster.embeddings.length
    : 0.75;

  return Math.max(
    0.55,
    Math.min(0.95, 0.55 + (cluster.queries.length - CLUSTER_MIN_SIZE) * 0.08 + (averageSimilarity - 0.75) * 0.5)
  );
}

function normalizeSkillName(input: string, generation: number) {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `skill-gap-${generation}`;
}
