import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";

export const logActivity = internalMutation({
  args: {
    userId: v.string(),
    eventType: v.union(
      v.literal("memory_stored"),
      v.literal("memory_recalled"),
      v.literal("memory_expired"),
      v.literal("memory_archived")
    ),
    memoryId: v.id("crystalMemories"),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("organicActivityLog", {
      userId: args.userId,
      eventType: args.eventType,
      memoryId: args.memoryId,
      timestamp: Date.now(),
      metadata: args.metadata,
    });
  },
});

export const logRecallActivity = internalMutation({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.id("crystalMemories")),
    query: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const metadataStr = args.query
      ? JSON.stringify({ query: args.query.slice(0, 200) })
      : undefined;
    for (const memoryId of args.memoryIds) {
      await ctx.db.insert("organicActivityLog", {
        userId: args.userId,
        eventType: "memory_recalled",
        memoryId,
        timestamp,
        metadata: metadataStr,
      });
    }
  },
});

export const pruneActivityLog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("organicActivityLog")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
      .take(500);
    for (const entry of old) {
      await ctx.db.delete(entry._id);
    }
  },
});
