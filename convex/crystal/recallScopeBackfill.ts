import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { memoryRecallScope } from "./memoryVectors";
import { patchMemoryEmbedding } from "./memoryEmbeddingRefs";

const JOB_NAME = "recall-scope-backfill";
const PAGE_ITEMS = 50;

type PageResult = {
  scanned: number;
  patched: number;
  unchanged: number;
  missingSources: number;
  continueCursor: string;
  isDone: boolean;
};

async function cursorRow(ctx: { db: any }) {
  return ctx.db.query("crystalJobCursors").withIndex("by_job", (q: any) => q.eq("jobName", JOB_NAME)).unique();
}

/** Operator-only page. A retry of the same cursor rewrites the same rows. */
export const backfillRecallScopePage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), dryRun: v.boolean() },
  handler: async (ctx, args): Promise<PageResult> => {
    const page = await ctx.db.query("crystalMemoryEmbeddings").paginate({ cursor: args.cursor, numItems: PAGE_ITEMS });
    let patched = 0;
    let unchanged = 0;
    let missingSources = 0;
    for (const side of page.page) {
      const memory = await ctx.db.get(side.memoryId);
      if (!memory) {
        missingSources += 1;
        continue;
      }
      const recallScope = memoryRecallScope(memory);
      if (side.recallScope === recallScope) {
        unchanged += 1;
        continue;
      }
      patched += 1;
      if (!args.dryRun) await patchMemoryEmbedding(ctx, side._id, { recallScope });
    }
    return {
      scanned: page.page.length,
      patched,
      unchanged,
      missingSources,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Persist the cursor only after the page's writes. Omitting it records completion. */
export const saveRecallScopeCursor = internalMutation({
  args: { cursor: v.optional(v.string()), completed: v.boolean() },
  handler: async (ctx, args) => {
    const row = await cursorRow(ctx);
    const patch = { cursor: args.completed ? undefined : args.cursor, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("crystalJobCursors", { jobName: JOB_NAME, ...patch });
  },
});

export const recallScopeBackfillStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await cursorRow(ctx);
    return { started: Boolean(row), complete: row !== null && row.cursor === undefined, cursor: row?.cursor ?? null };
  },
});

/**
 * Resume from the saved cursor. A page that throws is not saved, so the next
 * run repeats it. Completion is the saved cursor being cleared, which is the
 * only state that authorizes the read flag.
 */
export const backfillRecallScope = internalAction({
  args: { dryRun: v.optional(v.boolean()), maxPages: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PageResult & { complete: boolean; dryRun: boolean }> => {
    const dryRun = args.dryRun ?? true;
    const maxPages = Math.min(Math.max(Math.trunc(args.maxPages ?? 20), 1), 1000);
    const status: { cursor: string | null } = await ctx.runQuery(
      internal.crystal.recallScopeBackfill.recallScopeBackfillStatus, {},
    );
    let cursor = status.cursor;
    const totals = { scanned: 0, patched: 0, unchanged: 0, missingSources: 0 };
    let isDone = false;
    let pages = 0;
    while (pages < maxPages) {
      const page: PageResult = await ctx.runMutation(
        internal.crystal.recallScopeBackfill.backfillRecallScopePage, { cursor, dryRun },
      );
      pages += 1;
      totals.scanned += page.scanned;
      totals.patched += page.patched;
      totals.unchanged += page.unchanged;
      totals.missingSources += page.missingSources;
      isDone = page.isDone;
      if (!page.isDone && page.continueCursor === cursor) {
        throw new Error("recall scope backfill cursor did not advance");
      }
      if (!dryRun) {
        await ctx.runMutation(internal.crystal.recallScopeBackfill.saveRecallScopeCursor, {
          ...(page.isDone ? {} : { cursor: page.continueCursor }),
          completed: page.isDone,
        });
      }
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    return { ...totals, continueCursor: cursor ?? "", isDone, complete: !dryRun && isDone, dryRun };
  },
});
