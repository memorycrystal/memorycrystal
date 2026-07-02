import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { isProtectedSensoryCapture } from "./sensoryPolicy";

type MemoryDoc = {
  _id: any;
  userId: string;
  store: "sensory" | "episodic" | "semantic" | "procedural" | "prospective";
  category: "decision" | "lesson" | "person" | "rule" | "event" | "fact" | "goal" | "skill" | "workflow" | "conversation";
  archived: boolean;
  createdAt: number;
  strength: number;
  lastAccessedAt: number;
  knowledgeBaseId?: any;
  rawContentExpiresAt?: number;
  rawContentWipedAt?: number;
  rawRetentionState?: "raw" | "summarized" | "wiped" | "wiped_without_summary" | "protected";
  sensoryRawTtlDaysApplied?: number;
  summary?: string;
  recallText?: string;
  source?: string;
  tags?: string[];
};

function buildCleanupProjection(memory: MemoryDoc, now: number) {
  return {
    memoryId: memory._id,
    userId: memory.userId,
    store: memory.store,
    category: memory.category,
    archived: memory.archived,
    createdAt: memory.createdAt,
    strength: memory.strength,
    lastAccessedAt: memory.lastAccessedAt,
    knowledgeBaseId: memory.knowledgeBaseId,
    rawContentExpiresAt: memory.rawContentExpiresAt,
    rawContentWipedAt: memory.rawContentWipedAt,
    rawRetentionState: memory.rawRetentionState,
    sensoryRawTtlDaysApplied: memory.sensoryRawTtlDaysApplied,
    hasSummary: Boolean((memory.summary ?? "").trim()),
    hasRecallText: Boolean((memory.recallText ?? "").trim()),
    protectedSensoryCandidate: isProtectedSensoryCapture(memory),
    updatedAt: now,
  };
}

export async function upsertCleanupProjectionForMemory(ctx: any, memory: MemoryDoc, now = Date.now()) {
  const row = await ctx.db
    .query("crystalMemoryCleanupIndex")
    .withIndex("by_memory", (q: any) => q.eq("memoryId", memory._id))
    .first();
  const projection = buildCleanupProjection(memory, now);
  if (row) {
    await ctx.db.patch(row._id, projection);
    return row._id;
  }
  return await ctx.db.insert("crystalMemoryCleanupIndex", projection);
}

export async function deleteCleanupProjectionForMemory(ctx: any, memoryId: any) {
  const row = await ctx.db
    .query("crystalMemoryCleanupIndex")
    .withIndex("by_memory", (q: any) => q.eq("memoryId", memoryId))
    .first();
  if (row) await ctx.db.delete(row._id);
}

export const backfillCleanupProjectionForUser = internalMutation({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }) => {
    const max = Math.min(Math.max(limit ?? 50, 1), 500);
    const now = Date.now();
    const state = await ctx.db
      .query("crystalCleanupProjectionState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const lastCreatedAt = state?.lastCreatedAt ?? -1;
    const scan = state?.cursor && !state.completedAt
      ? ctx.db
        .query("crystalMemories")
        .withIndex("by_user_created", (q) => q.eq("userId", userId))
        .order("asc")
      : ctx.db
        .query("crystalMemories")
        .withIndex("by_user_created", (q) => q.eq("userId", userId).gt("createdAt", lastCreatedAt))
        .order("asc");
    const page = await scan.paginate({
      numItems: max,
      cursor: state?.cursor && !state.completedAt ? state.cursor : null,
    });
    const memories = page.page;

    let synced = 0;
    let nextCreatedAt = lastCreatedAt;
    for (const memory of memories) {
      await upsertCleanupProjectionForMemory(ctx, memory as MemoryDoc, now);
      synced += 1;
      nextCreatedAt = Math.max(nextCreatedAt, memory.createdAt);
    }

    const completedAt = page.isDone ? now : undefined;
    const cursor = page.isDone ? undefined : page.continueCursor;
    if (state) {
      await ctx.db.patch(state._id, {
        lastCreatedAt: nextCreatedAt,
        cursor,
        completedAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("crystalCleanupProjectionState", {
        userId,
        lastCreatedAt: nextCreatedAt,
        cursor,
        completedAt,
        updatedAt: now,
      });
    }

    return { synced, completed: page.isDone };
  },
});
