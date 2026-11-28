/** Verified, counts-only retirement of the legacy inline vector copy. */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { inlineMemoryVectorsRetired, MEMORY_VECTOR_DIMENSIONS } from "./memoryVectors";

const args = { cursor: v.union(v.string(), v.null()), batchSize: v.optional(v.number()) };
const batchSize = (size = 10) => Number.isFinite(size) ? Math.min(25, Math.max(1, Math.trunc(size))) : 10;

/** First failing reason of the inline validity check, or undefined for a valid vector. */
export function invalidInlineReason(vector: unknown): "non_array" | "wrong_length" | "non_finite" | undefined {
  if (!Array.isArray(vector)) return "non_array";
  if (vector.length !== MEMORY_VECTOR_DIMENSIONS) return "wrong_length";
  if (!vector.every(Number.isFinite)) return "non_finite";
  return undefined;
}

async function verifyPage(ctx: Pick<QueryCtx, "db">, input: { cursor: string | null; batchSize?: number }) {
  // 4 MiB paginated memories + at most 25 * 2 * ~50 KiB side rows (~3 MiB)
  // + at most 25 small patches stays below each 16 MiB read/write limit.
  const page = await ctx.db.query("crystalMemories").order("asc").paginate({
    cursor: input.cursor, numItems: batchSize(input.batchSize), maximumBytesRead: 4 * 1024 * 1024,
  });
  let inline = 0;
  const skipped: Record<string, number> = {};
  const verified = [];
  for (const memory of page.page) {
    if (memory.embedding === undefined) continue;
    inline++;
    let reason: string | undefined;
    const vector = memory.embedding;
    if (invalidInlineReason(vector)) {
      reason = "invalid_inline";
    } else {
      const sides = await ctx.db.query("crystalMemoryEmbeddings")
        .withIndex("by_memoryId", q => q.eq("memoryId", memory._id)).take(2);
      if (sides.length === 0) reason = "missing_side";
      else if (sides.length > 1) reason = "duplicate_side";
      else if (sides[0].userId !== memory.userId || sides[0].knowledgeBaseId !== memory.knowledgeBaseId) reason = "scope_mismatch";
      else if (sides[0].embedding.length !== vector.length || !vector.every((value, index) => value === sides[0].embedding[index])) reason = "vector_mismatch";
    }
    if (reason) {
      const key = memory.archived ? `archived_${reason}` : reason;
      skipped[key] = (skipped[key] ?? 0) + 1;
    } else verified.push(memory._id);
  }
  return { counts: { scanned: page.page.length, inline, skipped, continueCursor: page.continueCursor, isDone: page.isDone, splitRequired: page.pageStatus === "SplitRequired" }, verified };
}

export const stripInlineMemoryEmbeddingsPage = internalMutation({
  args,
  handler: async (ctx, input) => {
    if (!inlineMemoryVectorsRetired()) throw new ConvexError("inline vectors not retired");
    const { counts, verified } = await verifyPage(ctx, input);
    for (const memoryId of verified) await ctx.db.patch(memoryId, { embedding: undefined });
    return { ...counts, stripped: verified.length };
  },
});

export const countInlineMemoryEmbeddingsPage = internalQuery({
  args,
  handler: async (ctx, input) => {
    if (process.env.CRYSTAL_MEMORY_VECTOR_READ_MODE !== "side") throw new ConvexError("side mode required");
    const { counts, verified } = await verifyPage(ctx, input);
    return { ...counts, verifiable: verified.length };
  },
});

async function invalidPage(ctx: Pick<QueryCtx, "db">, input: { cursor: string | null; batchSize?: number }) {
  // Same bounds as verifyPage: 4 MiB of memories + at most 25 * 2 side rows.
  const page = await ctx.db.query("crystalMemories").order("asc").paginate({
    cursor: input.cursor, numItems: batchSize(input.batchSize), maximumBytesRead: 4 * 1024 * 1024,
  });
  const counts = { non_array: 0, wrong_length: 0, non_finite: 0, valid_skipped: 0, missing: 0, side_missing: 0, archived: 0 };
  const invalid = [];
  for (const memory of page.page) {
    if (memory.embedding === undefined) { counts.missing++; continue; }
    const reason = invalidInlineReason(memory.embedding);
    if (!reason) { counts.valid_skipped++; continue; }
    counts[reason]++;
    if (memory.archived) counts.archived++;
    // Report only: such a memory has no usable vector after the clear.
    const sides = await ctx.db.query("crystalMemoryEmbeddings")
      .withIndex("by_memoryId", q => q.eq("memoryId", memory._id)).take(2);
    if (!sides.some(row => !invalidInlineReason(row.embedding))) counts.side_missing++;
    invalid.push(memory._id);
  }
  return { counts: { scanned: page.page.length, ...counts, continueCursor: page.continueCursor, isDone: page.isDone, splitRequired: page.pageStatus === "SplitRequired" }, invalid };
}

export const clearInvalidInlineMemoryEmbeddingsPage = internalMutation({
  args,
  handler: async (ctx, input) => {
    if (!inlineMemoryVectorsRetired()) throw new ConvexError("inline vectors not retired");
    const { counts, invalid } = await invalidPage(ctx, input);
    for (const memoryId of invalid) await ctx.db.patch(memoryId, { embedding: undefined });
    return { ...counts, cleared: invalid.length };
  },
});

export const countInvalidInlineMemoryEmbeddingsPage = internalQuery({
  args,
  handler: async (ctx, input) => {
    if (process.env.CRYSTAL_MEMORY_VECTOR_READ_MODE !== "side") throw new ConvexError("side mode required");
    const { counts, invalid } = await invalidPage(ctx, input);
    return { ...counts, invalid: invalid.length };
  },
});
