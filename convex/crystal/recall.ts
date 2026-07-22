import { stableUserId } from "./auth";
import { v } from "convex/values";
import { action, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { type Id } from "../_generated/dataModel";
import { resolveFeatureFlag } from "./adminSettings/resolvers";
import { defaultRecallRankingWeights, diversityFilter, rankRecallCandidates } from "./recallRanking";
import {
  isKnowledgeBaseVisibleToAgent,
  isKnowledgeBaseChunkVisibleInChannel,
  isNonKnowledgeBaseMemoryVisibleInChannel,
  resolveDirectKnowledgeBaseQueryContext,
  resolveKnowledgeBaseAgentPriority,
} from "./knowledgeBases";
import { parseTemporalReference } from "./temporalParser";
import {
  getMemoryEffectiveText,
  isCompactRecallEnabled,
  resolveRecallContent,
} from "./memoryText";
import {
  isCostBreakerEnabled,
  mergeCostBudgetResults,
  resolveTieredVectorReachPolicy,
  type CostBudgetResult,
} from "./recallBudgetPolicy";
import type { UserTier } from "../../shared/tierLimits";

// M8 — Recall projection feature flag resolved at runtime via admin-settings resolver (Site 4).

export { projectMemoryWithoutEmbedding } from "./projectMemoryWithoutEmbedding";
import { projectMemoryWithoutEmbedding } from "./projectMemoryWithoutEmbedding";

const vectorTakeMin = 20;
const vectorTakeMax = 100;
const minLimit = 1;
// Hard ceiling on how many memories a single recall may surface. Stays at 20
// regardless of the env-configurable default below — clients cannot raise it.
const maxLimit = 20;
const ESTIMATED_RECALL_VECTOR_BYTES = 820 * 1024 * 1024;
const ESTIMATED_RECALL_TEXT_BYTES = 60 * 1024 * 1024;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
// Default number of memories surfaced when the caller does not pass an explicit
// limit and the recall mode has no preset. Bumped 10 -> 12 per the fleet-wide
// defaults (operator-validated 12x800 in production; compact recallText offsets
// the token cost). Overridable via MEMORY_CRYSTAL_MAX_MEMORIES (clamped to
// [minLimit, maxLimit]).
const DEFAULT_LIMIT_FALLBACK = 12;
const recencyDecayFactor = 0.1;

/**
 * Resolve the effective default recall limit. Reads MEMORY_CRYSTAL_MAX_MEMORIES
 * when set (a previously-hardcoded value now made configurable per the plan) and
 * clamps it into the allowed window. Invalid / empty values fall back to
 * DEFAULT_LIMIT_FALLBACK so a bad env var can never zero out or over-inflate recall.
 */
// Exported so the /api/mcp/recall HTTP handler (mcp.ts) shares the same
// fleet-wide default instead of hardcoding its own.
export const resolveDefaultLimit = (): number => {
  const raw = process.env.MEMORY_CRYSTAL_MAX_MEMORIES;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.max(parsed, minLimit), maxLimit);
    }
  }
  return DEFAULT_LIMIT_FALLBACK;
};

// Compact ("telegraphic") recall helpers are shared via ./memoryText so the
// recallMemories action, the /api/mcp/recall HTTP route, and the KB query all
// honor MEMORY_CRYSTAL_COMPACT_RECALL identically (see isCompactRecallEnabled /
// resolveRecallContent imports above).

/**
 * A "config" chunk is a config-header / source-mirror import row (chunkKind ===
 * "config"). Absent chunkKind == real content. These carry low recall value, so
 * the read side drops them — letting operators retire client-side
 * low-value-chunk filters. Only KB-imported rows are ever tagged.
 */
const isConfigChunk = (memory: { chunkKind?: string | null }): boolean =>
  typeof memory.chunkKind === "string" && memory.chunkKind.trim().toLowerCase() === "config";

/**
 * Decide whether a KB-imported candidate is visible in this recall.
 *
 * Uses the SAME context resolution as the direct KB-query path
 * (resolveDirectKnowledgeBaseQueryContext) so base recall and
 * `queryKnowledgeBase` agree on agentId semantics:
 *   - an explicit agentId is authoritative,
 *   - otherwise the channel prefix is derived (with agent aliases, e.g.
 *     support-coach -> coach), and
 *   - a permissive/owned KB whose agentId can't be derived falls back to its own
 *     agentId (so an owner's channel-only recall still returns their KB), while
 *   - strict peer KBs stay hidden without proper agent/peer context.
 * This is what fixes the peer-agent KB-zeroing bug at the recall layer: a
 * channel-only recall no longer silently returns zero KB hits.
 */
const isKnowledgeBaseCandidateVisible = (
  knowledgeBase: any,
  args: { agentId?: string; channel?: string },
  chunkChannel?: string,
): boolean => {
  const { effectiveAgentId, queryChannel } = resolveDirectKnowledgeBaseQueryContext(
    knowledgeBase,
    args,
  );
  // KB-level agent gate AND per-chunk peer isolation (2026-07-02 cross-tenant KB
  // leak). A channel-bearing KB chunk (per-client content) is only visible to
  // its exact peer; channel-less chunks (shared corpora) stay visible.
  return (
    isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, queryChannel ?? "") &&
    isKnowledgeBaseChunkVisibleInChannel(chunkChannel, args.channel)
  );
};
// ILL-79 — resolve the per-agent KB priority for a recall candidate using the
// SAME context resolution as the visibility check above, so priority and
// visibility can never disagree about which agent identity is in effect.
const resolveCandidateKbAgentPriority = (
  knowledgeBase: any,
  args: { agentId?: string; channel?: string },
): number => {
  if (!knowledgeBase) return 1;
  const { effectiveAgentId } = resolveDirectKnowledgeBaseQueryContext(knowledgeBase, args);
  return resolveKnowledgeBaseAgentPriority(knowledgeBase, effectiveAgentId);
};

const LOW_OBSERVATION_PROCEDURAL_SCORE_MULTIPLIER = 0.5;
const MIN_OBSERVATIONS_FOR_UNPENALIZED_PROCEDURAL_RECALL = 3;

type RecallMode = "general" | "decision" | "project" | "people" | "workflow" | "conversation";

async function debitRecallSearchCost(
  ctx: any,
  args: {
    userId: string;
    estimatedVectorQueryBytes?: number;
    estimatedTextQueryBytes?: number;
    estimatedEmbeddingCalls?: number;
    reason: string;
  },
): Promise<CostBudgetResult | null> {
  if (!isCostBreakerEnabled()) return null;
  try {
    const [userBudget, globalBudget] = await Promise.all([
      ctx.runMutation((internal as any).crystal.costBreaker.debitAndCheck, {
        scope: "user",
        scopeId: args.userId,
        surface: "recall",
        estimatedVectorQueryBytes: args.estimatedVectorQueryBytes,
        estimatedTextQueryBytes: args.estimatedTextQueryBytes,
        estimatedEmbeddingCalls: args.estimatedEmbeddingCalls,
        reason: args.reason,
      }),
      ctx.runMutation((internal as any).crystal.costBreaker.debitAndCheck, {
        scope: "global",
        scopeId: "global",
        surface: "recall",
        estimatedVectorQueryBytes: args.estimatedVectorQueryBytes,
        estimatedTextQueryBytes: args.estimatedTextQueryBytes,
        estimatedEmbeddingCalls: args.estimatedEmbeddingCalls,
        reason: args.reason,
      }),
    ]);
    return mergeCostBudgetResults(userBudget, globalBudget);
  } catch (error) {
    console.warn("[costBreaker] recall search debit failed open", error);
    return null;
  }
}

export const RECALL_MODE_PRESETS: Record<
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
    knowledgeBaseWeight: 0.26,
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
    knowledgeBaseWeight: 0.26,
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
    knowledgeBaseWeight: 0.26,
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
    knowledgeBaseWeight: 0.26,
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
    knowledgeBaseWeight: 0.18,
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
  summary?: string;
  recallText?: string;
  rawContentWipedAt?: number;
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
  sourceMessageIds?: Array<Id<"crystalMessages"> | string>;
  tags: string[];
  archived: boolean;
  knowledgeBaseId?: string;
  // Chunk provenance tag. "content" (or absent) == real memory content;
  // "config" == config-header / source-mirror import chunk that the read side
  // drops from recall so operators can retire client-side config filtering.
  chunkKind?: string;
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
  sessionKey: v.optional(v.string()),
  // Opt-in only. When true (and a sessionKey is supplied), recall drops
  // memories provably from a different session. Existing callers that send a
  // sessionKey but omit this flag are unaffected — sessionKey alone never
  // filters. See getCrossSessionMemoryIds for the "provably foreign" rule.
  scopeToSession: v.optional(v.boolean()),
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

export const normalizeTagList = (tags: string[]) =>
  tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);

const normalizeOptionalString = (value?: string) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

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
    // Verify ownership on BOTH sides of the link: the link row itself and the
    // referenced node. The previous version re-fetched `link.memoryId`, which was
    // the same key we queried by — a tautology that caught no cross-tenant drift.
    const allLinks = links.flat();
    const verifiedLinks = await Promise.all(
      allLinks.map(async (link) => {
        if ((link as any).userId !== args.userId) return null;
        const node = await ctx.db.get(link.nodeId as any);
        if (!node || (node as any).userId !== args.userId) return null;
        return link;
      })
    );
    return verifiedLinks.filter((l): l is NonNullable<typeof l> => l !== null);
  },
});

/**
 * Returns the subset of `memoryIds` that are *provably* from a different
 * session than `sessionKey`. A memory is "provably foreign" only when it has
 * source messages that still resolve AND none of the resolvable ones belong to
 * `sessionKey`. Memories with no source provenance (KB, manual, imported) and
 * memories whose source messages have all expired (STM TTL) are NEVER returned
 * here, so session scoping drops only genuine cross-session bleed and can never
 * silently empty recall of session-agnostic or aged memories.
 */
export const getCrossSessionMemoryIds = internalQuery({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.string()),
    sessionKey: v.string(),
  },
  handler: async (ctx, args) => {
    const sessionKey = normalizeOptionalString(args.sessionKey);
    if (!sessionKey) return [];

    const crossSessionMemoryIds: string[] = [];
    for (const memoryId of Array.from(new Set(args.memoryIds))) {
      const memory = await ctx.db.get(memoryId as Id<"crystalMemories">);
      if (!memory || memory.userId !== args.userId) continue;

      const sourceMessageIds = memory.sourceMessageIds ?? [];
      if (sourceMessageIds.length === 0) continue; // no provenance -> keep

      let resolvedAny = false;
      let inSession = false;
      for (const messageId of sourceMessageIds) {
        const message = await ctx.db.get(messageId);
        if (!message || message.userId !== args.userId) continue;
        resolvedAny = true;
        if (message.sessionKey === sessionKey) {
          inSession = true;
          break;
        }
      }

      // Provably foreign only when at least one source message resolved and
      // none matched the session. All-expired -> can't prove -> keep.
      if (resolvedAny && !inSession) {
        crossSessionMemoryIds.push(String(memory._id));
      }
    }

    return crossSessionMemoryIds;
  },
});

export const searchMemoriesByText = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    // Optional KB scope: when set, BM25 candidates are constrained to one KB.
    // Without this, KB-focused queries (runKnowledgeBaseQuery) pull user-wide
    // text matches that compete for the candidate pool with legitimate KB hits.
    knowledgeBaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 50);
    // KB scoping happens at the search index (knowledgeBaseId is a
    // filterField), so no over-fetch + post-filter is needed. The old 4×
    // over-fetch read up to 300 full docs per call — each dragging a ~24 KB
    // inline embedding — and threw most of them away (2026-07-07 cost audit).
    const kbId = args.knowledgeBaseId
      ? (args.knowledgeBaseId as Id<"knowledgeBases">)
      : undefined;
    const [contentResults, recallTextResults, titleResults] = await Promise.all([
      ctx.db
        .query("crystalMemories")
        .withSearchIndex("search_content", (q) => {
          const scoped = q.search("content", args.query).eq("userId", args.userId).eq("archived", false);
          return kbId ? scoped.eq("knowledgeBaseId", kbId) : scoped;
        })
        .take(limit),
      ctx.db
        .query("crystalMemories")
        .withSearchIndex("search_recall_text", (q) => {
          const scoped = q.search("recallText", args.query).eq("userId", args.userId).eq("archived", false);
          return kbId ? scoped.eq("knowledgeBaseId", kbId) : scoped;
        })
        .take(limit)
        .catch((error) => {
          // convex-test currently throws when optional search fields are missing
          // on fixture rows. Production Convex indexes optional fields safely.
          if (String(error?.message ?? error).includes("split")) return [];
          throw error;
        }),
      ctx.db
        .query("crystalMemories")
        .withSearchIndex("search_title", (q) => {
          const scoped = q.search("title", args.query).eq("userId", args.userId).eq("archived", false);
          return kbId ? scoped.eq("knowledgeBaseId", kbId) : scoped;
        })
        .take(limit),
    ]);
    const scopedContentResults = contentResults;
    const scopedRecallTextResults = recallTextResults;
    const scopedTitleResults = titleResults;

    // Dedupe by _id and attach a lexical relevance hint.
    // Title hits are stronger than content hits because they often correspond
    // to exact names, IDs, or labels users expect to recall verbatim.
    const seen = new Set<string>();
    const results: Array<{ _id: string; bm25Boost: number }> = [];

    for (const doc of scopedTitleResults) {
      if (!seen.has(doc._id as string)) {
        seen.add(doc._id as string);
        results.push({ _id: doc._id as string, bm25Boost: 1.0 });
      }
    }
    for (const doc of scopedContentResults) {
      if (!seen.has(doc._id as string)) {
        seen.add(doc._id as string);
        results.push({ _id: doc._id as string, bm25Boost: 0.75 });
      }
    }
    for (const doc of scopedRecallTextResults) {
      if (!seen.has(doc._id as string)) {
        seen.add(doc._id as string);
        results.push({ _id: doc._id as string, bm25Boost: 0.85 });
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

    const requestedLimit = Math.floor(args.limit ?? preset.limit ?? resolveDefaultLimit());
    const normalizedLimit = Math.min(Math.max(requestedLimit, minLimit), maxLimit);
    const compactRecallEnabled = isCompactRecallEnabled();
    const vectorTake = Math.min(Math.max(normalizedLimit * 4, vectorTakeMin), vectorTakeMax);

    // Task 1: Default includeAssociations to true
    const includeAssociations = args.includeAssociations ?? true;
    const includeArchived = args.includeArchived ?? false;
    const requestedTags = args.tags?.length ? normalizeTagList(args.tags) : undefined;
    const sessionKey = normalizeOptionalString(args.sessionKey);
    // Session scoping is strictly opt-in: only filter when the caller asks.
    const scopeToSession = args.scopeToSession === true && Boolean(sessionKey);

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const userTier = await ctx.runQuery(
      (internal as any).crystal.userProfiles.getUserTier,
      { userId },
    ) as UserTier;
    // M0 — instrument invocation count for cost-reduction baseline
    ctx.runMutation((internal as any).crystal.observability.functionCallMetrics.recordCall, {
      name: "recallMemories",
      userId,
    }).catch(() => null);

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
    // Prefer an explicit agentId. Only when none is supplied do we derive one
    // from the channel prefix (deriveAgentIdFromChannel). We remember which path
    // KB visibility is resolved per-candidate via isKnowledgeBaseCandidateVisible
    // (see helper above), which prefers this explicit agentId and otherwise
    // derives one from the channel. Only the explicit value is threaded here so
    // the derivation stays inside the shared resolver — the channel never
    // hard-filters KB content.
    const explicitAgentId =
      typeof args.agentId === "string" && args.agentId.trim().length > 0
        ? args.agentId.trim()
        : undefined;

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

    const [recallBudget, textBudget] = await Promise.all([
      debitRecallSearchCost(ctx, {
        userId,
        estimatedVectorQueryBytes: ESTIMATED_RECALL_VECTOR_BYTES,
        estimatedEmbeddingCalls: 1,
        reason: "recall.recallMemories.vector",
      }),
      textQuery.trim().length > 0
        ? debitRecallSearchCost(ctx, {
            userId,
            estimatedTextQueryBytes: ESTIMATED_RECALL_TEXT_BYTES * 3,
            reason: "recall.recallMemories.text",
          })
        : Promise.resolve(null),
    ]);
    const reachPolicy = resolveTieredVectorReachPolicy({
      tier: userTier,
      normalVectorDepth: vectorTake,
      vectorBudget: recallBudget,
      textBudget,
      indexedFallbackAllowedOnDegradation: true,
    });

    // Run vector search, BM25 text search, and prospective trace matching in parallel
    const [vectorResults, textSearchResults, traceMatches] = await Promise.all([
      !reachPolicy.vectorAllowed
        ? Promise.resolve([] as Array<{ _id: string; _score: number }>)
        : ctx.vectorSearch("crystalMemories", "by_embedding", {
            vector: args.embedding,
            limit: reachPolicy.vectorDepth,
            filter: (q: any) => q.eq("userId", userId),
          }) as Promise<Array<{ _id: string; _score: number }>>,
      textQuery.trim().length > 0 && reachPolicy.textAllowed
        ? ctx.runQuery(internal.crystal.recall.searchMemoriesByText, {
            userId,
            query: textQuery,
            limit: vectorTake,
          }) as Promise<Array<{ _id: string; bm25Boost: number }>>
        : Promise.resolve([] as Array<{ _id: string; bm25Boost: number }>),
      // Prospective trace matching — v2 uses vector search (never let errors break recall).
      // Phase 1 instrumentation: matchProspectiveTraces now returns { traces, stats }
      // so the recall log can attribute hit-rate drop-offs at each pipeline stage.
      textQuery.trim().length > 0 && reachPolicy.budgetLevel === "normal"
        ? ctx.runAction(internal.crystal.organic.traces.matchProspectiveTraces, {
            userId,
            query: textQuery,
          }).catch(() => ({
            traces: [] as Array<any>,
            stats: { matchedRaw: 0, aboveThreshold: 0, topScore: 0, activeTracesForUser: 0 },
          }))
        : Promise.resolve({
            traces: [] as Array<any>,
            stats: { matchedRaw: 0, aboveThreshold: 0, topScore: 0, activeTracesForUser: 0 },
          }),
    ]);
    const traceMatchesArray: Array<any> = traceMatches.traces;
    const traceMatchStats = traceMatches.stats;

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
    const hydratedCandidatesRaw = candidateIds.length > 0
      ? await ctx.runQuery(internal.crystal.mcp.getMemoriesByIds, { memoryIds: candidateIds as any, omitEmbedding: true })
      : [] as Array<Record<string, any>>;
    // M8 — When MC_RECALL_PROJECT_EMBEDDING_AWAY=true, strip the `embedding` field
    // from hydrated candidates to reduce in-process memory pressure post-cutover.
    // The vector search path (ctx.vectorSearch) is unaffected — it returns IDs only.
    // Site 4: resolve via admin-settings resolver instead of module-top constant.
    const projectEmbeddingAway = await resolveFeatureFlag(ctx, "embeddingProjectAway", "MC_RECALL_PROJECT_EMBEDDING_AWAY", false);
    const hydratedCandidates = projectEmbeddingAway
      ? hydratedCandidatesRaw.map(projectMemoryWithoutEmbedding)
      : hydratedCandidatesRaw as Array<Record<string, any>>;
    const hydratedCandidatesById = new Map(
      (hydratedCandidates as Array<Record<string, any>>).map((candidate: Record<string, any>) => [String(candidate._id), candidate] as const)
    );
    const rawResults = candidateIds
      .map((memoryId) => {
        const doc = hydratedCandidatesById.get(memoryId);
        if (!doc || doc.userId !== userId) return null; // defense-in-depth: verify ownership after vector lookup
        return { ...doc, _id: memoryId, _score: vectorScoreMap.get(memoryId) ?? 0 };
      })
      .filter((d) => d !== null) as Array<RecallCandidateDocument & { _id: string; _score: number; userId: string }>;
    const rawResultsById = new Map(
      rawResults.map((candidate) => [candidate._id, candidate] as const)
    );
    const crossSessionMemoryIds = scopeToSession && rawResults.length > 0
      ? new Set(
          await ctx.runQuery(internal.crystal.recall.getCrossSessionMemoryIds, {
            userId,
            memoryIds: rawResults.map((candidate) => candidate._id),
            sessionKey: sessionKey as string,
          }) as string[]
        )
      : null;
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

    // KB visibility is resolved per-candidate below via
    // isKnowledgeBaseCandidateVisible (which mirrors the direct-query context
    // resolver), so no flat channel-derived agentId fallback is needed here.

    // M5 — Lazy-enrich-on-recall debounce. Memories that previously hit the
    // strength-floor skip get one chance to be enriched here: schedule at most
    // ONE enrichMemoryGraph for the highest-accessCount candidate, and queue
    // the rest in crystalEnrichmentBacklog for the hourly cron to drain.
    // Fire-and-forget — recall must never wait on enrichment scheduling.
    const skippedByFloor = rawResults.filter(
      (candidate) => (candidate as any).enrichmentSkippedReason === "below_strength_floor"
    );
    if (skippedByFloor.length > 0) {
      const sortedSkipped = [...skippedByFloor].sort(
        (a, b) => ((b as any).accessCount ?? 0) - ((a as any).accessCount ?? 0)
      );
      const [primary, ...overflow] = sortedSkipped;
      try {
        await ctx.scheduler.runAfter(0, internal.crystal.graphEnrich.enrichMemoryGraph, {
          memoryId: primary._id as Id<"crystalMemories">,
          userId: primary.userId,
        });
      } catch { /* fire-and-forget */ }
      for (const overflowed of overflow) {
        ctx
          .runMutation(internal.crystal.enrichmentBacklog.enqueueBacklog, {
            memoryId: overflowed._id as Id<"crystalMemories">,
            userId: overflowed.userId,
            reason: "below_strength_floor",
          })
          .catch(() => null);
      }
    }

    const now = Date.now();

    const rankedFiltered = rankRecallCandidates(
      rawResults
        .filter((candidate) => {
          if (!getMemoryEffectiveText(candidate)) {
            return false;
          }

          if (!includeArchived && candidate.archived) {
            return false;
          }

          if (candidate.knowledgeBaseId) {
            const knowledgeBase = knowledgeBasesById.get(candidate.knowledgeBaseId);
            if (!knowledgeBase || !isKnowledgeBaseCandidateVisible(knowledgeBase, { agentId: explicitAgentId, channel: args.channel }, candidate.channel)) {
              return false;
            }
            // Drop config-header / source-mirror KB chunks from recall so
            // operators can retire client-side low-value-chunk filtering.
            if (isConfigChunk(candidate)) {
              return false;
            }
          } else if (!isNonKnowledgeBaseMemoryVisibleInChannel(candidate.channel, args.channel)) {
            return false;
          }

          if (crossSessionMemoryIds && crossSessionMemoryIds.has(candidate._id)) {
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
          content: resolveRecallContent(candidate, compactRecallEnabled),
          // Dedup on the untouched full content, not the compacted recallText
          // injected into `content`, so distinct memories with colliding
          // telegraphic recallText but different content are not deduped.
          dedupeText: candidate.content,
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
          knowledgeBaseName: candidate.knowledgeBaseId
            ? knowledgeBasesById.get(candidate.knowledgeBaseId)?.name
            : undefined,
          // ILL-79 — per-agent KB priority, resolved against the SAME effective
          // agentId the visibility gate used for this candidate's KB.
          kbAgentPriority: candidate.knowledgeBaseId
            ? resolveCandidateKbAgentPriority(
                knowledgeBasesById.get(candidate.knowledgeBaseId),
                { agentId: explicitAgentId, channel: args.channel },
              )
            : undefined,
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

    // Graph boost applied BEFORE the diversity filter + slice. Previously this
    // boost was applied AFTER slicing, so a well-connected memory sitting outside
    // the top-N window could never promote in — the re-sort only rearranged the
    // already-capped set. Threading it here lets the boost actually move memories
    // across the cut line when they carry a high-confidence knowledge-graph link.
    if (rankedFiltered.length > 0) {
      const candidateIds = rankedFiltered.map((r) => r.memoryId);
      const nodeLinks: Array<{ memoryId: string; linkConfidence: number }> = await ctx
        .runQuery(internal.crystal.recall.getNodesForMemories, {
          userId,
          memoryIds: candidateIds,
        })
        .catch(() => [] as Array<{ memoryId: string; linkConfidence: number }>);
      if (nodeLinks.length > 0) {
        const boostedIds = new Set<string>();
        for (const link of nodeLinks) {
          if (link.linkConfidence > 0.7) boostedIds.add(String(link.memoryId));
        }
        if (boostedIds.size > 0) {
          // Copy-on-write: the `map` chain above returns original objects when
          // penaltyMultiplier === 1, so we must not mutate in place or we'd
          // corrupt the upstream candidate set held by rawResultsById.
          for (let i = 0; i < rankedFiltered.length; i++) {
            const result = rankedFiltered[i];
            if (boostedIds.has(result.memoryId)) {
              rankedFiltered[i] = { ...result, scoreValue: result.scoreValue + 0.05 };
            }
          }
          rankedFiltered.sort(
            (a, b) => b.scoreValue - a.scoreValue || b.rankingSignals.textMatchScore - a.rankingSignals.textMatchScore,
          );
        }
      }
    }

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
    if (traceMatchesArray.length > 0) {
      try {
        const traceResults: RecallResult[] = traceMatchesArray.map((trace: any) => ({
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

        // Merge traces with the normal result set. Apply the same score threshold
        // the rest of the pipeline uses (0.25) so a low-confidence trace cannot
        // evict a legitimately-ranked vector hit, and score-sort the merged set so
        // the top-N slice reflects real relevance rather than trace prepend order.
        const qualifiedTraces = traceResults.filter((t) => t.scoreValue >= 0.25);
        const traceIds = new Set(qualifiedTraces.map((t) => t.memoryId));
        const nonDupeNormal = finalMemories.filter((m) => !traceIds.has(m.memoryId));
        const merged = [...qualifiedTraces, ...nonDupeNormal];
        merged.sort((a, b) => b.scoreValue - a.scoreValue);
        finalMemories = merged.slice(0, normalizedLimit);

        // Only validate traces that actually made it into the final result set.
        // Otherwise low-limit recalls can silently consume traces the user never saw.
        const surfacedTraceIds = new Set(
          finalMemories
            .filter((memory) => (memory as any)._source === "prospective" || memory.store === "prospective")
            .map((memory) => memory.memoryId)
        );
        for (const trace of traceMatchesArray) {
          if (!surfacedTraceIds.has(String(trace._id))) continue;
          ctx.runMutation(internal.crystal.organic.traces.markValidated, {
            traceId: trace._id,
          }).catch(() => {});
        }
      } catch (_) { /* never let trace errors propagate */ }
    }

    // Task 3: Graph boost was moved upstream (applied to `rankedFiltered` before
    // the diversity filter + slice) so well-connected memories can actually promote
    // from outside the top-N window. The old post-slice boost here was a no-op
    // because it could only reshuffle within an already-capped set.

    if (!includeAssociations || ranked.length === 0) {
      const injectionBlock = buildInjectionBlock(finalMemories);

      const nonProspectiveMemories = dedupeById(finalMemories.filter(
        (m) => (m as any)._source !== "prospective" && m.store !== "prospective"
      ));

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
        // Derive traceHit AND traceId from the actual surfaced results, not the raw
        // pre-filter matches. Previously `traceMatches[0]` was logged regardless of
        // whether it made the cut — corrupting the organic learning signal whenever
        // the score threshold or slice dropped it.
        const surfacedTrace = finalMemories.find(
          (m) => (m as any)._source === "prospective" || m.store === "prospective"
        );
        const traceHit = surfacedTrace !== undefined;
        const tracesSurvivedMerge = finalMemories.filter(
          (m) => (m as any)._source === "prospective" || m.store === "prospective"
        ).length;
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
          traceId: surfacedTrace ? (surfacedTrace.memoryId as any) : undefined,
          source: "api",
          sessionKey,
          tracesMatchedRaw: traceMatchStats.matchedRaw,
          tracesAboveThreshold: traceMatchStats.aboveThreshold,
          topTraceVectorScore: traceMatchStats.topScore,
          tracesSurvivedMerge,
          activeTracesForUser: traceMatchStats.activeTracesForUser,
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
    // Batch-hydrate associated memories so expansion does not issue one lookup per edge.
    const associationCandidateIds = Array.from(new Set(
      allAssocCandidatesNested.flatMap((assocCandidates, index) =>
        assocCandidates
          .map((assoc) => finalMemories[index].memoryId === assoc.sourceId ? assoc.targetId : assoc.sourceId)
          .filter((candidateId): candidateId is string => Boolean(candidateId))
      )
    ));
    const associatedDocs = associationCandidateIds.length > 0
      ? await ctx.runQuery(internal.crystal.mcp.getMemoriesByIds, { memoryIds: associationCandidateIds as any, omitEmbedding: true })
      : [] as Array<Record<string, any>>;
    const associatedDocsById = new Map(
      (associatedDocs as Array<Record<string, any>>).map((candidate: Record<string, any>) => [String(candidate._id), candidate] as const)
    );
    const associatedCrossSessionMemoryIds = scopeToSession && associatedDocs.length > 0
      ? new Set(
          await ctx.runQuery(internal.crystal.recall.getCrossSessionMemoryIds, {
            userId,
            memoryIds: associatedDocs.map((candidate: Record<string, any>) => String(candidate._id)),
            sessionKey: sessionKey as string,
          }) as string[]
        )
      : null;

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

        const linked = associatedDocsById.get(candidateId);
        if (!linked || linked.userId !== userId || (!includeArchived && linked.archived)) {
          continue;
        }
        if (linked.knowledgeBaseId) {
          const knowledgeBase = knowledgeBasesById.get(String(linked.knowledgeBaseId));
          if (!knowledgeBase || !isKnowledgeBaseCandidateVisible(knowledgeBase, { agentId: explicitAgentId, channel: args.channel }, linked.channel)) {
            continue;
          }
          if (isConfigChunk(linked)) {
            continue;
          }
        } else if (!isNonKnowledgeBaseMemoryVisibleInChannel(linked.channel, args.channel)) {
          continue;
        }
        if (associatedCrossSessionMemoryIds && associatedCrossSessionMemoryIds.has(candidateId)) {
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
          content: resolveRecallContent(candidate, compactRecallEnabled),
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

    const nonProspectiveForAccess = dedupeById(memories.filter(
      (m) => (m as any)._source !== "prospective" && m.store !== "prospective"
    ));

    for (const memory of nonProspectiveForAccess) {
      await ctx
        .runMutation(internal.crystal.memories.updateMemoryAccessInternal, { memoryId: memory.memoryId as any })
        .catch(() => {});
    }

    try {
      const loggableMemoryIds = nonProspectiveForAccess.map((m) => m.memoryId) as Array<any>;
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
      // Derive traceHit AND traceId from the surfaced result set — not the raw
      // pre-filter `traceMatches` — so the organic log records the trace the user
      // actually saw instead of whichever match happened to sit at index 0.
      const surfacedTrace = memories.find(
        (m) => (m as any)._source === "prospective" || m.store === "prospective"
      );
      const traceHit = surfacedTrace !== undefined;
      const tracesSurvivedMerge = memories.filter(
        (m) => (m as any)._source === "prospective" || m.store === "prospective"
      ).length;
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
        traceId: surfacedTrace ? (surfacedTrace.memoryId as any) : undefined,
        source: "api",
        sessionKey,
        tracesMatchedRaw: traceMatchStats.matchedRaw,
        tracesAboveThreshold: traceMatchStats.aboveThreshold,
        topTraceVectorScore: traceMatchStats.topScore,
        tracesSurvivedMerge,
        activeTracesForUser: traceMatchStats.activeTracesForUser,
      });
    } catch (_) { /* fire-and-forget */ }

    return {
      memories,
      injectionBlock: buildInjectionBlock(memories),
    } as RecallSet;
  },
});
