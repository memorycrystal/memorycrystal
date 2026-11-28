import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { stableUserId } from "./auth";
import { isDistillationPaused } from "./distillationPause.helper";

const WORKERS = 4;
const LEASE_MS = 5 * 60_000;

async function dispatchQueuedJobs(ctx: any, now: number, paused: boolean) {
  const running = await ctx.db
    .query("crystalDistillationJobs")
    .withIndex("by_state_next", (q: any) => q.eq("state", "running"))
    .take(WORKERS);
  for (const job of running) {
    if ((job.leaseUntil ?? 0) > now) continue;
    if (paused) {
      // A lease that expired while paused is not a worker failure.
      await ctx.db.patch(job._id, {
        state: "queued",
        token: undefined,
        leaseUntil: undefined,
        paused: true,
        nextAt: now,
        updatedAt: now,
      });
      continue;
    }
    const failures = job.failures + 1;
    await ctx.db.patch(job._id, {
      state: failures >= 3 ? "blocked" : "queued",
      failures,
      token: undefined,
      leaseUntil: undefined,
      reason: "worker_lease_expired",
      nextAt: now + 60_000,
      updatedAt: now,
    });
  }
  const active = running.filter((job: any) => (job.leaseUntil ?? 0) > now).length;
  if (paused || active >= WORKERS) return 0;
  const jobs = await ctx.db
    .query("crystalDistillationJobs")
    .withIndex("by_state_next", (q: any) =>
      q.eq("state", "queued").lte("nextAt", now),
    )
    .take(WORKERS - active);
  for (const job of jobs) {
    const token = crypto.randomUUID();
    await ctx.db.patch(job._id, {
      state: "running",
      token,
      leaseUntil: now + LEASE_MS,
      paused: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.crystal.distillationQueue.work, {
      userId: job.userId,
      token,
    });
  }
  return jobs.length;
}

export const enqueue = internalMutation({
  args: { userId: v.string(), cutoff: v.number() },
  handler: async (ctx, args) => {
    const paused = isDistillationPaused();
    const old = await ctx.db
      .query("crystalDistillationJobs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (old) {
      // A newer nightly pass never unblocks failures or steals a worker lease.
      await ctx.db.patch(old._id, {
        cutoff: Math.max(args.cutoff, old.cutoff),
        ...(old.state === "completed"
          ? { state: "queued" as const, nextAt: Date.now() }
          : {}),
        ...(paused ? { paused: true } : {}),
        updatedAt: Date.now(),
      });
    } else
      await ctx.db.insert("crystalDistillationJobs", {
        ...args,
        state: "queued",
        nextAt: Date.now(),
        updatedAt: Date.now(),
        ...(paused ? { paused: true } : {}),
        failures: 0,
        batches: 0,
        memoriesCreated: 0,
        estimatedCostUsd: 0,
      });
    if (!paused)
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.distillationQueue.dispatch,
        {},
      );
  },
});

// Transactional slot allocation prevents overlapping cron/continuation calls
// from exceeding global concurrency. Expired workers are fenced by token.
export const dispatch = internalMutation({
  args: {},
  handler: async (ctx) =>
    dispatchQueuedJobs(ctx, Date.now(), isDistillationPaused()),
});

export const resumePausedDistillation = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (isDistillationPaused())
      return { resumed: 0, moreMayRemain: false, paused: true };
    // Uses the same transactional lease allocation as recovery. Repeated calls
    // cannot schedule a job twice because the first call owns its worker lease.
    const resumed = await dispatchQueuedJobs(ctx, Date.now(), false);
    const moreMayRemain = Boolean(
      await ctx.db
        .query("crystalDistillationJobs")
        .withIndex("by_state_next", (q: any) =>
          q.eq("state", "queued").lte("nextAt", Date.now()),
        )
        .first(),
    );
    return {
      resumed,
      moreMayRemain,
      paused: false,
    };
  },
});

export const nightlyIndexedDistillation = internalAction({
  args: {},
  handler: async (ctx): Promise<{ users: number; scheduledUsers: number; paused?: boolean }> => {
    if (isDistillationPaused())
      return { users: 0, scheduledUsers: 0, paused: true };
    return await ctx.runAction(
      (internal as any).crystal.reflectionCycle.runReflectionCycle,
      {},
    );
  },
});

export const releasePausedLease = internalMutation({
  args: { userId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("crystalDistillationJobs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!job || job.token !== args.token || job.state !== "running") return;
    const paused = isDistillationPaused();
    await ctx.db.patch(job._id, {
      state: "queued",
      token: undefined,
      leaseUntil: undefined,
      paused: paused ? true : undefined,
      nextAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!paused)
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.distillationQueue.dispatch,
        {},
      );
  },
});

export const getJob = internalQuery({
  args: { userId: v.string() },
  handler: (ctx, args) =>
    ctx.db
      .query("crystalDistillationJobs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique(),
});

export const finishBatch = internalMutation({
  args: {
    userId: v.string(),
    token: v.string(),
    state: v.union(
      v.literal("queued"),
      v.literal("blocked"),
      v.literal("completed"),
    ),
    reason: v.optional(v.string()),
    failed: v.boolean(),
    waitUntil: v.optional(v.number()),
    cost: v.number(),
    memories: v.number(),
    cutoff: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("crystalDistillationJobs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!job || job.token !== args.token || job.state !== "running") return;
    // Waiting is neither a failed batch nor a successful reset of the budget.
    const failures = args.failed
      ? job.failures + 1
      : args.waitUntil !== undefined ? job.failures : 0;
    const state =
      failures >= 3
        ? "blocked"
        : args.state === "completed" && job.cutoff > args.cutoff
          ? "queued"
          : args.state;
    const now = Date.now();
    const paused = isDistillationPaused();
    const nextAt = Math.max(
      now + (args.failed ? 60_000 * 2 ** (failures - 1) : 0),
      args.waitUntil !== undefined
        ? args.waitUntil > now ? args.waitUntil : now + 1000
        : now,
    );
    await ctx.db.patch(job._id, {
      state,
      failures,
      reason: args.reason,
      token: undefined,
      leaseUntil: undefined,
      paused: paused && state === "queued" ? true : undefined,
      nextAt,
      updatedAt: Date.now(),
      batches: job.batches + 1,
      memoriesCreated: job.memoriesCreated + args.memories,
      estimatedCostUsd: job.estimatedCostUsd + args.cost,
    });
    if (state === "completed")
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.forgetting.runForgettingForUser,
        { userId: args.userId, now: args.cutoff },
      );
    if (!paused && state === "queued" && nextAt > now)
      await ctx.scheduler.runAfter(
        nextAt - now,
        internal.crystal.distillationQueue.dispatch,
        {},
      );
    if (!paused)
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.distillationQueue.dispatch,
        {},
      );
  },
});

export const work = internalAction({
  args: { userId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.crystal.distillationQueue.getJob, {
      userId: args.userId,
    });
    if (!job || job.token !== args.token || job.state !== "running") return;
    if (isDistillationPaused()) {
      await ctx.runMutation(
        internal.crystal.distillationQueue.releasePausedLease,
        args,
      );
      return;
    }
    let state: "queued" | "blocked" | "completed" = "queued";
    let reason: string | undefined;
    let failed = false;
    let waitUntil: number | undefined;
    let cost = 0;
    let memories = 0;
    try {
      const result = await ctx.runAction(
        internal.crystal.reflectionCycle.runDistillationForUser,
        {
          userId: args.userId,
          now: job.cutoff,
          messagesPerUser: 12,
          maxWindows: 2,
          skipForgetting: true,
        },
      );
      cost = result.estimatedCostUsd ?? 0;
      memories = result.inserted ?? 0;
      const pauseStoppedWindow = result.reason === "distillation_paused";
      reason = pauseStoppedWindow ? undefined : result.reason ?? result.error;
      failed = (result.errors ?? 0) > 0;
      waitUntil = result.waitUntil;
      if (reason?.includes("OPENROUTER_API_KEY")) state = "blocked";
      else {
        const remaining = await ctx.runQuery(
          internal.crystal.ltmExtraction.getReflectionCycleCandidates,
          { userId: args.userId, beforeTimestamp: job.cutoff, limit: 1 },
        );
        if (!remaining.length) {
          const blocked = await ctx.runQuery(
            internal.crystal.distillationQueue.hasBlockedMessages,
            { userId: args.userId, cutoff: job.cutoff },
          );
          state = blocked ? "blocked" : "completed";
          if (blocked) reason = "source_messages_blocked";
        } else if (
          !pauseStoppedWindow &&
          waitUntil === undefined && (
            reason ||
            !result.candidates ||
            (!result.windows && !result.unscoped)
          )
        ) {
          failed = true; // No progress must back off, never hot-loop.
        }
      }
    } catch (error) {
      failed = true;
      reason =
        error instanceof Error
          ? error.message.slice(0, 200)
          : "distillation_failed";
    }
    await ctx.runMutation(internal.crystal.distillationQueue.finishBatch, {
      ...args,
      cutoff: job.cutoff,
      state,
      reason,
      failed,
      waitUntil,
      cost,
      memories,
    });
  },
});

export const hasBlockedMessages = internalQuery({
  args: { userId: v.string(), cutoff: v.number() },
  handler: async (ctx, args) =>
    Boolean(
      await ctx.db
        .query("crystalMessages")
        .withIndex("by_user_ltm_runnable", (q) =>
          q
            .eq("userId", args.userId)
            .eq("ltmExtractedAt", undefined)
            .gt("ltmExtractionBlocked", undefined),
        )
        .filter((q) => q.lte(q.field("timestamp"), args.cutoff))
        .first(),
    ),
});

export const getMyStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const job = await ctx.db
      .query("crystalDistillationJobs")
      .withIndex("by_user", (q) =>
        q.eq("userId", stableUserId(identity.subject)),
      )
      .unique();
    if (!job) return null;
    return isDistillationPaused() || job.paused === true
      ? { ...job, paused: true }
      : job;
  },
});

export const retryMyJob = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    if (isDistillationPaused())
      return { unblocked: 0, moreMayRemain: true, paused: true };
    const userId = stableUserId(identity.subject);
    const job = await ctx.db
      .query("crystalDistillationJobs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (job?.state === "running")
      throw new Error("Distillation is already running");
    // Each click releases a bounded page. Never read all historical attempts.
    const attempts = await ctx.db
      .query("crystalLtmExtractionAttempts")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "blocked"),
      )
      .take(10);
    let unblocked = 0;
    for (const attempt of attempts) {
      for (const id of attempt.messageIds) {
        const message = await ctx.db.get(id);
        if (message?.userId !== userId || message.ltmExtractedAt !== undefined)
          continue;
        await ctx.db.patch(id, {
          ltmExtractionBlocked: undefined,
          ltmExtractionRetryAt: undefined,
        });
        unblocked += 1;
      }
      await ctx.db.patch(attempt._id, {
        status: "retry",
        attempts: 0,
        retryAt: Date.now(),
      });
    }
    if (job)
      await ctx.db.patch(job._id, {
        state: "queued",
        failures: 0,
        reason: undefined,
        nextAt: Date.now(),
        updatedAt: Date.now(),
      });
    await ctx.scheduler.runAfter(
      0,
      internal.crystal.distillationQueue.dispatch,
      {},
    );
    return { unblocked, moreMayRemain: attempts.length === 10 };
  },
});
