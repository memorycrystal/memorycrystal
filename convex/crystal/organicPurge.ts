/** Gated, counts-only purge of the retired Organic tables' rows (ILL-475). */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";

// Fixed order; the driver mirrors it. Within-Organic references point at
// tables later in the list, so children go before the rows they name.
export const ORGANIC_PURGE_TABLES = [
  "organicRecallStats", "organicRecallLog", "organicReplayReports", "organicRecallPolicies",
  "organicSkillSuggestions", "organicIdeas", "organicTickRuns", "organicTickState",
  "organicAlertBudget", "organicEnsembleMemberships", "organicEnsembles", "organicProspectiveTraces",
  "organicActivityLog",
] as const;
type OrganicTable = (typeof ORGANIC_PURGE_TABLES)[number];

const args = { table: v.string(), cursor: v.union(v.string(), v.null()), batchSize: v.optional(v.number()) };
const batchSize = (size = 100) => Number.isFinite(size) ? Math.min(200, Math.max(1, Math.trunc(size))) : 100;

export function organicPurgeReady(): boolean {
  const flag = process.env.CRYSTAL_ORGANIC_PURGE_READY;
  return flag === "1" || flag === "true";
}

function organicTable(table: string): OrganicTable {
  if (!(ORGANIC_PURGE_TABLES as readonly string[]).includes(table)) throw new ConvexError("not an organic purge table");
  return table as OrganicTable;
}

async function organicPage(ctx: Pick<QueryCtx, "db">, input: { table: string; cursor: string | null; batchSize?: number }) {
  // 4 MiB of paginated rows bounds both the read and the delete write set.
  return ctx.db.query(organicTable(input.table)).order("asc").paginate({
    cursor: input.cursor, numItems: batchSize(input.batchSize), maximumBytesRead: 4 * 1024 * 1024,
  });
}

export const purgeOrganicTablePage = internalMutation({
  args,
  handler: async (ctx, input) => {
    if (!organicPurgeReady()) throw new ConvexError("organic purge not ready");
    const page = await organicPage(ctx, input);
    for (const row of page.page) await ctx.db.delete(row._id);
    return { deleted: page.page.length, continueCursor: page.continueCursor, isDone: page.isDone, splitRequired: page.pageStatus === "SplitRequired" };
  },
});

export const countOrganicTablePage = internalQuery({
  args,
  handler: async (ctx, input) => {
    const page = await organicPage(ctx, input);
    return { rows: page.page.length, continueCursor: page.continueCursor, isDone: page.isDone, splitRequired: page.pageStatus === "SplitRequired" };
  },
});
