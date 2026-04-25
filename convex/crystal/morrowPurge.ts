import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const CHANNEL_PREFIX = "morrow-coach";
const DEFAULT_WINDOW_HOURS = 48;

type MemoryId = Id<"crystalMemories">;
type MessageId = Id<"crystalMessages">;
type SessionId = Id<"crystalSessions">;
type SnapshotId = Id<"crystalSnapshots">;
type CheckpointId = Id<"crystalCheckpoints">;
type AssociationId = Id<"crystalAssociations">;
type LinkId = Id<"crystalMemoryNodeLinks">;
type WakeStateId = Id<"crystalWakeState">;
type ActivityLogId = Id<"organicActivityLog">;
type NodeId = Id<"crystalNodes">;
type RelationId = Id<"crystalRelations">;
type EnsembleId = Id<"organicEnsembles">;
type EnsembleMembershipId = Id<"organicEnsembleMemberships">;
type IdeaId = Id<"organicIdeas">;
type SkillSuggestionId = Id<"organicSkillSuggestions">;
type TraceId = Id<"organicProspectiveTraces">;
type RecallLogId = Id<"organicRecallLog">;
type TickStateId = Id<"organicTickState">;

type MemoryRefPatch = {
  memoryId: MemoryId;
  clearSessionId: boolean;
  clearCheckpointId: boolean;
  clearSourceSnapshotId: boolean;
};

type NodePatch = {
  nodeId: NodeId;
  sourceMemoryIds: MemoryId[];
};

type RelationPatch = {
  relationId: RelationId;
  evidenceMemoryIds: MemoryId[];
};

type TickStatePatch = {
  tickStateId: TickStateId;
  warmCacheMemoryIds: string[];
};

type PurgePlan = {
  cutoff: number;
  memoryIds: MemoryId[];
  protectedKnowledgeBaseMemoryIds: MemoryId[];
  messageIds: MessageId[];
  sessionIds: SessionId[];
  snapshotIds: SnapshotId[];
  checkpointIds: CheckpointId[];
  associationIds: AssociationId[];
  linkIds: LinkId[];
  wakeStateIds: WakeStateId[];
  activityLogIds: ActivityLogId[];
  nodeIds: NodeId[];
  nodePatches: NodePatch[];
  relationIds: RelationId[];
  relationPatches: RelationPatch[];
  ensembleIds: EnsembleId[];
  ensembleMembershipIds: EnsembleMembershipId[];
  ideaIds: IdeaId[];
  skillSuggestionIds: SkillSuggestionId[];
  prospectiveTraceIds: TraceId[];
  recallLogIds: RecallLogId[];
  preservedMemoryPatches: MemoryRefPatch[];
  tickStatePatches: TickStatePatch[];
  summary: {
    memories: number;
    protectedKnowledgeBaseMemories: number;
    messages: number;
    sessions: number;
    snapshots: number;
    checkpoints: number;
    associations: number;
    memoryNodeLinks: number;
    wakeStates: number;
    activityLogs: number;
    graphNodesDeleted: number;
    graphNodesPatched: number;
    graphRelationsDeleted: number;
    graphRelationsPatched: number;
    organicEnsembles: number;
    organicEnsembleMemberships: number;
    organicIdeas: number;
    organicSkillSuggestions: number;
    organicProspectiveTraces: number;
    organicRecallLogs: number;
    preservedMemoryPatches: number;
    tickStatePatches: number;
  };
};

const crystalInternal: any = (internal as any).crystal;
const morrowInternal: any = crystalInternal.morrowPurge;
const dashboardTotalsInternal: any = crystalInternal.dashboardTotals;

const memoryRefPatchValidator = v.object({
  memoryId: v.id("crystalMemories"),
  clearSessionId: v.boolean(),
  clearCheckpointId: v.boolean(),
  clearSourceSnapshotId: v.boolean(),
});

const nodePatchValidator = v.object({
  nodeId: v.id("crystalNodes"),
  sourceMemoryIds: v.array(v.id("crystalMemories")),
});

const relationPatchValidator = v.object({
  relationId: v.id("crystalRelations"),
  evidenceMemoryIds: v.array(v.id("crystalMemories")),
});

const tickStatePatchValidator = v.object({
  tickStateId: v.id("organicTickState"),
  warmCacheMemoryIds: v.array(v.string()),
});

const purgePlanValidator = v.object({
  cutoff: v.number(),
  memoryIds: v.array(v.id("crystalMemories")),
  protectedKnowledgeBaseMemoryIds: v.array(v.id("crystalMemories")),
  messageIds: v.array(v.id("crystalMessages")),
  sessionIds: v.array(v.id("crystalSessions")),
  snapshotIds: v.array(v.id("crystalSnapshots")),
  checkpointIds: v.array(v.id("crystalCheckpoints")),
  associationIds: v.array(v.id("crystalAssociations")),
  linkIds: v.array(v.id("crystalMemoryNodeLinks")),
  wakeStateIds: v.array(v.id("crystalWakeState")),
  activityLogIds: v.array(v.id("organicActivityLog")),
  nodeIds: v.array(v.id("crystalNodes")),
  nodePatches: v.array(nodePatchValidator),
  relationIds: v.array(v.id("crystalRelations")),
  relationPatches: v.array(relationPatchValidator),
  ensembleIds: v.array(v.id("organicEnsembles")),
  ensembleMembershipIds: v.array(v.id("organicEnsembleMemberships")),
  ideaIds: v.array(v.id("organicIdeas")),
  skillSuggestionIds: v.array(v.id("organicSkillSuggestions")),
  prospectiveTraceIds: v.array(v.id("organicProspectiveTraces")),
  recallLogIds: v.array(v.id("organicRecallLog")),
  preservedMemoryPatches: v.array(memoryRefPatchValidator),
  tickStatePatches: v.array(tickStatePatchValidator),
  summary: v.object({
    memories: v.number(),
    protectedKnowledgeBaseMemories: v.number(),
    messages: v.number(),
    sessions: v.number(),
    snapshots: v.number(),
    checkpoints: v.number(),
    associations: v.number(),
    memoryNodeLinks: v.number(),
    wakeStates: v.number(),
    activityLogs: v.number(),
    graphNodesDeleted: v.number(),
    graphNodesPatched: v.number(),
    graphRelationsDeleted: v.number(),
    graphRelationsPatched: v.number(),
    organicEnsembles: v.number(),
    organicEnsembleMemberships: v.number(),
    organicIdeas: v.number(),
    organicSkillSuggestions: v.number(),
    organicProspectiveTraces: v.number(),
    organicRecallLogs: v.number(),
    preservedMemoryPatches: v.number(),
    tickStatePatches: v.number(),
  }),
});

function cutoffMs(windowHours: number): number {
  return Date.now() - windowHours * 60 * 60 * 1000;
}

function isMorrowChannel(channel: string | undefined | null): boolean {
  return typeof channel === "string" && channel.startsWith(CHANNEL_PREFIX);
}

function toIdSet(ids: readonly (string | Id<any>)[]): Set<string> {
  return new Set(ids.map((id) => String(id)));
}

function intersectsIds(ids: readonly (string | Id<any>)[] | undefined, blocked: Set<string>): boolean {
  return Array.isArray(ids) && ids.some((id) => blocked.has(String(id)));
}

function filterIds<T extends string | Id<any>>(ids: readonly T[] | undefined, blocked: Set<string>): T[] {
  return Array.isArray(ids) ? ids.filter((id) => !blocked.has(String(id))) : [];
}

function summarizePlan(plan: Omit<PurgePlan, "summary">): PurgePlan["summary"] {
  return {
    memories: plan.memoryIds.length,
    protectedKnowledgeBaseMemories: plan.protectedKnowledgeBaseMemoryIds.length,
    messages: plan.messageIds.length,
    sessions: plan.sessionIds.length,
    snapshots: plan.snapshotIds.length,
    checkpoints: plan.checkpointIds.length,
    associations: plan.associationIds.length,
    memoryNodeLinks: plan.linkIds.length,
    wakeStates: plan.wakeStateIds.length,
    activityLogs: plan.activityLogIds.length,
    graphNodesDeleted: plan.nodeIds.length,
    graphNodesPatched: plan.nodePatches.length,
    graphRelationsDeleted: plan.relationIds.length,
    graphRelationsPatched: plan.relationPatches.length,
    organicEnsembles: plan.ensembleIds.length,
    organicEnsembleMemberships: plan.ensembleMembershipIds.length,
    organicIdeas: plan.ideaIds.length,
    organicSkillSuggestions: plan.skillSuggestionIds.length,
    organicProspectiveTraces: plan.prospectiveTraceIds.length,
    organicRecallLogs: plan.recallLogIds.length,
    preservedMemoryPatches: plan.preservedMemoryPatches.length,
    tickStatePatches: plan.tickStatePatches.length,
  };
}

async function collectAssociationIds(ctx: any, memoryIds: readonly MemoryId[]): Promise<AssociationId[]> {
  const ids = new Set<string>();
  for (const memoryId of memoryIds) {
    const [fromAssociations, toAssociations] = await Promise.all([
      ctx.db.query("crystalAssociations").withIndex("by_from", (q: any) => q.eq("fromMemoryId", memoryId)).collect(),
      ctx.db.query("crystalAssociations").withIndex("by_to", (q: any) => q.eq("toMemoryId", memoryId)).collect(),
    ]);
    for (const association of [...fromAssociations, ...toAssociations]) {
      ids.add(String(association._id));
    }
  }
  return Array.from(ids) as AssociationId[];
}

async function collectMemoryNodeLinkIds(ctx: any, memoryIds: readonly MemoryId[], nodeIds: readonly NodeId[]): Promise<LinkId[]> {
  const ids = new Set<string>();
  for (const memoryId of memoryIds) {
    const links = await ctx.db
      .query("crystalMemoryNodeLinks")
      .withIndex("by_memory", (q: any) => q.eq("memoryId", memoryId))
      .collect();
    for (const link of links) ids.add(String(link._id));
  }
  for (const nodeId of nodeIds) {
    const links = await ctx.db
      .query("crystalMemoryNodeLinks")
      .withIndex("by_node", (q: any) => q.eq("nodeId", nodeId))
      .collect();
    for (const link of links) ids.add(String(link._id));
  }
  return Array.from(ids) as LinkId[];
}

// Hard cap on rows pulled into a single `scanCandidates` call. Convex internal queries
// have per-transaction limits (8MB read / 16k rows) — an unbounded `.collect()` on a
// power user with 10k+ memories in the morrow window would abort mid-scan, leaving
// the purge half-applied. Capping here turns the failure mode into a loud warning
// (see `scanExhausted` flag in the returned plan) that the operator can act on by
// running with a shorter window.
const SCAN_ROW_CAP = 10_000;

export const scanCandidates = internalQuery({
  args: { userId: v.string(), cutoff: v.number() },
  handler: async (ctx, { userId, cutoff }): Promise<PurgePlan> => {
    const warn = (kind: string, count: number) => {
      if (count >= SCAN_ROW_CAP) {
        console.warn(
          `[morrowPurge.scanCandidates] hit SCAN_ROW_CAP=${SCAN_ROW_CAP} on ${kind} — re-run with a shorter windowHours or paginate the scan`,
        );
      }
    };

    const recentMemories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) => q.eq("userId", userId).gte("createdAt", cutoff))
      .take(SCAN_ROW_CAP);
    warn("crystalMemories", recentMemories.length);

    const purgeMemories = recentMemories.filter((memory) => isMorrowChannel(memory.channel) && !memory.knowledgeBaseId);
    const protectedKnowledgeBaseMemories = recentMemories.filter((memory) => isMorrowChannel(memory.channel) && !!memory.knowledgeBaseId);
    const memoryIds = purgeMemories.map((memory) => memory._id);
    const purgeMemorySet = toIdSet(memoryIds);

    const recentMessages = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_time", (q) => q.eq("userId", userId).gte("timestamp", cutoff))
      .take(SCAN_ROW_CAP);
    warn("crystalMessages", recentMessages.length);
    const messageIds = recentMessages
      .filter((message) => isMorrowChannel(message.channel))
      .map((message) => message._id);

    const recentSessions = await ctx.db
      .query("crystalSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId).gte("lastActiveAt", cutoff))
      .take(SCAN_ROW_CAP);
    warn("crystalSessions", recentSessions.length);
    const sessionIds = recentSessions
      .filter((session) => isMorrowChannel(session.channel))
      .map((session) => session._id);
    const purgeSessionSet = toIdSet(sessionIds);

    const recentSnapshots = await ctx.db
      .query("crystalSnapshots")
      .withIndex("by_user", (q) => q.eq("userId", userId).gte("createdAt", cutoff))
      .take(SCAN_ROW_CAP);
    warn("crystalSnapshots", recentSnapshots.length);
    const snapshotIds = recentSnapshots
      .filter((snapshot) => isMorrowChannel(snapshot.channel))
      .map((snapshot) => snapshot._id);
    const purgeSnapshotSet = toIdSet(snapshotIds);

    const recentCheckpoints = await ctx.db
      .query("crystalCheckpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId).gte("createdAt", cutoff))
      .take(SCAN_ROW_CAP);
    warn("crystalCheckpoints", recentCheckpoints.length);
    const checkpointIds = recentCheckpoints
      .filter((checkpoint) =>
        (checkpoint.sessionId && purgeSessionSet.has(String(checkpoint.sessionId))) ||
        checkpoint.memorySnapshot.some((entry) => purgeMemorySet.has(String(entry.memoryId)))
      )
      .map((checkpoint) => checkpoint._id);
    const purgeCheckpointSet = toIdSet(checkpointIds);

    const preservedMemoryPatches = recentMemories
      .filter((memory) => !purgeMemorySet.has(String(memory._id)))
      .map((memory) => ({
        memoryId: memory._id,
        clearSessionId: !!memory.sessionId && purgeSessionSet.has(String(memory.sessionId)),
        clearCheckpointId: !!memory.checkpointId && purgeCheckpointSet.has(String(memory.checkpointId)),
        clearSourceSnapshotId: !!memory.sourceSnapshotId && purgeSnapshotSet.has(String(memory.sourceSnapshotId)),
      }))
      .filter((patch) => patch.clearSessionId || patch.clearCheckpointId || patch.clearSourceSnapshotId);

    const associationIds = await collectAssociationIds(ctx, memoryIds);

    const wakeStates = await ctx.db
      .query("crystalWakeState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SCAN_ROW_CAP);
    warn("crystalWakeState", wakeStates.length);
    const wakeStateIds = wakeStates
      .filter((wakeState) =>
        purgeSessionSet.has(String(wakeState.sessionId)) ||
        intersectsIds(wakeState.injectedMemoryIds, purgeMemorySet)
      )
      .map((wakeState) => wakeState._id);

    const activityLogIds = new Set<string>();
    for (const memoryId of memoryIds) {
      const logs = await ctx.db
        .query("organicActivityLog")
        .withIndex("by_memory", (q: any) => q.eq("memoryId", memoryId))
        .take(SCAN_ROW_CAP);
      warn("organicActivityLog", logs.length);
      for (const log of logs) activityLogIds.add(String(log._id));
    }

    const nodes = await ctx.db
      .query("crystalNodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SCAN_ROW_CAP);
    warn("crystalNodes", nodes.length);
    const nodePatches: NodePatch[] = [];
    const nodeIds: NodeId[] = [];
    for (const node of nodes) {
      if (!intersectsIds(node.sourceMemoryIds, purgeMemorySet)) continue;
      const nextSourceMemoryIds = filterIds(node.sourceMemoryIds, purgeMemorySet) as MemoryId[];
      if (nextSourceMemoryIds.length === 0) {
        nodeIds.push(node._id);
        continue;
      }
      nodePatches.push({ nodeId: node._id, sourceMemoryIds: nextSourceMemoryIds });
    }
    const purgeNodeSet = toIdSet(nodeIds);

    const relations = await ctx.db
      .query("crystalRelations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SCAN_ROW_CAP);
    warn("crystalRelations", relations.length);
    const relationPatches: RelationPatch[] = [];
    const relationIds: RelationId[] = [];
    for (const relation of relations) {
      const nextEvidenceMemoryIds = filterIds(relation.evidenceMemoryIds, purgeMemorySet) as MemoryId[];
      const touchesDeletedNode =
        purgeNodeSet.has(String(relation.fromNodeId)) ||
        purgeNodeSet.has(String(relation.toNodeId));
      const touchedEvidence = nextEvidenceMemoryIds.length !== relation.evidenceMemoryIds.length;
      if (!touchesDeletedNode && !touchedEvidence) continue;
      if (touchesDeletedNode || nextEvidenceMemoryIds.length === 0) {
        relationIds.push(relation._id);
        continue;
      }
      relationPatches.push({ relationId: relation._id, evidenceMemoryIds: nextEvidenceMemoryIds });
    }

    const linkIds = await collectMemoryNodeLinkIds(ctx, memoryIds, nodeIds);

    const ensembles = await ctx.db
      .query("organicEnsembles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SCAN_ROW_CAP);
    warn("organicEnsembles", ensembles.length);
    const ensembleIds = ensembles
      .filter((ensemble) => intersectsIds(ensemble.memberMemoryIds, purgeMemorySet))
      .map((ensemble) => ensemble._id);
    const purgeEnsembleSet = toIdSet(ensembleIds);

    const ensembleMemberships = await ctx.db
      .query("organicEnsembleMemberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SCAN_ROW_CAP);
    warn("organicEnsembleMemberships", ensembleMemberships.length);
    const ensembleMembershipIds = ensembleMemberships
      .filter((membership) =>
        purgeMemorySet.has(String(membership.memoryId)) ||
        purgeEnsembleSet.has(String(membership.ensembleId))
      )
      .map((membership) => membership._id);

    const recentIdeas = await ctx.db
      .query("organicIdeas")
      .withIndex("by_user_created", (q) => q.eq("userId", userId).gte("createdAt", cutoff))
      .take(SCAN_ROW_CAP);
    warn("organicIdeas", recentIdeas.length);
    const ideaIds = recentIdeas
      .filter((idea) =>
        intersectsIds(idea.sourceMemoryIds, purgeMemorySet) ||
        intersectsIds(idea.sourceEnsembleIds ?? [], purgeEnsembleSet)
      )
      .map((idea) => idea._id);
    const purgeIdeaSet = toIdSet(ideaIds);

    const recentSkillSuggestions = await ctx.db
      .query("organicSkillSuggestions")
      .withIndex("by_user_created", (q) => q.eq("userId", userId).gte("createdAt", cutoff))
      .take(SCAN_ROW_CAP);
    warn("organicSkillSuggestions", recentSkillSuggestions.length);
    const skillSuggestionIds = recentSkillSuggestions
      .filter((suggestion) =>
        (suggestion.ideaId && purgeIdeaSet.has(String(suggestion.ideaId))) ||
        (suggestion.activatedMemoryId && purgeMemorySet.has(String(suggestion.activatedMemoryId))) ||
        suggestion.evidence.some((entry) => entry.memoryId && purgeMemorySet.has(String(entry.memoryId)))
      )
      .map((suggestion) => suggestion._id);

    const prospectiveTraces = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_user_expires", (q) => q.eq("userId", userId))
      .take(SCAN_ROW_CAP);
    warn("organicProspectiveTraces", prospectiveTraces.length);
    const prospectiveTraceIds = prospectiveTraces
      .filter((trace) => trace.createdAt >= cutoff && intersectsIds(trace.sourceMemoryIds, purgeMemorySet))
      .map((trace) => trace._id);

    const recentRecallLogs = await ctx.db
      .query("organicRecallLog")
      .withIndex("by_user", (q) => q.eq("userId", userId).gte("createdAt", cutoff))
      .take(SCAN_ROW_CAP);
    warn("organicRecallLog", recentRecallLogs.length);
    const recallLogIds = recentRecallLogs
      .filter((log) =>
        intersectsIds(log.topResultIds, purgeMemorySet) ||
        log.candidateSignals?.some((signal) => purgeMemorySet.has(String(signal.memoryId))) === true
      )
      .map((log) => log._id);

    const tickStates = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SCAN_ROW_CAP);
    warn("organicTickState", tickStates.length);
    const tickStatePatches = tickStates
      .map((tickState) => ({
        tickStateId: tickState._id,
        warmCacheMemoryIds: Array.isArray(tickState.warmCacheMemoryIds)
          ? tickState.warmCacheMemoryIds.filter((memoryId) => !purgeMemorySet.has(String(memoryId)))
          : [],
        originalWarmCacheMemoryIds: Array.isArray(tickState.warmCacheMemoryIds) ? tickState.warmCacheMemoryIds : [],
      }))
      .filter((patch) => patch.warmCacheMemoryIds.length !== patch.originalWarmCacheMemoryIds.length)
      .map(({ tickStateId, warmCacheMemoryIds }) => ({ tickStateId, warmCacheMemoryIds }));

    const planWithoutSummary = {
      cutoff,
      memoryIds,
      protectedKnowledgeBaseMemoryIds: protectedKnowledgeBaseMemories.map((memory) => memory._id),
      messageIds,
      sessionIds,
      snapshotIds,
      checkpointIds,
      associationIds,
      linkIds,
      wakeStateIds,
      activityLogIds: Array.from(activityLogIds) as ActivityLogId[],
      nodeIds,
      nodePatches,
      relationIds,
      relationPatches,
      ensembleIds,
      ensembleMembershipIds,
      ideaIds,
      skillSuggestionIds,
      prospectiveTraceIds,
      recallLogIds,
      preservedMemoryPatches,
      tickStatePatches,
    };

    return {
      ...planWithoutSummary,
      summary: summarizePlan(planWithoutSummary),
    };
  },
});

export const dryRunScan: any = internalAction({
  args: {
    userId: v.string(),
    windowHours: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const windowHours = args.windowHours ?? DEFAULT_WINDOW_HOURS;
    const cutoff = cutoffMs(windowHours);
    const plan: any = await ctx.runQuery(morrowInternal.scanCandidates, {
      userId: args.userId,
      cutoff,
    });

    console.log("=== MORROW PURGE DRY RUN ===");
    console.log(`userId: ${args.userId}`);
    console.log(`windowHours: ${windowHours}`);
    console.log(`cutoff: ${new Date(cutoff).toISOString()}`);
    console.log(JSON.stringify(plan.summary, null, 2));
    console.log(
      `protectedKnowledgeBaseMemoryIds=${plan.protectedKnowledgeBaseMemoryIds.map((id: MemoryId) => String(id)).join(",") || "(none)"}`
    );
    console.log("============================");

    return {
      dryRun: true,
      userId: args.userId,
      windowHours,
      cutoff,
      summary: plan.summary,
      protectedKnowledgeBaseMemoryIds: plan.protectedKnowledgeBaseMemoryIds,
    };
  },
});

async function deleteByIds(ctx: any, ids: readonly (string | Id<any>)[]): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    const normalizedId = id as Id<any>;
    const existing = await ctx.db.get(normalizedId);
    if (!existing) continue;
    await ctx.db.delete(normalizedId);
    deleted += 1;
  }
  return deleted;
}

export const applyPurgePlan = internalMutation({
  args: purgePlanValidator,
  handler: async (ctx, plan) => {
    let patchedMemories = 0;
    for (const patch of plan.preservedMemoryPatches) {
      const existing = await ctx.db.get(patch.memoryId);
      if (!existing) continue;
      const next: Record<string, unknown> = {};
      if (patch.clearSessionId) next.sessionId = undefined;
      if (patch.clearCheckpointId) next.checkpointId = undefined;
      if (patch.clearSourceSnapshotId) next.sourceSnapshotId = undefined;
      if (Object.keys(next).length === 0) continue;
      await ctx.db.patch(patch.memoryId, next);
      patchedMemories += 1;
    }

    let patchedNodes = 0;
    for (const patch of plan.nodePatches) {
      const existing = await ctx.db.get(patch.nodeId);
      if (!existing) continue;
      await ctx.db.patch(patch.nodeId, { sourceMemoryIds: patch.sourceMemoryIds });
      patchedNodes += 1;
    }

    let patchedRelations = 0;
    for (const patch of plan.relationPatches) {
      const existing = await ctx.db.get(patch.relationId);
      if (!existing) continue;
      await ctx.db.patch(patch.relationId, { evidenceMemoryIds: patch.evidenceMemoryIds });
      patchedRelations += 1;
    }

    let patchedTickStates = 0;
    for (const patch of plan.tickStatePatches) {
      const existing = await ctx.db.get(patch.tickStateId);
      if (!existing) continue;
      await ctx.db.patch(patch.tickStateId, { warmCacheMemoryIds: patch.warmCacheMemoryIds });
      patchedTickStates += 1;
    }

    const deleted = {
      associations: await deleteByIds(ctx, plan.associationIds),
      memoryNodeLinks: await deleteByIds(ctx, plan.linkIds),
      wakeStates: await deleteByIds(ctx, plan.wakeStateIds),
      activityLogs: await deleteByIds(ctx, plan.activityLogIds),
      recallLogs: await deleteByIds(ctx, plan.recallLogIds),
      prospectiveTraces: await deleteByIds(ctx, plan.prospectiveTraceIds),
      skillSuggestions: await deleteByIds(ctx, plan.skillSuggestionIds),
      ideas: await deleteByIds(ctx, plan.ideaIds),
      ensembleMemberships: await deleteByIds(ctx, plan.ensembleMembershipIds),
      relations: await deleteByIds(ctx, plan.relationIds),
      nodes: await deleteByIds(ctx, plan.nodeIds),
      ensembles: await deleteByIds(ctx, plan.ensembleIds),
      checkpoints: await deleteByIds(ctx, plan.checkpointIds),
      messages: await deleteByIds(ctx, plan.messageIds),
      memories: await deleteByIds(ctx, plan.memoryIds),
      snapshots: await deleteByIds(ctx, plan.snapshotIds),
      sessions: await deleteByIds(ctx, plan.sessionIds),
    };

    return {
      deleted,
      patched: {
        memories: patchedMemories,
        nodes: patchedNodes,
        relations: patchedRelations,
        tickStates: patchedTickStates,
      },
    };
  },
});

export const executePurge: any = internalAction({
  args: {
    userId: v.string(),
    confirm: v.literal("PURGE"),
    windowHours: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const windowHours = args.windowHours ?? DEFAULT_WINDOW_HOURS;
    const cutoff = cutoffMs(windowHours);

    let plan: any = await ctx.runQuery(morrowInternal.scanCandidates, {
      userId: args.userId,
      cutoff,
    });

    console.log("=== MORROW PURGE EXECUTE ===");
    console.log(
      JSON.stringify(
        {
          userId: args.userId,
          windowHours,
          cutoff,
          summary: plan.summary,
          protectedKnowledgeBaseMemoryIds: plan.protectedKnowledgeBaseMemoryIds.map((id: MemoryId) => String(id)),
        },
        null,
        2,
      ),
    );

    const applyRounds: any[] = [];
    let applied: any = null;
    let lastRemainingJson = "";
    for (let round = 0; round < 10; round += 1) {
      const remainingJson = JSON.stringify(plan.summary);
      if (remainingJson === lastRemainingJson) break;
      lastRemainingJson = remainingJson;
      applied = await ctx.runMutation(morrowInternal.applyPurgePlan, plan);
      applyRounds.push(applied);
      const nextPlan = await ctx.runQuery(morrowInternal.scanCandidates, {
        userId: args.userId,
        cutoff,
      });
      plan = nextPlan;
      if (Object.values(nextPlan.summary as Record<string, number>).every((value) => value === 0)) {
        break;
      }
    }
    const dashboardTotals: any = await ctx.runMutation(dashboardTotalsInternal.backfillDashboardTotalsForUser, {
      userId: args.userId,
    });
    const remainingPlan = plan;

    console.log("=== MORROW PURGE COMPLETE ===");
    console.log(JSON.stringify({ applied, remaining: remainingPlan.summary }, null, 2));

    return {
      userId: args.userId,
      windowHours,
      cutoff,
      applied,
      applyRounds,
      dashboardTotals,
      remaining: remainingPlan.summary,
    };
  },
});

// Peer-capable scope prefixes — mirrors PEER_CAPABLE_SCOPES in the forthcoming
// Phase 2.1 knowledgeBases.ts update. Kept local so this query ships independently.
const PEER_CAPABLE_SCOPE_PREFIXES = new Set(["morrow-coach", "cass-coach"]);

function derivePeerCapablePrefix(agentIds?: string[]): string | undefined {
  if (!Array.isArray(agentIds)) return undefined;
  for (const id of agentIds) {
    const prefix = id.trim();
    if (PEER_CAPABLE_SCOPE_PREFIXES.has(prefix)) return prefix;
  }
  return undefined;
}

/**
 * Phase 1.5 tenant enumeration — read-only, no writes.
 *
 * Enumerate every KB whose agentIds map to a peer-capable scope prefix
 * (morrow-coach, cass-coach) but whose scope field is empty/missing.
 * Also returns the chunk count per KB from crystalMemories.
 *
 * Run before any Phase 2 deploy:
 *   npx convex run crystal/morrowPurge:enumerateKbPeerScopeImpact '{}'
 *
 * Output: array of { userId, knowledgeBaseId, agentIds, derivedScopePrefix, chunkCount }
 * Post the JSON to the PR per Phase 1.5 acceptance criteria.
 */
export const enumerateKbPeerScopeImpact = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{
    userId: string;
    knowledgeBaseId: string;
    agentIds: string[];
    derivedScopePrefix: string;
    chunkCount: number;
  }>> => {
    const KB_SCAN_CAP = 2000;

    const allKbs = await ctx.db
      .query("knowledgeBases")
      .take(KB_SCAN_CAP);

    if (allKbs.length >= KB_SCAN_CAP) {
      console.warn(
        `[morrowPurge.enumerateKbPeerScopeImpact] hit KB_SCAN_CAP=${KB_SCAN_CAP} — results may be incomplete`,
      );
    }

    const impacted = allKbs.filter((kb) => {
      const hasEmptyScope = !kb.scope || kb.scope.trim() === "";
      const prefix = derivePeerCapablePrefix(kb.agentIds);
      return hasEmptyScope && !!prefix;
    });

    const results: Array<{
      userId: string;
      knowledgeBaseId: string;
      agentIds: string[];
      derivedScopePrefix: string;
      chunkCount: number;
    }> = [];

    for (const kb of impacted) {
      const prefix = derivePeerCapablePrefix(kb.agentIds)!;

      const chunks = await ctx.db
        .query("crystalMemories")
        .withIndex("by_user_created", (q) => q.eq("userId", kb.userId))
        .filter((q) => q.eq(q.field("knowledgeBaseId"), kb._id))
        .take(10000);

      results.push({
        userId: kb.userId,
        knowledgeBaseId: kb._id as string,
        agentIds: kb.agentIds ?? [],
        derivedScopePrefix: prefix,
        chunkCount: chunks.length,
      });
    }

    console.log(
      "[morrowPurge.enumerateKbPeerScopeImpact] impact list:",
      JSON.stringify(results, null, 2),
    );

    return results;
  },
});
