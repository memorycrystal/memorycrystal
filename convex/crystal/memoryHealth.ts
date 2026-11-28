/**
 * ILL-1177: the dashboard's Memory health API.
 *
 * Tenant isolation: the account is always the signed-in identity, or the
 * target of the caller's live impersonation session through
 * resolveEffectiveUserId, the same rule every dashboard page uses. `asUserId`
 * is only a claim checked against that session; it never selects an account
 * on its own.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { stableUserId } from "./auth";
import { resolveEffectiveUserId } from "./publicImpersonation";
import { keyMetrics, scoreSnapshot } from "./memoryHealthRubric";
import { failStalledRuns, insertSnapshot, STALL_MS } from "./memoryHealthCollect";
import { MEMORY_HEALTH_STEPS } from "./memoryHealthModel";

/** Manual runs per account: at most one per hour. */
export const MANUAL_RUN_INTERVAL_MS = 60 * 60 * 1000;
export const HISTORY_LIMIT = 60;

async function effectiveUserId(ctx: any, asUserId?: string): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return resolveEffectiveUserId(ctx, stableUserId(identity.subject), asUserId);
}

/** Score defensively: a rubric bug must not take the page down. */
function safeScore(row: { startedAt: number; metrics: any }) {
  try {
    return scoreSnapshot(row);
  } catch {
    return null;
  }
}

async function runState(ctx: any, userId: string, now: number) {
  const lastManual = await ctx.db
    .query("crystalMemoryHealthSnapshots")
    .withIndex("by_user_trigger_started", (q: any) => q.eq("userId", userId).eq("trigger", "manual"))
    .order("desc")
    .first();
  const latest = await ctx.db
    .query("crystalMemoryHealthSnapshots")
    .withIndex("by_user_started", (q: any) => q.eq("userId", userId))
    .order("desc")
    .first();
  const running = latest?.status === "running" && now - latest.startedAt < STALL_MS;
  const nextAllowedAt = lastManual ? lastManual.startedAt + MANUAL_RUN_INTERVAL_MS : null;
  return {
    running,
    lastManualAt: lastManual?.startedAt ?? null,
    nextAllowedAt: nextAllowedAt !== null && nextAllowedAt > now ? nextAllowedAt : null,
  };
}

export const getMemoryHealth = query({
  args: { asUserId: v.optional(v.string()) },
  handler: async (ctx, { asUserId }) => {
    const userId = await effectiveUserId(ctx, asUserId);
    if (!userId) return null;
    const now = Date.now();
    const rows = await ctx.db
      .query("crystalMemoryHealthSnapshots")
      .withIndex("by_user_started", (q) => q.eq("userId", userId))
      .order("desc")
      .take(HISTORY_LIMIT);

    const history = [];
    for (const row of rows) {
      if (row.status !== "complete") continue;
      const scored = safeScore(row);
      if (!scored) continue;
      history.push({
        startedAt: row.startedAt,
        trigger: row.trigger,
        overall: scored.overall,
        scores: Object.fromEntries(scored.scores.map((c) => [c.key, c.score])),
        ...keyMetrics(row),
      });
    }
    history.reverse();

    const newest = rows[0] ?? null;
    const latestComplete = rows.find((row) => row.status === "complete") ?? null;
    const scored = latestComplete ? safeScore(latestComplete) : null;
    const latest = latestComplete
      ? scored
        ? {
            snapshotId: latestComplete._id,
            trigger: latestComplete.trigger,
            startedAt: latestComplete.startedAt,
            completedAt: latestComplete.completedAt ?? null,
            failedSteps: latestComplete.failedSteps ?? [],
            work: latestComplete.metrics.work ?? null,
            ...scored,
            metrics: keyMetrics(latestComplete),
          }
        : { error: "unscorable" as const, startedAt: latestComplete.startedAt }
      : null;

    const inFlight = newest && newest.status === "running"
      ? {
          startedAt: newest.startedAt,
          step: newest.step ?? null,
          stepIndex: newest.step ? MEMORY_HEALTH_STEPS.indexOf(newest.step) : null,
          steps: MEMORY_HEALTH_STEPS.length,
          // A query does not re-run when time passes, so the page also gets the
          // deadline and re-derives "stalled" from its own clock.
          stallAt: newest.startedAt + STALL_MS,
          stalled: now - newest.startedAt >= STALL_MS,
        }
      : null;
    const lastFailed = newest && newest.status === "failed"
      ? { startedAt: newest.startedAt, reason: newest.failureReason === "stalled" ? ("stalled" as const) : ("failed" as const) }
      : null;

    return { latest, history, inFlight, lastFailed, run: await runState(ctx, userId, now) };
  },
});

export const requestMemoryHealthRun = mutation({
  args: { asUserId: v.optional(v.string()) },
  handler: async (ctx, { asUserId }) => {
    const userId = await effectiveUserId(ctx, asUserId);
    if (!userId) throw new ConvexError({ code: "unauthenticated" });
    const now = Date.now();
    await failStalledRuns(ctx, userId, now);
    const state = await runState(ctx, userId, now);
    if (state.nextAllowedAt !== null) {
      throw new ConvexError({ code: "rate_limited", nextAllowedAt: state.nextAllowedAt });
    }
    if (state.running) throw new ConvexError({ code: "already_running" });
    const snapshotId = await insertSnapshot(ctx, userId, "manual", now);
    await ctx.scheduler.runAfter(0, internal.crystal.memoryHealthCollect.runMemoryHealthStep, {
      snapshotId,
      step: MEMORY_HEALTH_STEPS[0],
      attempt: 0,
      cursor: 0,
    });
    return { startedAt: now, nextAllowedAt: now + MANUAL_RUN_INTERVAL_MS };
  },
});
