/**
 * Authoritative LTM vector access for v0.9.0.
 *
 * All retained callers use this module so owner/KB checks, dimensions, model,
 * lifecycle cascades, and the physical vector table cannot drift independently.
 */
import type { Doc, Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { isNonKnowledgeBaseMemoryVisibleInChannel } from "./knowledgeBases";
import { deleteMemoryEmbedding, insertMemoryEmbedding, patchMemoryEmbedding } from "./memoryEmbeddingRefs";
import { recallWorkChannelVisibilityEnabled } from "./recallEngine/memoryPolicy";
import { recallHydrationRefsEnabled, uniqueHydrationRef } from "./recallEngine/hydrationRefs";

export const MEMORY_VECTOR_DIMENSIONS = 3072;
export const MEMORY_VECTOR_MODEL = "google/gemini-embedding-2-preview";
/** Default ANN cap. Recall lifts it only for the filter refill. */
export const MEMORY_VECTOR_DEFAULT_CAP = 100;
export const MEMORY_VECTOR_FILTERED_CAP = 256;
/**
 * Legacy crystalMemories rows carry inline embeddings (~50 KiB). 100 documents
 * stay under the 12 MiB transaction-test budget, including a side-row read.
 */
export const MEMORY_VECTOR_READ_BATCH = 100;

export function memoryVectorSearchLimit(limit: number, expandForFilters = false): number {
  if (expandForFilters) {
    const requested = Math.trunc(limit);
    const bounded = Number.isFinite(requested) ? Math.max(requested, 1) : 1;
    return Math.min(bounded, MEMORY_VECTOR_FILTERED_CAP);
  }
  // Default callers stay on the historical 100-hit window.
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

const vectorLimitObservers: Array<(limit: number, expandForFilters: boolean) => void> = [];

/** Test observation for the applied vector cap. No-op when nobody is listening. */
export function observeMemoryVectorLimits(observer: (limit: number, expandForFilters: boolean) => void): () => void {
  vectorLimitObservers.push(observer);
  return () => {
    const index = vectorLimitObservers.indexOf(observer);
    if (index >= 0) vectorLimitObservers.splice(index, 1);
  };
}

// Enable only after the additive conversationUserId backfill is verified.
// Until then, owner-prefiltering preserves existing vectors during rollout.
export function conversationVectorFilter(q: any, userId: string) {
  return process.env.CRYSTAL_SCOPED_VECTORS_READY === "1"
    ? q.eq("conversationUserId", userId)
    : q.eq("userId", userId);
}

/** Separator between the owner and the channel. Neither side contains it. */
const RECALL_SCOPE_SEPARATOR = "\u001f";

/**
 * Side-row value for a memory the request can see by owner and channel.
 * A knowledge-base row has no value: KB visibility is not a channel equality.
 * The empty channel is the global value. An archived row has no value, so a
 * legacy side row loses it on backfill instead of staying in the filter.
 */
export function memoryRecallScope(memory: {
  userId?: string;
  channel?: string;
  knowledgeBaseId?: unknown;
  archived?: boolean;
}): string | undefined {
  if (memory.archived || memory.knowledgeBaseId !== undefined) return undefined;
  const userId = memory.userId?.trim();
  if (!userId || userId.includes(RECALL_SCOPE_SEPARATOR)) return undefined;
  const channel = memory.channel?.trim() ?? "";
  if (channel.includes(RECALL_SCOPE_SEPARATOR)) return undefined;
  return `${userId}${RECALL_SCOPE_SEPARATOR}${channel}`;
}

/**
 * Equality values for the channels `isNonKnowledgeBaseMemoryVisibleInChannel`
 * would keep, or null when that rule cannot be named as a few equalities.
 * Null keeps the owner-only filter. Work-channel visibility, archived reads
 * and an agent layer all see rows this list would drop.
 */
export function recallScopeEqualities(args: {
  userId: string;
  channel?: string;
  includeArchived?: boolean;
  agentLayer?: boolean;
}): string[] | null {
  if (process.env.CRYSTAL_RECALL_SCOPE_VECTORS_READY !== "1") return null;
  if (process.env.CRYSTAL_SCOPED_VECTORS_READY !== "1") return null;
  if (args.includeArchived || args.agentLayer) return null;
  if (recallWorkChannelVisibilityEnabled()) return null;
  const channel = args.channel?.trim() ?? "";
  if (!channel) {
    const global = memoryRecallScope({ userId: args.userId });
    return global ? [global] : null;
  }
  if (channel.includes(RECALL_SCOPE_SEPARATOR)) return null;
  const exact = memoryRecallScope({ userId: args.userId, channel });
  if (!exact) return null;
  const values = [exact];
  const colon = channel.indexOf(":");
  if (colon < 0) return null;
  const suffix = channel.slice(colon + 1);
  if (/(^|:)group(:|$)/i.test(channel) || /^\d+$/.test(suffix)) return values;
  const prefix = channel.slice(0, colon);
  for (const candidate of [prefix, suffix]) {
    if (!candidate || candidate === channel) continue;
    if (!isNonKnowledgeBaseMemoryVisibleInChannel(candidate, channel)) continue;
    const scope = memoryRecallScope({ userId: args.userId, channel: candidate });
    if (scope && !values.includes(scope)) values.push(scope);
  }
  return values;
}

function recallScopeVectorFilter(q: any, userId: string, values: string[] | null) {
  if (!values || values.length === 0) return conversationVectorFilter(q, userId);
  if (values.length === 1) return q.eq("recallScope", values[0]);
  return q.or(...values.map((value) => q.eq("recallScope", value)));
}

export type MemoryVectorHit = {
  sideId: Id<"crystalMemoryEmbeddings">;
  memoryId: Id<"crystalMemories">;
  score: number;
};

type RecallVectorArgs = {
  vector: number[];
  limit: number;
  userId?: string;
  knowledgeBaseId?: Id<"knowledgeBases">;
  excludeKnowledgeBase?: boolean;
  includeArchived?: boolean;
  /** Recall filter refill only. Other callers keep the 100-hit cap. */
  expandForFilters?: boolean;
  /** Channel the request may see. Absent for a knowledge-base search. */
  channel?: string;
  /** An agent layer sees channels an equality list cannot name. */
  agentLayer?: boolean;
  /** Return each hit's memory document, without its embedding, from the same read that checks it. */
  includeMemory?: boolean;
};

type RecallVectorHit = { memoryId: Id<"crystalMemories">; score: number; memory?: Record<string, any> };

/**
 * Recall has no side-row identity until the independently audited cutover.
 * One vector search per call. Callers that search more than one vector must
 * run each call in its own execution to keep billing linear (each search counts
 * the full index size), even if preliminary usage accounting misbehaves, and
 * keep actions short and within time and memory limits.
 * https://linear.app/illumin8/issue/ILL-554
 */
export async function recallMemoryIds(
  ctx: any,
  args: RecallVectorArgs,
): Promise<RecallVectorHit[]> {
  assertMemoryVector(args.vector);
  if (!args.userId && !args.knowledgeBaseId)
    throw new Error(
      "memory vector search requires an owner or knowledge base scope",
    );
  const side = process.env.CRYSTAL_MEMORY_VECTOR_READ_MODE === "side";
  const appliedLimit = args.expandForFilters
    ? memoryVectorSearchLimit(args.limit, true)
    : Math.min(Math.max(Math.trunc(args.limit), 1), 100);
  for (const observer of vectorLimitObservers) observer(appliedLimit, args.expandForFilters === true);
  const raw = await ctx.vectorSearch(
    side ? "crystalMemoryEmbeddings" : "crystalMemories",
    "by_embedding",
    {
      vector: args.vector,
      limit: appliedLimit,
      filter: (q: any) => {
        // Hydration below is the authority for archive and KB exclusion on
        // both representations. A side conversation search may also name the
        // visible channels, once their scope values are backfilled.
        if (args.knowledgeBaseId) return q.eq("knowledgeBaseId", args.knowledgeBaseId);
        if (!(side && args.excludeKnowledgeBase)) return q.eq("userId", args.userId);
        return recallScopeVectorFilter(
          q,
          args.userId!,
          recallScopeEqualities({
            userId: args.userId!,
            channel: args.channel,
            includeArchived: args.includeArchived,
            agentLayer: args.agentLayer,
          }),
        );
      },
    },
  );
  const hits: RecallVectorHit[] = [];
  for (let index = 0; index < raw.length; index += MEMORY_VECTOR_READ_BATCH) {
    const slice = raw.slice(index, index + MEMORY_VECTOR_READ_BATCH);
    const part = await ctx.runQuery(internal.crystal.memoryVectors.hydrateRecallVectorHits, {
      memoryIds: side ? [] : slice.map((hit: any) => hit._id),
      sideIds: side ? slice.map((hit: any) => hit._id) : [],
      scores: slice.map((hit: any) => hit._score),
      userId: args.userId,
      knowledgeBaseId: args.knowledgeBaseId,
      excludeKnowledgeBase: args.excludeKnowledgeBase,
      includeArchived: args.includeArchived,
      ...(args.includeMemory ? { includeMemory: true } : {}),
    });
    hits.push(...part);
  }
  return hits;
}

export const hydrateRecallVectorHits = internalQuery({
  args: {
    memoryIds: v.array(v.id("crystalMemories")),
    sideIds: v.array(v.id("crystalMemoryEmbeddings")),
    scores: v.array(v.number()),
    userId: v.optional(v.string()),
    knowledgeBaseId: v.optional(v.id("knowledgeBases")),
    excludeKnowledgeBase: v.optional(v.boolean()),
    includeArchived: v.optional(v.boolean()),
    includeMemory: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!args.userId && !args.knowledgeBaseId)
      throw new Error("recall hydration requires scope");
    if (args.memoryIds.length && args.sideIds.length)
      throw new Error("mixed recall vector representations");
    const hits: RecallVectorHit[] = [];
    const hit = (memory: Doc<"crystalMemories">, score: number): RecallVectorHit => {
      if (!args.includeMemory) return { memoryId: memory._id, score };
      const { embedding: _embedding, embeddingModel: _model, ...rest } = memory as Doc<"crystalMemories"> & { embeddingModel?: unknown };
      return { memoryId: memory._id, score, memory: rest };
    };
    const ids = args.sideIds.length ? args.sideIds : args.memoryIds;
    const useRefs = recallHydrationRefsEnabled();
    for (let i = 0; i < ids.length; i++) {
      if (useRefs && args.sideIds.length) {
        const ref = await uniqueHydrationRef(ctx, args.sideIds[i]);
        if (ref) {
          const memory = await ctx.db.get(ref.memoryId);
          if (!memory || (!args.includeArchived && memory.archived)) continue;
          if (args.userId && (ref.userId !== args.userId || memory.userId !== args.userId)) continue;
          if (args.excludeKnowledgeBase && memory.knowledgeBaseId !== undefined) continue;
          if (args.knowledgeBaseId &&
              (ref.knowledgeBaseId !== args.knowledgeBaseId || memory.knowledgeBaseId !== args.knowledgeBaseId)) continue;
          hits.push(hit(memory, args.scores[i] ?? 0));
          continue;
        }
      }
      const side = args.sideIds.length
        ? await ctx.db.get(args.sideIds[i])
        : null;
      if (args.sideIds.length && !side) continue;
      const memory = await ctx.db.get(side ? side.memoryId : args.memoryIds[i]);
      if (!memory || (!args.includeArchived && memory.archived)) continue;
      if (
        args.userId &&
        (memory.userId !== args.userId || (side && side.userId !== args.userId))
      )
        continue;
      if (args.excludeKnowledgeBase && memory.knowledgeBaseId !== undefined)
        continue;
      if (
        args.knowledgeBaseId &&
        (memory.knowledgeBaseId !== args.knowledgeBaseId ||
          (side && side.knowledgeBaseId !== args.knowledgeBaseId))
      )
        continue;
      hits.push(hit(memory, args.scores[i] ?? 0));
    }
    return hits;
  },
});

/** Score bounded recency-intent candidates without widening the vector index window. */
export const scoreRecallCandidateVectors = internalQuery({
  args: {
    memoryIds: v.array(v.id("crystalMemories")),
    userId: v.string(),
    queryEmbedding: v.array(v.number()),
  },
  handler: async (ctx, { memoryIds, userId, queryEmbedding }) => {
    assertMemoryVector(queryEmbedding);
    const uniqueIds = Array.from(new Set(memoryIds.map(String)));
    if (uniqueIds.length > 100) {
      throw new Error("recent recall candidate scoring exceeds the platform-safe cap");
    }
    const side = process.env.CRYSTAL_MEMORY_VECTOR_READ_MODE === "side";
    const rows = await Promise.all(uniqueIds.map(async (rawId) => {
      const memoryId = rawId as Id<"crystalMemories">;
      const memory = await ctx.db.get(memoryId);
      if (!memory || memory.userId !== userId || memory.archived) return null;

      let embedding: number[] | undefined = memory.embedding;
      if (side) {
        const sideRow = await ctx.db
          .query("crystalMemoryEmbeddings")
          .withIndex("by_memoryId", (q) => q.eq("memoryId", memoryId))
          .first();
        if (!sideRow || (sideRow.userId && sideRow.userId !== userId)) return null;
        embedding = sideRow.embedding;
      }
      if (!Array.isArray(embedding) || embedding.length !== queryEmbedding.length) return null;

      let dot = 0;
      let queryNorm = 0;
      let embeddingNorm = 0;
      for (let index = 0; index < queryEmbedding.length; index += 1) {
        const left = queryEmbedding[index];
        const right = embedding[index];
        dot += left * right;
        queryNorm += left * left;
        embeddingNorm += right * right;
      }
      if (!queryNorm || !embeddingNorm) return { memoryId: rawId, score: 0 };
      return {
        memoryId: rawId,
        score: Math.max(0, Math.min(1, dot / Math.sqrt(queryNorm * embeddingNorm))),
      };
    }));
    return rows.filter((row): row is { memoryId: string; score: number } => row !== null);
  },
});

/** Call the bounded scoring query from an action adapter without duplicating its argument shaping. */
export function runScoreRecallCandidateQuery(
  ctx: any,
  args: { userId: string; memoryIds: string[]; queryEmbedding: number[] },
): Promise<Array<{ memoryId: string; score: number }>> {
  return ctx.runQuery(internal.crystal.memoryVectors.scoreRecallCandidateVectors, {
    ...args,
    memoryIds: args.memoryIds as any,
  });
}

export function assertMemoryVector(vector: number[]): void {
  if (
    vector.length !== MEMORY_VECTOR_DIMENSIONS ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `memory vector must contain ${MEMORY_VECTOR_DIMENSIONS} finite values`,
    );
  }
}

/**
 * One vector search per call. Callers that search more than one vector must
 * run each call in its own execution to keep billing linear (each search counts
 * the full index size), even if preliminary usage accounting misbehaves, and
 * keep actions short and within time and memory limits.
 * https://linear.app/illumin8/issue/ILL-554
 */
export async function vectorSearchMemoryIds(
  ctx: any,
  args: {
    vector: number[];
    limit: number;
    userId?: string;
    knowledgeBaseId?: Id<"knowledgeBases">;
    excludeKnowledgeBase?: boolean;
    expandForFilters?: boolean;
  },
): Promise<MemoryVectorHit[]> {
  assertMemoryVector(args.vector);
  if (!args.userId && !args.knowledgeBaseId) {
    throw new Error(
      "memory vector search requires an owner or knowledge base scope",
    );
  }
  const limit = memoryVectorSearchLimit(args.limit, args.expandForFilters);
  const filter = args.knowledgeBaseId
    ? (q: any) => q.eq("knowledgeBaseId", args.knowledgeBaseId)
    : args.excludeKnowledgeBase
      ? (q: any) => conversationVectorFilter(q, args.userId!)
      : (q: any) => q.eq("userId", args.userId);
  const raw = await ctx.vectorSearch(
    "crystalMemoryEmbeddings",
    "by_embedding",
    {
      vector: args.vector,
      limit,
      filter,
    },
  );

  const hits: MemoryVectorHit[] = [];
  for (let index = 0; index < raw.length; index += MEMORY_VECTOR_READ_BATCH) {
    const slice = raw.slice(index, index + MEMORY_VECTOR_READ_BATCH);
    const part = await ctx.runQuery(internal.crystal.memoryVectors.hydrateVectorHits, {
      sideIds: slice.map((result: any) => result._id),
      scores: slice.map((result: any) => result._score),
      userId: args.userId,
      knowledgeBaseId: args.knowledgeBaseId,
      excludeKnowledgeBase: args.excludeKnowledgeBase,
    });
    hits.push(...part);
  }
  return hits;
}

export const hydrateVectorHits = internalQuery({
  args: {
    sideIds: v.array(v.id("crystalMemoryEmbeddings")),
    scores: v.array(v.number()),
    userId: v.optional(v.string()),
    knowledgeBaseId: v.optional(v.id("knowledgeBases")),
    excludeKnowledgeBase: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const hits: MemoryVectorHit[] = [];
    const useRefs = recallHydrationRefsEnabled();
    for (let index = 0; index < args.sideIds.length; index += 1) {
      if (useRefs) {
        const ref = await uniqueHydrationRef(ctx, args.sideIds[index]);
        if (ref) {
          const memory = await ctx.db.get(ref.memoryId);
          if (!memory || memory.archived) continue;
          if (args.userId && (ref.userId !== args.userId || memory.userId !== args.userId)) continue;
          if (args.excludeKnowledgeBase && memory.knowledgeBaseId !== undefined) continue;
          if (args.knowledgeBaseId &&
              (ref.knowledgeBaseId !== args.knowledgeBaseId || memory.knowledgeBaseId !== args.knowledgeBaseId)) continue;
          hits.push({ sideId: args.sideIds[index], memoryId: memory._id, score: args.scores[index] ?? 0 });
          continue;
        }
      }
      const side = await ctx.db.get(args.sideIds[index]);
      if (!side) continue;
      const memory = await ctx.db.get(side.memoryId);
      if (!memory || memory.archived) continue;
      // Convex filter fields are an optimization, never the authorization gate.
      if (
        args.userId &&
        (side.userId !== args.userId || memory.userId !== args.userId)
      )
        continue;
      if (args.excludeKnowledgeBase && memory.knowledgeBaseId !== undefined)
        continue;
      if (
        args.knowledgeBaseId &&
        (side.knowledgeBaseId !== args.knowledgeBaseId ||
          memory.knowledgeBaseId !== args.knowledgeBaseId)
      )
        continue;
      hits.push({
        sideId: side._id,
        memoryId: memory._id,
        score: args.scores[index] ?? 0,
      });
    }
    return hits;
  },
});

export async function getMemoryVector(
  ctx: any,
  memoryId: Id<"crystalMemories">,
) {
  const rows = await ctx.db
    .query("crystalMemoryEmbeddings")
    .withIndex("by_memoryId", (q: any) => q.eq("memoryId", memoryId))
    .take(2);
  if (rows.length > 1)
    throw new Error(`duplicate vectors for memory ${String(memoryId)}`);
  return rows[0] ?? null;
}

/** Keep the side row's recall scope equal to the memory after a channel or KB change. */
export async function syncMemoryVectorRecallScope(
  ctx: any,
  memoryId: Id<"crystalMemories">,
): Promise<void> {
  const memory = await ctx.db.get(memoryId);
  const side = await getMemoryVector(ctx, memoryId);
  if (!memory || !side) return;
  const recallScope = memoryRecallScope(memory);
  if (side.recallScope === recallScope) return;
  await patchMemoryEmbedding(ctx, side._id, { recallScope });
}

/** Deploy first; retire only after the final strict parity tripwire. */
export function inlineMemoryVectorsRetired(): boolean {
  return process.env.CRYSTAL_MEMORY_VECTOR_READ_MODE === "side" &&
    process.env.CRYSTAL_MEMORY_INLINE_VECTORS === "retired";
}

export async function upsertMemoryVector(
  ctx: any,
  args: {
    memoryId: Id<"crystalMemories">;
    userId: string;
    knowledgeBaseId?: Id<"knowledgeBases">;
    embedding: number[];
    model?: string;
  },
): Promise<Id<"crystalMemoryEmbeddings">> {
  assertMemoryVector(args.embedding);
  if (args.model !== undefined && args.model !== MEMORY_VECTOR_MODEL) {
    throw new Error(`memory vector model must be ${MEMORY_VECTOR_MODEL}`);
  }
  const memory = await ctx.db.get(args.memoryId);
  if (!memory || memory.userId !== args.userId)
    throw new Error("memory owner mismatch");
  if (memory.archived)
    throw new Error("cannot persist a vector for an archived memory");
  if (memory.knowledgeBaseId !== args.knowledgeBaseId) {
    throw new Error("memory knowledge-base scope mismatch");
  }
  const existing = await getMemoryVector(ctx, args.memoryId);
  // Retired inline copies must not diverge from the newly written side vector.
  await ctx.db.patch(args.memoryId, {
    embedding: inlineMemoryVectorsRetired() ? undefined : args.embedding,
  });
  const value = {
    memoryId: args.memoryId,
    userId: args.userId,
    knowledgeBaseId: args.knowledgeBaseId,
    embedding: args.embedding,
    conversationUserId:
      args.knowledgeBaseId === undefined ? args.userId : undefined,
    recallScope: memoryRecallScope(memory),
    model: args.model ?? MEMORY_VECTOR_MODEL,
    dimensions: MEMORY_VECTOR_DIMENSIONS,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  if (existing) {
    await patchMemoryEmbedding(ctx, existing._id, value);
    return existing._id;
  }
  return insertMemoryEmbedding(ctx, value);
}

/** Operator-driven, cursor-paged additive backfill; never a recurring scan. */
export const backfillConversationScopePage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemoryEmbeddings")
      .paginate({ cursor: args.cursor, numItems: 50 });
    let mismatches = 0;
    let missingSources = 0;
    for (const side of page.page) {
      const memory = await ctx.db.get(side.memoryId);
      if (!memory) {
        missingSources++;
        continue;
      }
      const conversationUserId =
        memory.knowledgeBaseId === undefined ? memory.userId : undefined;
      if (
        side.userId !== memory.userId ||
        side.knowledgeBaseId !== memory.knowledgeBaseId ||
        side.conversationUserId !== conversationUserId
      ) {
        mismatches++;
        if (!args.dryRun)
          await patchMemoryEmbedding(ctx, side._id, {
            userId: memory.userId,
            knowledgeBaseId: memory.knowledgeBaseId,
            conversationUserId,
          });
      }
    }
    return {
      mismatches,
      missingSources,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export async function deleteMemoryVector(
  ctx: any,
  memoryId: Id<"crystalMemories">,
): Promise<number> {
  // `by_memoryId` is unique at the application layer. Fail closed on legacy
  // duplicates; the reviewed repair normalizes only byte-identical groups.
  const rows = await ctx.db
    .query("crystalMemoryEmbeddings")
    .withIndex("by_memoryId", (q: any) => q.eq("memoryId", memoryId))
    .take(16);
  if (rows.length > 1)
    throw new Error(`duplicate vectors for memory ${String(memoryId)}`);
  if (await ctx.db.get(memoryId))
    await ctx.db.patch(memoryId, { embedding: undefined });
  if (rows[0]) await deleteMemoryEmbedding(ctx, rows[0]._id);
  return rows.length;
}
