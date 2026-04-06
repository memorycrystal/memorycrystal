import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { embedText } from "./utils";

/**
 * matchProspectiveTraces — called from recall action.
 * v2: Uses vector search on documentEmbedding (query-to-document matching).
 * Falls back to text search on predictedQuery for legacy traces without embeddings.
 */
export const matchProspectiveTraces = internalAction({
  args: {
    userId: v.string(),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.query.trim()) return [];

    // Early exit: skip embedding if user has no active traces at all
    const hasTraces = await ctx.runQuery(
      internal.crystal.organic.traces.hasActiveTraces,
      { userId: args.userId }
    );
    if (!hasTraces) return [];

    const now = Date.now();
    const COSINE_THRESHOLD = 0.40;

    // v2: embed the query and search against document embeddings
    const queryEmbedding = await embedText(args.query).catch(() => null);

    let vectorMatches: any[] = [];
    if (queryEmbedding) {
      try {
        const vectorResults = await ctx.vectorSearch("organicProspectiveTraces", "by_document_embedding", {
          vector: queryEmbedding,
          limit: 20,
          filter: (q: any) => q.eq("userId", args.userId),
        });
        // Fetch full documents and filter by threshold, expiry, and validation status
        vectorMatches = (await Promise.all(
          vectorResults
            .filter((r: any) => r._score >= COSINE_THRESHOLD)
            .map(async (r: any) => {
              const doc = await ctx.runQuery(internal.crystal.organic.traces.getTraceById, { traceId: r._id });
              if (!doc || doc.validated !== null || doc.expiresAt <= now) return null;
              return { ...doc, _score: r._score };
            })
        )).filter((d): d is NonNullable<typeof d> => d !== null);
      } catch {
        // Vector index may not be populated yet; fall through to text search
      }
    }

    // Fallback: text search for legacy traces without document embeddings
    const textResults = await ctx.runQuery(internal.crystal.organic.traces.textMatchTraces, {
      userId: args.userId,
      query: args.query,
    });

    // Merge, dedup, sort by confidence
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const t of [...vectorMatches, ...textResults]) {
      const id = String(t._id);
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(t);
      }
    }

    return merged
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  },
});

/**
 * hasActiveTraces — lightweight check: does this user have any non-expired, non-validated traces?
 */
export const hasActiveTraces = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Query non-expired traces and find ANY with validated===null.
    // Previously only checked .first() which could return a validated trace,
    // causing a false negative that silently disabled trace matching.
    const trace = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_user_expires", (q) =>
        q.eq("userId", args.userId).gt("expiresAt", now)
      )
      .filter((q) => q.eq(q.field("validated"), null))
      .first();
    return trace !== null;
  },
});

/**
 * getTraceById — internal query to fetch a single trace by ID.
 */
export const getTraceById = internalQuery({
  args: { traceId: v.id("organicProspectiveTraces") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.traceId);
  },
});

/**
 * textMatchTraces — legacy text search fallback for traces without document embeddings.
 */
export const textMatchTraces = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.query.trim()) return [];
    const now = Date.now();
    const results = await ctx.db
      .query("organicProspectiveTraces")
      .withSearchIndex("search_predicted_query", (q) =>
        q.search("predictedQuery", args.query).eq("userId", args.userId)
      )
      .take(20);
    return results.filter((t) => t.validated === null && t.expiresAt > now && !t.documentEmbedding);
  },
});

/**
 * markValidated — sets validated = true, validatedAt = now on a trace.
 * Also increments accessCount.
 */
export const markValidated = internalMutation({
  args: { traceId: v.id("organicProspectiveTraces") },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get(args.traceId);
    if (!trace) return;
    await ctx.db.patch(args.traceId, {
      validated: true,
      validatedAt: Date.now(),
      accessCount: trace.accessCount + 1,
    });
  },
});

/**
 * getActiveTraces — returns all pending (non-expired, non-validated) traces for a user.
 */
export const getActiveTraces = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const traces = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_user_expires", (q) =>
        q.eq("userId", args.userId).gt("expiresAt", now)
      )
      .take(500);

    return traces.filter((t) => t.validated === null);
  },
});

/**
 * getTraceStats — returns hit rate, total generated, total validated for dashboard.
 */
export const getTraceStats = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Count validated traces efficiently using the by_user_validated index
    const validatedTraces = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_user_validated", (q) =>
        q.eq("userId", args.userId).eq("validated", true)
      )
      .take(5000);
    const validated = validatedTraces.length;

    // For total, use tickState accumulated counters (authoritative) if available,
    // otherwise fall back to scanning.
    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    const total = tickState?.totalTracesGenerated ?? validated;
    const hitRate = total > 0 ? validated / total : 0;

    return { total, validated, hitRate };
  },
});

/**
 * pruneExpiredTraces — hard-delete validated/expired traces older than 30 days.
 * Called daily via crons.
 */
export const pruneExpiredTraces = internalMutation({
  args: {},
  handler: async (ctx) => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    // Delete expired traces older than 30 days, using index + batch limit
    const expired = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_expires", (q) => q.lt("expiresAt", thirtyDaysAgo))
      .take(100);

    let deleted = 0;
    for (const trace of expired) {
      const isOldExpired = trace.expiresAt < thirtyDaysAgo;
      const isOldValidated = trace.validated === true && (trace.validatedAt ?? 0) < thirtyDaysAgo;

      if (isOldExpired || isOldValidated) {
        await ctx.db.delete(trace._id);
        deleted++;
      }
    }

    return { deleted };
  },
});

/**
 * logRecallQuery — log a recall query to organicRecallLog (Fix 2).
 */
export const logRecallQuery = internalMutation({
  args: {
    userId: v.string(),
    query: v.string(),
    resultCount: v.number(),
    topResultIds: v.array(v.id("crystalMemories")),
    candidateSignals: v.optional(v.array(v.object({
      memoryId: v.id("crystalMemories"),
      strength: v.float64(),
      confidence: v.float64(),
      accessCount: v.number(),
      lastAccessedAt: v.optional(v.number()),
      createdAt: v.number(),
      salienceScore: v.optional(v.float64()),
      vectorScore: v.optional(v.float64()),
      textMatchScore: v.optional(v.float64()),
    }))),
    traceHit: v.optional(v.boolean()),
    traceId: v.optional(v.id("organicProspectiveTraces")),
    source: v.string(),
    sessionKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const activePolicy = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId).eq("status", "active"))
      .first();
    await ctx.db.insert("organicRecallLog", {
      userId: args.userId,
      query: args.query.slice(0, 500),
      resultCount: args.resultCount,
      topResultIds: args.topResultIds.slice(0, 5),
      candidateSignals: args.candidateSignals?.slice(0, 30),
      traceHit: args.traceHit,
      traceId: args.traceId,
      source: args.source,
      sessionKey: args.sessionKey,
      policyGeneration: activePolicy?.generation ?? 1,
      createdAt: now,
    });

    const stats = await ctx.db
      .query("organicRecallStats")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (stats) {
      await ctx.db.patch(stats._id, {
        totalQueries: stats.totalQueries + 1,
        traceHits: stats.traceHits + (args.traceHit ? 1 : 0),
        totalResultCount: stats.totalResultCount + args.resultCount,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert("organicRecallStats", {
      userId: args.userId,
      totalQueries: 1,
      traceHits: args.traceHit ? 1 : 0,
      totalResultCount: args.resultCount,
      updatedAt: now,
    });
  },
});
