// Shared rotation cursors for recurring background jobs (crystalJobCursors).
//
// Pattern: a job's action reads its cursor (getJobCursor), fetches ONE page of
// users via internal.crystal.userProfiles.listUserIdsPage, processes them, and
// persists continueCursor (setJobCursor) — omitting `cursor` when the page
// isDone so the rotation restarts from the top of the table. Dry runs and
// explicit single-user runs must NOT advance the shared cursor. Each job uses
// its own stable jobName so rotations never interfere.
//
// Reference implementation: organic/recallCompressionBackfill.ts (which keeps
// a local copy of these helpers for historical reasons); test shape:
// __tests__/recallCompressionBackfill.test.ts.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/** Read the persisted rotation cursor for a job (null = start of table). */
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

/** Upsert a job's rotation cursor; omit `cursor` to reset the rotation. */
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
