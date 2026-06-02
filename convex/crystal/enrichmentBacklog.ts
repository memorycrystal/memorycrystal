/**
 * enrichmentBacklog.ts — M5
 *
 * Lazy-enrich-on-recall debounce queue. When `recall.recallMemories` surfaces
 * memories that previously hit the M5 strength-floor skip, it schedules at
 * most ONE `enrichMemoryGraph` per request and queues the rest in this table.
 * The hourly `crystal-graph-backfill` cron drains up to 5 rows from this
 * table before its standard 25-memory backfill page.
 *
 * Dedupe: there is one row per memoryId. Re-enqueueing an existing memory
 * just bumps `lastQueuedAt` so the cron drains the most recently relevant
 * memories first.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { type Id } from "../_generated/dataModel";

/** Maximum rows the hourly cron drains from the backlog before its standard page. */
export const BACKLOG_DRAIN_LIMIT = 5;

/** Drained rows must have been accessed within this window to remain "hot". */
export const BACKLOG_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Enqueue (or refresh) a memory in the backlog. Idempotent on memoryId — a
 * second call for the same memory bumps `lastQueuedAt` rather than inserting
 * a duplicate row.
 */
export const enqueueBacklog = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    userId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("crystalEnrichmentBacklog")
      .withIndex("by_memory", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { lastQueuedAt: now, reason: args.reason });
      return existing._id;
    }

    return ctx.db.insert("crystalEnrichmentBacklog", {
      memoryId: args.memoryId,
      userId: args.userId,
      reason: args.reason,
      lastQueuedAt: now,
    });
  },
});

interface DrainedBacklogRow {
  _id: Id<"crystalEnrichmentBacklog">;
  memoryId: Id<"crystalMemories">;
  userId: string;
}

/**
 * Pull up to `limit` backlog rows that are still drainable: the underlying
 * memory must still have `enrichmentSkippedReason === "below_strength_floor"`,
 * `lastAccessedAt > now - 24h`, and `enrichmentAttempts < MAX_ENRICHMENT_ATTEMPTS`.
 *
 * Stale rows (where the memory no longer matches — e.g. the skip was already
 * cleared, the memory was archived, the memory was deleted, or it ran out of
 * attempts) are silently removed during the scan.
 */
export const drainBacklog = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args): Promise<DrainedBacklogRow[]> => {
    const cap = Math.max(1, Math.trunc(args.limit));
    const now = Date.now();
    const freshnessCutoff = now - BACKLOG_FRESHNESS_MS;

    // Pull a small candidate window. Most recent first so hot recalls drain first.
    const candidates = await ctx.db
      .query("crystalEnrichmentBacklog")
      .order("desc")
      .take(cap * 4);

    const drained: DrainedBacklogRow[] = [];
    for (const row of candidates) {
      if (drained.length >= cap) break;

      const memory = await ctx.db.get(row.memoryId);
      const stale =
        !memory ||
        memory.archived ||
        memory.enrichmentSkippedReason !== "below_strength_floor" ||
        (memory.lastAccessedAt ?? 0) <= freshnessCutoff ||
        (memory.enrichmentAttempts ?? 0) >= 5;

      if (stale) {
        await ctx.db.delete(row._id);
        continue;
      }

      drained.push({
        _id: row._id,
        memoryId: row.memoryId,
        userId: row.userId,
      });
      await ctx.db.delete(row._id);
    }

    return drained;
  },
});

/**
 * Test/diagnostic helper — list current backlog rows for a user.
 */
export const listBacklogForUser = internalQuery({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cap = Math.max(1, Math.trunc(args.limit ?? 50));
    return ctx.db
      .query("crystalEnrichmentBacklog")
      .withIndex("by_userId_lastQueuedAt", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(cap);
  },
});
