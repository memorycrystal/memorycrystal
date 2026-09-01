/**
 * ILL-182 Verbatim Window re-stamp.
 *
 * Code + tests only. Do NOT run the forward migration against production from
 * this change. Re-confirm the ILL-181 zero-backlog gate, then an operator
 * starts the forward mutation after merge with confirm: true (omitted confirm
 * is a dry-run).
 *
 * Forward: expiresAt = min(existing, timestamp + current owner tier window).
 * Never lengthens a window that is already shorter. Also stamps ltmExtracted
 * on rows that already have ltmExtractedAt so expire can seek them.
 *
 * Reverse: expiresAt = timestamp + prior (pre-ILL-182) owner tier window.
 *
 * Both are cursor-paged on by_user_time. No .collect() and no post-index
 * .filter() over crystalMessages.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  PRIOR_STM_TTL_DAYS,
  TIER_STM_TTL_DAYS,
  type UserTier,
} from "../../shared/tierLimits";
import { deriveTier } from "./userProfiles";

export const FORWARD_JOB_NAME = "verbatim-window-restamp";
export const REVERSE_JOB_NAME = "verbatim-window-restamp-reverse";
export const DEFAULT_RESTAMP_BATCH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const restampResult = v.object({
  scanned: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  flaggedExtracted: v.number(),
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
  dryRun: v.boolean(),
});

const restampArgs = {
  cursor: v.optional(v.string()),
  batchSize: v.optional(v.number()),
  dryRun: v.optional(v.boolean()),
  confirm: v.optional(v.boolean()),
  reset: v.optional(v.boolean()),
};

/** Writes require confirm: true. Omitted or dryRun: true stays a dry-run. */
export function isRestampDryRun(args: { dryRun?: boolean; confirm?: boolean }): boolean {
  return !(args.confirm === true && args.dryRun !== true);
}

export function verbatimExpiresAt(timestamp: number, ttlDays: number): number {
  return timestamp + ttlDays * DAY_MS;
}

export function forwardExpiresAt(
  currentExpiresAt: number,
  timestamp: number,
  ttlDays: number,
): number {
  const target = verbatimExpiresAt(timestamp, ttlDays);
  return target < currentExpiresAt ? target : currentExpiresAt;
}

function shouldScheduleMigrationWork() {
  return !(
    typeof process !== "undefined" &&
    (process.env.VITEST || process.env.NODE_ENV === "test")
  );
}

async function resolveOwnerTier(
  ctx: Pick<MutationCtx, "db">,
  userId: string,
  cache: Map<string, UserTier>,
): Promise<UserTier> {
  const cached = cache.get(userId);
  if (cached) return cached;
  const profiles = await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(32);
  const profile = profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const tier = deriveTier(profile);
  cache.set(userId, tier);
  return tier;
}

async function persistJobCursor(
  ctx: Pick<MutationCtx, "db">,
  jobName: string,
  cursor: string | undefined,
): Promise<void> {
  const existing = await ctx.db
    .query("crystalJobCursors")
    .withIndex("by_job", (q) => q.eq("jobName", jobName))
    .unique();
  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, { cursor, updatedAt: now });
    return;
  }
  await ctx.db.insert("crystalJobCursors", {
    jobName,
    cursor,
    updatedAt: now,
  });
}

async function readJobCursor(
  ctx: Pick<MutationCtx, "db">,
  jobName: string,
): Promise<string | null> {
  const existing = await ctx.db
    .query("crystalJobCursors")
    .withIndex("by_job", (q) => q.eq("jobName", jobName))
    .unique();
  return existing?.cursor ?? null;
}

type RestampMode = "forward" | "reverse";

async function runRestampPage(
  ctx: MutationCtx,
  args: {
    cursor?: string;
    batchSize?: number;
    dryRun?: boolean;
    confirm?: boolean;
    reset?: boolean;
  },
  mode: RestampMode,
) {
  const jobName = mode === "forward" ? FORWARD_JOB_NAME : REVERSE_JOB_NAME;
  const batchSize = Math.min(Math.max(Math.trunc(args.batchSize ?? DEFAULT_RESTAMP_BATCH), 1), 200);
  const dryRun = isRestampDryRun(args);
  const windows = mode === "forward" ? TIER_STM_TTL_DAYS : PRIOR_STM_TTL_DAYS;
  const startCursor = args.reset
    ? null
    : (args.cursor ?? await readJobCursor(ctx, jobName));

  const page = await ctx.db
    .query("crystalMessages")
    .withIndex("by_user_time")
    .paginate({ cursor: startCursor, numItems: batchSize });

  const tierCache = new Map<string, UserTier>();
  let updated = 0;
  let unchanged = 0;
  let flaggedExtracted = 0;

  for (const message of page.page) {
    const tier = await resolveOwnerTier(ctx, message.userId, tierCache);
    const nextExpiresAt = mode === "forward"
      ? forwardExpiresAt(message.expiresAt, message.timestamp, windows[tier])
      : verbatimExpiresAt(message.timestamp, windows[tier]);
    const needsExpiresPatch = nextExpiresAt !== message.expiresAt;
    const needsExtractedFlag = mode === "forward"
      && message.ltmExtractedAt !== undefined
      && message.ltmExtracted !== true;

    if (!needsExpiresPatch && !needsExtractedFlag) {
      unchanged += 1;
      continue;
    }

    if (!dryRun) {
      const patch: { expiresAt?: number; ltmExtracted?: boolean } = {};
      if (needsExpiresPatch) patch.expiresAt = nextExpiresAt;
      if (needsExtractedFlag) {
        patch.ltmExtracted = true;
        flaggedExtracted += 1;
      }
      await ctx.db.patch(message._id, patch);
    } else if (needsExtractedFlag) {
      flaggedExtracted += 1;
    }
    updated += 1;
  }

  const continueCursor = page.isDone ? null : page.continueCursor;
  if (!dryRun) {
    await persistJobCursor(ctx, jobName, continueCursor ?? undefined);
  }

  if (!page.isDone && !dryRun && shouldScheduleMigrationWork()) {
    const continuation = mode === "forward"
      ? internal.crystal.verbatimWindowMigration.restampExpiresAt
      : internal.crystal.verbatimWindowMigration.reverseRestampExpiresAt;
    await ctx.scheduler.runAfter(0, continuation, {
      cursor: page.continueCursor,
      batchSize,
      confirm: true,
      dryRun: false,
    });
  }

  return {
    scanned: page.page.length,
    updated,
    unchanged,
    flaggedExtracted,
    isDone: page.isDone,
    continueCursor,
    dryRun,
  };
}

export const restampExpiresAt = internalMutation({
  args: restampArgs,
  returns: restampResult,
  handler: async (ctx, args) => {
    return await runRestampPage(ctx, args, "forward");
  },
});

export const reverseRestampExpiresAt = internalMutation({
  args: restampArgs,
  returns: restampResult,
  handler: async (ctx, args) => {
    return await runRestampPage(ctx, args, "reverse");
  },
});
