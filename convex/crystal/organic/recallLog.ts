/**
 * Organic Recall Log — public queries for the dashboard.
 * The authoritative logRecallQuery mutation lives in traces.ts
 * (with truncation safeguards: query capped at 500 chars, topResultIds at 5).
 */
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "../../_generated/server";
import { stableUserId } from "../auth";

// ── Public queries (dashboard) ─────────────────────────────────────────────

export const getRecentRecallQueries = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);
    const limit = Math.min(args.limit ?? 50, 200);

    return ctx.db
      .query("organicRecallLog")
      .withIndex("by_user", (idx) => idx.eq("userId", userId))
      .order("desc")
      .take(limit);
  },
});

export const getRecallStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);

    return getRecallStatsForUser(ctx, userId);
  },
});

export const getRecallStatsInternal = internalQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    return getRecallStatsForUser(ctx, args.userId);
  },
});

/**
 * Phase 1 traces instrumentation — funnel aggregation over the last 24 hours.
 * Returns counts at each pipeline stage so the diagnostic dashboard panel can show
 * where trace candidates drop off (raw vector matches → above 0.40 threshold →
 * survived the recall merge → logged as a hit).
 *
 * This is a temporary diagnostic surface; promoted to a permanent panel only after
 * Phase 2 lands and trace hit rate is non-zero.
 */
export const getTraceFunnelStats24h = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);
    const since = Date.now() - 24 * 60 * 60 * 1000;

    const rows = await ctx.db
      .query("organicRecallLog")
      .withIndex("by_user", (idx) => idx.eq("userId", userId).gt("createdAt", since))
      .take(2000);

    let withInstrumentation = 0;
    let queriesWithActiveTraces = 0;
    let totalRaw = 0;
    let totalAboveThreshold = 0;
    let totalSurvivedMerge = 0;
    let totalHits = 0;
    let topScoreSum = 0;
    let topScoreCount = 0;
    let topScoreMax = 0;
    const topScores: number[] = [];

    for (const row of rows) {
      if (row.tracesMatchedRaw === undefined) continue;
      withInstrumentation++;
      if ((row.activeTracesForUser ?? 0) > 0) queriesWithActiveTraces++;
      totalRaw += row.tracesMatchedRaw ?? 0;
      totalAboveThreshold += row.tracesAboveThreshold ?? 0;
      totalSurvivedMerge += row.tracesSurvivedMerge ?? 0;
      if (row.traceHit) totalHits++;
      if (row.topTraceVectorScore !== undefined && row.topTraceVectorScore > 0) {
        topScoreSum += row.topTraceVectorScore;
        topScoreCount++;
        topScores.push(row.topTraceVectorScore);
        if (row.topTraceVectorScore > topScoreMax) topScoreMax = row.topTraceVectorScore;
      }
    }

    topScores.sort((a, b) => a - b);
    const p50 = topScores.length > 0 ? topScores[Math.floor(topScores.length * 0.5)] : 0;
    const p90 = topScores.length > 0 ? topScores[Math.floor(topScores.length * 0.9)] : 0;

    return {
      windowHours: 24,
      totalRecalls: rows.length,
      withInstrumentation,
      queriesWithActiveTraces,
      totalRaw,
      totalAboveThreshold,
      totalSurvivedMerge,
      totalHits,
      hitRate:
        queriesWithActiveTraces > 0 ? totalHits / queriesWithActiveTraces : 0,
      topScoreAvg: topScoreCount > 0 ? topScoreSum / topScoreCount : 0,
      topScoreMax,
      topScoreP50: p50,
      topScoreP90: p90,
    };
  },
});

export const pruneOldRecallLogEntries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const oldEntries = await ctx.db
      .query("organicRecallLog")
      .withIndex("by_created", (idx) => idx.lt("createdAt", cutoff))
      .take(100);

    for (const entry of oldEntries) {
      await ctx.db.delete(entry._id);
    }

    return { deleted: oldEntries.length };
  },
});

async function getRecallStatsForUser(
  ctx: any,
  userId: string
) {
  const stats = await ctx.db
    .query("organicRecallStats")
    .withIndex("by_user", (idx: any) => idx.eq("userId", userId))
    .first();

  if (!stats) {
    return {
      totalQueries: 0,
      traceHits: 0,
      hitRate: 0,
      avgResultCount: 0,
    };
  }

  return {
    totalQueries: stats.totalQueries,
    traceHits: stats.traceHits,
    hitRate: stats.totalQueries > 0 ? stats.traceHits / stats.totalQueries : 0,
    avgResultCount: stats.totalQueries > 0 ? stats.totalResultCount / stats.totalQueries : 0,
  };
}
