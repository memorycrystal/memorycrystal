import { agentPoolValidator, agentLayerRefillEnabled } from "./recallEngine/agentLayer";
import { enforceAccountRateLimit } from "./accountRateLimit";
import { logError } from "./crypto";
import { stableUserId } from "./auth";
import type { UserTier } from "../../shared/tierLimits";
import { v } from "convex/values";
import { action, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { type Id } from "../_generated/dataModel";
import {
  isCostBreakerEnabled,
  mergeCostBudgetResults,
  resolveTieredVectorReachPolicy,
  type CostBudgetResult,
} from "./recallBudgetPolicy";
import { normalizeActionRecallArgs } from "./recallEngine/normalize";
import { runRecallEngine } from "./recallEngine/run";
import { dispatchCreditMutation } from "./recallEngine/budgets";
import type { RecallCostDebit, RecallDegradation, RecallPorts } from "./recallEngine/types";
import { runScoreRecallCandidateQuery } from "./memoryVectors";
import { collectFilteredMemoryTextHits, hydrateRecallMemories, MEMORY_TEXT_PAGE_SIZE, queryCrossSessionMemoryIds } from "./recallEngine/memoryPolicy";

/** Title and recallText reads stay at 50 unless a caller is not this query. */
export const MEMORY_TEXT_AUXILIARY_CAP = 50;

export { projectMemoryWithoutEmbedding } from "./projectMemoryWithoutEmbedding";
export { RECALL_MODE_PRESETS } from "./recallEngine/presets";
export { normalizeTagList, resolveDefaultLimit } from "./recallEngine/limits";

export const hydrateArchivedVectorHits = internalQuery({
  args: {
    sideIds: v.array(v.id("crystalMemoryEmbeddings")),
    scores: v.array(v.number()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const hits: Array<{ memoryId: Id<"crystalMemories">; score: number }> = [];
    for (let index = 0; index < args.sideIds.length; index += 1) {
      const side = await ctx.db.get(args.sideIds[index]);
      if (!side || side.userId !== args.userId) continue;
      const memory = await ctx.db.get(side.memoryId);
      if (!memory || memory.userId !== args.userId || memory.knowledgeBaseId !== undefined) continue;
      hits.push({ memoryId: memory._id, score: args.scores[index] ?? 0 });
    }
    return hits;
  },
});

type DebitReceipt = {
  dayKey: string;
  applied: { user: { vectorBytes: number; textBytes: number }; global: { vectorBytes: number; textBytes: number } };
  crossedEmergency: { user: { vector: boolean; text: boolean }; global: { vector: boolean; text: boolean } };
};

async function debitRecallSearchCostWithReceipt(
  ctx: any,
  args: RecallCostDebit & { userId: string },
): Promise<{ budget: CostBudgetResult | null; receipt: DebitReceipt | null }> {
  if (!isCostBreakerEnabled()) return { budget: null, receipt: null };
  try {
    const result = await ctx.runMutation(internal.crystal.costBreaker.debitUserAndGlobal, {
      userId: args.userId,
      surface: args.surface,
      estimatedVectorQueryBytes: args.estimatedVectorQueryBytes,
      estimatedTextQueryBytes: args.estimatedTextQueryBytes,
      estimatedEmbeddingCalls: args.estimatedEmbeddingCalls,
      reason: args.reason,
    });
    return {
      budget: mergeCostBudgetResults(result.user, result.global),
      receipt: {
        dayKey: result.dayKey,
        applied: result.applied,
        crossedEmergency: result.crossedEmergency,
      },
    };
  } catch (error) {
    console.warn("[costBreaker] recall search debit failed open", await logError(error, args.userId));
    return { budget: null, receipt: null };
  }
}

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
  // ILL-104 — provenance & staleness surfaced inside the recall payload.
  createdAt?: number;
  source?: string;
  age?: string; // compact label, e.g. "14d"
  stale?: boolean; // older than the store's staleness threshold
  contradicted?: boolean; // older side of an unresolved `contradicts` edge
  superseded?: boolean; // has a supersededByMemoryId (belt-and-suspenders)
  supersededByMemoryId?: string;
};



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
  agentPool: v.optional(agentPoolValidator),
  // When explicitly false, recall runs read-only: it still ranks and returns
  // memories but does NOT record access (no accessCount/lastAccessedAt bump and
  // no ILL-103 reinforcement). Defaults to true so every real caller is
  // unchanged; used by the eval harness so a measurement run has no side
  // effects that would bleed across cases.
  recordAccess: v.optional(v.boolean()),
  mode: v.optional(
    v.union(
      v.literal("general"),
      v.literal("decision"),
      v.literal("project"),
      v.literal("people"),
      v.literal("workflow"),
      v.literal("conversation"),
      v.literal("preflight"),
    )
  ),
});

type RecallSet = {
  memories: RecallResult[];
  injectionBlock: string;
  // Additive (ILL-305): the engine absorbs lane failures and reports them here.
  degraded: boolean;
  degradation?: RecallDegradation;
};

const normalizeOptionalString = (value?: string) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const buildInjectionBlock = (memories: RecallResult[]) => {
  if (memories.length === 0) {
    return "## 🧠 Memory Crystal Memory Recall\nNo matching memories found.";
  }

  const lines = memories.map((memory) => {
    const relation = memory.relation ? ` (${memory.relation})` : "";
    // ILL-104 — compact provenance line. Age + source always; warning tokens
    // (stale / contradicted / superseded) only when applicable, to stay
    // token-efficient and avoid noise on healthy memories.
    const warnings = [
      memory.stale ? "⚠ stale" : "",
      memory.contradicted ? "⚠ contradicted" : "",
      memory.superseded ? "⚠ superseded" : "",
    ].filter(Boolean).join(" ");
    const provenance = `Age: ${memory.age ?? "unknown"} | Source: ${memory.source ?? "unknown"}${warnings ? ` | ${warnings}` : ""}`;
    return [
      `### ${memory.store.toUpperCase()}: ${memory.title}${relation}`,
      memory.content,
      `Tags: ${memory.tags.join(", ") || "none"} | Strength: ${(memory.strength ?? 0).toFixed(2)} | Confidence: ${(memory.confidence ?? 0).toFixed(2)} | Score: ${(memory.scoreValue ?? 0).toFixed(2)}`,
      provenance,
      "",
    ].join("\n");
  });

  return ["## 🧠 Memory Crystal Memory Recall", ...lines].join("\n");
};

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
    const contentLimit = Math.min(args.limit ?? 20, 200);
    const auxiliaryLimit = Math.min(contentLimit, MEMORY_TEXT_AUXILIARY_CAP);
    // KB scoping happens at the search index (knowledgeBaseId is a
    // filterField), so no over-fetch + post-filter is needed. Keep auxiliary
    // title/recallText reads at 50, while content can return a bounded 200 IDs:
    // exact-text and inference variants otherwise crowd the canonical source
    // row out before the shared compositor can dedupe them.
    const kbId = args.knowledgeBaseId
      ? (args.knowledgeBaseId as Id<"knowledgeBases">)
      : undefined;
    const [contentResults, recallTextResults, titleResults] = await Promise.all([
      ctx.db
        .query("crystalMemories")
        .withSearchIndex("search_content", (q) => {
          const scoped = q.search("content", args.query).eq("userId", args.userId).eq("archived", false);
          return scoped.eq("knowledgeBaseId", kbId);
        })
        .take(contentLimit),
      ctx.db
        .query("crystalMemories")
        .withSearchIndex("search_recall_text", (q) => {
          const scoped = q.search("recallText", args.query).eq("userId", args.userId).eq("archived", false);
          return scoped.eq("knowledgeBaseId", kbId);
        })
        .take(auxiliaryLimit)
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
          return scoped.eq("knowledgeBaseId", kbId);
        })
        .take(auxiliaryLimit),
    ]);
    const scopedContentResults = contentResults;
    const scopedRecallTextResults = recallTextResults;
    const scopedTitleResults = titleResults;

    // Dedupe by _id and attach a lexical relevance hint.
    // Title hits are stronger than content hits because they often correspond
    // to exact names, IDs, or labels users expect to recall verbatim.
    const seen = new Set<string>();
    const results: Array<{ _id: string }> = [];

    for (const doc of scopedTitleResults) {
      if (!seen.has(doc._id as string)) {
        seen.add(doc._id as string);
        results.push({ _id: doc._id as string });
      }
    }
    for (const doc of scopedContentResults) {
      if (!seen.has(doc._id as string)) {
        seen.add(doc._id as string);
        results.push({ _id: doc._id as string });
      }
    }
    for (const doc of scopedRecallTextResults) {
      if (!seen.has(doc._id as string)) {
        seen.add(doc._id as string);
        results.push({ _id: doc._id as string });
      }
    }

    return results;
  },
});

/**
 * One search index, one paginate, ids only. With RECALL_FILTER_REFILL on, the recall action loops this to
 * 256 hits per index only when the checks applied to the first window before
 * ranking (visibility, project, store, category and tag filters, the
 * cross-session filter, the identifier-conflict exclusion and rows without
 * usable content) removed more than half of its unique ids.
 */
export const searchMemoryTextIndexPage = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
    index: v.union(v.literal("content"), v.literal("title"), v.literal("recallText")),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    knowledgeBaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const pageSize = Math.min(MEMORY_TEXT_PAGE_SIZE, Math.max(1, Math.trunc(args.pageSize ?? MEMORY_TEXT_PAGE_SIZE)));
    const kbId = args.knowledgeBaseId
      ? (args.knowledgeBaseId as Id<"knowledgeBases">)
      : undefined;
    const indexName = args.index === "title"
      ? "search_title"
      : args.index === "recallText"
        ? "search_recall_text"
        : "search_content";
    const field = args.index === "title" ? "title" : args.index === "recallText" ? "recallText" : "content";
    try {
      const page = await ctx.db
        .query("crystalMemories")
        .withSearchIndex(indexName, (q) => {
          const scoped = q.search(field, args.query).eq("userId", args.userId).eq("archived", false);
          return scoped.eq("knowledgeBaseId", kbId);
        })
        .paginate({ numItems: pageSize, cursor: args.cursor ?? null });
      return {
        ids: page.page.map((doc) => String(doc._id)),
        continueCursor: page.continueCursor,
        isDone: page.isDone,
      };
    } catch (error) {
      if (args.index === "recallText" && String((error as { message?: string })?.message ?? error).includes("split")) {
        return { ids: [] as string[], continueCursor: "", isDone: true };
      }
      throw error;
    }
  },
});

function toRecallResult(memory: any): RecallResult {
  const scoreValue = Number(memory?.score ?? 0);
  const vectorScore = Number(memory?.vectorScore ?? memory?._score);
  const result: RecallResult = {
    memoryId: String(memory?._id ?? memory?.memoryId ?? ""),
    store: String(memory?.store ?? ""),
    category: String(memory?.category ?? ""),
    title: String(memory?.title ?? ""),
    content: String(memory?.content ?? ""),
    // Stored strength, carried as memoryStrength. `strength` on engine rows is
    // the composition's ranking input and can be a first-pass score.
    strength: Number(memory?.memoryStrength ?? memory?.strength ?? 0),
    confidence: Number(memory?.confidence ?? 0),
    tags: Array.isArray(memory?.tags) ? memory.tags.map(String) : [],
    scoreValue,
  };
  if (Number.isFinite(vectorScore)) result._score = vectorScore;
  if (typeof memory?.createdAt === "number") result.createdAt = memory.createdAt;
  if (typeof memory?.source === "string") result.source = memory.source;
  if (typeof memory?.age === "string") result.age = memory.age;
  if (typeof memory?.stale === "boolean") result.stale = memory.stale;
  if (typeof memory?.contradicted === "boolean") result.contradicted = memory.contradicted;
  if (typeof memory?.superseded === "boolean") result.superseded = memory.superseded;
  if (typeof memory?.supersededByMemoryId === "string") result.supersededByMemoryId = memory.supersededByMemoryId;
  return result;
}

function buildRecallMemoriesPorts(ctx: any, userId: string): RecallPorts {
  const recallReceipts = new Map<string, any>();
  return {
    userId,
    benchmarkRecall: false,
    embed: async () => {
      throw new Error("recallMemories uses a caller-supplied embedding");
    },
    getTier: () => Promise.resolve("pro" as UserTier),
    // resolveIdentity:false and includeMessages:false keep ordinary action
    // recalls from resolving identity/searching messages. People mode still
    // resolves the display name and bounded person titles for name preferences.
    getAgentRecallPolicy: (args) => ctx.runQuery(internal.crystal.agentRecallPolicies.getAgentRecallPolicy, args),
    getIdentity: () => ctx.runQuery(internal.crystal.mcp.getAccountIdentity, { userId }),
    getPersonMemoryCandidates: (args: { userId: string; limit: number }) =>
      ctx.runQuery(internal.crystal.mcp.listPersonMemoryCandidatesForRecallInternal, args),
    debit: async (args) => {
      const { budget, receipt } = await debitRecallSearchCostWithReceipt(ctx, { userId, ...args });
      if (receipt) recallReceipts.set(args.surface, receipt);
      return budget;
    },
    creditLane: (args) => {
      const r = recallReceipts.get(args.surface);
      if (!r || (!args.vectorBytes && !args.textBytes)) return Promise.resolve();
      return dispatchCreditMutation(ctx, internal.crystal.costBreaker.creditUnexecuted, {
        userId,
        surface: args.surface,
        receipt: r,
        user: { vectorBytes: args.vectorBytes, textBytes: args.textBytes },
        global: { vectorBytes: args.vectorBytes, textBytes: args.textBytes },
        reason: `recall.recallMemories.credit.${args.surface}`,
      }, isCostBreakerEnabled());
    },
    textSearch: (args) => args.recallFilters
      ? collectFilteredMemoryTextHits(
          (ref, query) => ctx.runQuery(ref, query),
          internal.crystal.recall.searchMemoryTextIndexPage,
          { userId: args.userId, query: args.query, limit: args.limit, ...(args.agentLayer ? { agentLayerRefill: agentLayerRefillEnabled(args.agentLayer) } : {}) },
        )
      : ctx.runQuery(internal.crystal.recall.searchMemoriesByText, {
          userId: args.userId,
          query: args.query,
          limit: args.limit,
        }),
    recent: (args) =>
      ctx.runQuery(internal.crystal.mcp.listRecentMemories, {
        userId: args.userId,
        limit: args.limit,
        channel: args.channel,
        sessionKey: args.sessionKey,
        scopeToSession: args.scopeToSession,
        excludeKnowledgeBase: true,
        recallVisibility: true,
        ...(args.agentLayer ? { agentLayer: args.agentLayer } : {}),
        ...(args.requestProjectId ? { requestProjectId: args.requestProjectId } : {}),
        ...(args.repoSlug ? { repoSlug: args.repoSlug } : {}),
        ...(args.recencyIntent ? { recencyIntent: true } : {}),
      }),
    scoreRecallCandidates: (args) => runScoreRecallCandidateQuery(ctx, args),
    hydrate: (args) => hydrateRecallMemories(
      (ref, query) => ctx.runQuery(ref, query),
      internal.crystal.mcp.getMemoriesByIds,
      args.memoryIds,
    ),
    crossSessionIds: (args) => queryCrossSessionMemoryIds(
      (ref, query) => ctx.runQuery(ref, query),
      internal.crystal.recall.getCrossSessionMemoryIds,
      { userId, memoryIds: args.memoryIds, sessionKey: args.sessionKey },
    ),
    listKnowledgeBases: async () => [],
    vectorSearch: (args) =>
      ctx.runAction(internal.crystal.mcp.semanticSearch, {
        userId: args.userId,
        queryEmbedding: args.queryEmbedding,
        query: args.query,
        limit: args.limit,
        channel: args.channel,
        sessionKey: args.sessionKey,
        scopeToSession: args.scopeToSession,
        vectorDepth: args.vectorDepth,
        ...(args.allowFilterRefill === false ? { allowFilterRefill: false } : {}),
        ...(args.includeArchived ? { includeArchived: true } : {}),
        ...(args.candidateDepth !== undefined ? { candidateDepth: args.candidateDepth } : {}),
        ...(args.agentLayer ? { agentLayer: args.agentLayer } : {}),
        ...(args.requestProjectId ? { requestProjectId: args.requestProjectId } : {}),
        ...(args.repoSlug ? { repoSlug: args.repoSlug } : {}),
        includeMemoryStrength: true,
      }),
    searchAssets: async () => [],
    queryKnowledgeBase: async () => ({ memories: [] }),
    searchMessages: async () => [],
    shapeMessages: (messages) => messages,
    includeEmbeddings: () => false,
    bookkeep: async (memoryIds) => {
      const bookkeepingArgs = { memoryIds: memoryIds as any };
      if (process.env.VITEST) {
        await ctx.runMutation(internal.crystal.memories.updateMemoryAccessBatchInternal, bookkeepingArgs);
      } else {
        await ctx.scheduler.runAfter(0, internal.crystal.memories.updateMemoryAccessBatchInternal, bookkeepingArgs);
      }
    },
    resolveReach: (args) => resolveTieredVectorReachPolicy(args),
  };
}

export const recallMemories = action({
  args: requestSchema,
  handler: async (ctx, args) => {
    // ILL-305: this action ranks through the shared engine, as mcpRecall does.
    // The pre-engine action's extras are gone:
    // - per-mode preset ranking weights (presets now pick stores, categories and limit only);
    // - the current-intent freshness boost (hasCurrentIntent stays in recallRanking.ts for R3);
    // - the diversityFilter pass;
    // - the procedural low-observation penalty (helper deleted);
    // - the RECALL_SCORE_FLOOR cut and its contradiction-fade clamp (the fade set was always empty);
    // - the temporal date-window candidate lane (searchMemoriesByDateRange and
    //   temporalParser.ts deleted). Its rows had no vector or BM25 score, so the
    //   ILL-245 relevance floor dropped them unless their text matched the query.
    // normalizeActionRecallArgs and these ports keep the earlier debits, filters,
    // visibility and returned strength (no KB rows, no message lane, no identity
    // lookup; filtered calls keep the deeper vector pool).
    // Engine candidate generation and composition are shared with mcpRecall on
    // purpose, so the two entrypoints return the same results (AC3): the engine's
    // unfiltered vector depth (12-16 hits for limit 1-4, where the old action
    // fetched 20), its recent lane (up to 200 docs, which adds tag-only and
    // recent candidates) and its dedupe (same normalized content, or same title
    // plus a 160-char content prefix) now apply to this action too.
    void args.includeAssociations;
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    await enforceAccountRateLimit(ctx, userId);
    const outcome = await runRecallEngine(normalizeActionRecallArgs(args), buildRecallMemoriesPorts(ctx, userId));
    const memories = ((outcome.body.memories as any[]) ?? []).map(toRecallResult);
    const degradation = outcome.body.degradation as RecallDegradation | undefined;
    const result: RecallSet = {
      memories,
      injectionBlock: buildInjectionBlock(memories),
      degraded: outcome.body.degraded === true,
    };
    if (degradation) result.degradation = degradation;
    return result;
  },
});
