import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

const GRAPH_TABLE_AUDIT_CAP = 10_000;
const DASHBOARD_TOTALS_ROW_AUDIT_CAP = 1_000;
const DEFAULT_MEMORY_SAMPLE_LIMIT = 0;
const MAX_MEMORY_SAMPLE_LIMIT = 25;

type IssueSeverity = "high" | "medium" | "low";

type Issue = {
  code: string;
  severity: IssueSeverity;
  count: number;
  sampleIds?: string[];
  details?: Record<string, unknown>;
};

function addIssue(
  issues: Issue[],
  code: string,
  severity: IssueSeverity,
  count: number,
  sampleIds?: string[],
  details?: Record<string, unknown>,
) {
  if (count <= 0) return;
  issues.push({
    code,
    severity,
    count,
    ...(sampleIds && sampleIds.length ? { sampleIds: sampleIds.slice(0, 10) } : {}),
    ...(details ? { details } : {}),
  });
}

function increment(map: Record<string, number>, key: string | undefined) {
  const normalized = key?.trim() || "unknown";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function graphBucketTotal(totals: any) {
  return (
    Number(totals?.enrichedMemories ?? 0) +
    Number(totals?.graphEligiblePendingMemories ?? 0) +
    Number(totals?.graphSkippedMemories ?? 0)
  );
}

async function takeByUser(ctx: any, table: string, userId: string, cap = GRAPH_TABLE_AUDIT_CAP) {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .take(cap + 1);
  return {
    rows: rows.slice(0, cap),
    truncated: rows.length > cap,
  };
}

async function getDashboardTotalsRows(ctx: any, userId: string) {
  const rows = await ctx.db
    .query("crystalDashboardTotals")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .take(DASHBOARD_TOTALS_ROW_AUDIT_CAP + 1);
  return {
    rows: rows.slice(0, DASHBOARD_TOTALS_ROW_AUDIT_CAP),
    truncated: rows.length > DASHBOARD_TOTALS_ROW_AUDIT_CAP,
  };
}

function latestDashboardTotalsRow(rows: any[]) {
  if (rows.length === 0) return null;
  return [...rows].sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

async function sampleGraphMemories(ctx: any, args: {
  userId: string;
  graphEnriched: boolean | undefined;
  limit: number;
  skipped?: boolean;
}) {
  if (args.limit <= 0) return [];
  return await ctx.db
    .query("crystalMemories")
    .withIndex("by_graph_enriched", (q: any) => q.eq("graphEnriched", args.graphEnriched).eq("userId", args.userId))
    .filter((q: any) =>
      q.and(
        q.eq(q.field("archived"), false),
        args.skipped === true
          ? q.neq(q.field("enrichmentSkippedReason"), undefined)
          : args.skipped === false
            ? q.eq(q.field("enrichmentSkippedReason"), undefined)
            : q.neq(q.field("_id"), undefined),
      )
    )
    .take(args.limit);
}

export const listAuditUserIdsInternal: any = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ids = new Set<string>();

    const profiles = await ctx.db.query("crystalUserProfiles").take(10_000);
    for (const profile of profiles) {
      if (typeof profile.userId === "string" && profile.userId) ids.add(profile.userId);
    }

    const totals = await ctx.db.query("crystalDashboardTotals").take(10_000);
    for (const row of totals) {
      if (typeof row.userId === "string" && row.userId) ids.add(row.userId);
    }

    const graphTables = ["crystalNodes", "crystalRelations", "crystalMemoryNodeLinks"] as const;
    for (const table of graphTables) {
      const rows = await ctx.db.query(table).take(10_000);
      for (const row of rows) {
        if (typeof (row as any).userId === "string" && (row as any).userId) ids.add((row as any).userId);
      }
    }

    return {
      userIds: Array.from(ids).sort(),
      sourceTruncated: {
        profiles: profiles.length >= 10_000,
        totals: totals.length >= 10_000,
      },
    };
  },
});

export const auditUserGraphInternal: any = internalQuery({
  args: {
    userId: v.string(),
    memorySampleLimit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const memorySampleLimit = Math.min(
      Math.max(Math.floor(args.memorySampleLimit ?? DEFAULT_MEMORY_SAMPLE_LIMIT), 0),
      MAX_MEMORY_SAMPLE_LIMIT,
    );
    const issues: Issue[] = [];

    const [tier, openRouterKey, totalsRowsResult, nodesResult, relationsResult, linksResult] = await Promise.all([
      ctx.runQuery((internal as any).crystal.userProfiles.getUserTier, { userId: args.userId }).catch(() => "free"),
      ctx.runQuery((internal as any).crystal.providerSettings.resolveOpenRouterKeyForUser, {
        userId: args.userId,
        includeShared: false,
      }).catch(() => null),
      getDashboardTotalsRows(ctx, args.userId),
      takeByUser(ctx, "crystalNodes", args.userId),
      takeByUser(ctx, "crystalRelations", args.userId),
      takeByUser(ctx, "crystalMemoryNodeLinks", args.userId),
    ]);

    const totals = latestDashboardTotalsRow(totalsRowsResult.rows);
    const nodes = nodesResult.rows;
    const relations = relationsResult.rows;
    const links = linksResult.rows;
    const nodeIds = new Set(nodes.map((node: any) => String(node._id)));
    const nodeById = new Map(nodes.map((node: any) => [String(node._id), node]));
    const linksByMemoryId = new Map<string, number>();
    const linksByNodeId = new Map<string, number>();
    const linkKeys = new Map<string, number>();
    const canonicalKeys = new Map<string, number>();
    const relationKeys = new Map<string, number>();
    const skipReasons: Record<string, number> = {};

    for (const node of nodes) {
      canonicalKeys.set(node.canonicalKey, (canonicalKeys.get(node.canonicalKey) ?? 0) + 1);
    }
    for (const link of links) {
      const memoryId = String(link.memoryId);
      const nodeId = String(link.nodeId);
      linksByMemoryId.set(memoryId, (linksByMemoryId.get(memoryId) ?? 0) + 1);
      linksByNodeId.set(nodeId, (linksByNodeId.get(nodeId) ?? 0) + 1);
      const key = `${memoryId}:${nodeId}:${link.role}`;
      linkKeys.set(key, (linkKeys.get(key) ?? 0) + 1);
    }
    for (const relation of relations) {
      const key = `${relation.fromNodeId}:${relation.toNodeId}:${relation.relationType}`;
      relationKeys.set(key, (relationKeys.get(key) ?? 0) + 1);
    }

    const missingRelationEndpointIds: string[] = [];
    const relationUserMismatchIds: string[] = [];
    const missingEvidenceIds: string[] = [];
    const selfRelationIds: string[] = [];
    for (const relation of relations) {
      const fromExists = nodeIds.has(String(relation.fromNodeId));
      const toExists = nodeIds.has(String(relation.toNodeId));
      if (!fromExists || !toExists) missingRelationEndpointIds.push(String(relation._id));
      const from: any = fromExists ? nodeById.get(String(relation.fromNodeId)) : null;
      const to: any = toExists ? nodeById.get(String(relation.toNodeId)) : null;
      if ((from && from.userId !== args.userId) || (to && to.userId !== args.userId)) {
        relationUserMismatchIds.push(String(relation._id));
      }
      if (!Array.isArray(relation.evidenceMemoryIds) || relation.evidenceMemoryIds.length === 0) {
        missingEvidenceIds.push(String(relation._id));
      }
      if (String(relation.fromNodeId) === String(relation.toNodeId)) selfRelationIds.push(String(relation._id));
    }

    const missingLinkNodeIds: string[] = [];
    const missingLinkMemoryIds: string[] = [];
    const linkUserMismatchIds: string[] = [];
    const linkMemoryLookupCap = memorySampleLimit;
    let linkMemoryLookups = 0;
    let linkMemoryLookupTruncated = false;
    for (const link of links) {
      const node: any = nodeById.get(String(link.nodeId)) ?? null;
      let memory: any = null;
      linkMemoryLookups += 1;
      if (linkMemoryLookupCap > 0 && linkMemoryLookups <= linkMemoryLookupCap) {
        memory = await ctx.db.get(link.memoryId);
      } else {
        linkMemoryLookupTruncated = true;
      }
      if (!node) missingLinkNodeIds.push(String(link._id));
      if (linkMemoryLookupCap > 0 && linkMemoryLookups <= linkMemoryLookupCap && !memory) missingLinkMemoryIds.push(String(link._id));
      if ((node && node.userId !== args.userId) || (memory && memory.userId !== args.userId)) {
        linkUserMismatchIds.push(String(link._id));
      }
    }

    const missingNodeSourceIds: string[] = [];
    const nodeSourceUserMismatchIds: string[] = [];
    const sourceMemoryLookupCap = memorySampleLimit;
    let sourceMemoryLookups = 0;
    let sourceMemoryLookupTruncated = false;
    for (const node of nodes) {
      if (!Array.isArray(node.sourceMemoryIds) || node.sourceMemoryIds.length === 0) {
        missingNodeSourceIds.push(String(node._id));
        continue;
      }
      for (const memoryId of node.sourceMemoryIds) {
        sourceMemoryLookups += 1;
        if (sourceMemoryLookupCap <= 0 || sourceMemoryLookups > sourceMemoryLookupCap) {
          sourceMemoryLookupTruncated = true;
          break;
        }
        const memory: any = await ctx.db.get(memoryId);
        if (!memory) {
          missingNodeSourceIds.push(String(node._id));
          break;
        }
        if (memory.userId !== args.userId) {
          nodeSourceUserMismatchIds.push(String(node._id));
          break;
        }
      }
      if (sourceMemoryLookupTruncated) break;
    }

    const duplicateCanonicalIds = nodes
      .filter((node: any) => (canonicalKeys.get(node.canonicalKey) ?? 0) > 1)
      .map((node: any) => String(node._id));
    const duplicateLinkIds = links
      .filter((link: any) => (linkKeys.get(`${link.memoryId}:${link.nodeId}:${link.role}`) ?? 0) > 1)
      .map((link: any) => String(link._id));
    const duplicateRelationIds = relations
      .filter((relation: any) => (relationKeys.get(`${relation.fromNodeId}:${relation.toNodeId}:${relation.relationType}`) ?? 0) > 1)
      .map((relation: any) => String(relation._id));
    const orphanNodeIds = nodes
      .filter((node: any) => !linksByNodeId.has(String(node._id)) && (!Array.isArray(node.sourceMemoryIds) || node.sourceMemoryIds.length === 0))
      .map((node: any) => String(node._id));

    const [enrichedSample, pendingFalseSample, pendingUndefinedSample, skippedFalseSample, skippedUndefinedSample] = await Promise.all([
      sampleGraphMemories(ctx, {
        userId: args.userId,
        graphEnriched: true,
        limit: memorySampleLimit,
      }),
      sampleGraphMemories(ctx, {
        userId: args.userId,
        graphEnriched: false,
        skipped: false,
        limit: memorySampleLimit,
      }),
      sampleGraphMemories(ctx, {
        userId: args.userId,
        graphEnriched: undefined,
        skipped: false,
        limit: memorySampleLimit,
      }),
      sampleGraphMemories(ctx, {
        userId: args.userId,
        graphEnriched: false,
        skipped: true,
        limit: memorySampleLimit,
      }),
      sampleGraphMemories(ctx, {
        userId: args.userId,
        graphEnriched: undefined,
        skipped: true,
        limit: memorySampleLimit,
      }),
    ]);
    const pendingSample = [...pendingFalseSample, ...pendingUndefinedSample];
    const skippedSample = [...skippedFalseSample, ...skippedUndefinedSample];
    const enrichedWithoutLinks = enrichedSample
      .filter((memory: any) => !linksByMemoryId.has(String(memory._id)))
      .map((memory: any) => String(memory._id));
    for (const memory of skippedSample as any[]) {
      increment(skipReasons, memory.enrichmentSkippedReason);
    }

    const activeMemories = Number(totals?.activeMemories ?? 0);
    const enrichedMemories = Number(totals?.enrichedMemories ?? 0);
    const pendingMemories = Number(totals?.graphEligiblePendingMemories ?? 0);
    const skippedMemories = Number(totals?.graphSkippedMemories ?? 0);
    const bucketTotal = graphBucketTotal(totals);
    const hasPersonalOpenRouterKey = Boolean(openRouterKey?.apiKey);

    addIssue(issues, "graph_table_audit_truncated", "medium",
      Number(nodesResult.truncated) + Number(relationsResult.truncated) + Number(linksResult.truncated),
      undefined,
      { nodes: nodesResult.truncated, relations: relationsResult.truncated, links: linksResult.truncated },
    );
    addIssue(issues, "dashboard_totals_audit_truncated", "medium", Number(totalsRowsResult.truncated));
    addIssue(issues, "duplicate_dashboard_totals_rows", "medium", Math.max(0, totalsRowsResult.rows.length - 1), undefined, {
      dashboardTotalsRows: totalsRowsResult.rows.length,
      latestUpdatedAt: totals?.updatedAt ?? null,
    });
    addIssue(issues, "memory_reference_audit_sampled", "low",
      Number(sourceMemoryLookupTruncated) + Number(linkMemoryLookupTruncated),
      undefined,
      { sourceMemoryLookupTruncated, linkMemoryLookupTruncated },
    );
    addIssue(issues, "dashboard_graph_bucket_drift", "high", totals && bucketTotal !== activeMemories ? 1 : 0, undefined, {
      activeMemories,
      graphBucketTotal: bucketTotal,
      enrichedMemories,
      pendingMemories,
      skippedMemories,
    });
    addIssue(issues, "dashboard_enriched_exceeds_active", "high", totals && enrichedMemories > activeMemories ? 1 : 0);
    addIssue(issues, "no_dashboard_totals", "medium", totals ? 0 : 1);
    addIssue(issues, "enriched_memories_but_no_nodes", "high", enrichedMemories > 0 && nodes.length === 0 ? 1 : 0);
    addIssue(issues, "missing_relation_endpoint", "high", missingRelationEndpointIds.length, missingRelationEndpointIds);
    addIssue(issues, "relation_user_mismatch", "high", relationUserMismatchIds.length, relationUserMismatchIds);
    addIssue(issues, "relation_missing_evidence", "medium", missingEvidenceIds.length, missingEvidenceIds);
    addIssue(issues, "self_relations", "low", selfRelationIds.length, selfRelationIds);
    addIssue(issues, "duplicate_relations", "medium", duplicateRelationIds.length, duplicateRelationIds);
    addIssue(issues, "missing_link_node", "high", missingLinkNodeIds.length, missingLinkNodeIds);
    addIssue(issues, "missing_link_memory", "high", missingLinkMemoryIds.length, missingLinkMemoryIds);
    addIssue(issues, "link_user_mismatch", "high", linkUserMismatchIds.length, linkUserMismatchIds);
    addIssue(issues, "duplicate_links", "medium", duplicateLinkIds.length, duplicateLinkIds);
    addIssue(issues, "duplicate_canonical_nodes", "medium", duplicateCanonicalIds.length, duplicateCanonicalIds);
    addIssue(issues, "orphan_nodes", "low", orphanNodeIds.length, orphanNodeIds);
    addIssue(issues, "node_missing_source_memory", "medium", missingNodeSourceIds.length, missingNodeSourceIds, {
      sourceMemoryLookupTruncated,
    });
    addIssue(issues, "node_source_user_mismatch", "high", nodeSourceUserMismatchIds.length, nodeSourceUserMismatchIds);
    addIssue(issues, "enriched_sample_without_links", "medium", enrichedWithoutLinks.length, enrichedWithoutLinks, {
      sampled: enrichedSample.length,
    });
    addIssue(issues, "eligible_graph_backlog_with_byok", "medium", hasPersonalOpenRouterKey ? pendingMemories : 0, undefined, {
      pendingMemories,
      hasPersonalOpenRouterKey,
    });
    addIssue(issues, "eligible_graph_backlog_without_byok", "low", hasPersonalOpenRouterKey ? 0 : pendingMemories, undefined, {
      pendingMemories,
      hasPersonalOpenRouterKey,
    });
    addIssue(issues, "skipped_graph_memories", "medium", skippedMemories, undefined, {
      sampled: skippedSample.length,
      sampleReasons: skipReasons,
    });

    return {
      userId: args.userId,
      tier,
      hasPersonalOpenRouterKey,
      counts: {
        activeMemories,
        enrichedMemories,
        pendingMemories,
        skippedMemories,
        graphBucketTotal: bucketTotal,
        nodes: nodes.length,
        relations: relations.length,
        links: links.length,
        sampledEnrichedMemories: enrichedSample.length,
        sampledPendingMemories: pendingSample.length,
        sampledSkippedMemories: skippedSample.length,
        dashboardTotalsRows: totalsRowsResult.rows.length,
      },
      truncated: {
        dashboardTotalsRows: totalsRowsResult.truncated,
        nodes: nodesResult.truncated,
        relations: relationsResult.truncated,
        links: linksResult.truncated,
        sourceMemoryLookups: sourceMemoryLookupTruncated,
        linkMemoryLookups: linkMemoryLookupTruncated,
      },
      skipReasonsSample: skipReasons,
      issues,
    };
  },
});

export const auditAllUsersGraphData: any = internalAction({
  args: {
    limitUsers: v.optional(v.number()),
    memorySampleLimit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const listing = await ctx.runQuery((internal as any).crystal.graphAudit.listAuditUserIdsInternal, {});
    const userIds = (listing.userIds as string[]).slice(0, args.limitUsers ?? listing.userIds.length);
    const users = [];
    const issueTotals: Record<string, number> = {};
    const issueUsers: Record<string, number> = {};

    for (const userId of userIds) {
      const audit = await ctx.runQuery((internal as any).crystal.graphAudit.auditUserGraphInternal, {
        userId,
        memorySampleLimit: args.memorySampleLimit,
      });
      users.push(audit);
      for (const issue of audit.issues as Issue[]) {
        issueTotals[issue.code] = (issueTotals[issue.code] ?? 0) + issue.count;
        issueUsers[issue.code] = (issueUsers[issue.code] ?? 0) + 1;
      }
    }

    const totals = users.reduce((acc: any, user: any) => {
      acc.activeMemories += user.counts.activeMemories;
      acc.enrichedMemories += user.counts.enrichedMemories;
      acc.pendingMemories += user.counts.pendingMemories;
      acc.skippedMemories += user.counts.skippedMemories;
      acc.nodes += user.counts.nodes;
      acc.relations += user.counts.relations;
      acc.links += user.counts.links;
      return acc;
    }, {
      activeMemories: 0,
      enrichedMemories: 0,
      pendingMemories: 0,
      skippedMemories: 0,
      nodes: 0,
      relations: 0,
      links: 0,
    });

    const usersWithHighIssues = users.filter((user: any) =>
      user.issues.some((issue: Issue) => issue.severity === "high")
    ).length;

    return {
      generatedAt: Date.now(),
      auditedUsers: users.length,
      availableUsers: listing.userIds.length,
      sourceTruncated: listing.sourceTruncated,
      usersWithIssues: users.filter((user: any) => user.issues.length > 0).length,
      usersWithHighIssues,
      totals,
      issueTotals,
      issueUsers,
      users,
    };
  },
});
