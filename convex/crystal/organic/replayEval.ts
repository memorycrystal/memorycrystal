import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { stableUserId } from "../auth";

const REPLAY_SAMPLE_LIMIT = 200;
const REPLAY_WINDOW_MS = 30 * 60 * 1000;
const replayEvalApi = ((internal as any).crystal.organic.replayEval) as any;
const policyTunerApi = ((internal as any).crystal.organic.policyTuner) as any;

export type ReplayActivityEvent = {
  memoryId: string;
  eventType: "memory_stored" | "memory_recalled" | "memory_expired" | "memory_archived";
  timestamp: number;
};

type ReplaySampleInput = {
  query: string;
  topResultIds: string[];
  activities: ReplayActivityEvent[];
};

export type ReplaySampleScore = {
  query: string;
  relevantMemoryIds: string[];
  hitCount: number;
  missedCount: number;
  groundingScore: number;
  coverageScore: number;
  precisionScore: number;
  compositeScore: number;
  reason: string;
};

type ActivityWindowEvent = {
  memoryId: string;
  eventType: ReplayActivityEvent["eventType"];
  timestamp: number;
};

type ActivityWindowResult = {
  events: ActivityWindowEvent[];
  truncated: boolean;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const dedupeIds = (values: string[]) => Array.from(new Set(values.map((value) => String(value))));

export const scoreReplaySample = ({
  query,
  topResultIds,
  activities,
}: ReplaySampleInput): ReplaySampleScore => {
  const rankedIds = dedupeIds(topResultIds);
  const relevantMemoryIds = dedupeIds(
    activities
      .filter((activity) => activity.eventType === "memory_recalled" || activity.eventType === "memory_stored")
      .map((activity) => activity.memoryId)
  );
  const relevantSet = new Set(relevantMemoryIds);
  const hits = rankedIds.filter((memoryId) => relevantSet.has(memoryId));
  const hitCount = hits.length;
  const missedCount = relevantMemoryIds.filter((memoryId) => !rankedIds.includes(memoryId)).length;
  const denominator = rankedIds.length || 1;
  const relevanceDenominator = hitCount + missedCount;
  const groundingScore = clamp01(hitCount / denominator);
  const precisionScore = groundingScore;
  const coverageScore = relevanceDenominator > 0 ? clamp01(hitCount / relevanceDenominator) : 0;
  const compositeScore = clamp01(
    groundingScore * 0.5 + coverageScore * 0.5
  );
  const reason =
    relevanceDenominator === 0
      ? "No follow-up memory activity observed in the replay window."
      : `Hit ${hitCount} followed memories and missed ${missedCount} relevant follow-up memories.`;

  return {
    query,
    relevantMemoryIds,
    hitCount,
    missedCount,
    groundingScore,
    coverageScore,
    precisionScore,
    compositeScore,
    reason,
  };
};

export const getRecentReplaySamples = internalQuery({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? REPLAY_SAMPLE_LIMIT, REPLAY_SAMPLE_LIMIT);
    return ctx.db
      .query("organicRecallLog")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(limit)
      .then((rows) => rows.filter((row) => row.topResultIds.length > 0));
  },
});

export const getActivityWindow = internalQuery({
  args: { userId: v.string(), start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("organicActivityLog")
      .withIndex("by_user_time", (q) => q.eq("userId", args.userId).gte("timestamp", args.start).lte("timestamp", args.end))
      .take(500);
    return {
      events: rows.map((row) => ({
        memoryId: String(row.memoryId),
        eventType: row.eventType,
        timestamp: row.timestamp,
      })),
      truncated: rows.length >= 500,
    };
  },
});

const normalizeActivityWindowResult = (
  activityWindow: ActivityWindowResult | ActivityWindowEvent[]
): ActivityWindowResult => {
  if (Array.isArray(activityWindow)) {
    return { events: activityWindow, truncated: false };
  }
  return activityWindow;
};

export const insertReplayReport = internalMutation({
  args: {
    userId: v.string(),
    sampleCount: v.number(),
    groundingScore: v.float64(),
    coverageScore: v.float64(),
    precisionScore: v.float64(),
    compositeScore: v.float64(),
    worstQueries: v.array(v.object({
      query: v.string(),
      score: v.float64(),
      reason: v.string(),
    })),
    policyGeneration: v.number(),
    generationDelta: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("organicReplayReports", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const getReplayReports = internalQuery({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 50);
    const reports = await ctx.db
      .query("organicReplayReports")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(limit);

    return reports.map((report, index) => {
      const previous = reports[index + 1] ?? null;
      const weekOverWeekDelta = previous ? report.compositeScore - previous.compositeScore : undefined;
      return {
        ...report,
        weekOverWeekDelta,
      };
    });
  },
});

export const getMyReplayReports = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }
    const userId = stableUserId(identity.subject);
    return ctx.runQuery(replayEvalApi.getReplayReports, {
      userId,
      limit: args.limit,
    });
  },
});

export const runReplayEvaluation = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const samples = await ctx.runQuery(replayEvalApi.getRecentReplaySamples, {
      userId: args.userId,
      limit: REPLAY_SAMPLE_LIMIT,
    });
    const policyState = await ctx.runQuery(policyTunerApi.getActivePolicyState, {
      userId: args.userId,
    });
    const policyGeneration = policyState?.generation ?? 1;

    const scored = [];
    for (const sample of samples) {
      const activityWindow = normalizeActivityWindowResult(await ctx.runQuery(replayEvalApi.getActivityWindow, {
        userId: args.userId,
        start: sample.createdAt,
        end: sample.createdAt + REPLAY_WINDOW_MS,
      }));
      scored.push(
        scoreReplaySample({
          query: sample.query,
          topResultIds: sample.topResultIds.map((memoryId: any) => String(memoryId)),
          activities: activityWindow.events,
        })
      );
    }

    const sampleCount = scored.length;
    const aggregate = scored.reduce(
      (acc, sample) => {
        acc.groundingScore += sample.groundingScore;
        acc.coverageScore += sample.coverageScore;
        acc.precisionScore += sample.precisionScore;
        acc.compositeScore += sample.compositeScore;
        return acc;
      },
      { groundingScore: 0, coverageScore: 0, precisionScore: 0, compositeScore: 0 }
    );
    const divisor = sampleCount || 1;
    const groundingScore = aggregate.groundingScore / divisor;
    const coverageScore = aggregate.coverageScore / divisor;
    const precisionScore = aggregate.precisionScore / divisor;
    const compositeScore = aggregate.compositeScore / divisor;
    const worstQueries = [...scored]
      .sort((a, b) => a.compositeScore - b.compositeScore)
      .slice(0, 5)
      .map((sample) => ({
        query: sample.query,
        score: sample.compositeScore,
        reason: sample.reason,
      }));

    const recentReports = await ctx.runQuery(replayEvalApi.getReplayReports, {
      userId: args.userId,
      limit: 1,
    });
    const generationDelta = recentReports[0] ? compositeScore - recentReports[0].compositeScore : undefined;

    await ctx.runMutation(replayEvalApi.insertReplayReport, {
      userId: args.userId,
      sampleCount,
      groundingScore,
      coverageScore,
      precisionScore,
      compositeScore,
      worstQueries,
      policyGeneration,
      generationDelta,
    });

    return {
      sampleCount,
      groundingScore,
      coverageScore,
      precisionScore,
      compositeScore,
      worstQueries,
      policyGeneration,
      generationDelta,
    };
  },
});
