/**
 * ILL-1177: daily Memory health snapshot, one bounded run per account.
 *
 * Why not reuse auditLtmFluff: it runs auditLtmDuplicates (a full scan of
 * every active row plus up to 800 nested vector-search actions) and then a
 * second full scan, all inside one action. On a 78k-row account that is two
 * passes over ~385 pages of ~150 large documents (legacy rows still carry a
 * ~50 KiB inline embedding) in a single execution, so it runs into the
 * action's time and memory ceilings before it returns. A health snapshot must
 * cost the same on a 500-row account as on a 78k-row one, so nothing here
 * scans an account. Counts come from aggregates (crystalDashboardTotals,
 * crystalRecallHealthDaily, crystalGeminiDailyUsage), the STM backlog reads a
 * capped index range of undistilled rows, and duplicates, fluff and accuracy
 * come from a fixed-size random sample. The ltmHygiene classifiers and its
 * one-search-per-execution near-duplicate action are reused on that sample.
 *
 * Each step is its own scheduled action. A step writes its section and
 * schedules the next one, so a failure costs one step: it is retried twice
 * with backoff, then recorded in `failedSteps` and skipped (its categories
 * score "not measured") while the later steps still run.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { isTerminallyProcessed } from "./messageRetirement";
import { readRecallHealthWindow, utcDayKey, RECALL_HEALTH_RETENTION_DAYS } from "./recallHealthStats";
import { memoryHealthMetrics, memoryHealthStep, MEMORY_HEALTH_STEPS, type MemoryHealthMetrics, type MemoryHealthStep, type MemoryHealthWork } from "./memoryHealthModel";
import { runProbeStep } from "./memoryHealthProbe";
import { approxDocBytes, sampleStep } from "./memoryHealthSample";
import { logError } from "./crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOW_DAYS = 7;
/** Snapshots read to find the probe's own embeddings in the cost window (at most ~25 runs a day). */
const PROBE_RUNS_SCAN_CAP = 200;
/** Accounts whose totals row changed in this window get a daily snapshot. */
export const ACTIVE_ACCOUNT_WINDOW_MS = 30 * DAY_MS;
export const FANOUT_PAGE_SIZE = 100;
/** Gap between account starts, so a page of accounts does not start at once. */
export const FANOUT_STAGGER_MS = 3_000;
export const SNAPSHOT_RETENTION_DAYS = 180;
export const STEP_RETRIES = 2;
const STEP_RETRY_BACKOFF_MS = 30_000;

export const STM_PAGE_SIZE = 100;
export const STM_MAX_PAGES = 5;

type Work = MemoryHealthWork;
export const emptyWork = (): Work => ({ functionCalls: 0, docsRead: 0, bytesRead: 0, vectorSearches: 0, embeddingCalls: 0, recallRuns: 0 });

/** Wraps an action ctx so every function call the step makes is counted. */
export function countingCtx(ctx: ActionCtx, work: Work): ActionCtx {
  const count = <T extends (...a: any[]) => any>(fn: T): T => ((...a: any[]) => {
    work.functionCalls += 1;
    return fn(...a);
  }) as T;
  return {
    ...ctx,
    runQuery: count(ctx.runQuery.bind(ctx)),
    runMutation: count(ctx.runMutation.bind(ctx)),
    runAction: count(ctx.runAction.bind(ctx)),
  } as ActionCtx;
}

// ── Snapshot lifecycle ────────────────────────────────────────────────────────

export async function insertSnapshot(ctx: MutationCtx, userId: string, trigger: "cron" | "manual", now: number) {
  const snapshotId = await ctx.db.insert("crystalMemoryHealthSnapshots", {
    userId,
    trigger,
    dayKey: utcDayKey(now),
    status: "running",
    step: MEMORY_HEALTH_STEPS[0],
    attempt: 0,
    startedAt: now,
    metrics: {},
  });
  return snapshotId;
}

/** A run still "running" after this long is closed as failed ("stalled") before a new one starts. */
export const STALL_MS = 2 * 60 * 60 * 1000;

/**
 * Closes this account's runs that are still "running" after STALL_MS as
 * failed with reason "stalled". A late step of such a run is then a no-op,
 * because finishStep and failStep only act on running rows.
 */
export async function failStalledRuns(ctx: MutationCtx, userId: string, now: number): Promise<number> {
  const recent = await ctx.db
    .query("crystalMemoryHealthSnapshots")
    .withIndex("by_user_started", (q) => q.eq("userId", userId).lte("startedAt", now - STALL_MS))
    .order("desc")
    .take(5);
  let closed = 0;
  for (const row of recent) {
    if (row.status !== "running") continue;
    await ctx.db.patch(row._id, { status: "failed", failureReason: "stalled", step: undefined, attempt: undefined, completedAt: now });
    closed += 1;
  }
  return closed;
}

export function isActiveAccount(totals: Pick<Doc<"crystalDashboardTotals">, "activeMemories" | "totalMessages" | "updatedAt">, now: number): boolean {
  return (totals.activeMemories > 0 || totals.totalMessages > 0) && totals.updatedAt >= now - ACTIVE_ACCOUNT_WINDOW_MS;
}

/**
 * Daily fan-out. Pages crystalDashboardTotals (one small row per account) and
 * schedules one run per active account that has no cron snapshot today, then
 * schedules itself for the next page. The first page also starts the prunes.
 */
export const startDailyMemoryHealth = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), scheduled: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const dayKey = utcDayKey(now);
    if (!args.cursor) {
      await ctx.scheduler.runAfter(0, internal.crystal.recallHealthStats.pruneRecallHealthDaily, {
        beforeDayKey: utcDayKey(now - RECALL_HEALTH_RETENTION_DAYS * DAY_MS),
      });
      await ctx.scheduler.runAfter(0, internal.crystal.memoryHealthCollect.pruneSnapshots, {
        before: now - SNAPSHOT_RETENTION_DAYS * DAY_MS,
      });
      await ctx.scheduler.runAfter(0, internal.crystal.memoryHealthProbe.pruneSearchSlots, {
        beforeDayKey: utcDayKey(now - 2 * DAY_MS),
      });
    }
    const page = await ctx.db.query("crystalDashboardTotals").paginate({ cursor: args.cursor ?? null, numItems: FANOUT_PAGE_SIZE });
    let scheduled = args.scheduled ?? 0;
    for (const totals of page.page) {
      if (!isActiveAccount(totals, now)) continue;
      await failStalledRuns(ctx, totals.userId, now);
      const today = await ctx.db
        .query("crystalMemoryHealthSnapshots")
        .withIndex("by_user_day", (q) => q.eq("userId", totals.userId).eq("dayKey", dayKey))
        .filter((q) => q.eq(q.field("trigger"), "cron"))
        .first();
      if (today) continue;
      const snapshotId = await insertSnapshot(ctx, totals.userId, "cron", now);
      await ctx.scheduler.runAfter(scheduled * FANOUT_STAGGER_MS, internal.crystal.memoryHealthCollect.runMemoryHealthStep, {
        snapshotId,
        step: MEMORY_HEALTH_STEPS[0],
        attempt: 0,
        cursor: 0,
      });
      scheduled += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.crystal.memoryHealthCollect.startDailyMemoryHealth, {
        cursor: page.continueCursor,
        scheduled,
      });
    }
    return { scanned: page.page.length, scheduled, isDone: page.isDone };
  },
});

const PRUNE_BATCH = 200;

export const pruneSnapshots = internalMutation({
  args: { before: v.number() },
  handler: async (ctx, { before }) => {
    const rows = await ctx.db
      .query("crystalMemoryHealthSnapshots")
      .withIndex("by_started", (q) => q.lt("startedAt", before))
      .take(PRUNE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === PRUNE_BATCH) await ctx.scheduler.runAfter(0, internal.crystal.memoryHealthCollect.pruneSnapshots, { before });
    return { deleted: rows.length };
  },
});

export const getSnapshotForStep = internalQuery({
  args: { snapshotId: v.id("crystalMemoryHealthSnapshots") },
  handler: async (ctx, { snapshotId }) => {
    const row = await ctx.db.get(snapshotId);
    if (!row) return null;
    return {
      userId: row.userId,
      status: row.status,
      step: row.step,
      startedAt: row.startedAt,
      dayKey: row.dayKey,
      probeTargets: row.probeTargets ?? [],
      attempt: row.attempt ?? 0,
      probeCursor: row.probeCursor ?? 0,
      probe: row.metrics.probe ?? null,
    };
  },
});

const workValidator = v.object({
  functionCalls: v.number(),
  docsRead: v.number(),
  bytesRead: v.number(),
  vectorSearches: v.number(),
  embeddingCalls: v.number(),
  recallRuns: v.number(),
});

function nextStep(step: MemoryHealthStep): MemoryHealthStep | null {
  const index = MEMORY_HEALTH_STEPS.indexOf(step);
  return MEMORY_HEALTH_STEPS[index + 1] ?? null;
}

function addWork(a: Work | undefined, b: Work): Work {
  const base = a ?? emptyWork();
  return {
    functionCalls: base.functionCalls + b.functionCalls,
    docsRead: base.docsRead + b.docsRead,
    bytesRead: base.bytesRead + b.bytesRead,
    vectorSearches: base.vectorSearches + b.vectorSearches,
    embeddingCalls: base.embeddingCalls + b.embeddingCalls,
    recallRuns: base.recallRuns + b.recallRuns,
  };
}

/**
 * True when a step invocation is the one the row is waiting for. Every
 * scheduled step carries the attempt and probe cursor that were written to the
 * row when it was scheduled; a late finish or failure from an older attempt or
 * batch must not move the run.
 */
function isCurrent(row: Doc<"crystalMemoryHealthSnapshots"> | null, step: MemoryHealthStep, attempt: number, cursor: number) {
  return row !== null && row.status === "running" && row.step === step
    && (row.attempt ?? 0) === attempt && (row.probeCursor ?? 0) === cursor;
}

async function moveOn(ctx: MutationCtx, snapshotId: Id<"crystalMemoryHealthSnapshots">, step: MemoryHealthStep, patch: Record<string, unknown>) {
  const next = nextStep(step);
  if (next) {
    await ctx.db.patch(snapshotId, { ...patch, step: next, attempt: 0, probeCursor: undefined });
    await ctx.scheduler.runAfter(0, internal.crystal.memoryHealthCollect.runMemoryHealthStep, { snapshotId, step: next, attempt: 0, cursor: 0 });
  } else {
    await ctx.db.patch(snapshotId, { ...patch, step: undefined, attempt: undefined, status: "complete", completedAt: Date.now() });
  }
}

/** Writes one step's section and work, then schedules the next step or completes the run. */
export const finishStep = internalMutation({
  args: {
    snapshotId: v.id("crystalMemoryHealthSnapshots"),
    step: memoryHealthStep,
    metrics: memoryHealthMetrics,
    work: workValidator,
    probeTargets: v.optional(v.array(v.id("crystalMemories"))),
    /** Set when the step has more batches: store the cursor and run the same step again. */
    nextCursor: v.optional(v.number()),
    attempt: v.number(),
    cursor: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.snapshotId);
    // A duplicate or late delivery of an attempt or batch the row has moved past is a no-op.
    if (!row || !isCurrent(row, args.step, args.attempt, args.cursor)) return;
    const metrics: MemoryHealthMetrics = { ...row.metrics, ...args.metrics };
    // The wrapper does not see the step action itself, its snapshot read or this write.
    metrics.work = addWork(row.metrics.work, { ...args.work, functionCalls: args.work.functionCalls + 3 });
    if (args.nextCursor !== undefined) {
      await ctx.db.patch(args.snapshotId, { metrics, probeCursor: args.nextCursor, attempt: 0 });
      await ctx.scheduler.runAfter(0, internal.crystal.memoryHealthCollect.runMemoryHealthStep, {
        snapshotId: args.snapshotId,
        step: args.step,
        attempt: 0,
        cursor: args.nextCursor,
      });
      return;
    }
    await moveOn(ctx, args.snapshotId, args.step, {
      metrics,
      ...(args.probeTargets ? { probeTargets: args.probeTargets } : {}),
    });
  },
});

/** Retries a failed step with backoff; after STEP_RETRIES, records it and moves on. */
export const failStep = internalMutation({
  args: { snapshotId: v.id("crystalMemoryHealthSnapshots"), step: memoryHealthStep, attempt: v.number(), cursor: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.snapshotId);
    if (!row || !isCurrent(row, args.step, args.attempt, args.cursor)) return;
    if (args.attempt < STEP_RETRIES) {
      const attempt = args.attempt + 1;
      await ctx.db.patch(args.snapshotId, { attempt });
      await ctx.scheduler.runAfter(STEP_RETRY_BACKOFF_MS * attempt, internal.crystal.memoryHealthCollect.runMemoryHealthStep, {
        snapshotId: args.snapshotId,
        step: args.step,
        attempt,
        cursor: args.cursor,
      });
      return;
    }
    const failedSteps = [...(row.failedSteps ?? []), args.step];
    if (failedSteps.length === MEMORY_HEALTH_STEPS.length) {
      await ctx.db.patch(args.snapshotId, { failedSteps, step: undefined, attempt: undefined, status: "failed", completedAt: Date.now() });
      return;
    }
    await moveOn(ctx, args.snapshotId, args.step, { failedSteps });
  },
});

type StepOutput = { metrics: MemoryHealthMetrics; probeTargets?: Id<"crystalMemories">[]; nextCursor?: number };
type StepInput = {
  snapshotId: Id<"crystalMemoryHealthSnapshots">;
  userId: string;
  startedAt: number;
  dayKey: string;
  probeTargets: Id<"crystalMemories">[];
  probeCursor: number;
  probe: NonNullable<MemoryHealthMetrics["probe"]> | null;
};

export const runMemoryHealthStep = internalAction({
  args: { snapshotId: v.id("crystalMemoryHealthSnapshots"), step: memoryHealthStep, attempt: v.number(), cursor: v.number() },
  handler: async (ctx, args) => {
    const snapshot = await ctx.runQuery(internal.crystal.memoryHealthCollect.getSnapshotForStep, { snapshotId: args.snapshotId });
    // Only the invocation the row is waiting for does any work.
    if (!snapshot || snapshot.status !== "running" || snapshot.step !== args.step
      || snapshot.attempt !== args.attempt || snapshot.probeCursor !== args.cursor) return;
    const work = emptyWork();
    const counted = countingCtx(ctx, work);
    const input: StepInput = { snapshotId: args.snapshotId, ...snapshot };
    try {
      const output = await runStep(counted, args.step, input, work);
      await ctx.runMutation(internal.crystal.memoryHealthCollect.finishStep, {
        snapshotId: args.snapshotId,
        step: args.step,
        metrics: output.metrics,
        work,
        ...(output.probeTargets ? { probeTargets: output.probeTargets } : {}),
        ...(output.nextCursor !== undefined ? { nextCursor: output.nextCursor } : {}),
        attempt: args.attempt,
        cursor: args.cursor,
      });
    } catch (error) {
      console.error("[memoryHealth] step failed:", await logError(error, snapshot.userId));
      await ctx.runMutation(internal.crystal.memoryHealthCollect.failStep, args);
    }
  },
});

async function runStep(ctx: ActionCtx, step: MemoryHealthStep, input: StepInput, work: Work): Promise<StepOutput> {
  switch (step) {
    case "store":
      return storeStep(ctx, input, work);
    case "stm":
      return stmStep(ctx, input, work);
    case "sample":
      return sampleStep(ctx, input, work);
    case "probe": {
      const batch = await runProbeStep(ctx, input, work);
      return { metrics: { probe: batch.section }, ...(batch.nextCursor !== null ? { nextCursor: batch.nextCursor } : {}) };
    }
  }
}

// ── store: aggregates ─────────────────────────────────────────────────────────

// Published per-1M-token rates; the same estimate the hosted cost dashboard
// makes from crystalGeminiDailyUsage (chars / 4 = tokens, 300 output tokens
// per generation). The hosted module is not in the public mirror.
const EMBED_USD_PER_1M = 0.15;
const GENERATE_USD_PER_1M = { input: 0.1, output: 0.4 };
const GENERATE_OUTPUT_TOKENS = 300;
const tokens = (chars: number) => Math.ceil(Math.max(chars, 0) / 4);

type UsageRow = {
  callCount?: number; estimatedInputChars?: number; generateContentCalls?: number;
  embedContentCalls?: number; batchEmbedContentsCalls?: number; batchEmbedContentItems?: number;
};

/**
 * A usage row minus `probeCalls` single embeddings made by the Memory health
 * probe (source memory_health_probe). The row only aggregates per day, so
 * their input chars are taken out at the row's average chars per call.
 */
export function withoutProbeCalls<T extends UsageRow>(row: T, probeCalls: number): T & { excluded: number } {
  const embed = Math.max(row.embedContentCalls ?? 0, 0);
  const excluded = Math.min(Math.max(probeCalls, 0), embed);
  if (excluded === 0) return { ...row, excluded: 0 };
  const calls = Math.max(row.callCount ?? 0, 1);
  const charsPerCall = Math.max(row.estimatedInputChars ?? 0, 0) / calls;
  return {
    ...row,
    embedContentCalls: embed - excluded,
    callCount: Math.max((row.callCount ?? 0) - excluded, 0),
    estimatedInputChars: Math.max((row.estimatedInputChars ?? 0) - charsPerCall * excluded, 0),
    excluded,
  };
}

/** Estimated model spend for one crystalGeminiDailyUsage row. */
export function estimateModelSpendUsd(row: {
  callCount?: number; estimatedInputChars?: number; generateContentCalls?: number;
  embedContentCalls?: number; batchEmbedContentsCalls?: number; batchEmbedContentItems?: number;
}): number {
  const generate = Math.max(row.generateContentCalls ?? 0, 0);
  const embed = Math.max(row.embedContentCalls ?? 0, 0);
  const batchCalls = Math.max(row.batchEmbedContentsCalls ?? 0, 0);
  const batchItems = Math.max(row.batchEmbedContentItems ?? 0, 0);
  const charsPerCall = Math.max(row.estimatedInputChars ?? 0, 0) / Math.max(generate + embed + batchCalls, row.callCount ?? 0, 1);
  const embedUsd = (tokens(charsPerCall * (embed + Math.max(batchItems, batchCalls))) / 1e6) * EMBED_USD_PER_1M;
  const generateUsd = (tokens(charsPerCall * generate) / 1e6) * GENERATE_USD_PER_1M.input
    + ((generate * GENERATE_OUTPUT_TOKENS) / 1e6) * GENERATE_USD_PER_1M.output;
  return embedUsd + generateUsd;
}

export const readStoreInputs = internalQuery({
  args: { userId: v.string(), fromDayKey: v.string(), days: v.number() },
  handler: async (ctx, { userId, fromDayKey, days }) => {
    const totals = await ctx.db.query("crystalDashboardTotals").withIndex("by_user", (q) => q.eq("userId", userId)).first();
    const recall = await readRecallHealthWindow(ctx, userId, fromDayKey, days);
    const usage = await ctx.db
      .query("crystalGeminiDailyUsage")
      .withIndex("by_user_date", (q) => q.eq("userId", userId).gte("dateKey", fromDayKey))
      .take(days + 1);
    // This page's own probe embeddings land in the same usage rows; count them per day to take them out.
    const fromMs = Date.parse(`${fromDayKey}T00:00:00Z`);
    const runs = await ctx.db
      .query("crystalMemoryHealthSnapshots")
      .withIndex("by_user_started", (q) => q.eq("userId", userId).gte("startedAt", fromMs))
      .take(PROBE_RUNS_SCAN_CAP);
    const probeCallsByDay: Record<string, number> = {};
    for (const run of runs) {
      const calls = run.metrics.probe?.embeddingCalls ?? 0;
      if (calls > 0) probeCallsByDay[run.dayKey] = (probeCallsByDay[run.dayKey] ?? 0) + calls;
    }
    const docsRead = (totals ? 1 : 0) + usage.length + runs.length;
    const bytesRead = approxDocBytes(totals) + approxDocBytes(usage) + approxDocBytes(runs);
    return { totals, recall, usage, probeCallsByDay, docsRead, bytesRead };
  },
});

async function storeStep(ctx: ActionCtx, input: StepInput, work: Work): Promise<StepOutput> {
  const fromDayKey = utcDayKey(input.startedAt - (WINDOW_DAYS - 1) * DAY_MS);
  const read = await ctx.runQuery(internal.crystal.memoryHealthCollect.readStoreInputs, { userId: input.userId, fromDayKey, days: WINDOW_DAYS });
  work.docsRead += read.docsRead;
  work.bytesRead += read.bytesRead;
  const metrics: MemoryHealthMetrics = { recall: read.recall };
  const t = read.totals;
  if (t) {
    metrics.store = {
      activeMemories: t.activeMemories,
      knowledgeBaseMemories: t.knowledgeBaseMemories ?? 0,
      archivedMemories: t.archivedMemories,
      ...(typeof t.activeRecalledMemories === "number" ? { activeRecalledMemories: t.activeRecalledMemories } : {}),
      totalMessages: t.totalMessages,
      ...(typeof t.lastCaptureCreatedAt === "number" ? { lastCaptureAt: t.lastCaptureCreatedAt } : {}),
    };
  }
  // Cost is the tenant's own spend: this page's probe embeddings are taken out of each day's row.
  const rows = read.usage.map((row) => withoutProbeCalls(row, read.probeCallsByDay[row.dateKey] ?? 0));
  let embedCalls = 0;
  let generateCalls = 0;
  let providerCalls = 0;
  let inputChars = 0;
  let probeCallsExcluded = 0;
  for (const row of rows) {
    embedCalls += (row.embedContentCalls ?? 0) + (row.batchEmbedContentItems ?? 0);
    generateCalls += row.generateContentCalls ?? 0;
    providerCalls += row.callCount ?? 0;
    inputChars += row.estimatedInputChars ?? 0;
    probeCallsExcluded += row.excluded;
  }
  metrics.cost = {
    days: WINDOW_DAYS,
    providerCalls,
    embedCalls,
    generateCalls,
    inputChars,
    probeCallsExcluded,
    estimatedUsd: Math.round(rows.reduce((sum, row) => sum + estimateModelSpendUsd(row), 0) * 10000) / 10000,
  };
  return { metrics };
}

// ── stm: capped backlog of undistilled rows ───────────────────────────────────

export const readStmPendingPage = internalQuery({
  args: { userId: v.string(), cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, { userId, cursor, numItems }) => {
    const page = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_ltm_extracted_time", (q) => q.eq("userId", userId).eq("ltmExtractedAt", undefined))
      .paginate({ cursor, numItems: Math.min(Math.max(numItems, 1), STM_PAGE_SIZE) });
    let pending = 0;
    let oldestPendingAt: number | undefined;
    for (const message of page.page) {
      if (message.retiredAt || isTerminallyProcessed(message)) continue;
      pending += 1;
      if (oldestPendingAt === undefined || message.timestamp < oldestPendingAt) oldestPendingAt = message.timestamp;
    }
    let lastMessageAt: number | undefined;
    let extraDocs = 0;
    if (cursor === null) {
      const latest = await ctx.db.query("crystalMessages").withIndex("by_user_time", (q) => q.eq("userId", userId)).order("desc").first();
      lastMessageAt = latest?.timestamp;
      extraDocs = latest ? 1 : 0;
    }
    return {
      pending,
      oldestPendingAt,
      lastMessageAt,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      docsRead: page.page.length + extraDocs,
      bytesRead: approxDocBytes(page.page),
    };
  },
});

async function stmStep(ctx: ActionCtx, input: StepInput, work: Work): Promise<StepOutput> {
  let cursor: string | null = null;
  let pending = 0;
  let oldestPendingAt: number | undefined;
  let lastMessageAt: number | undefined;
  let capped = false;
  for (let page = 0; page < STM_MAX_PAGES; page += 1) {
    const read: {
      pending: number; oldestPendingAt?: number; lastMessageAt?: number; isDone: boolean; continueCursor: string; docsRead: number; bytesRead: number;
    } = await ctx.runQuery(internal.crystal.memoryHealthCollect.readStmPendingPage, { userId: input.userId, cursor, numItems: STM_PAGE_SIZE });
    work.docsRead += read.docsRead;
    work.bytesRead += read.bytesRead;
    pending += read.pending;
    if (read.oldestPendingAt !== undefined && (oldestPendingAt === undefined || read.oldestPendingAt < oldestPendingAt)) oldestPendingAt = read.oldestPendingAt;
    if (page === 0) lastMessageAt = read.lastMessageAt;
    if (read.isDone) break;
    cursor = read.continueCursor;
    if (page === STM_MAX_PAGES - 1) capped = true;
  }
  return {
    metrics: {
      stm: {
        pendingExtraction: pending,
        pendingCapped: capped,
        ...(oldestPendingAt !== undefined ? { oldestPendingAt } : {}),
        ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
      },
    },
  };
}
