/**
 * Authoritative LTM vector access for v0.9.0.
 *
 * All retained callers use this module so owner/KB checks, dimensions, model,
 * lifecycle cascades, and the physical vector table cannot drift independently.
 */
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

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
};

/** Recall has no side-row identity until the independently audited cutover. */
export async function recallMemoryIds(
  ctx: any,
  args: RecallVectorArgs,
): Promise<Array<{ memoryId: Id<"crystalMemories">; score: number }>> {
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
        // Convex vector filters support one equality scope; hydration below is
        // the authority for archive and KB exclusion on both representations.
        return args.knowledgeBaseId
          ? q.eq("knowledgeBaseId", args.knowledgeBaseId)
          : side && args.excludeKnowledgeBase
            ? conversationVectorFilter(q, args.userId!)
            : q.eq("userId", args.userId);
      },
    },
  );
  const hits: Array<{ memoryId: Id<"crystalMemories">; score: number }> = [];
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
  },
  handler: async (ctx, args) => {
    if (!args.userId && !args.knowledgeBaseId)
      throw new Error("recall hydration requires scope");
    if (args.memoryIds.length && args.sideIds.length)
      throw new Error("mixed recall vector representations");
    const hits: Array<{ memoryId: Id<"crystalMemories">; score: number }> = [];
    const ids = args.sideIds.length ? args.sideIds : args.memoryIds;
    for (let i = 0; i < ids.length; i++) {
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
      hits.push({ memoryId: memory._id, score: args.scores[i] ?? 0 });
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
    for (let index = 0; index < args.sideIds.length; index += 1) {
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
    model: args.model ?? MEMORY_VECTOR_MODEL,
    dimensions: MEMORY_VECTOR_DIMENSIONS,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  if (existing) {
    await ctx.db.patch(existing._id, value);
    return existing._id;
  }
  return ctx.db.insert("crystalMemoryEmbeddings", value);
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
          await ctx.db.patch(side._id, {
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
  if (rows[0]) await ctx.db.delete(rows[0]._id);
  return rows.length;
}
