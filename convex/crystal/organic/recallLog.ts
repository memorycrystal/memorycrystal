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
