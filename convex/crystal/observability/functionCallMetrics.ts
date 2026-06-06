/**
 * M0 — Function-call metrics (cost-reduction baseline instrumentation).
 *
 * Upserts an hourly bucket row per (name, bucket) pair so Convex function
 * costs can be attributed by route over time. All writes are fire-and-forget
 * from hot paths — errors are swallowed so instrumentation never breaks
 * production behaviour.
 *
 * `recordCall` — internalMutation, upsert the bucket row.
 * `getMetricsByName` — internalQuery, last N hourly buckets for one function.
 * `getDashboardSummary` — internalQuery, top-N functions by count over 24h.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";

/** ISO-8601 date truncated to the hour: "2026-05-03T18" */
function hourBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
}

// ── recordCall ────────────────────────────────────────────────────────────────

export const recordCall = internalMutation({
  args: {
    name: v.string(),
    userId: v.optional(v.string()),
    tier: v.optional(v.string()),
    bandwidthBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const bucket = hourBucket(now);

    const existing = await ctx.db
      .query("crystalFunctionCallMetrics")
      .withIndex("by_name_bucket", (q) =>
        q.eq("name", args.name).eq("bucket", bucket),
      )
      .filter((q) =>
        args.userId !== undefined
          ? q.eq(q.field("userId"), args.userId)
          : q.eq(q.field("userId"), undefined),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        count: existing.count + 1,
        bandwidthBytes:
          args.bandwidthBytes !== undefined
            ? (existing.bandwidthBytes ?? 0) + args.bandwidthBytes
            : existing.bandwidthBytes,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("crystalFunctionCallMetrics", {
        name: args.name,
        bucket,
        count: 1,
        userId: args.userId,
        tier: args.tier,
        bandwidthBytes: args.bandwidthBytes,
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});

// ── getMetricsByName ──────────────────────────────────────────────────────────

export const getMetricsByName = internalQuery({
  args: {
    name: v.string(),
    sinceHours: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.sinceHours * 60 * 60 * 1000;
    const cutoffBucket = hourBucket(cutoff);

    const rows = await ctx.db
      .query("crystalFunctionCallMetrics")
      .withIndex("by_name_bucket", (q) =>
        q.eq("name", args.name).gte("bucket", cutoffBucket),
      )
      .collect();

    return rows.map((r) => ({
      bucket: r.bucket,
      count: r.count,
      userId: r.userId,
      tier: r.tier,
      bandwidthBytes: r.bandwidthBytes,
    }));
  },
});

// ── pruneOldBuckets ───────────────────────────────────────────────────────────

const PRUNE_PAGE_SIZE = 1000;

export const pruneOldBuckets = internalMutation({
  args: {
    ttlDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ttlDays = args.ttlDays ?? 30;
    const cutoffBucket = new Date(Date.now() - ttlDays * 86400_000)
      .toISOString()
      .slice(0, 13); // "YYYY-MM-DDTHH"

    // Full table scan filtered to bucket < cutoff, bounded by page size.
    // by_name_bucket index requires an equality prefix on `name`, so we use
    // a plain scan + filter here which is acceptable since this runs once/day
    // at off-peak hours and deletes are bounded per invocation.
    const page = await ctx.db
      .query("crystalFunctionCallMetrics")
      .filter((q) => q.lt(q.field("bucket"), cutoffBucket))
      .take(PRUNE_PAGE_SIZE);

    for (const row of page) {
      await ctx.db.delete(row._id);
    }

    const hasMore = page.length === PRUNE_PAGE_SIZE;

    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.observability.functionCallMetrics.pruneOldBuckets,
        { ttlDays },
      );
    }

    return { deleted: page.length, hasMore };
  },
});

// ── getDashboardSummary ───────────────────────────────────────────────────────

const TOP_N = 20;

export const getDashboardSummary = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const cutoffBucket = hourBucket(cutoff);

    // Collect all rows from the last 24 h. The table is small (one row per
    // function × hour × user), so a full scan is acceptable for now.
    const rows = await ctx.db
      .query("crystalFunctionCallMetrics")
      .collect();

    const recent = rows.filter((r) => r.bucket >= cutoffBucket);

    const totals = new Map<string, number>();
    for (const r of recent) {
      totals.set(r.name, (totals.get(r.name) ?? 0) + r.count);
    }

    const sorted = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([name, count]) => ({ name, count }));

    return {
      windowHours: 24,
      generatedAt: Date.now(),
      topFunctions: sorted,
    };
  },
});
