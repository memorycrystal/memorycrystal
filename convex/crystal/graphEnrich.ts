import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { type Id } from "../_generated/dataModel";
import { applyDashboardTotalsDelta } from "./dashboardTotals";
import { truncatePromptContent } from "./organic/truncatePromptContent";
import { resolveGraphModel, resolveFeatureFlag } from "./adminSettings/resolvers";
import { shouldEnrich, STRENGTH_FLOOR } from "./organic/enrichmentEligibility";
import { DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP } from "./graphSettings";
import { stableUserId } from "./auth";
import { canPerformWriteActions, normalizeRoles } from "./permissions";

const GRAPH_TEMPERATURE = 0.1;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
// Site 1 fallback: resolver uses this as the hardcoded default for the OpenRouter model.
const OPENROUTER_GRAPH_MODEL = "google/gemini-2.5-flash";

/** Circuit breaker: abort the backfill run after this many consecutive enrichment failures. */
const GRAPH_BACKFILL_CIRCUIT_BREAKER_THRESHOLD = 3;
const GRAPH_BACKFILL_GLOBAL_SUCCESS_CAP = 50;
const GRAPH_BACKFILL_BACKLOG_DRAIN_LIMIT = 5;
// Rotation: each hourly tick reads ONE page of user profiles (resuming from the
// crystalJobCursors cursor) instead of collecting the whole table. Safe because
// enrichment is convergent and permanently marked (markMemoryEnriched /
// persisted attempt counts): users not visited this tick are picked up when the
// rotation reaches them, and the global success cap already meant late-order
// users received nothing on many ticks. This also bounds the tail
// refreshStatsCache/telemetry loop, which was O(all users) per run.
const GRAPH_BACKFILL_USERS_PER_TICK = 25;
const GRAPH_BACKFILL_JOB_NAME = "graph-enrich";
const GRAPH_BACKFILL_GLOBAL_USER_ID = "__system__";
const GRAPH_BACKFILL_RUN_KIND = "graph_enrichment_backfill_run";
const DETERMINISTIC_SKIP_REASONS = new Set([
  "sensory_skip",
  "kb_chunk",
  "below_strength_floor",
  "max_attempts_exceeded",
]);
const GRAPH_SKIP_AUDIT_REASONS = [
  "sensory_skip",
  "kb_chunk",
  "below_strength_floor",
  "max_attempts_exceeded",
] as const;
const RETRYABLE_GRAPH_SKIP_REASONS = new Set<string>([
  "below_strength_floor",
  "max_attempts_exceeded",
]);
const BENIGN_BACKFILL_REASONS = new Set([
  "already_enriched",
  "archived_memory",
  "memory_not_found",
]);

// Site 2: async helper replacing the module-top TIER_ENRICHMENT_MODELS constant.
// Personal OpenRouter keys are handled separately below; without a personal key
// graph enrichment requires the user's personal OpenRouter key.
// The resolver is used for pro (operator-configurable); ultra/unlimited stay pinned.
async function getEnrichmentModel(ctx: any, tier: string): Promise<string> {
  if (tier === "pro") {
    // pro: resolver-controlled (env MC_GEMINI_GRAPH_MODEL / Convex row / default gemini-2.5-flash)
    return await resolveFeatureFlag(ctx, "geminiGraphModel", "MC_GEMINI_GRAPH_MODEL", "gemini-2.5-flash");
  }
  if (tier === "ultra" || tier === "unlimited") {
    return "gemini-2.5-flash";
  }
  return "gemini-2.0-flash";
}

const entityTypes = ["person", "project", "goal", "decision", "concept", "tool", "event", "resource", "channel"] as const;
type EntityType = (typeof entityTypes)[number];

const relationTypes = [
  "mentions",
  "decided_in",
  "leads_to",
  "depends_on",
  "owns",
  "uses",
  "conflicts_with",
  "supports",
  "occurs_with",
  "assigned_to",
] as const;
type RelationType = (typeof relationTypes)[number];

const associationTypes = ["supports", "contradicts", "derives_from", "co_occurred", "generalizes", "precedes"] as const;
type AssociationType = (typeof associationTypes)[number];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const normalizeText = (value: string) => value.trim().toLowerCase();

const uniqueStrings = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const canonicalize = (prefix: string, value: string) => {
  const slug = normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${prefix}:${slug || "untitled"}`;
};

type ExtractedEntity = {
  label: string;
  type: EntityType;
  description?: string;
};

type ExtractedRelation = {
  from: string;
  to: string;
  type: RelationType;
  weight?: number;
  note?: string;
};

type ExtractionPayload = {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  associationHint?: string;
};

async function callOpenRouterGraphExtractor(prompt: string, apiKey: string, model: string): Promise<{ text: string; errorReason?: string }> {
  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://memorycrystal.ai",
        "X-Title": "Memory Crystal",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: GRAPH_TEMPERATURE,
        max_tokens: 1000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      console.log(`[graphEnrich] OpenRouter error ${response.status}: ${errorText}`);
      return { text: "", errorReason: `openrouter_${response.status}` };
    }

    const payload = await response.json();
    const rawContent = payload?.choices?.[0]?.message?.content ?? "";
    return { text: typeof rawContent === "string" ? rawContent.trim() : "", errorReason: undefined };
  } catch (err) {
    console.log("[graphEnrich] OpenRouter network/parse error", err);
    return { text: "", errorReason: "openrouter_error" };
  }
}

const buildPrompt = (title: string, content: string) => {
  // M3: truncate content to 2000 chars to bound Gemini input tokens.
  const truncatedContent = truncatePromptContent(content, 2000);
  return buildPromptFromParts(title, truncatedContent);
};

const buildPromptFromParts = (title: string, content: string) => `You are a knowledge graph extractor. From the following memory, extract:
1. Named entities (people, projects, concepts, tools, decisions, goals)
2. Relationships between entities
3. The single most important other memory concept this relates to (for associations)

Respond with ONLY valid JSON:
{
  "entities": [
    { "label": "Sarah", "type": "person", "description": "manages backend team" },
    { "label": "API", "type": "tool", "description": "backend API owned by Sarah" }
  ],
  "relations": [
    { "from": "Sarah", "to": "API", "type": "owns", "weight": 0.85, "note": "Sarah owns the API" }
  ],
  "associationHint": "optional free-text concept this memory co-occurs with"
}

Valid entity types: person, project, goal, decision, concept, tool, event, resource, channel
Valid relation types: mentions, decided_in, leads_to, depends_on, owns, uses, conflicts_with, supports, occurs_with, assigned_to

Return empty arrays if nothing meaningful is extractable. Keep it tight — max 5 entities, max 5 relations.

Memory title:
${title}

Memory content:
${content}`;

const parseExtraction = (rawContent: string): ExtractionPayload | null => {
  if (!rawContent.trim()) return null;

  try {
    const cleaned = rawContent
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as Partial<ExtractionPayload>;

    const entities = Array.isArray(parsed.entities)
      ? parsed.entities
          .slice(0, 5)
          .map((entity) => ({
            label: typeof entity?.label === "string" ? entity.label.trim() : "",
            type: typeof entity?.type === "string" ? (entity.type as EntityType) : ("concept" as EntityType),
            description: typeof entity?.description === "string" ? entity.description.trim() : "",
          }))
          .filter((entity) => entity.label.length > 0 && entityTypes.includes(entity.type))
      : [];

    const relations = Array.isArray(parsed.relations)
      ? parsed.relations
          .slice(0, 5)
          .map((relation) => ({
            from: typeof relation?.from === "string" ? relation.from.trim() : "",
            to: typeof relation?.to === "string" ? relation.to.trim() : "",
            type: typeof relation?.type === "string" ? (relation.type as RelationType) : ("mentions" as RelationType),
            weight: typeof relation?.weight === "number" ? relation.weight : 0.7,
            note: typeof relation?.note === "string" ? relation.note.trim() : "",
          }))
          .filter((relation) => relation.from.length > 0 && relation.to.length > 0 && relationTypes.includes(relation.type))
      : [];

    const associationHint = typeof parsed.associationHint === "string" ? parsed.associationHint.trim() : "";

    return { entities, relations, associationHint };
  } catch {
    return null;
  }
};

const mapRelationToAssociationType = (relationType: RelationType): AssociationType => {
  switch (relationType) {
    case "conflicts_with":
      return "contradicts";
    case "depends_on":
      return "derives_from";
    case "occurs_with":
      return "co_occurred";
    case "leads_to":
      return "precedes";
    case "supports":
      return "supports";
    default:
      return "supports";
  }
};

export const getMemoryForEnrichment = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, { memoryId }) => {
    const memory = await ctx.db.get(memoryId);
    if (!memory) return null;

    return {
      _id: memory._id,
      userId: memory.userId,
      title: memory.title,
      content: memory.content,
      tags: memory.tags,
      store: memory.store,
      category: memory.category,
      archived: memory.archived,
      channel: memory.channel,
      graphEnriched: memory.graphEnriched,
      // M4: KB parent-aware enrichment
      isKbParent: memory.isKbParent,
      knowledgeBaseId: memory.knowledgeBaseId,
      // F7: full eligibility fields for defense-in-depth shouldEnrich check
      enrichmentSkippedReason: memory.enrichmentSkippedReason,
      enrichmentAttempts: memory.enrichmentAttempts,
      strength: memory.strength,
      accessCount: memory.accessCount,
    };
  },
});

/** M4: fetch sibling KB chunks for parent-aware enrichment prompt construction. */
export const getKbSiblingChunks = internalQuery({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    userId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId)
      )
      .filter((q) => q.eq(q.field("archived"), false))
      .take(args.limit);
    return chunks.map((c) => ({ _id: c._id, content: c.content, title: c.title }));
  },
});

export const markMemoryEnriched = internalMutation({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, { memoryId }) => {
    const memory = await ctx.db.get(memoryId);
    if (!memory) return;
    if (memory.archived) return;
    // Only increment enriched counter if not already enriched
    const wasEnriched = memory.graphEnriched === true;
    const wasSkipped = Boolean(memory.enrichmentSkippedReason);
    await ctx.db.patch(memoryId, {
      graphEnriched: true,
      graphEnrichedAt: Date.now(),
      enrichmentSkippedReason: undefined,
    });
    if (!wasEnriched && memory.userId) {
      await applyDashboardTotalsDelta(ctx, memory.userId, {
        enrichedMemoriesDelta: 1,
        graphEligiblePendingMemoriesDelta: wasSkipped ? 0 : -1,
        graphSkippedMemoriesDelta: wasSkipped ? -1 : 0,
      });
    }
  },
});

/** M2 — Maximum enrichment attempts before a memory is permanently skipped. */
const MAX_ENRICHMENT_ATTEMPTS = 5;

/**
 * M2 — markMemoryEnrichmentFailed
 *
 * Increments `enrichmentAttempts` on each failure. When the attempt count
 * reaches MAX_ENRICHMENT_ATTEMPTS, sets `enrichmentSkippedReason` so the
 * cron-side filter permanently excludes this memory.
 */
export const markMemoryEnrichmentFailed = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    userId: v.string(),
    tier: v.optional(v.string()),
  },
  handler: async (ctx, { memoryId, userId, tier }) => {
    const memory = await ctx.db.get(memoryId);
    if (!memory) return { attempts: 0, capped: false };

    const newAttempts = (memory.enrichmentAttempts ?? 0) + 1;
    const capped = newAttempts >= MAX_ENRICHMENT_ATTEMPTS;
    const wasSkipped = Boolean(memory.enrichmentSkippedReason);

    const patch: Record<string, unknown> = { enrichmentAttempts: newAttempts };
    if (capped) {
      patch.enrichmentSkippedReason = "max_attempts_exceeded";
    }

    await ctx.db.patch(memoryId, patch as any);
    if (capped && !wasSkipped && !memory.archived && memory.graphEnriched !== true) {
      await applyDashboardTotalsDelta(ctx, userId, {
        graphEligiblePendingMemoriesDelta: -1,
        graphSkippedMemoriesDelta: 1,
      });
    }

    // M0 telemetry — fire-and-forget
    const metricName = capped ? "enrichMemoryGraph_maxAttemptsHit" : "enrichMemoryGraph_fail";
    ctx.runMutation(
      internal.crystal.observability.functionCallMetrics.recordCall,
      { name: metricName, userId, tier },
    ).catch(() => null);

    return { attempts: newAttempts, capped };
  },
});

export const markMemoryEnrichmentSkipped = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    userId: v.string(),
    reason: v.string(),
    tier: v.optional(v.string()),
  },
  handler: async (ctx, { memoryId, userId, reason, tier }) => {
    const memory = await ctx.db.get(memoryId);
    if (!memory || memory.userId !== userId) return { skipped: false };
    if (memory.archived || memory.graphEnriched === true) return { skipped: false };
    if (!DETERMINISTIC_SKIP_REASONS.has(reason)) return { skipped: false };
    const wasSkipped = Boolean(memory.enrichmentSkippedReason);

    const patch: Record<string, unknown> = { enrichmentSkippedReason: reason };
    if (reason === "below_strength_floor") {
      patch.enrichmentAttempts = 0;
    }
    await ctx.db.patch(memoryId, patch as any);
    if (!wasSkipped) {
      await applyDashboardTotalsDelta(ctx, userId, {
        graphEligiblePendingMemoriesDelta: -1,
        graphSkippedMemoriesDelta: 1,
      });
    }
    ctx.runMutation(
      internal.crystal.observability.functionCallMetrics.recordCall,
      { name: "enrichMemoryGraph_classifiedSkip", userId, tier },
    ).catch(() => null);

    return { skipped: true, reason };
  },
});

export const ensureNodeForMemory = internalMutation({
  args: {
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    label: v.string(),
    nodeType: v.union(
      v.literal("person"),
      v.literal("project"),
      v.literal("goal"),
      v.literal("decision"),
      v.literal("concept"),
      v.literal("tool"),
      v.literal("event"),
      v.literal("resource"),
      v.literal("channel")
    ),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const canonicalKey = canonicalize(args.nodeType, args.label);

    const existing = (
      await ctx.db
        .query("crystalNodes")
        .withIndex("by_user_canonical", (q) => q.eq("userId", args.userId).eq("canonicalKey", canonicalKey))
        .take(1)
    )[0];

    const now = Date.now();

    if (existing) {
      if (!existing.sourceMemoryIds.includes(args.memoryId)) {
        await ctx.db.patch(existing._id, {
          sourceMemoryIds: [...existing.sourceMemoryIds, args.memoryId],
          updatedAt: now,
        });
      }

      const existingLink = (
        await ctx.db
          .query("crystalMemoryNodeLinks")
          .withIndex("by_memory", (q) => q.eq("memoryId", args.memoryId))
          .filter((q) => q.eq(q.field("nodeId"), existing._id))
          .take(1)
      )[0];

      if (!existingLink) {
        await ctx.db.insert("crystalMemoryNodeLinks", {
          userId: args.userId,
          memoryId: args.memoryId,
          nodeId: existing._id,
          role: "topic",
          linkConfidence: 0.8,
          createdAt: now,
        });
      }

      return { nodeId: existing._id };
    }

    const nodeId = await ctx.db.insert("crystalNodes", {
      userId: args.userId,
      label: args.label,
      nodeType: args.nodeType,
      alias: [],
      canonicalKey,
      description: args.description ?? "",
      strength: 0.5,
      confidence: 0.6,
      tags: [],
      metadata: "",
      createdAt: now,
      updatedAt: now,
      sourceMemoryIds: [args.memoryId],
      status: "active",
    });

    await ctx.db.insert("crystalMemoryNodeLinks", {
      userId: args.userId,
      memoryId: args.memoryId,
      nodeId,
      role: "topic",
      linkConfidence: 0.8,
      createdAt: now,
    });

    return { nodeId };
  },
});

export const upsertRelationForMemory = internalMutation({
  args: {
    userId: v.string(),
    fromNodeId: v.id("crystalNodes"),
    toNodeId: v.id("crystalNodes"),
    relationType: v.union(
      v.literal("mentions"),
      v.literal("decided_in"),
      v.literal("leads_to"),
      v.literal("depends_on"),
      v.literal("owns"),
      v.literal("uses"),
      v.literal("conflicts_with"),
      v.literal("supports"),
      v.literal("occurs_with"),
      v.literal("assigned_to")
    ),
    memoryId: v.id("crystalMemories"),
    channel: v.optional(v.string()),
    weight: v.optional(v.float64()),
    proofNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = (
      await ctx.db
        .query("crystalRelations")
        .withIndex("by_from_to_relation", (q) =>
          q.eq("fromNodeId", args.fromNodeId).eq("toNodeId", args.toNodeId).eq("relationType", args.relationType)
        )
        .take(1)
    )[0];

    const relationWeight = clamp(args.weight ?? 0.7, 0.1, 1);
    const channel = args.channel?.trim() ? args.channel.trim() : "unknown";
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        updatedAt: now,
        weight: clamp(Math.max(existing.weight, relationWeight), 0.1, 1),
        confidence: clamp(Math.max(existing.confidence, relationWeight), 0.1, 1),
        proofNote: args.proofNote || existing.proofNote,
        evidenceMemoryIds: uniqueStrings([...existing.evidenceMemoryIds, args.memoryId as string]) as Id<"crystalMemories">[],
        channels: uniqueStrings([...existing.channels, channel]),
      });
      return { created: false };
    }

    await ctx.db.insert("crystalRelations", {
      userId: args.userId,
      fromNodeId: args.fromNodeId,
      toNodeId: args.toNodeId,
      relationType: args.relationType,
      weight: relationWeight,
      evidenceMemoryIds: [args.memoryId],
      evidenceWindow: undefined,
      channels: [channel],
      proofNote: args.proofNote,
      confidence: relationWeight,
      confidenceReason: "Extracted from memory capture via graphEnrich pipeline.",
      createdAt: now,
      updatedAt: now,
      promotedFrom: undefined,
    });

    return { created: true };
  },
});

export const findAssociationTargetMemory = internalQuery({
  args: {
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    hint: v.string(),
  },
  handler: async (ctx, args) => {
    const hint = args.hint.trim().toLowerCase();
    if (!hint) return null;

    const candidates = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("archived"), false))
      .order("desc")
      .take(100);

    return (
      candidates.find(
        (memory) =>
          memory._id !== args.memoryId &&
          ((memory.title ?? "").toLowerCase().includes(hint) || (memory.content ?? "").toLowerCase().includes(hint))
      ) ?? null
    );
  },
});

const GRAPH_BACKFILL_PAGE_SIZE = 10;
const GRAPH_BACKFILL_MAX_BYTES = 512 * 1024;

type GraphBackfillPage = {
  page: Array<{ _id: Id<"crystalMemories">; userId: string }>;
  isDone: boolean;
  continueCursor?: string;
};

type GraphBackfillUserStats = {
  processed: number;
  succeeded: number;
  done: boolean;
  circuitBroken: boolean;
  failureReasons: Record<string, number>;
};

type GraphSkippedMemoryPage = {
  page: Array<{
    _id: Id<"crystalMemories">;
    userId: string;
    store?: string;
    category?: string;
    title?: string;
    enrichmentSkippedReason?: string;
    enrichmentAttempts?: number;
    strength?: number;
    accessCount?: number;
    knowledgeBaseId?: Id<"knowledgeBases">;
    isKbParent?: boolean;
    supersedesMemoryId?: Id<"crystalMemories">;
    supersededByMemoryId?: Id<"crystalMemories">;
  }>;
  isDone: boolean;
  continueCursor?: string;
};

function incrementCount(map: Record<string, number>, key: string | undefined) {
  const normalized = key?.trim() || "unknown";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function assessGraphEligibilityAfterRetryReset(memory: {
  store?: string;
  tier?: string;
  isKbParent?: boolean;
  knowledgeBaseId?: unknown;
  strength?: number;
  accessCount?: number;
}) {
  return shouldEnrich({
    store: memory.store,
    tier: memory.tier,
    isKbParent: memory.isKbParent,
    knowledgeBaseId: memory.knowledgeBaseId ? String(memory.knowledgeBaseId) : undefined,
    enrichmentSkippedReason: undefined,
    attempts: 0,
    strength: memory.strength,
    accessCount: memory.accessCount,
  });
}

async function requireGraphBackfillOverrideAccess(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated: graph backfill overrides require manager or admin access");
  const viewerId = stableUserId(identity.subject);
  const access = await ctx.runQuery(internal.crystal.graphEnrich.getGraphBackfillOverrideAccess, { viewerId }) as { allowed: boolean };
  if (!access.allowed) {
    throw new Error("Forbidden: graph backfill overrides require manager or admin access");
  }
}

export const getGraphBackfillOverrideAccess = internalQuery({
  args: { viewerId: v.string() },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.viewerId))
      .collect();
    const latestProfile = profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    return { allowed: canPerformWriteActions(normalizeRoles((latestProfile as any)?.roles)) };
  },
});

export const listSkippedMemoriesPageForUser = internalQuery({
  args: {
    userId: v.string(),
    reason: v.string(),
    cursor: v.optional(v.string()),
    pageSize: v.number(),
  },
  handler: async (ctx, args): Promise<GraphSkippedMemoryPage> => {
    const page: any = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_archived_skip_reason", (q) =>
        q
          .eq("userId", args.userId)
          .eq("archived", false)
          .eq("enrichmentSkippedReason", args.reason)
      )
      .filter((q) => q.neq(q.field("graphEnriched"), true))
      .paginate({
        numItems: Math.max(1, Math.trunc(args.pageSize)),
        cursor: args.cursor ?? null,
        maximumBytesRead: GRAPH_BACKFILL_MAX_BYTES,
      });

    return {
      page: (page.page as Array<any>).map((memory) => ({
        _id: memory._id,
        userId: memory.userId,
        store: memory.store,
        category: memory.category,
        title: memory.title,
        enrichmentSkippedReason: memory.enrichmentSkippedReason,
        enrichmentAttempts: memory.enrichmentAttempts,
        strength: memory.strength,
        accessCount: memory.accessCount,
        knowledgeBaseId: memory.knowledgeBaseId,
        isKbParent: memory.isKbParent,
        supersedesMemoryId: memory.supersedesMemoryId,
        supersededByMemoryId: memory.supersededByMemoryId,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor as string | undefined,
    };
  },
});

export const resetMemoryGraphSkipForRetry = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    userId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    if (!RETRYABLE_GRAPH_SKIP_REASONS.has(args.reason)) {
      return { reset: false, reason: "not_retryable_skip_reason" };
    }

    const memory = await ctx.db.get(args.memoryId);
    if (!memory || memory.userId !== args.userId) {
      return { reset: false, reason: "memory_not_found" };
    }
    if (memory.archived) return { reset: false, reason: "archived_memory" };
    if (memory.graphEnriched === true) return { reset: false, reason: "already_enriched" };
    if (memory.enrichmentSkippedReason !== args.reason) {
      return {
        reset: false,
        reason: "skip_reason_changed",
        currentReason: memory.enrichmentSkippedReason,
      };
    }

    const eligibility = assessGraphEligibilityAfterRetryReset({
      store: memory.store,
      isKbParent: memory.isKbParent,
      knowledgeBaseId: memory.knowledgeBaseId,
      strength: memory.strength,
      accessCount: memory.accessCount,
    });
    if (!eligibility.ok) {
      return { reset: false, reason: eligibility.reason ?? "not_graph_eligible_after_reset" };
    }

    await ctx.db.patch(args.memoryId, {
      enrichmentSkippedReason: undefined,
      enrichmentAttempts: 0,
    });
    await applyDashboardTotalsDelta(ctx, args.userId, {
      graphSkippedMemoriesDelta: -1,
      graphEligiblePendingMemoriesDelta: 1,
    });

    return { reset: true };
  },
});

export const auditSkippedGraphEnrichmentForUserInternal = internalAction({
  args: {
    userId: v.string(),
    sampleLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const sampleLimit = clamp(Math.trunc(args.sampleLimit ?? 5), 0, 25);
    const reasons: Record<string, number> = {};
    const stores: Record<string, number> = {};
    const categories: Record<string, number> = {};
    const retryable: Record<string, number> = {};
    const blockedAfterRetryReset: Record<string, number> = {};
    const duplicateLike = { supersedes: 0, supersededBy: 0 };
    const examples: Array<Record<string, unknown>> = [];

    for (const reason of GRAPH_SKIP_AUDIT_REASONS) {
      let cursor: string | undefined;
      do {
        const page = await ctx.runQuery(internal.crystal.graphEnrich.listSkippedMemoriesPageForUser, {
          userId: args.userId,
          reason,
          cursor,
          pageSize: 25,
        }) as GraphSkippedMemoryPage;

        for (const memory of page.page) {
          incrementCount(reasons, reason);
          incrementCount(stores, memory.store);
          incrementCount(categories, memory.category);
          if (memory.supersedesMemoryId) duplicateLike.supersedes += 1;
          if (memory.supersededByMemoryId) duplicateLike.supersededBy += 1;

          if (RETRYABLE_GRAPH_SKIP_REASONS.has(reason)) {
            const eligibility = assessGraphEligibilityAfterRetryReset(memory);
            if (eligibility.ok) {
              incrementCount(retryable, reason);
            } else {
              incrementCount(blockedAfterRetryReset, eligibility.reason);
            }
          }

          if (examples.length < sampleLimit) {
            examples.push({
              id: String(memory._id),
              title: memory.title,
              reason,
              store: memory.store,
              category: memory.category,
              strength: memory.strength,
              accessCount: memory.accessCount,
              enrichmentAttempts: memory.enrichmentAttempts,
              isKbParent: memory.isKbParent,
              hasKnowledgeBaseId: Boolean(memory.knowledgeBaseId),
            });
          }
        }

        cursor = page.continueCursor;
        if (page.isDone) break;
      } while (cursor);
    }

    return {
      userId: args.userId,
      strengthFloor: STRENGTH_FLOOR,
      skippedTotal: Object.values(reasons).reduce((sum, count) => sum + count, 0),
      reasons,
      stores,
      categories,
      retryable,
      blockedAfterRetryReset,
      duplicateLike,
      examples,
    };
  },
});

export const retrySkippedGraphEnrichmentForUserInternal = internalAction({
  args: {
    userId: v.string(),
    maxMemories: v.optional(v.number()),
    reasons: v.optional(v.array(v.string())),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const target = clamp(Math.trunc(args.maxMemories ?? 25), 1, GRAPH_BACKFILL_GLOBAL_SUCCESS_CAP);
    const dryRun = args.dryRun === true;
    const requestedReasons = args.reasons?.length ? args.reasons : Array.from(RETRYABLE_GRAPH_SKIP_REASONS);
    const reasons = requestedReasons.filter((reason) => RETRYABLE_GRAPH_SKIP_REASONS.has(reason));

    const stats = {
      userId: args.userId,
      dryRun,
      target,
      reasons,
      considered: 0,
      eligibleForRetry: 0,
      reset: 0,
      processed: 0,
      enriched: 0,
      skipped: {} as Record<string, number>,
      failureReasons: {} as Record<string, number>,
    };

    for (const reason of reasons) {
      let cursor: string | undefined;
      while (stats.eligibleForRetry < target) {
        const page = await ctx.runQuery(internal.crystal.graphEnrich.listSkippedMemoriesPageForUser, {
          userId: args.userId,
          reason,
          cursor,
          pageSize: 10,
        }) as GraphSkippedMemoryPage;

        if (page.page.length === 0) {
          if (page.isDone || !page.continueCursor) break;
          cursor = page.continueCursor;
          continue;
        }

        for (const memory of page.page) {
          stats.considered += 1;
          const eligibility = assessGraphEligibilityAfterRetryReset(memory);
          if (!eligibility.ok) {
            incrementCount(stats.skipped, eligibility.reason);
            continue;
          }

          stats.eligibleForRetry += 1;
          if (dryRun) {
            if (stats.eligibleForRetry >= target) break;
            continue;
          }

          const reset = await ctx.runMutation(internal.crystal.graphEnrich.resetMemoryGraphSkipForRetry, {
            memoryId: memory._id,
            userId: args.userId,
            reason,
          }) as { reset: boolean; reason?: string; currentReason?: string };

          if (!reset.reset) {
            incrementCount(stats.skipped, reset.reason ?? "reset_failed");
            continue;
          }

          stats.reset += 1;
          const result = await ctx.runAction(internal.crystal.graphEnrich.enrichMemoryGraph, {
            memoryId: memory._id,
            userId: args.userId,
          }) as { enriched?: boolean; reason?: string };
          stats.processed += 1;

          if (result?.enriched) {
            stats.enriched += 1;
          } else {
            incrementCount(stats.failureReasons, result?.reason ?? "unknown");
          }

          if (stats.eligibleForRetry >= target) break;
        }

        if (stats.eligibleForRetry >= target || page.isDone || !page.continueCursor) break;
        cursor = page.continueCursor;
      }
    }

    try {
      await ctx.runAction(internal.crystal.evalStats.refreshStatsCache, { userId: args.userId });
    } catch {
      // Diagnostic cache refresh is non-fatal.
    }

    return stats;
  },
});

export const adminAuditSkippedGraphEnrichmentForUser: any = action({
  args: {
    userId: v.string(),
    sampleLimit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireGraphBackfillOverrideAccess(ctx);
    return ctx.runAction(internal.crystal.graphEnrich.auditSkippedGraphEnrichmentForUserInternal, args);
  },
});

export const adminRetrySkippedGraphEnrichmentForUser: any = action({
  args: {
    userId: v.string(),
    maxMemories: v.optional(v.number()),
    reasons: v.optional(v.array(v.string())),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireGraphBackfillOverrideAccess(ctx);
    return ctx.runAction(internal.crystal.graphEnrich.retrySkippedGraphEnrichmentForUserInternal, args);
  },
});

export const listUnenrichedMemoriesForUser = internalQuery({
  args: {
    userId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const falseRows = await ctx.db
      .query("crystalMemories")
      .withIndex("by_graph_enriched", (q) => q.eq("graphEnriched", false).eq("userId", args.userId))
      .filter((q) => q.eq(q.field("archived"), false))
      .take(args.limit);

    if (falseRows.length >= args.limit) return falseRows;

    const undefinedRows = await ctx.db
      .query("crystalMemories")
      .withIndex("by_graph_enriched", (q) => q.eq("graphEnriched", undefined).eq("userId", args.userId))
      .filter((q) => q.eq(q.field("archived"), false))
      .take(args.limit - falseRows.length);

    return [...falseRows, ...undefinedRows];
  },
});

export const listUnenrichedMemoriesPageForUser = internalQuery({
  args: {
    userId: v.string(),
    state: v.union(v.literal("false"), v.literal("undefined")),
    cursor: v.optional(v.string()),
    pageSize: v.number(),
  },
  handler: async (ctx, args): Promise<GraphBackfillPage> => {
    const graphEnrichedValue = args.state === "false" ? false : undefined;
    // M2 cron-side filter: exclude memories that have a permanent skip reason
    // (max_attempts_exceeded, sensory_skip, etc.). This is a lazy-classification
    // approach — legacy poison rows are excluded after they accumulate a skip reason;
    // no backfill migration required.
    const page: any = await ctx.db
      .query("crystalMemories")
      .withIndex("by_graph_enriched", (q) => q.eq("graphEnriched", graphEnrichedValue).eq("userId", args.userId))
      .filter((q) =>
        q.and(
          q.eq(q.field("archived"), false),
          q.eq(q.field("enrichmentSkippedReason"), undefined),
        )
      )
      .paginate({
        numItems: Math.max(args.pageSize, 1),
        cursor: args.cursor ?? null,
        maximumBytesRead: GRAPH_BACKFILL_MAX_BYTES,
      });

    return {
      page: (page.page as Array<any>).map((memory) => ({
        _id: memory._id,
        userId: memory.userId,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor as string | undefined,
    };
  },
});

export const enrichMemoryGraph: ReturnType<typeof internalAction> = internalAction({
  args: {
    memoryId: v.id("crystalMemories"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    // M0 — instrument invocation count for cost-reduction baseline
    ctx.runMutation(internal.crystal.observability.functionCallMetrics.recordCall, {
      name: "enrichMemoryGraph",
      userId: args.userId,
    }).catch(() => null);

    const memory = await ctx.runQuery(internal.crystal.graphEnrich.getMemoryForEnrichment, {
      memoryId: args.memoryId,
    });
    if (!memory || memory.userId !== args.userId) return { enriched: false, reason: "memory_not_found" };
    if ((memory as any).archived === true) return { enriched: false, reason: "archived_memory", deterministicSkip: true };

    // Skip if already enriched — prevents duplicate processing from over-scheduled backfill
    if ((memory as any).graphEnriched === true) return { enriched: false, reason: "already_enriched" };

    const eligibility = shouldEnrich({
      store: (memory as any).store,
      tier: (memory as any).tier,
      isKbParent: (memory as any).isKbParent,
      knowledgeBaseId: (memory as any).knowledgeBaseId,
      enrichmentSkippedReason: (memory as any).enrichmentSkippedReason,
      attempts: (memory as any).enrichmentAttempts,
      strength: (memory as any).strength,
      accessCount: (memory as any).accessCount,
    });
    if (!eligibility.ok) {
      ctx
        .runMutation(
          internal.crystal.observability.functionCallMetrics.recordCall,
          {
            name: "enrichMemoryGraph_skip",
            tier: (memory as any).store,
            userId: memory.userId,
          },
        )
        .catch(() => null);
      if (eligibility.reason && DETERMINISTIC_SKIP_REASONS.has(eligibility.reason)) {
        await ctx.runMutation(internal.crystal.graphEnrich.markMemoryEnrichmentSkipped, {
          memoryId: args.memoryId,
          userId: args.userId,
          reason: eligibility.reason,
          tier: (memory as any).store,
        });
      }
      return { enriched: false, reason: eligibility.reason, deterministicSkip: true };
    }

    const tier = await ctx.runQuery(internal.crystal.userProfiles.getUserTier, {
      userId: memory.userId,
    });
    const model = await getEnrichmentModel(ctx, tier);
    // Site 1: resolve the OpenRouter graph model via admin-settings resolver
    const openRouterModel = await resolveGraphModel(ctx, tier as any);

    // M4: if this is a KB parent, fetch sibling chunk content and concatenate
    // into the enrichment prompt for richer cross-chunk graph extraction.
    // Capped at 50 siblings; total prompt content is truncated to 8000 chars
    // (4× the per-memory cap from M3) via buildPromptFromParts to bypass the
    // inner 2000-char truncation in buildPrompt.
    const KB_PARENT_PROMPT_CAP = 8000;
    const KB_SIBLING_LIMIT = 50;
    let prompt: string;
    if ((memory as any).isKbParent === true && (memory as any).knowledgeBaseId) {
      const siblings = await ctx.runQuery(internal.crystal.graphEnrich.getKbSiblingChunks, {
        knowledgeBaseId: (memory as any).knowledgeBaseId,
        userId: args.userId,
        limit: KB_SIBLING_LIMIT,
      });
      if (siblings.length > 1) {
        // Concatenate all sibling content (parent chunk appears in the results too)
        const combined = siblings.map((s: { content: string }) => s.content).join("\n\n---\n\n");
        const truncated = truncatePromptContent(combined, KB_PARENT_PROMPT_CAP);
        // Use buildPromptFromParts directly to preserve the 8k cap (buildPrompt would re-truncate to 2k)
        prompt = buildPromptFromParts(memory.title, truncated);
      } else {
        prompt = buildPrompt(memory.title, memory.content);
      }
    } else {
      prompt = buildPrompt(memory.title, memory.content);
    }
    const openRouterKey = await ctx.runQuery(
      internal.crystal.providerSettings.resolveOpenRouterKeyForUser,
      { userId: args.userId, includeShared: false },
    ) as { apiKey: string | null; source: "personal" | "shared" | null } | null;

    let rawContent = "";
    if (openRouterKey?.apiKey) {
      const result = await callOpenRouterGraphExtractor(prompt, openRouterKey.apiKey, openRouterModel);
      if (result.errorReason) {
        // M2: persist failure attempt count; sets enrichmentSkippedReason at cap
        await ctx.runMutation(internal.crystal.graphEnrich.markMemoryEnrichmentFailed, {
          memoryId: args.memoryId,
          userId: args.userId,
          tier,
        });
        return { enriched: false, reason: result.errorReason };
      }
      rawContent = result.text;
      if (!rawContent) {
        // M2: persist failure attempt count; sets enrichmentSkippedReason at cap
        await ctx.runMutation(internal.crystal.graphEnrich.markMemoryEnrichmentFailed, {
          memoryId: args.memoryId,
          userId: args.userId,
          tier,
        });
        return { enriched: false, reason: "openrouter_empty" };
      }
    }

    if (!rawContent) {
      console.log("[graphEnrich] no enrichment content available; skipping enrichment", { memoryId: args.memoryId });
      return { enriched: false, reason: "missing_openrouter_key" };
    }

    try {
      const extraction = parseExtraction(rawContent);
      if (!extraction) {
        console.log("[graphEnrich] Failed to parse extraction JSON", { memoryId: args.memoryId });
        // M2: persist failure attempt count; sets enrichmentSkippedReason at cap
        await ctx.runMutation(internal.crystal.graphEnrich.markMemoryEnrichmentFailed, {
          memoryId: args.memoryId,
          userId: args.userId,
          tier,
        });
        return { enriched: false, reason: "parse_failed" };
      }

      const nodeIdByLabel = new Map<string, Id<"crystalNodes">>();

      for (const entity of extraction.entities) {
        const node = await ctx.runMutation(internal.crystal.graphEnrich.ensureNodeForMemory, {
          userId: args.userId,
          memoryId: args.memoryId,
          label: entity.label,
          nodeType: entity.type,
          description: entity.description,
        });
        nodeIdByLabel.set(normalizeText(entity.label), node.nodeId);
      }

      for (const relation of extraction.relations) {
        const fromNodeId = nodeIdByLabel.get(normalizeText(relation.from));
        const toNodeId = nodeIdByLabel.get(normalizeText(relation.to));
        if (!fromNodeId || !toNodeId) continue;

        await ctx.runMutation(internal.crystal.graphEnrich.upsertRelationForMemory, {
          userId: args.userId,
          fromNodeId,
          toNodeId,
          relationType: relation.type,
          memoryId: args.memoryId,
          channel: memory.channel,
          weight: relation.weight,
          proofNote: relation.note,
        });
      }

      if (extraction.associationHint) {
        const target = await ctx.runQuery(internal.crystal.graphEnrich.findAssociationTargetMemory, {
          userId: args.userId,
          memoryId: args.memoryId,
          hint: extraction.associationHint,
        });

        if (target) {
          const fallbackRelationType: RelationType = extraction.relations[0]?.type ?? "occurs_with";
          await ctx.runMutation(internal.crystal.associations.upsertAssociationRecord, {
            userId: args.userId,
            fromMemoryId: args.memoryId,
            toMemoryId: target._id,
            relationshipType: mapRelationToAssociationType(fallbackRelationType),
            weight: clamp(extraction.relations[0]?.weight ?? 0.75, 0.1, 1),
          });
        }
      }

      await ctx.runMutation(internal.crystal.graphEnrich.markMemoryEnriched, { memoryId: args.memoryId });
      return { enriched: true };
    } catch (err) {
      console.log("[graphEnrich] enrichMemoryGraph failed:", err);
      // M2: persist failure attempt count before rethrowing; sets enrichmentSkippedReason at cap
      await ctx.runMutation(internal.crystal.graphEnrich.markMemoryEnrichmentFailed, {
        memoryId: args.memoryId,
        userId: args.userId,
        tier,
      });
      throw err;
    }
  },
});

export const backfillGraphEnrichment = action({
  args: { maxMemories: v.optional(v.number()), userId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{
    processed: number;
    succeeded: number;
    done: boolean;
    circuitBroken: boolean;
    failureReasons: Record<string, number>;
    usersConsidered: number;
  }> => {
    if (args.userId || args.maxMemories !== undefined) {
      await requireGraphBackfillOverrideAccess(ctx);
    }

    const explicitTarget = args.maxMemories === undefined
      ? null
      : clamp(Math.trunc(args.maxMemories), 1, GRAPH_BACKFILL_GLOBAL_SUCCESS_CAP);
    const globalTarget = explicitTarget ?? GRAPH_BACKFILL_GLOBAL_SUCCESS_CAP;
    const capCache = new Map<string, number>();
    const personalOpenRouterKeyCache = new Map<string, boolean>();
    const resolveUserCap = async (userId: string) => {
      if (args.userId && explicitTarget !== null) return explicitTarget;
      const cached = capCache.get(userId);
      if (cached !== undefined) return cached;
      const settings = await ctx.runQuery(
        (internal as any).crystal.graphSettings.resolveGraphEnrichmentHourlyCapForUser,
        { userId },
      ) as { effectiveHourlySuccessCap?: number } | null;
      const cap = clamp(
        settings?.effectiveHourlySuccessCap ?? DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP,
        1,
        GRAPH_BACKFILL_GLOBAL_SUCCESS_CAP,
      );
      capCache.set(userId, cap);
      return cap;
    };
    const hasPersonalOpenRouterKey = async (userId: string) => {
      const cached = personalOpenRouterKeyCache.get(userId);
      if (cached !== undefined) return cached;
      const openRouterKey = await ctx.runQuery(
        internal.crystal.providerSettings.resolveOpenRouterKeyForUser,
        { userId, includeShared: false },
      ) as { apiKey: string | null; source: "personal" | "shared" | null } | null;
      const hasKey = Boolean(openRouterKey?.apiKey);
      personalOpenRouterKeyCache.set(userId, hasKey);
      return hasKey;
    };

    let userIds: string[];
    let nextRotationCursor: string | undefined;
    if (args.userId) {
      userIds = [args.userId];
    } else {
      const rotationCursor = (await ctx.runQuery(internal.crystal.jobCursors.getJobCursor, {
        jobName: GRAPH_BACKFILL_JOB_NAME,
      })) as string | null;
      let page: { userIds: string[]; continueCursor: string; isDone: boolean };
      try {
        page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          cursor: rotationCursor ?? undefined,
          numItems: GRAPH_BACKFILL_USERS_PER_TICK,
        });
      } catch {
        // Stale/invalidated pagination cursor (table churn between ticks):
        // restart the rotation from the beginning rather than failing the tick.
        page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          numItems: GRAPH_BACKFILL_USERS_PER_TICK,
        });
      }
      userIds = page.userIds;
      nextRotationCursor = page.isDone ? undefined : page.continueCursor;
    }
    let processed = 0;
    let succeeded = 0;
    let done = true;
    let consecutiveFailures = 0;
    let circuitBroken = false;
    const failureReasons: Record<string, number> = {};
    const userStats = new Map<string, GraphBackfillUserStats>();

    // M5 — Drain the lazy-enrichment backlog FIRST. These rows came from
    // `recall.recallMemories` discovering memories that previously hit the
    // strength-floor skip but are now hot again. The backlog mutation only
    // returns rows that still satisfy the freshness / attempts / skip-reason
    // conditions (stale rows are silently removed). Capped at 5 per cron tick
    // so a hot recall storm cannot fan out unbounded enrichment.
    if (!args.userId) {
      try {
        const drained = (await ctx.runMutation(
          internal.crystal.enrichmentBacklog.drainBacklog,
          { limit: GRAPH_BACKFILL_BACKLOG_DRAIN_LIMIT }
        )) as Array<{ memoryId: Id<"crystalMemories">; userId: string }>;
        for (const row of drained) {
          let stats = userStats.get(row.userId);
          if (!stats) {
            stats = { processed: 0, succeeded: 0, done: true, circuitBroken: false, failureReasons: {} };
            userStats.set(row.userId, stats);
          }
          if (!(await hasPersonalOpenRouterKey(row.userId))) {
            stats.failureReasons.skipped_no_personal_openrouter_key =
              (stats.failureReasons.skipped_no_personal_openrouter_key ?? 0) + 1;
            continue;
          }
          const userCap = await resolveUserCap(row.userId);
          if (succeeded >= globalTarget || circuitBroken) break;
          if (stats.succeeded >= userCap) continue;
          processed += 1;
          stats.processed += 1;
          const result = await ctx.runAction(internal.crystal.graphEnrich.enrichMemoryGraph, {
            memoryId: row.memoryId,
            userId: row.userId,
          });
          if (result?.enriched) {
            succeeded += 1;
            stats.succeeded += 1;
            consecutiveFailures = 0;
          } else {
            const reason = typeof result?.reason === "string" && result.reason.trim()
              ? result.reason.trim()
              : "unknown";
            failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
            stats.failureReasons[reason] = (stats.failureReasons[reason] ?? 0) + 1;
            if (
              result?.deterministicSkip === true ||
              DETERMINISTIC_SKIP_REASONS.has(reason) ||
              BENIGN_BACKFILL_REASONS.has(reason)
            ) {
              consecutiveFailures = 0;
            } else {
              consecutiveFailures += 1;
            }
            if (consecutiveFailures >= GRAPH_BACKFILL_CIRCUIT_BREAKER_THRESHOLD) {
              console.error(
                `[graphEnrich] CIRCUIT BREAKER tripped during backlog drain (processed=${processed}, succeeded=${succeeded}).`
              );
              circuitBroken = true;
              stats.circuitBroken = true;
              stats.done = false;
              done = false;
              break;
            }
          }
        }
      } catch (err) {
        // Backlog drain is best-effort. Never let it block the main backfill.
        console.error("[graphEnrich] backlog drain failed:", err);
      }
    }

    for (const userId of userIds) {
      let stats = userStats.get(userId);
      if (!stats) {
        stats = { processed: 0, succeeded: 0, done: true, circuitBroken: false, failureReasons: {} };
        userStats.set(userId, stats);
      }
      if (!(await hasPersonalOpenRouterKey(userId))) {
        stats.failureReasons.skipped_no_personal_openrouter_key =
          (stats.failureReasons.skipped_no_personal_openrouter_key ?? 0) + 1;
        continue;
      }
      const userCap = await resolveUserCap(userId);

      if (succeeded >= globalTarget || circuitBroken) {
        done = false;
        break;
      }
      if (stats.succeeded >= userCap) {
        stats.done = false;
        done = false;
        continue;
      }

      const states: Array<"false" | "undefined"> = ["false", "undefined"];

      for (const state of states) {
        if (succeeded >= globalTarget || stats.succeeded >= userCap || circuitBroken) {
          stats.done = false;
          done = false;
          break;
        }

        let cursor: string | undefined = undefined;

        while (succeeded < globalTarget && stats.succeeded < userCap && !circuitBroken) {
          const page = (await ctx.runQuery(internal.crystal.graphEnrich.listUnenrichedMemoriesPageForUser, {
            userId,
            state,
            cursor,
            pageSize: GRAPH_BACKFILL_PAGE_SIZE,
          })) as GraphBackfillPage;

          if (page.page.length === 0) {
            if (page.isDone || !page.continueCursor) {
              break;
            }
            cursor = page.continueCursor;
            continue;
          }

          for (const memory of page.page) {
            processed += 1;
            stats.processed += 1;
            const result = await ctx.runAction(internal.crystal.graphEnrich.enrichMemoryGraph, {
              memoryId: memory._id,
              userId: memory.userId,
            });

            if (result?.enriched) {
              succeeded += 1;
              stats.succeeded += 1;
              consecutiveFailures = 0;
              if (succeeded >= globalTarget || stats.succeeded >= userCap) {
                stats.done = false;
                done = false;
                break;
              }
            } else {
              const reason = typeof result?.reason === "string" && result.reason.trim()
                ? result.reason.trim()
                : "unknown";
              failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
              stats.failureReasons[reason] = (stats.failureReasons[reason] ?? 0) + 1;
              if (
                result?.deterministicSkip === true ||
                DETERMINISTIC_SKIP_REASONS.has(reason) ||
                BENIGN_BACKFILL_REASONS.has(reason)
              ) {
                consecutiveFailures = 0;
              } else {
                consecutiveFailures += 1;
              }
              if (consecutiveFailures >= GRAPH_BACKFILL_CIRCUIT_BREAKER_THRESHOLD) {
                console.error(
                  `[graphEnrich] CIRCUIT BREAKER: ${consecutiveFailures} consecutive enrichment failures. ` +
                  `Aborting backfill run early (processed=${processed}, succeeded=${succeeded}). ` +
                  `Next cron invocation will retry.`
                );
                circuitBroken = true;
                stats.circuitBroken = true;
                stats.done = false;
                done = false;
                break;
              }
            }
          }

          if (succeeded >= globalTarget || stats.succeeded >= userCap || circuitBroken) {
            break;
          }

          if (page.isDone || !page.continueCursor) {
            break;
          }

          cursor = page.continueCursor;
        }
      }
    }

    const finishedAt = Date.now();
    try {
      await ctx.runMutation(internal.crystal.mcp.insertTelemetry, {
        userId: GRAPH_BACKFILL_GLOBAL_USER_ID,
        kind: GRAPH_BACKFILL_RUN_KIND,
        payload: JSON.stringify({
          processed,
          succeeded,
          done,
          circuitBroken,
          failureReasons,
          usersConsidered: userIds.length,
          usersTouched: Array.from(userStats.values()).filter((stats) => stats.processed > 0).length,
          globalTarget,
        }),
        createdAt: finishedAt,
        expiresAt: finishedAt + 30 * 24 * 60 * 60 * 1000,
      });
    } catch {
      // Non-fatal — heartbeat telemetry is diagnostic only.
    }

    // After backfill batch, refresh stats cache for each user so telemetry stays current
    for (const userId of userIds) {
      const stats = userStats.get(userId) ?? {
        processed: 0,
        succeeded: 0,
        done: true,
        circuitBroken: false,
        failureReasons: {},
      };
      try {
        await ctx.runAction(internal.crystal.evalStats.refreshStatsCache, { userId });
      } catch {
        // Non-fatal — stats cache will be recomputed on next page load
      }
      if (stats.processed === 0) continue;
      try {
        await ctx.runMutation(internal.crystal.mcp.insertTelemetry, {
          userId,
          kind: "graph_enrichment_backfill",
          payload: JSON.stringify({
            processed: stats.processed,
            succeeded: stats.succeeded,
            done: stats.done,
            circuitBroken: stats.circuitBroken,
            failureReasons: stats.failureReasons,
            target: capCache.get(userId) ?? (args.userId && explicitTarget !== null ? explicitTarget : DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP),
            effectiveHourlyCap: capCache.get(userId) ?? (args.userId && explicitTarget !== null ? explicitTarget : DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP),
          }),
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        });
      } catch {
        // Non-fatal — telemetry is diagnostic only.
      }
    }

    // Advance (or reset) the rotation only for full sweeps: explicit
    // single-user runs must not move the shared cursor.
    if (!args.userId) {
      await ctx.runMutation(internal.crystal.jobCursors.setJobCursor, {
        jobName: GRAPH_BACKFILL_JOB_NAME,
        cursor: nextRotationCursor,
      });
    }

    return { processed, succeeded, done, circuitBroken, failureReasons, usersConsidered: userIds.length };
  },
});
