import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { syncMemoryEmbeddingRef } from "./memoryEmbeddingRefs";

const PAGE_ITEMS = 64;
const MAXIMUM_BYTES_READ = 4 * 1024 * 1024;
const BUDGET_MS = 8 * 60 * 1000;
const emptyCounts = () => ({ scanned: 0, created: 0, repaired: 0, unchanged: 0 });
type PageResult = ReturnType<typeof emptyCounts> & {
  continueCursor: string;
  isDone: boolean;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
  splitCursor?: string | null;
};

/** Operator-only scan. Orphans are deliberately mirrored without reading memories. */
export const backfillMemoryEmbeddingRefsPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()), dryRun: v.boolean(),
    // Used only to retry an incomplete range in a separate transaction.
    endCursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<PageResult> => {
    const page = await ctx.db.query("crystalMemoryEmbeddings").paginate({
      cursor: args.cursor, numItems: PAGE_ITEMS, maximumBytesRead: MAXIMUM_BYTES_READ,
      ...(args.endCursor === undefined ? {} : { endCursor: args.endCursor }),
    });
    const counts = emptyCounts();
    // SplitRequired may omit rows. Do not write or advance past that range.
    if (page.pageStatus !== "SplitRequired") {
      for (const row of page.page) {
        counts[await syncMemoryEmbeddingRef(ctx, row, args.dryRun)]++;
        counts.scanned++;
      }
    }
    return {
      ...counts, continueCursor: page.continueCursor,
      isDone: page.isDone && args.endCursor === undefined && page.pageStatus !== "SplitRequired",
      ...(page.pageStatus === undefined ? {} : { pageStatus: page.pageStatus }),
      ...(page.splitCursor === undefined ? {} : { splitCursor: page.splitCursor }),
    };
  },
});

export const backfillMemoryEmbeddingRefs = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    dryRun: v.optional(v.boolean()), maxPages: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const totals = emptyCounts();
    let cursor = args.cursor ?? null;
    let endCursor: string | undefined;
    let isDone = false;
    let pages = 0;
    const dryRun = args.dryRun ?? true;
    const maxPages = Math.min(Math.max(Math.trunc(args.maxPages ?? 1000), 1), 100_000);
    const deadline = Date.now() + BUDGET_MS;
    while (pages < maxPages && Date.now() < deadline) {
      const page: PageResult = await ctx.runMutation(
        internal.crystal.memoryEmbeddingRefsBackfill.backfillMemoryEmbeddingRefsPage,
        { cursor, dryRun, ...(endCursor === undefined ? {} : { endCursor }) },
      );
      pages++;
      if (page.pageStatus === "SplitRequired") {
        if (!page.splitCursor || page.splitCursor === cursor || page.splitCursor === endCursor) {
          throw new Error("incomplete ref backfill page has no advancing split cursor");
        }
        endCursor = page.splitCursor;
        continue;
      }
      for (const key of ["scanned", "created", "repaired", "unchanged"] as const) totals[key] += page[key];
      // SplitRecommended pages are complete; continue normally. After a bounded
      // half-page, resume the unrestricted scan at its returned cursor.
      if (!page.isDone && page.continueCursor === cursor) throw new Error("ref backfill cursor did not advance");
      cursor = page.continueCursor;
      endCursor = undefined;
      isDone = page.isDone;
      if (isDone) break;
    }
    // If a split retry was interrupted, cursor still names the last complete
    // range. Resuming may re-read the incomplete page but cannot skip its rows.
    return { ...totals, continueCursor: cursor, isDone, pages, dryRun };
  },
});
