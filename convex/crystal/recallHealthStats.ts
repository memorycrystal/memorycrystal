/**
 * ILL-1177: counts-only daily recall aggregate for the Memory health tab.
 *
 * `/api/mcp/recall` returns per-request timings and rerank counts but stores
 * neither, so a health snapshot had nothing to read. After each successful
 * recall the handler enqueues one `recordRecall` write with numbers only:
 * total ms, how many memories and message matches came back, how many
 * characters they carried, and the answer check's candidates/kept/abstained.
 * Never the query, a memory id or any text.
 *
 * Rows are (userId, UTC day, shard). Four shards keep concurrent recalls of
 * one account from conflicting on a single document. Latency is a fixed
 * histogram so p50/p95 can be read back without storing each request.
 */
import { v } from "convex/values";
import { internalMutation, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { logError } from "./crypto";
import { awaitEnqueue } from "./requestEnqueues";

/** Upper edges (ms) of the latency buckets. The last bucket is open-ended. */
export const RECALL_LATENCY_BUCKET_EDGES_MS = [
  100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1250, 1500, 2000, 3000, 5000, 10000,
] as const;
export const RECALL_LATENCY_BUCKETS = RECALL_LATENCY_BUCKET_EDGES_MS.length + 1;
export const RECALL_HEALTH_SHARDS = 4;
/** Daily rows older than this are pruned by the Memory health cron (ILL-1177 part B). */
export const RECALL_HEALTH_RETENTION_DAYS = 35;

export type RecallHealthSample = {
  totalMs: number;
  memories: number;
  messageMatches: number;
  returnedChars: number;
  rerank?: { candidates: number; kept: number; abstained: boolean; fallback: boolean };
};

const finiteCount = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

function textLength(row: any): number {
  if (!row || typeof row !== "object") return 0;
  let chars = 0;
  for (const field of ["title", "content", "summary", "text"]) {
    if (typeof row[field] === "string") chars += row[field].length;
  }
  return chars;
}

/** Counts-only summary of one recall response body. Returns null for a body it cannot read. */
export function summarizeRecallBody(body: Record<string, unknown> | null | undefined): RecallHealthSample | null {
  if (!body || typeof body !== "object") return null;
  const memories = Array.isArray(body.memories) ? body.memories : null;
  if (!memories) return null;
  const messages = Array.isArray(body.messageMatches) ? body.messageMatches : [];
  const diagnostics = (body.diagnostics ?? {}) as Record<string, any>;
  const totalMs = finiteCount(diagnostics?.timings?.total);
  let returnedChars = 0;
  for (const row of memories) returnedChars += textLength(row);
  for (const row of messages) returnedChars += textLength(row);
  const rerank = diagnostics?.rerank;
  return {
    totalMs,
    memories: memories.length,
    messageMatches: messages.length,
    returnedChars,
    ...(rerank && typeof rerank === "object"
      ? {
          rerank: {
            candidates: finiteCount(rerank.candidates),
            kept: finiteCount(rerank.kept),
            abstained: rerank.abstained === true,
            fallback: typeof rerank.fallbackReason === "string",
          },
        }
      : {}),
  };
}

/**
 * The recordRecall args for one /api/mcp/recall outcome, or null when nothing
 * is recorded: a failed request, an unreadable body, or a benchmark key (not
 * tenant traffic).
 */
function recallHealthWrite(
  userId: string,
  outcome: { status: number; body: Record<string, unknown> },
  benchmark: boolean,
): { userId: string; shard: number; sample: RecallHealthSample } | null {
  if (outcome.status !== 200 || benchmark) return null;
  const sample = summarizeRecallBody(outcome.body);
  return sample ? { userId, shard: Math.floor(Math.random() * RECALL_HEALTH_SHARDS), sample } : null;
}

/**
 * Awaits a recall outcome, enqueues its counts-only health write on the
 * request's drain, and returns the outcome unchanged. A failed enqueue is
 * logged and never affects the response.
 */
export async function withRecallHealth<T extends { status: number; body: Record<string, unknown> }>(
  ctx: ActionCtx,
  userId: string,
  benchmark: boolean,
  outcome: Promise<T>,
): Promise<T> {
  const result = await outcome;
  const write = recallHealthWrite(userId, result, benchmark);
  if (write) {
    await awaitEnqueue(ctx, ctx.scheduler.runAfter(0, internal.crystal.recallHealthStats.recordRecall, write).then(
      () => undefined,
      async (error) => console.error("[recallHealth] enqueue failed:", await logError(error)),
    ));
  }
  return result;
}

export function latencyBucketIndex(ms: number): number {
  for (let i = 0; i < RECALL_LATENCY_BUCKET_EDGES_MS.length; i += 1) {
    if (ms <= RECALL_LATENCY_BUCKET_EDGES_MS[i]) return i;
  }
  return RECALL_LATENCY_BUCKET_EDGES_MS.length;
}

/**
 * Percentile from bucket counts, interpolated linearly inside the bucket. The
 * open last bucket reports its lower edge (a floor, never an invented value).
 */
export function histogramPercentile(buckets: number[], p: number): number | null {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return null;
  const target = Math.min(Math.max(p, 0), 1) * total;
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    const count = buckets[i] ?? 0;
    if (count <= 0) continue;
    if (seen + count >= target) {
      const lower = i === 0 ? 0 : RECALL_LATENCY_BUCKET_EDGES_MS[i - 1];
      const upper = RECALL_LATENCY_BUCKET_EDGES_MS[i];
      if (upper === undefined) return lower;
      const within = (target - seen) / count;
      return Math.round(lower + (upper - lower) * within);
    }
    seen += count;
  }
  return RECALL_LATENCY_BUCKET_EDGES_MS[RECALL_LATENCY_BUCKET_EDGES_MS.length - 1];
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

const sampleValidator = v.object({
  totalMs: v.number(),
  memories: v.number(),
  messageMatches: v.number(),
  returnedChars: v.number(),
  rerank: v.optional(v.object({
    candidates: v.number(),
    kept: v.number(),
    abstained: v.boolean(),
    fallback: v.boolean(),
  })),
});

export const recordRecall = internalMutation({
  args: { userId: v.string(), shard: v.number(), sample: sampleValidator },
  handler: async (ctx, { userId, shard, sample }) => {
    const now = Date.now();
    const dayKey = utcDayKey(now);
    const safeShard = Math.min(Math.max(Math.trunc(shard), 0), RECALL_HEALTH_SHARDS - 1);
    const existing = await ctx.db
      .query("crystalRecallHealthDaily")
      .withIndex("by_user_day_shard", (q) => q.eq("userId", userId).eq("dayKey", dayKey).eq("shard", safeShard))
      .first();
    const buckets = existing?.latencyBuckets.slice() ?? new Array(RECALL_LATENCY_BUCKETS).fill(0);
    while (buckets.length < RECALL_LATENCY_BUCKETS) buckets.push(0);
    buckets[latencyBucketIndex(sample.totalMs)] += 1;
    const empty = sample.memories === 0 && sample.messageMatches === 0 ? 1 : 0;
    const rr = sample.rerank;
    const next = {
      recalls: (existing?.recalls ?? 0) + 1,
      emptyRecalls: (existing?.emptyRecalls ?? 0) + empty,
      latencyBuckets: buckets,
      returnedChars: (existing?.returnedChars ?? 0) + sample.returnedChars,
      returnedMemories: (existing?.returnedMemories ?? 0) + sample.memories,
      rerankRuns: (existing?.rerankRuns ?? 0) + (rr && !rr.fallback ? 1 : 0),
      rerankCandidates: (existing?.rerankCandidates ?? 0) + (rr && !rr.fallback ? rr.candidates : 0),
      rerankKept: (existing?.rerankKept ?? 0) + (rr && !rr.fallback ? rr.kept : 0),
      rerankAbstained: (existing?.rerankAbstained ?? 0) + (rr && !rr.fallback && rr.abstained ? 1 : 0),
      rerankFallbacks: (existing?.rerankFallbacks ?? 0) + (rr?.fallback ? 1 : 0),
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, next);
    else await ctx.db.insert("crystalRecallHealthDaily", { userId, dayKey, shard: safeShard, ...next });
  },
});

export type RecallHealthWindow = {
  days: number;
  recalls: number;
  emptyRecalls: number;
  latencyBuckets: number[];
  returnedChars: number;
  returnedMemories: number;
  rerankRuns: number;
  rerankCandidates: number;
  rerankKept: number;
  rerankAbstained: number;
  rerankFallbacks: number;
};

/** Sum of one account's daily rows from `fromDayKey` (inclusive). At most days x shards rows. */
export async function readRecallHealthWindow(
  ctx: { db: any },
  userId: string,
  fromDayKey: string,
  days: number,
): Promise<RecallHealthWindow> {
  const rows = await ctx.db
    .query("crystalRecallHealthDaily")
    .withIndex("by_user_day_shard", (q: any) => q.eq("userId", userId).gte("dayKey", fromDayKey))
    .take(days * RECALL_HEALTH_SHARDS + RECALL_HEALTH_SHARDS);
  const window: RecallHealthWindow = {
    days,
    recalls: 0,
    emptyRecalls: 0,
    latencyBuckets: new Array(RECALL_LATENCY_BUCKETS).fill(0),
    returnedChars: 0,
    returnedMemories: 0,
    rerankRuns: 0,
    rerankCandidates: 0,
    rerankKept: 0,
    rerankAbstained: 0,
    rerankFallbacks: 0,
  };
  for (const row of rows) {
    window.recalls += row.recalls;
    window.emptyRecalls += row.emptyRecalls;
    row.latencyBuckets.forEach((n: number, i: number) => {
      if (i < RECALL_LATENCY_BUCKETS) window.latencyBuckets[i] += n;
    });
    window.returnedChars += row.returnedChars;
    window.returnedMemories += row.returnedMemories;
    window.rerankRuns += row.rerankRuns;
    window.rerankCandidates += row.rerankCandidates;
    window.rerankKept += row.rerankKept;
    window.rerankAbstained += row.rerankAbstained;
    window.rerankFallbacks += row.rerankFallbacks;
  }
  return window;
}

const PRUNE_BATCH = 200;

/** Deletes daily rows older than `beforeDayKey`, one bounded batch per call, rescheduling until done. */
export const pruneRecallHealthDaily = internalMutation({
  args: { beforeDayKey: v.string() },
  handler: async (ctx, { beforeDayKey }) => {
    const rows = await ctx.db
      .query("crystalRecallHealthDaily")
      .withIndex("by_day", (q) => q.lt("dayKey", beforeDayKey))
      .take(PRUNE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    const more = rows.length === PRUNE_BATCH;
    if (more) await ctx.scheduler.runAfter(0, internal.crystal.recallHealthStats.pruneRecallHealthDaily, { beforeDayKey });
    return { deleted: rows.length, more };
  },
});
