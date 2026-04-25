import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { type Id } from "../_generated/dataModel";
import { applyDashboardTotalsDelta } from "./dashboardTotals";

const GRAPH_TEMPERATURE = 0.1;

/** Circuit breaker: abort the backfill run after this many consecutive enrichment failures. */
const GRAPH_BACKFILL_CIRCUIT_BREAKER_THRESHOLD = 3;

const TIER_ENRICHMENT_MODELS: Record<string, string | null> = {
  free: "gemini-2.0-flash",
  starter: "gemini-2.0-flash",
  pro: "gemini-2.5-flash",
  ultra: "gemini-2.5-flash",
  unlimited: "gemini-2.5-flash",
};

function getEnrichmentModel(tier: string): string | null {
  return TIER_ENRICHMENT_MODELS[tier] ?? "gemini-2.0-flash";
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

const buildPrompt = (title: string, content: string) => `You are a knowledge graph extractor. From the following memory, extract:
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
      channel: memory.channel,
      graphEnriched: memory.graphEnriched,
    };
  },
});

export const markMemoryEnriched = internalMutation({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, { memoryId }) => {
    const memory = await ctx.db.get(memoryId);
    if (!memory) return;
    // Only increment enriched counter if not already enriched
    const wasEnriched = memory.graphEnriched === true;
    await ctx.db.patch(memoryId, {
      graphEnriched: true,
      graphEnrichedAt: Date.now(),
    });
    if (!wasEnriched && memory.userId) {
      await applyDashboardTotalsDelta(ctx, memory.userId, { enrichedMemoriesDelta: 1 });
    }
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

export const listUnenrichedMemoriesForUser = internalQuery({
  args: {
    userId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const falseRows = await ctx.db
      .query("crystalMemories")
      .withIndex("by_graph_enriched", (q) => q.eq("graphEnriched", false).eq("userId", args.userId))
      .take(args.limit);

    if (falseRows.length >= args.limit) return falseRows;

    const undefinedRows = await ctx.db
      .query("crystalMemories")
      .withIndex("by_graph_enriched", (q) => q.eq("graphEnriched", undefined).eq("userId", args.userId))
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
    const page: any = await ctx.db
      .query("crystalMemories")
      .withIndex("by_graph_enriched", (q) => q.eq("graphEnriched", graphEnrichedValue).eq("userId", args.userId))
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
    const memory = await ctx.runQuery(internal.crystal.graphEnrich.getMemoryForEnrichment, {
      memoryId: args.memoryId,
    });
    if (!memory || memory.userId !== args.userId) return { enriched: false, reason: "memory_not_found" };

    // Skip if already enriched — prevents duplicate processing from over-scheduled backfill
    if ((memory as any).graphEnriched === true) return { enriched: false, reason: "already_enriched" };

    const tier = await ctx.runQuery(internal.crystal.userProfiles.getUserTier, {
      userId: memory.userId,
    });
    const model = getEnrichmentModel(tier);
    if (!model) {
      return { enriched: false, reason: "free_tier" };
    }

    const apiKey = process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log("[graphEnrich] CRYSTAL_API_KEY / GEMINI_API_KEY missing; skipping enrichment", { memoryId: args.memoryId });
      return { enriched: false, reason: "missing_api_key" };
    }

    // Daily Gemini call guardrail — skip if cap exceeded (tier-aware)
    const guardrail = await ctx.runMutation(internal.crystal.geminiGuardrail.incrementAndCheck, { userId: args.userId, calls: 1 });
    if (!guardrail.allowed) {
      console.log(
        `[graphEnrich] Daily Gemini call cap reached (${guardrail.callCount}/${guardrail.cap}). Skipping enrichment for ${args.memoryId}.`
      );
      return { enriched: false, reason: "daily_cap_reached" };
    }

    try {
      const prompt = buildPrompt(memory.title, memory.content);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: GRAPH_TEMPERATURE,
              responseMimeType: "application/json",
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        console.log(`[graphEnrich] Gemini error ${response.status}: ${errorText}`);
        return { enriched: false, reason: `gemini_${response.status}` };
      }

      const payload = await response.json();
      const rawContent: string = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const extraction = parseExtraction(rawContent);
      if (!extraction) {
        console.log("[graphEnrich] Failed to parse extraction JSON", { memoryId: args.memoryId });
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
      return { enriched: false, reason: String(err) };
    }
  },
});

export const backfillGraphEnrichment = action({
  args: { maxMemories: v.optional(v.number()), userId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ processed: number; succeeded: number; done: boolean }> => {
    const requested = Math.trunc(args.maxMemories ?? 100);
    const target = clamp(Number.isFinite(requested) ? requested : 100, 1, 500);

    const userIds = args.userId ? [args.userId] : ((await ctx.runQuery(internal.crystal.userProfiles.listAllUserIds, {})) as string[]);
    let processed = 0;
    let succeeded = 0;
    let done = true;
    let consecutiveFailures = 0;
    let circuitBroken = false;

    for (const userId of userIds) {
      if (succeeded >= target || circuitBroken) {
        done = false;
        break;
      }

      const states: Array<"false" | "undefined"> = ["false", "undefined"];

      for (const state of states) {
        if (succeeded >= target || circuitBroken) {
          done = false;
          break;
        }

        let cursor: string | undefined = undefined;

        while (succeeded < target && !circuitBroken) {
          const page = (await ctx.runQuery(internal.crystal.graphEnrich.listUnenrichedMemoriesPageForUser, {
            userId,
            state,
            cursor,
            pageSize: GRAPH_BACKFILL_PAGE_SIZE,
          })) as GraphBackfillPage;

          if (page.page.length === 0) {
            break;
          }

          for (const memory of page.page) {
            processed += 1;
            const result = await ctx.runAction(internal.crystal.graphEnrich.enrichMemoryGraph, {
              memoryId: memory._id,
              userId: memory.userId,
            });

            if (result?.enriched) {
              succeeded += 1;
              consecutiveFailures = 0;
              if (succeeded >= target) {
                done = false;
                break;
              }
            } else {
              consecutiveFailures += 1;
              if (consecutiveFailures >= GRAPH_BACKFILL_CIRCUIT_BREAKER_THRESHOLD) {
                console.error(
                  `[graphEnrich] CIRCUIT BREAKER: ${consecutiveFailures} consecutive enrichment failures. ` +
                  `Aborting backfill run early (processed=${processed}, succeeded=${succeeded}). ` +
                  `Next cron invocation will retry.`
                );
                circuitBroken = true;
                done = false;
                break;
              }
            }
          }

          if (succeeded >= target || circuitBroken) {
            break;
          }

          if (page.isDone || !page.continueCursor) {
            break;
          }

          cursor = page.continueCursor;
        }
      }
    }

    // After backfill batch, refresh stats cache for each user so telemetry stays current
    for (const userId of userIds) {
      try {
        await ctx.runAction(internal.crystal.evalStats.refreshStatsCache, { userId });
      } catch {
        // Non-fatal — stats cache will be recomputed on next page load
      }
    }

    return { processed, succeeded, done };
  },
});
