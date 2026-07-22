import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

const DASHBOARD_TOTALS_ROW_REPAIR_CAP = 1_000;
const SELF_RELATION_REPAIR_CAP = 20_000;
const SELF_RELATION_PAGE_SIZE = 1_000;
const SELF_RELATION_PAGE_MAX_BYTES = 4_000_000;

function latestByUpdatedAt(rows: any[]) {
  return [...rows].sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
}

async function compactDashboardTotalsRows(ctx: any, userId: string, dryRun: boolean) {
  const rows = await ctx.db
    .query("crystalDashboardTotals")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .take(DASHBOARD_TOTALS_ROW_REPAIR_CAP + 1);
  const truncated = rows.length > DASHBOARD_TOTALS_ROW_REPAIR_CAP;
  const scopedRows = rows.slice(0, DASHBOARD_TOTALS_ROW_REPAIR_CAP);
  const latest = latestByUpdatedAt(scopedRows);
  const staleRows = latest
    ? scopedRows.filter((row: any) => row._id !== latest._id)
    : [];

  if (!dryRun) {
    for (const row of staleRows) {
      await ctx.db.delete(row._id);
    }
  }

  return {
    scanned: scopedRows.length,
    keptId: latest?._id ?? null,
    staleRows: staleRows.length,
    deleted: dryRun ? 0 : staleRows.length,
    truncated,
  };
}

async function deleteSelfRelations(ctx: any, userId: string, dryRun: boolean) {
  const rows = await ctx.db
    .query("crystalRelations")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .take(SELF_RELATION_REPAIR_CAP + 1);
  const truncated = rows.length > SELF_RELATION_REPAIR_CAP;
  const scopedRows = rows.slice(0, SELF_RELATION_REPAIR_CAP);
  const selfRelations = scopedRows.filter((relation: any) =>
    String(relation.fromNodeId) === String(relation.toNodeId)
  );

  if (!dryRun) {
    for (const relation of selfRelations) {
      await ctx.db.delete(relation._id);
    }
  }

  return {
    scanned: scopedRows.length,
    selfRelations: selfRelations.length,
    deleted: dryRun ? 0 : selfRelations.length,
    sampleIds: selfRelations.slice(0, 10).map((relation: any) => String(relation._id)),
    truncated,
  };
}

export const repairUserGraphDataInternal: any = internalMutation({
  args: {
    userId: v.string(),
    dryRun: v.optional(v.boolean()),
    includeSelfRelations: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const dashboardTotals = await compactDashboardTotalsRows(ctx, args.userId, dryRun);
    const selfRelations = args.includeSelfRelations === false
      ? {
          scanned: 0,
          selfRelations: 0,
          deleted: 0,
          sampleIds: [],
          truncated: false,
        }
      : await deleteSelfRelations(ctx, args.userId, dryRun);

    return {
      userId: args.userId,
      dryRun,
      dashboardTotals,
      selfRelations,
    };
  },
});

export const listSelfRelationsPageInternal: any = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pageSize = Math.min(Math.max(Math.trunc(args.pageSize ?? SELF_RELATION_PAGE_SIZE), 1), SELF_RELATION_PAGE_SIZE);
    const page: any = await ctx.db
      .query("crystalRelations")
      .withIndex("by_user", (q: any) => q.eq("userId", args.userId))
      .paginate({
        cursor: args.cursor ?? null,
        numItems: pageSize,
        maximumBytesRead: SELF_RELATION_PAGE_MAX_BYTES,
      });
    const relationIds = (page.page as any[])
      .filter((relation: any) => String(relation.fromNodeId) === String(relation.toNodeId))
      .map((relation: any) => String(relation._id));

    return {
      scanned: page.page.length,
      relationIds,
      isDone: page.isDone,
      continueCursor: page.continueCursor as string | undefined,
    };
  },
});

export const deleteSelfRelationsByIdInternal: any = internalMutation({
  args: {
    userId: v.string(),
    relationIds: v.array(v.id("crystalRelations")),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    let deleted = 0;
    let skipped = 0;
    const sampleIds: string[] = [];
    for (const relationId of args.relationIds) {
      const relation = await ctx.db.get(relationId);
      if (
        !relation ||
        relation.userId !== args.userId ||
        String(relation.fromNodeId) !== String(relation.toNodeId)
      ) {
        skipped += 1;
        continue;
      }
      sampleIds.push(String(relation._id));
      if (!dryRun) {
        await ctx.db.delete(relation._id);
      }
      deleted += 1;
    }
    return { deleted: dryRun ? 0 : deleted, matched: deleted, skipped, sampleIds: sampleIds.slice(0, 10) };
  },
});

export const repairKnownGraphDataInternal: any = internalAction({
  args: {
    userIds: v.optional(v.array(v.string())),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const listing = args.userIds?.length
      ? { userIds: Array.from(new Set(args.userIds)) }
      : await ctx.runQuery((internal as any).crystal.graphAudit.listAuditUserIdsInternal, {});
    const userIds = listing.userIds as string[];
    const results = [];
    for (const userId of userIds) {
      const baseRepair = await ctx.runMutation((internal as any).crystal.graphRepair.repairUserGraphDataInternal, {
        userId,
        dryRun: args.dryRun,
        includeSelfRelations: false,
      });

      let cursor: string | undefined = undefined;
      let scanned = 0;
      let matched = 0;
      let deleted = 0;
      let skipped = 0;
      const sampleIds: string[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const page = await ctx.runQuery((internal as any).crystal.graphRepair.listSelfRelationsPageInternal, {
          userId,
          cursor,
          pageSize: SELF_RELATION_PAGE_SIZE,
        }) as { scanned: number; relationIds: string[]; isDone: boolean; continueCursor?: string };
        scanned += page.scanned;
        if (page.relationIds.length > 0) {
          const deletion = await ctx.runMutation((internal as any).crystal.graphRepair.deleteSelfRelationsByIdInternal, {
            userId,
            relationIds: page.relationIds,
            dryRun: args.dryRun,
          }) as { matched: number; deleted: number; skipped: number; sampleIds: string[] };
          matched += deletion.matched;
          deleted += deletion.deleted;
          skipped += deletion.skipped;
          sampleIds.push(...deletion.sampleIds);
        }
        if (page.isDone || !page.continueCursor) break;
        cursor = page.continueCursor;
      }

      results.push({
        ...baseRepair,
        selfRelations: {
          scanned,
          selfRelations: matched,
          deleted,
          skipped,
          sampleIds: sampleIds.slice(0, 10),
          truncated: false,
        },
      });
    }
    return {
      dryRun: args.dryRun !== false,
      usersProcessed: results.length,
      results,
    };
  },
});
