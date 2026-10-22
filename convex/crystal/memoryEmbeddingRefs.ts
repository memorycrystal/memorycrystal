import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type Vector = WithoutSystemFields<Doc<"crystalMemoryEmbeddings">>;
type RefSource = Pick<Doc<"crystalMemoryEmbeddings">, "_id" | "memoryId" | "userId" | "knowledgeBaseId">;

/** Mirror the vector's own scope, including absent fields; never infer from memory. */
export async function syncMemoryEmbeddingRef(ctx: MutationCtx, row: RefSource, dryRun = false) {
  const refs = await ctx.db.query("crystalMemoryEmbeddingRefs")
    .withIndex("by_embeddingId", (q) => q.eq("embeddingId", row._id)).collect();
  const fields = { memoryId: row.memoryId, userId: row.userId, knowledgeBaseId: row.knowledgeBaseId };
  if (!refs.length) {
    if (!dryRun) await ctx.db.insert("crystalMemoryEmbeddingRefs", { embeddingId: row._id, ...fields });
    return "created" as const;
  }
  if (refs.length === 1 && refs[0].memoryId === fields.memoryId &&
      refs[0].userId === fields.userId && refs[0].knowledgeBaseId === fields.knowledgeBaseId) {
    return "unchanged" as const;
  }
  if (!dryRun) {
    await ctx.db.patch(refs[0]._id, fields);
    for (const ref of refs.slice(1)) await ctx.db.delete(ref._id);
  }
  return "repaired" as const;
}

/** Vector and ref writes share the caller's mutation transaction. */
export async function insertMemoryEmbedding(ctx: MutationCtx, value: Vector) {
  const embeddingId = await ctx.db.insert("crystalMemoryEmbeddings", value);
  await syncMemoryEmbeddingRef(ctx, { ...value, _id: embeddingId });
  return embeddingId;
}

export async function patchMemoryEmbedding(
  ctx: MutationCtx, embeddingId: Id<"crystalMemoryEmbeddings">, patch: Partial<Vector>,
) {
  await ctx.db.patch(embeddingId, patch);
  const row = await ctx.db.get(embeddingId);
  if (!row) throw new Error("vector missing after patch");
  await syncMemoryEmbeddingRef(ctx, row);
}

export async function deleteMemoryEmbedding(ctx: MutationCtx, embeddingId: Id<"crystalMemoryEmbeddings">) {
  const refs = await ctx.db.query("crystalMemoryEmbeddingRefs")
    .withIndex("by_embeddingId", (q) => q.eq("embeddingId", embeddingId)).collect();
  for (const ref of refs) await ctx.db.delete(ref._id);
  await ctx.db.delete(embeddingId);
}
