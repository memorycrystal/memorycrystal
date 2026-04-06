import { stableUserId } from "./auth";
import { v } from "convex/values";
import { action, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { defaultRecallRankingWeights, diversityFilter, rankRecallCandidates } from "./recallRanking";
import {
  isKnowledgeBaseVisibleToAgent,
  isNonKnowledgeBaseMemoryVisibleInChannel,
  resolveKnowledgeBaseAgentId,
} from "./knowledgeBases";
import { parseTemporalReference } from "./temporalParser";

const vectorTakeMin = 20;
const vectorTakeMax = 100;
const minLimit = 1;
const maxLimit = 20;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const defaultLimit = 8;
const recencyDecayFactor = 0.1;
const LOW_OBSERVATION_PROCEDURAL_SCORE_MULTIPLIER = 0.5;
const MIN_OBSERVATIONS_FOR_UNPENALIZED_PROCEDURAL_RECALL = 3;

type RecallMode = "general" | "decision" | "project" | "people" | "workflow" | "conversation";

const RECALL_MODE_PRESETS: Record<
  RecallMode,
  {
    stores?: string[];
    categories?: string[];
    limit?: number;
    strengthWeight?: number;
    freshnessWeight?: number;
    vectorWeight?: number;
    salienceWeight?: number;
    continuityWeight?: number;
    textMatchWeight?: number;
    knowledgeBaseWeight?: number;
  }
> = {
  general: {}, // defaults, no overrides
  decision: {
    stores: ["semantic", "episodic"],
    categories: ["decision", "lesson", "rule"],
    limit: 12,
    strengthWeight: 0.34,
    freshnessWeight: 0.12,
    vectorWeight: 0.33,
    salienceWeight: 0.16,
    textMatchWeight: 0.14,
    knowledgeBaseWeight: 0.08,
  },
  project: {
    stores: ["semantic", "episodic", "procedural"],
    categories: ["goal", "workflow", "skill", "decision", "fact"],
    limit: 12,
    strengthWeight: 0.26,
    freshnessWeight: 0.24,
    vectorWeight: 0.26,
    salienceWeight: 0.14,
    continuityWeight: 0.1,
    textMatchWeight: 0.14,
    knowledgeBaseWeight: 0.08,
  },
  people: {
    stores: ["semantic", "episodic"],
    categories: ["person", "decision", "event"],
    limit: 8,
    strengthWeight: 0.32,
    freshnessWeight: 0.1,
    vectorWeight: 0.36,
    salienceWeight: 0.14,
    textMatchWeight: 0.16,
    knowledgeBaseWeight: 0.08,
  },
  workflow: {
    stores: ["procedural", "semantic"],
    categories: ["workflow", "skill", "rule", "lesson"],
    limit: 10,
    strengthWeight: 0.22,
    freshnessWeight: 0.18,
    vectorWeight: 0.34,
    salienceWeight: 0.14,
    textMatchWeight: 0.2,
    knowledgeBaseWeight: 0.08,
  },
  conversation: {
    stores: ["sensory", "episodic"],
    categories: ["conversation", "event"],
    limit: 6,
    strengthWeight: 0.18,
    freshnessWeight: 0.28,
    vectorWeight: 0.26,
    salienceWeight: 0.1,
    continuityWeight: 0.12,
    textMatchWeight: 0.16,
    knowledgeBaseWeight: 0.04,
  },
};

const memoryStore = v.union(
  v.literal("sensory"),
  v.literal("episodic"),
  v.literal("semantic"),
  v.literal("procedural"),
  v.literal("prospective")
);

const memoryCategory = v.union(
  v.literal("decision"),
  v.literal("lesson"),
  v.literal("person"),
  v.literal("rule"),
  v.literal("event"),
  v.literal("fact"),
  v.literal("goal"),
  v.literal("skill"),
  v.literal("workflow"),
  v.literal("conversation")
);

type RecallCandidateDocument = {
  _id: string;
  store: string;
  category: string;
  title: string;
  content: string;
  metadata?: string;
  strength: number;
  confidence: number;
  arousal: number;
  valence: number;
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  salienceScore?: number;
  channel?: string;
  tags: string[];
  archived: boolean;
  knowledgeBaseId?: string;
};

type RecallResult = {
  _score?: number;
  memoryId: string;
  store: string;
  category: string;
  title: string;
  content: string;
  strength: number;
  confidence: number;
  tags: string[];
  scoreValue: number;
  relation?: string;
};

type RecallLogCandidateSignal = {
  memoryId: string;
  strength: number;
  confidence: number;
  accessCount: number;
  lastAccessedAt?: number;
  createdAt: number;
  salienceScore?: number;
  vectorScore?: number;
  textMatchScore?: number;
};

const buildCandidateSignals = (
  ranked: Array<{ memoryId: string }>,
  candidatesById: Map<string, RecallCandidateDocument & { _score?: number }>,
  textMatchScores: Map<string, number>
): RecallLogCandidateSignal[] =>
  ranked.slice(0, 30).flatMap((result) => {
    const candidate = candidatesById.get(result.memoryId);
    if (!candidate) {
      return [];
    }
    return [{
      memoryId: result.memoryId,
      strength: candidate.strength ?? 0,
      confidence: candidate.confidence ?? 0,
      accessCount: candidate.accessCount ?? 0,
      lastAccessedAt: candidate.lastAccessedAt,
      createdAt: candidate.createdAt,
      salienceScore: candidate.salienceScore,
      vectorScore: candidate._score ?? 0,
      textMatchScore: textMatchScores.get(result.memoryId) ?? 0,
    }];
  });

const requestSchema = v.object({
  embedding: v.array(v.float64()),
  query: v.optional(v.string()),
  stores: v.optional(v.array(memoryStore)),
  categories: v.optional(v.array(memoryCategory)),
  tags: v.optional(v.array(v.string())),
  limit: v.optional(v.number()),
  includeAssociations: v.optional(v.boolean()),
  includeArchived: v.optional(v.boolean()),
  recentMemoryIds: v.optional(v.array(v.string())),
  channel: v.optional(v.string()),
  agentId: v.optional(v.string()),
  mode: v.optional(
    v.union(
      v.literal("general"),
      v.literal("decision"),
      v.literal("project"),
      v.literal("people"),
      v.literal("workflow"),
      v.literal("conversation"),
    )
  ),
});

type RecallSet = {
  memories: RecallResult[];
  injectionBlock: string;
};

const clamp01 = (value: number): number => {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
};

const normalizeId = (value: string | { id: string }) => (typeof value === "string" ? value : value.id);

const recencyScore = (ageDays: number) => clamp01(Math.exp(-recencyDecayFactor * ageDays));

const normalizeTagList = (tags: string[]) =>
  tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);

const dedupeById = (items: RecallResult[]) => {
  const seen = new Set<string>();
  const out: RecallResult[] = [];

  for (const item of items) {
    if (seen.has(item.memoryId)) {
      continue;
    }
    seen.add(item.memoryId);
    out.push(item);
  }

  return out;
};

const getProceduralObservationCount = (metadata?: string): number | null => {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { observationCount?: unknown };
    return typeof parsed.observationCount === "number" ? parsed.observationCount : null;
  } catch {
    return null;
  }
};

export const getProceduralRecallPenaltyMultiplier = (candidate: {
  store: string;
  category: string;
  metadata?: string;
}): number => {
  if (candidate.store !== "procedural" || candidate.category !== "workflow") {
    return 1;
  }
  const observationCount = getProceduralObservationCount(candidate.metadata);
  if (observationCount === null || observationCount >= MIN_OBSERVATIONS_FOR_UNPENALIZED_PROCEDURAL_RECALL) {
    return 1;
  }
  return LOW_OBSERVATION_PROCEDURAL_SCORE_MULTIPLIER;
};

/**
 * `ctx` is the Convex action context. This file uses action-only helpers
 * like `runQuery`, and the SDK typing does not expose complete context shapes
 * for these helpers in this file, so `any` is an intentional choice.
 */
const buildAssociationCandidates = async (ctx: any, userId: string, memoryId: string, limit: number) => {
  // In an Action context, ctx.db is not available — use ctx.runQuery to call a query function.
  // Fall back gracefully if associations aren't populated.
  const outgoing: any[] = await ctx.runQuery(
    internal.crystal.associations.listByFrom,
    { userId, fromMemoryId: memoryId }
  ).catch(() => []);

  const incoming: any[] = await ctx.runQuery(
    internal.crystal.associations.listByTo,
    { userId, toMemoryId: memoryId }
  ).catch(() => []);

  return [...outgoing, ...incoming]
    .map((association: { _id: string; relationshipType: string; weight: number; fromMemoryId: string | { id: string }; toMemoryId: string | { id: string } }) => ({
      _id: association._id,
      relationshipType: association.relationshipType,
      weight: association.weight,
      sourceId: normalizeId(association.fromMemoryId),
      targetId: normalizeId(association.toMemoryId),
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
};

const buildInjectionBlock = (memories: RecallResult[]) => {
  if (memories.length === 0) {
    return "## 🧠 Memory Crystal Memory Recall\nNo matching memories found.";
  }

  const lines = memories.map((memory) => {
    const relation = memory.relation ? ` (${memory.relation})` : "";
    return [
      `### ${memory.store.toUpperCase()}: ${memory.title}${relation}`,
      memory.content,
      `Tags: ${memory.tags.join(", ") || "none"} | Strength: ${(memory.strength ?? 0).toFixed(2)} | Confidence: ${(memory.confidence ?? 0).toFixed(2)} | Score: ${(memory.scoreValue ?? 0).toFixed(2)}`,
      "",
    ].join("\n");
  });

  return ["## 🧠 Memory Crystal Memory Recall", ...lines].join("\n");
};

/**
 * Look up crystalMemoryNodeLinks for a set of memory IDs.
 * Used by the recallMemories action to apply a knowledge-graph boost.
 */
export const getNodesForMemories = internalQuery({
  args: { userId: v.string(), memoryIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    // Look up crystalMemoryNodeLinks for each memoryId
    const links = await Promise.all(
      args.memoryIds.map((id) =>
        ctx.db
          .query("crystalMemoryNodeLinks")
          .withIndex("by_memory", (q) => q.eq("memoryId", id as any))
          .collect()
      )
    );
    // Verify each link's source memory belongs to this user (belt-and-suspenders ownership check)
    const allLinks = links.flat();
    const verifiedLinks = await Promise.all(
      allLinks.map(async (link) => {
        const mem = await ctx.db.get(link.memoryId as any);
        return mem && (mem as any).userId === args.userId ? link : null;
      })
    );
    return verifiedLinks.filter((l): l is NonNullable<typeof l> => l !== null);
  },
});

export const searchMemoriesByText = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 50);
    const [contentResults, titleResults] = await Promise.all([
      ctx.db
        .query("crystalMemories")
        .withSearchIndex("search_content", (q) =>
          q.search("content", args.query).eq("userId", args.userId).eq("archived", false)
        )
        .take(limit),
      ctx.db
        .query("crystalMemories")
        .withSearchIndex("search_title", (q) =>
          q.search("title", args.query).eq("userId", args.userId).eq("archived", false)
        )
        .take(limit),
    ]);

    // Dedupe by _id and attach a lexical relevance hint.
    // Title hits are stronger than content hits because they often correspond
    // to exact names, IDs, or labels users expect to recall verbatim.
    const seen = new Set<string>();
    const results: Array<{ _id: string; bm25Boost: number }> = [];

    for (const doc of titleResults) {
      if (!seen.has(doc._id as string)) {
        seen.add(doc._id as string);
        results.push({ _id: doc._id as string, bm25Boost: 1.0 });
      }
    }
    for (const doc of contentResults) {
      if (!seen.has(doc._id as string)) {
        seen.add(doc._id as string);
        results.push({ _id: doc._id as string, bm25Boost: 0.75 });
      }
    }

    return results;
  },
});

export const searchMemoriesByDateRange = internalQuery({
  args: {
    userId: v.string(),
    startMs: v.number(),
    endMs: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 30, 50);

    // Date strings rarely embed well, so this indexed fallback lets temporal
    // queries pull memories from the requested window before ranking merges
    // them with semantic and lexical candidates.
    const results = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) =>
        q.eq("userId", args.userId).gte("createdAt", args.startMs).lte("createdAt", args.endMs)
      )
      .filter((q) => q.eq(q.field("archived"), false))
      .take(limit);

    return results.map((result) => ({ _id: String(result._id) }));
  },
});

export const recallMemories = action({
  args: requestSchema,
  handler: async (ctx, args) => {
    const preset = RECALL_MODE_PRESETS[args.mode ?? "general"];

    const resolvedStores = args.stores?.length ? args.stores : preset.stores;
    const resolvedCategories = args.categories?.length ? args.categories : preset.categories;

    const requestedLimit = Math.floor(args.limit ?? preset.limit ?? defaultLimit);
    const normalizedLimit = Math.min(Math.max(requestedLimit, minLimit), maxLimit);
    const vectorTake = Math.min(Math.max(normalizedLimit * 4, vectorTakeMin), vectorTakeMax);

    // Task 1: Default includeAssociations to true
    const includeAssociations = args.includeAssociations ?? true;
    const includeArchived = args.includeArchived ?? false;
    const requestedTags = args.tags?.length ? normalizeTagList(args.tags) : undefined;

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const activePolicyWeights = await ctx.runQuery(
      ((internal as any).crystal.organic.policyTuner.getActivePolicyWeights),
      { userId }
    ).catch((err: unknown) => {
      console.error("[recall] policy weights fallback:", err);
      return defaultRecallRankingWeights;
    });
    const scoringWeights = {
      ...defaultRecallRankingWeights,
      ...activePolicyWeights,
      strengthWeight: preset.strengthWeight ?? activePolicyWeights.strengthWeight,
      freshnessWeight: preset.freshnessWeight ?? activePolicyWeights.freshnessWeight,
      vectorWeight: preset.vectorWeight ?? activePolicyWeights.vectorWeight,
      accessWeight: activePolicyWeights.accessWeight ?? defaultRecallRankingWeights.accessWeight,
      salienceWeight: preset.salienceWeight ?? activePolicyWeights.salienceWeight,
      continuityWeight: preset.continuityWeight ?? activePolicyWeights.continuityWeight,
      textMatchWeight: preset.textMatchWeight ?? activePolicyWeights.textMatchWeight,
      knowledgeBaseWeight: preset.knowledgeBaseWeight ?? activePolicyWeights.knowledgeBaseWeight ?? defaultRecallRankingWeights.knowledgeBaseWeight,
    };
    const effectiveAgentId = resolveKnowledgeBaseAgentId(args.agentId, args.channel);

    // Derive text query for BM25 hybrid search.
    // Passed as `query` from the plugin/mcp-server alongside the embedding.
    const textQuery: string = args.query ?? "";

    // Fix 4: Check warm cache for pre-fetched memory IDs
    let warmCacheIds: string[] = [];
    try {
      const cached = await ctx.runQuery(internal.crystal.organic.tick.getWarmCache, { userId });
      if (cached && cached.length > 0) {
        warmCacheIds = cached;
      }
    } catch { /* warm cache is optional */ }

    // Run vector search, BM25 text search, and prospective trace matching in parallel
    const [vectorResults, textSearchResults, traceMatches] = await Promise.all([
      ctx.vectorSearch("crystalMemories", "by_embedding", {
        vector: args.embedding,
        limit: vectorTake,
        filter: (q: any) => q.eq("userId", userId),
      }) as Promise<Array<{ _id: string; _score: number }>>,
      textQuery.trim().length > 0
        ? ctx.runQuery(internal.crystal.recall.searchMemoriesByText, {
            userId,
            query: textQuery,
            limit: vectorTake,
          }) as Promise<Array<{ _id: string; bm25Boost: number }>>
        : Promise.resolve([] as Array<{ _id: string; bm25Boost: number }>),
      // Prospective trace matching — v2 uses vector search (never let errors break recall)
      textQuery.trim().length > 0
        ? ctx.runAction(internal.crystal.organic.traces.matchProspectiveTraces, {
            userId,
            query: textQuery,
          }).catch(() => [] as Array<any>)
        : Promise.resolve([] as Array<any>),
    ]);

    const temporalRange = textQuery.trim().length > 0 ? parseTemporalReference(textQuery, Date.now()) : null;
    let temporalCandidateIds: string[] = [];
    if (temporalRange) {
      const temporalResults = await ctx.runQuery(
        internal.crystal.recall.searchMemoriesByDateRange,
        {
          userId,
          startMs: temporalRange.startMs,
          endMs: temporalRange.endMs,
          limit: vectorTake,
        }
      ) as Array<{ _id: string }>;
      temporalCandidateIds = temporalResults.map((result: { _id: string }) => String(result._id));
    }

    // Build lexical relevance map keyed by memory _id
    const bm25BoostMap = new Map<string, number>();
    for (const entry of textSearchResults as Array<{ _id: string; bm25Boost: number }>) {
      bm25BoostMap.set(entry._id, entry.bm25Boost);
    }

    const vectorScoreMap = new Map<string, number>();
    for (const result of vectorResults) {
      vectorScoreMap.set(String(result._id), result._score ?? 0);
    }

    const candidateIds = Array.from(
      new Set<string>([
        ...vectorResults.map((result: { _id: string; _score: number }) => String(result._id)),
        ...textSearchResults.map((entry: { _id: string; bm25Boost: number }) => String(entry._id)),
        ...warmCacheIds,
        ...temporalCandidateIds,
      ])
    );

    // Fetch full documents for both semantic and lexical candidates.
    const rawResults = (
      await Promise.all(
        candidateIds.map(async (memoryId) => {
          const doc = await ctx.runQuery(internal.crystal.memories.getMemoryInternal, { memoryId: memoryId as any });
          if (!doc || doc.userId !== userId) return null; // defense-in-depth: verify ownership after vector lookup
          return { ...doc, _id: memoryId, _score: vectorScoreMap.get(memoryId) ?? 0 };
        })
      )
    ).filter((d) => d !== null) as Array<RecallCandidateDocument & { _id: string; _score: number; userId: string }>;
    const rawResultsById = new Map(
      rawResults.map((candidate) => [candidate._id, candidate] as const)
    );
    const knowledgeBaseIds = Array.from(
      new Set(
        rawResults
          .map((candidate) => candidate.knowledgeBaseId)
          .filter((knowledgeBaseId): knowledgeBaseId is string => typeof knowledgeBaseId === "string")
      )
    );
    const knowledgeBasesById = new Map(
      (
        await Promise.all(
          knowledgeBaseIds.map(async (knowledgeBaseId) => {
            const knowledgeBase = await ctx.runQuery(internal.crystal.knowledgeBases.getKnowledgeBaseByIdInternal, {
              knowledgeBaseId: knowledgeBaseId as any,
            });
            return knowledgeBase ? [String(knowledgeBase._id), knowledgeBase] as const : null;
          })
        )
      ).filter((entry): entry is readonly [string, any] => entry !== null)
    );

    const now = Date.now();

    const rankedFiltered = rankRecallCandidates(
      rawResults
        .filter((candidate) => {
          if (!includeArchived && candidate.archived) {
            return false;
          }

          if (candidate.knowledgeBaseId) {
            const knowledgeBase = knowledgeBasesById.get(candidate.knowledgeBaseId);
            if (!knowledgeBase || !isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, args.channel)) {
              return false;
            }
          } else if (!isNonKnowledgeBaseMemoryVisibleInChannel(candidate.channel, args.channel)) {
            return false;
          }

          if (resolvedStores?.length) {
            const hasStore = resolvedStores.some((store) => store === candidate.store);
            if (!hasStore) {
              return false;
            }
          }

          if (resolvedCategories?.length) {
            const hasCategory = resolvedCategories.some((category) => category === candidate.category);
            if (!hasCategory) {
              return false;
            }
          }

          if (requestedTags?.length) {
            const lowerTags = normalizeTagList(candidate.tags);
            const hasAllTags = requestedTags.every((tag) => lowerTags.includes(tag));
            if (!hasAllTags) {
              return false;
            }
          }

          return true;
        })
        .map((candidate) => ({
          memoryId: candidate._id,
          store: candidate.store,
          category: candidate.category,
          title: candidate.title,
          content: candidate.content,
          metadata: candidate.metadata,
          strength: candidate.strength,
          confidence: candidate.confidence,
          tags: candidate.tags,
          accessCount: candidate.accessCount,
          lastAccessedAt: candidate.lastAccessedAt,
          createdAt: candidate.createdAt,
          salienceScore: candidate.salienceScore,
          channel: candidate.channel,
          vectorScore: candidate._score,
          textMatchScore: bm25BoostMap.get(candidate._id) ?? 0,
          knowledgeBaseId: candidate.knowledgeBaseId,
          _score: candidate._score,
        })),
      {
        now,
        query: textQuery,
        channel: args.channel,
        weights: scoringWeights,
      }
    )
      .map((result) => {
        const penaltyMultiplier = getProceduralRecallPenaltyMultiplier(result);
        return penaltyMultiplier === 1
          ? result
          : { ...result, scoreValue: result.scoreValue * penaltyMultiplier };
      })
      .sort((a, b) => b.scoreValue - a.scoreValue || b.rankingSignals.textMatchScore - a.rankingSignals.textMatchScore)
      .filter((result) => result.scoreValue >= 0.25);

    // Near-duplicate recalls crowd out better context, so enforce lexical
    // diversity before we spend the final result budget.
    const ranked = diversityFilter(rankedFiltered, normalizedLimit)
      .slice(0, normalizedLimit)
      .map((result) => ({
        memoryId: result.memoryId,
        store: result.store,
        category: result.category,
        title: result.title,
        content: result.content,
        strength: result.strength,
        confidence: result.confidence,
        tags: result.tags,
        _score: result._score,
        scoreValue: result.scoreValue,
      } as RecallResult));

    // Session deduplication: filter out memories already shown this session
    const recentMemoryIdSet = new Set<string>(args.recentMemoryIds ?? []);
    const sessionFiltered = recentMemoryIdSet.size > 0
      ? ranked.filter((r) => !recentMemoryIdSet.has(r.memoryId))
      : ranked;

    let finalMemories = dedupeById(sessionFiltered);
    const candidateSignals = buildCandidateSignals(ranked, rawResultsById, bm25BoostMap);

    // Prospective trace merge: prepend matching traces, cap at requested limit
    if (traceMatches.length > 0) {
      try {
        const traceResults: RecallResult[] = traceMatches.map((trace: any) => ({
          memoryId: trace._id as string,
          store: "prospective" as string,
          category: trace.traceType as string,
          title: trace.predictedQuery,
          content: trace.predictedContext,
          strength: trace.confidence,
          confidence: trace.confidence,
          tags: [] as string[],
          scoreValue: trace.confidence,
          _source: "prospective" as string,
        }));

        // Prepend traces, then fill remaining slots with normal results
        const traceIds = new Set(traceResults.map((t) => t.memoryId));
        const nonDupeNormal = finalMemories.filter((m) => !traceIds.has(m.memoryId));
        finalMemories = [...traceResults, ...nonDupeNormal].slice(0, normalizedLimit);

        // Only validate traces that actually made it into the final result set.
        // Otherwise low-limit recalls can silently consume traces the user never saw.
        const surfacedTraceIds = new Set(
          finalMemories
            .filter((memory) => (memory as any)._source === "prospective" || memory.store === "prospective")
            .map((memory) => memory.memoryId)
        );
        for (const trace of traceMatches) {
          if (!surfacedTraceIds.has(String(trace._id))) continue;
          ctx.runMutation(internal.crystal.organic.traces.markValidated, {
            traceId: trace._id,
          }).catch(() => {});
        }
      } catch (_) { /* never let trace errors propagate */ }
    }

    // Task 3: Node/Relation Graph Boost
    // Look up crystalMemoryNodeLinks for all final memories and boost scores for
    // well-connected memories (linkConfidence > 0.7).
    const finalMemoryIds = finalMemories.map((m) => m.memoryId);
    if (finalMemoryIds.length > 0) {
      const nodeLinks: Array<{ memoryId: string; linkConfidence: number }> = await ctx
        .runQuery(internal.crystal.recall.getNodesForMemories, {
          userId,
          memoryIds: finalMemoryIds,
        })
        .catch(() => []);

      // Build a set of memoryIds that have at least one high-confidence node link
      const boostedMemoryIds = new Set<string>(
        nodeLinks
          .filter((link) => link.linkConfidence > 0.7)
          .map((link) => link.memoryId)
      );

      if (boostedMemoryIds.size > 0) {
        finalMemories = finalMemories.map((memory) => {
          if (boostedMemoryIds.has(memory.memoryId)) {
            return { ...memory, scoreValue: memory.scoreValue + 0.05 };
          }
          return memory;
        });
        // Re-sort after applying node boost
        finalMemories = finalMemories.sort((a, b) => b.scoreValue - a.scoreValue);
      }
    }

    if (!includeAssociations || ranked.length === 0) {
      const injectionBlock = buildInjectionBlock(finalMemories);

      const nonProspectiveMemories = finalMemories.filter(
        (m) => (m as any)._source !== "prospective" && m.store !== "prospective"
      );

      for (const memory of nonProspectiveMemories) {
        await ctx
          .runMutation(internal.crystal.memories.updateMemoryAccessInternal, { memoryId: memory.memoryId as any })
          .catch(() => {});
      }

      try {
        const loggableMemoryIds = nonProspectiveMemories.map((m) => m.memoryId) as Array<any>;
        if (loggableMemoryIds.length > 0) {
          await ctx.runMutation(internal.crystal.organic.activityLog.logRecallActivity, {
            userId,
            memoryIds: loggableMemoryIds,
            query: args.query?.slice(0, 200),
          });
        }
      } catch (_) { /* fire-and-forget */ }

      // Fix 2: Log recall query to organicRecallLog
      try {
        // Compute traceHit from actual surfaced results, not raw matches
        const traceHit = finalMemories.some(
          (m) => (m as any)._source === "prospective" || m.store === "prospective"
        );
        await ctx.runMutation(internal.crystal.organic.traces.logRecallQuery, {
          userId,
          query: textQuery.slice(0, 500),
          resultCount: finalMemories.length,
          topResultIds: nonProspectiveMemories.slice(0, 5).map((m) => m.memoryId) as any,
          candidateSignals: candidateSignals.map((candidate) => ({
            ...candidate,
            memoryId: candidate.memoryId as any,
          })),
          traceHit,
          traceId: traceHit ? traceMatches[0]._id : undefined,
          source: "api",
        });
      } catch (_) { /* fire-and-forget */ }

      return {
        memories: finalMemories,
        injectionBlock,
      } as RecallSet;
    }

    // Task 2: Batch Association Lookup
    // Collect all final memory IDs and run buildAssociationCandidates concurrently
    // instead of sequentially, reducing round trips.
    const linkedIds = new Set<string>(finalMemories.map((result) => result.memoryId));

    const allAssocCandidatesNested = await Promise.all(
      finalMemories.map((topResult) => buildAssociationCandidates(ctx, userId, topResult.memoryId, 3))
    );

    // Expand associated memories — fetch docs and score them
    const expanded: RecallResult[] = [];

    for (let i = 0; i < finalMemories.length; i++) {
      const topResult = finalMemories[i];
      const assocCandidates = allAssocCandidatesNested[i];

      for (const assoc of assocCandidates) {
        const candidateId = topResult.memoryId === assoc.sourceId ? assoc.targetId : assoc.sourceId;
        if (!candidateId || linkedIds.has(candidateId) || candidateId === topResult.memoryId) {
          continue;
        }

        const linked = await ctx.runQuery(internal.crystal.memories.getMemoryInternal, { memoryId: candidateId as any });
        if (!linked || linked.userId !== userId || (!includeArchived && linked.archived)) {
          continue;
        }
        if (linked.knowledgeBaseId) {
          const knowledgeBase = knowledgeBasesById.get(String(linked.knowledgeBaseId));
          if (!knowledgeBase || !isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, args.channel)) {
            continue;
          }
        } else if (!isNonKnowledgeBaseMemoryVisibleInChannel(linked.channel, args.channel)) {
          continue;
        }

        const candidate = linked as RecallCandidateDocument & { _id: string };
        linkedIds.add(candidateId);

        const ageDays = Math.max(0, (now - (candidate.lastAccessedAt ?? candidate.createdAt)) / millisecondsPerDay);
        const recency = recencyScore(ageDays);
        const accessScore = Math.min((candidate.accessCount ?? 0) / 20, 1);
        const associationWeight = Math.max(0.1, Math.min(assoc.weight, 1));
        const scoreValue = topResult.scoreValue * associationWeight * 0.25 + recency * 0.15 + accessScore * 0.1;

        expanded.push({
          memoryId: candidateId,
          store: candidate.store,
          category: candidate.category,
          title: candidate.title,
          content: candidate.content,
          strength: candidate.strength,
          confidence: candidate.confidence,
          tags: candidate.tags,
          scoreValue,
          relation: `${assoc.relationshipType} (${assoc.weight.toFixed(2)})`,
        });
      }
    }

    const memories = dedupeById([...finalMemories, ...expanded])
      .sort((a, b) => b.scoreValue - a.scoreValue)
      .slice(0, normalizedLimit);

    const nonProspectiveForAccess = finalMemories.filter(
      (m) => (m as any)._source !== "prospective" && m.store !== "prospective"
    );

    for (const memory of nonProspectiveForAccess) {
      await ctx
        .runMutation(internal.crystal.memories.updateMemoryAccessInternal, { memoryId: memory.memoryId as any })
        .catch(() => {});
    }

    try {
      const loggableMemoryIds = memories
        .filter((m) => (m as any)._source !== "prospective" && m.store !== "prospective")
        .map((m) => m.memoryId) as Array<any>;
      if (loggableMemoryIds.length > 0) {
        await ctx.runMutation(internal.crystal.organic.activityLog.logRecallActivity, {
          userId,
          memoryIds: loggableMemoryIds,
          query: args.query?.slice(0, 200),
        });
      }
    } catch (_) { /* fire-and-forget */ }

    // Fix 2: Log recall query to organicRecallLog
    try {
      const nonProspective = memories.filter(
        (m) => (m as any)._source !== "prospective" && m.store !== "prospective"
      );
      // Compute traceHit from actual surfaced results, not raw matches
      const traceHit = memories.some(
        (m) => (m as any)._source === "prospective" || m.store === "prospective"
      );
      await ctx.runMutation(internal.crystal.organic.traces.logRecallQuery, {
        userId,
        query: textQuery.slice(0, 500),
        resultCount: memories.length,
        topResultIds: nonProspective.slice(0, 5).map((m) => m.memoryId) as any,
        candidateSignals: candidateSignals.map((candidate) => ({
          ...candidate,
          memoryId: candidate.memoryId as any,
        })),
        traceHit,
        traceId: traceHit ? traceMatches[0]._id : undefined,
        source: "api",
      });
    } catch (_) { /* fire-and-forget */ }

    return {
      memories,
      injectionBlock: buildInjectionBlock(memories),
    } as RecallSet;
  },
});
