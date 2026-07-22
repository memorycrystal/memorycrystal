import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { isProtectedSensoryCapture } from "./sensoryPolicy";

type MemoryDoc = {
  _id: any;
  userId: string;
  store: "sensory" | "episodic" | "semantic" | "procedural" | "prospective";
  category: "decision" | "lesson" | "person" | "rule" | "event" | "fact" | "goal" | "skill" | "workflow" | "conversation";
  archived: boolean;
  archivedAt?: number;
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
  const rows = await ctx.db
    .query("crystalMemoryCleanupIndex")
    .withIndex("by_memory", (q: any) => q.eq("memoryId", memory._id))
    .collect();
  const projection = buildCleanupProjection(memory, now);
  const [canonical, ...duplicates] = rows;
  if (canonical) {
    await ctx.db.patch(canonical._id, projection);
    for (const duplicate of duplicates) await ctx.db.delete(duplicate._id);
    return canonical._id;
  }
  return await ctx.db.insert("crystalMemoryCleanupIndex", projection);
}

export async function patchMemoryAndSyncCleanupProjection(
  ctx: any,
  memory: MemoryDoc,
  patch: Record<string, unknown>,
  now = Date.now(),
) {
  await ctx.db.patch(memory._id, patch);
  await upsertCleanupProjectionForMemory(
    ctx,
    { ...memory, ...patch } as MemoryDoc,
    now,
  );
}

export async function archiveMemoryAndSyncCleanupProjection(
  ctx: any,
  memory: MemoryDoc,
  archivedAt: number,
  patch: Record<string, unknown> = {},
) {
  await patchMemoryAndSyncCleanupProjection(
    ctx,
    memory,
    { ...patch, archived: true, archivedAt },
    archivedAt,
  );
}

export async function deleteCleanupProjectionForMemory(ctx: any, memoryId: any) {
  const rows = await ctx.db
    .query("crystalMemoryCleanupIndex")
    .withIndex("by_memory", (q: any) => q.eq("memoryId", memoryId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

// Repairs legacy projection drift in bounded pages. This is internal-only so a
// caller must deliberately orchestrate pagination; deploying it runs nothing.
export const reconcileCleanupProjectionPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, limit }) => {
    const requested = Number.isFinite(limit) ? Math.trunc(limit as number) : 50;
    const max = Math.min(Math.max(requested, 1), 500);
    const now = Date.now();
    const page = await ctx.db
      .query("crystalMemoryCleanupIndex")
      .paginate({ cursor, numItems: max });
    let synced = 0;
    let deletedOrphans = 0;
    for (const row of page.page) {
      const memory = await ctx.db.get(row.memoryId);
      if (!memory) {
        await ctx.db.delete(row._id);
        deletedOrphans += 1;
        continue;
      }
      await upsertCleanupProjectionForMemory(ctx, memory as MemoryDoc, now);
      synced += 1;
    }
    return {
      synced,
      deletedOrphans,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

const CLEANUP_PROJECTION_CURSOR_VERSION = 2;

export const backfillCleanupProjectionForUser = internalMutation({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }) => {
    const max = Math.min(Math.max(limit ?? 50, 1), 500);
    const now = Date.now();
    const state = await ctx.db
      .query("crystalCleanupProjectionState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const canResume = Boolean(
      state?.cursor &&
      !state.completedAt &&
      state.cursorVersion === CLEANUP_PROJECTION_CURSOR_VERSION &&
      state.scanAfterCreatedAt !== undefined,
    );
    // Convex cursors are bound to the exact indexed-query shape. Keep the lower
    // bound fixed for the life of a cursor, and restart legacy v1 cursors whose
    // first page used a different range from their resume page.
    const scanAfterCreatedAt = canResume
      ? state!.scanAfterCreatedAt!
      : state?.completedAt
        ? state.lastCreatedAt
        : -1;
    const scan = ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) =>
        q.eq("userId", userId).gt("createdAt", scanAfterCreatedAt)
      )
      .order("asc");
    const page = await scan.paginate({
      numItems: max,
      cursor: canResume ? state!.cursor! : null,
    });
    const memories = page.page;

    let synced = 0;
    let nextCreatedAt = canResume
      ? state!.lastCreatedAt
      : Math.max(state?.lastCreatedAt ?? -1, scanAfterCreatedAt);
    for (const memory of memories) {
      await upsertCleanupProjectionForMemory(ctx, memory as MemoryDoc, now);
      synced += 1;
      nextCreatedAt = Math.max(nextCreatedAt, memory.createdAt);
    }

    const completedAt = page.isDone ? now : undefined;
    const cursor = page.isDone ? undefined : page.continueCursor;
    const scanLowerBound = page.isDone ? undefined : scanAfterCreatedAt;
    if (state) {
      await ctx.db.patch(state._id, {
        lastCreatedAt: nextCreatedAt,
        cursor,
        cursorVersion: CLEANUP_PROJECTION_CURSOR_VERSION,
        scanAfterCreatedAt: scanLowerBound,
        completedAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("crystalCleanupProjectionState", {
        userId,
        lastCreatedAt: nextCreatedAt,
        cursor,
        cursorVersion: CLEANUP_PROJECTION_CURSOR_VERSION,
        scanAfterCreatedAt: scanLowerBound,
        completedAt,
        updatedAt: now,
      });
    }

    return { synced, completed: page.isDone };
  },
});
