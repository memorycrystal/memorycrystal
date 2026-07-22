// Wave 2 — lazy recallText backfill (Organic background pulse).
//
// Compresses old memories that predate the forward-only recallText writer, in
// small bounded batches over time. No synchronous mass migration: one bounded
// tick fans out across a rotating slice of users, each processing at most
// MAX_PER_USER rows. Fully idempotent — rows that already have a recallText are
// skipped by the index range, and compressRecallText is deterministic so a
// re-run produces identical output. The full `content` field is never touched,
// so the transform is safe and reversible-by-fallback.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { classifyChunkKind, compressRecallText } from "../recallCompression";

const DEFAULT_USERS_PER_TICK = 10;
const MAX_USERS_PER_TICK = 200;
const DEFAULT_MAX_PER_USER = 25;
const MAX_MAX_PER_USER = 200;
// Persistent rotation cursor (crystalJobCursors) so each hourly tick reads only
// one page of user profiles instead of collecting the whole table.
const JOB_NAME = "organic-recall-compression-backfill";

const clampInt = (value: number | undefined, min: number, max: number, fallback: number) => {
  const raw = Number.isFinite(value ?? NaN) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(raw, min), max);
};

/**
 * Compress a bounded batch of a single user's memories. Idempotent: only
 * patches rows still missing recallText, and only sets chunkKind when absent.
 *
 * The missing-recallText scan is done inline via the by_user_recall_text index
 * (userId, recallText === undefined, archived === false) rather than through a
 * separate internalQuery, because this is a mutation and a self-referential
 * runQuery into the same module breaks TS inference at codegen time.
 */
export const backfillRecallTextForUser = internalMutation({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit, 1, MAX_MAX_PER_USER, DEFAULT_MAX_PER_USER);
    // Query the index directly (this is a mutation) — avoids a self-referential
    // runQuery into the same module, which breaks TS inference at codegen time.
    const candidates = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_recall_text", (q) =>
        q.eq("userId", args.userId).eq("recallText", undefined).eq("archived", false)
      )
      .take(limit);

    let compressed = 0;
    for (const current of candidates) {
      // recallText is guaranteed undefined by the index range, but re-check to
      // stay safe if the row shape ever changes. Keeps the batch idempotent.
      if (typeof current.recallText === "string") continue;

      const memoryId = current._id;
      const recallText = compressRecallText(current.content);
      // compressRecallText returns "" only for empty/whitespace content. Stamp
      // the empty sentinel anyway so the row leaves the recallText === undefined
      // index range — otherwise it re-appears in every tick's .take() window
      // forever and can starve real backfill for the user. All read surfaces
      // gate on recallText?.trim(), so "" behaves exactly like absent.
      const patch: Record<string, unknown> = { recallText };
      if (current.chunkKind === undefined) {
        patch.chunkKind = classifyChunkKind({
          content: current.content,
          title: current.title,
          tags: current.tags ?? [],
          source: current.source,
        });
      }

      if (!args.dryRun) {
        await ctx.db.patch(memoryId, patch);
      }
      if (recallText) compressed += 1;
    }

    return {
      userId: args.userId,
      scanned: candidates.length,
      compressed: args.dryRun ? 0 : compressed,
      wouldCompress: args.dryRun ? compressed : undefined,
      dryRun: args.dryRun ?? false,
    };
  },
});

/** Read the persisted rotation cursor for this job (null = start of table). */
export const getJobCursor = internalQuery({
  args: { jobName: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("crystalJobCursors")
      .withIndex("by_job", (q) => q.eq("jobName", args.jobName))
      .unique();
    return row?.cursor ?? null;
  },
});

/** Upsert the rotation cursor; omit `cursor` to reset the rotation to the start. */
export const setJobCursor = internalMutation({
  args: { jobName: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("crystalJobCursors")
      .withIndex("by_job", (q) => q.eq("jobName", args.jobName))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, { cursor: args.cursor, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("crystalJobCursors", {
        jobName: args.jobName,
        cursor: args.cursor,
        updatedAt: Date.now(),
      });
    }
  },
});

/**
 * Cron entry point: rotates across a bounded slice of users each tick and
 * compresses a bounded number of their un-compressed memories. Safe to re-run.
 *
 * Cost-bounded by design: reads ONE paginated page of user profiles per tick
 * (resuming from the crystalJobCursors cursor) instead of collecting the whole
 * profiles table hourly. When the rotation reaches the end of the table the
 * cursor resets and the sweep starts over.
 */
export const runRecallCompressionBackfill = internalAction({
  args: {
    userId: v.optional(v.string()),
    usersLimit: v.optional(v.number()),
    maxPerUser: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const usersLimit = clampInt(args.usersLimit, 1, MAX_USERS_PER_TICK, DEFAULT_USERS_PER_TICK);
    const maxPerUser = clampInt(args.maxPerUser, 1, MAX_MAX_PER_USER, DEFAULT_MAX_PER_USER);

    let userIds: string[];
    let nextCursor: string | undefined;
    if (args.userId) {
      userIds = [args.userId];
    } else {
      const cursor = (await ctx.runQuery(
        internal.crystal.organic.recallCompressionBackfill.getJobCursor,
        { jobName: JOB_NAME }
      )) as string | null;
      let page: { userIds: string[]; continueCursor: string; isDone: boolean };
      try {
        page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          cursor: cursor ?? undefined,
          numItems: usersLimit,
        });
      } catch {
        // Stale/invalidated pagination cursor (table churn between ticks):
        // restart the rotation from the beginning rather than failing the tick.
        page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          numItems: usersLimit,
        });
      }
      userIds = page.userIds;
      nextCursor = page.isDone ? undefined : page.continueCursor;
    }

    let totalCompressed = 0;
    let failedUsers = 0;
    const results = [];
    for (const userId of userIds) {
      try {
        const result = await ctx.runMutation(
          internal.crystal.organic.recallCompressionBackfill.backfillRecallTextForUser,
          { userId, limit: maxPerUser, dryRun: args.dryRun }
        );
        totalCompressed += result.compressed ?? 0;
        results.push(result);
      } catch (error) {
        failedUsers += 1;
        console.error("[recallCompressionBackfill] user batch failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        results.push({ userId, scanned: 0, compressed: 0, failed: true });
      }
    }

    // Advance (or reset) the rotation only for real cron sweeps: explicit
    // single-user runs and dry runs must not move the shared cursor.
    if (!args.userId && !args.dryRun) {
      await ctx.runMutation(
        internal.crystal.organic.recallCompressionBackfill.setJobCursor,
        { jobName: JOB_NAME, cursor: nextCursor }
      );
    }

    return {
      users: userIds.length,
      compressed: totalCompressed,
      failedUsers,
      dryRun: args.dryRun ?? false,
      results,
    };
  },
});
