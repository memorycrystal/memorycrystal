import { stableUserId } from "./auth";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";

const createInput = v.object({
  label: v.string(),
  description: v.optional(v.string()),
});

const listMemoryIds = async (ctx: any, memoryIds: string[]) => {
  const snapshots = [];
  for (const memoryId of memoryIds) {
    const memory = await ctx.db.get(memoryId);
    if (!memory || memory.archived) continue;
    snapshots.push({
      memoryId: memoryId as Id<"crystalMemories">,
      strength: memory.strength,
      content: memory.content,
      store: memory.store,
    });
  }
  return snapshots;
};

export const createCheckpoint = mutation({
  args: createInput,
  handler: async (ctx, { label, description }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const requestedLimit = 12;
    const chosenIds = (
      await ctx.db
        .query("crystalMemories")
        .withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", false))
        .take(requestedLimit)
    )
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, requestedLimit)
      .map((memory) => memory._id);

    const snapshot = await listMemoryIds(ctx, chosenIds);
    const defaultSummary = snapshot
      .slice(0, 3)
      .map((entry) => `${entry.store}: ${entry.content.slice(0, 80)}`)
      .join("\n");

    return ctx.db.insert("crystalCheckpoints", {
      userId,
      label,
      description,
      createdAt: Date.now(),
      createdBy: userId,
      memorySnapshot: snapshot,
      semanticSummary: defaultSummary,
      tags: [],
    });
  },
});

export const getCheckpoint = query({
  args: { checkpointId: v.id("crystalCheckpoints") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const checkpoint = await ctx.db.get(args.checkpointId);
    if (!checkpoint || checkpoint.userId !== stableUserId(identity.subject)) return null;
    return checkpoint;
  },
});

export const listCheckpoints = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    return ctx.db
      .query("crystalCheckpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit ?? 50);
  },
});
