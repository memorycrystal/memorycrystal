import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

function pageSize(value: number | undefined, fallback: number) {
  return Math.min(100, Math.max(1, Math.floor(Number.isNaN(value) ? fallback : (value ?? fallback))));
}

export const stripLegacyMessageEmbeddingsPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // At most 100 legacy rows * 60 KB = 6 MB, below the 16 MiB read limit.
    const result = await ctx.db.query("crystalMessages").withIndex("by_timestamp")
      .order("asc").paginate({ cursor: args.cursor, numItems: pageSize(args.batchSize, 40) });
    let stripped = 0;
    for (const row of result.page) {
      if ("embedding" in row || "embedded" in row) {
        await ctx.db.patch(row._id, { embedding: undefined, embedded: undefined });
        stripped++;
      }
    }
    return { scanned: result.page.length, stripped, continueCursor: result.continueCursor, isDone: result.isDone };
  },
});

export const countLegacyMessageEmbeddingsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), pageSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("crystalMessages").withIndex("by_timestamp")
      .order("asc").paginate({ cursor: args.cursor, numItems: pageSize(args.pageSize, 50) });
    return {
      scanned: result.page.length,
      legacy: result.page.filter(row => "embedding" in row || "embedded" in row).length,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
