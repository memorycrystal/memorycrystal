import { v } from "convex/values";
import { mutation, query } from "../../_generated/server";
import { stableUserId } from "../auth";
import type { Doc, Id } from "../../_generated/dataModel";

type ConflictStatus = "unresolved" | "dismissed" | "resolved" | "scoped";

type ConflictMetadata = {
  version: 1;
  kind: "contradiction";
  pairKey: string;
  status: ConflictStatus;
  conflictType?: string;
  score?: number;
  explanation?: string;
  suggestedResolution?: string;
  detectedAt?: number;
  detectedBy?: "pulse" | "write";
  resolvedAt?: number;
  resolvedByAction?: string;
  resolutionNote?: string;
  resolutionMemoryId?: string;
  supersededMemoryId?: string;
};

type ConflictGroup = Doc<"organicEnsembles">;

const resolutionAction = v.union(
  v.literal("dismissed"),
  v.literal("scoped"),
);

function defaultPairKey(group: Pick<ConflictGroup, "memberMemoryIds">) {
  return group.memberMemoryIds.map(String).sort().join("::");
}

function parseConflictMetadata(group: ConflictGroup): ConflictMetadata {
  if (group.metadata) {
    try {
      const parsed = JSON.parse(group.metadata);
      if (parsed && typeof parsed === "object") {
        return {
          version: 1,
          kind: "contradiction",
          pairKey: typeof parsed.pairKey === "string" ? parsed.pairKey : defaultPairKey(group),
          status: isConflictStatus(parsed.status) ? parsed.status : "unresolved",
          conflictType: typeof parsed.conflictType === "string" ? parsed.conflictType : undefined,
          score: typeof parsed.score === "number" ? parsed.score : undefined,
          explanation: typeof parsed.explanation === "string" ? parsed.explanation : group.summary,
          suggestedResolution: typeof parsed.suggestedResolution === "string" ? parsed.suggestedResolution : undefined,
          detectedAt: typeof parsed.detectedAt === "number" ? parsed.detectedAt : group.updatedAt,
          detectedBy: parsed.detectedBy === "write" || parsed.detectedBy === "pulse" ? parsed.detectedBy : undefined,
          resolvedAt: typeof parsed.resolvedAt === "number" ? parsed.resolvedAt : undefined,
          resolvedByAction: typeof parsed.resolvedByAction === "string" ? parsed.resolvedByAction : undefined,
          resolutionNote: typeof parsed.resolutionNote === "string" ? parsed.resolutionNote : undefined,
          resolutionMemoryId: typeof parsed.resolutionMemoryId === "string" ? parsed.resolutionMemoryId : undefined,
          supersededMemoryId: typeof parsed.supersededMemoryId === "string" ? parsed.supersededMemoryId : undefined,
        };
      }
    } catch {
      // Fall through to a backward-compatible unresolved shape.
    }
  }

  return {
    version: 1,
    kind: "contradiction",
    pairKey: defaultPairKey(group),
    status: "unresolved",
    explanation: group.summary,
    detectedAt: group.updatedAt,
  };
}

function isConflictStatus(value: unknown): value is ConflictStatus {
  return value === "unresolved" || value === "dismissed" || value === "resolved" || value === "scoped";
}

function serializeMetadata(group: ConflictGroup, patch: Partial<ConflictMetadata>) {
  return JSON.stringify({
    ...parseConflictMetadata(group),
    ...patch,
  });
}

async function getMyConflictGroup(ctx: any, userId: string, ensembleId: Id<"organicEnsembles">) {
  const group = await ctx.db.get(ensembleId);
  if (!group || group.userId !== userId || group.archived || group.ensembleType !== "conflict_group") {
    return null;
  }
  return group as ConflictGroup;
}

async function serializeConflictGroup(ctx: any, group: ConflictGroup) {
  const memories = await Promise.all(group.memberMemoryIds.map((id) => ctx.db.get(id)));
  return {
    _id: group._id,
    label: group.label,
    summary: group.summary,
    confidence: group.confidence,
    strength: group.strength,
    updatedAt: group.updatedAt,
    metadata: parseConflictMetadata(group),
    memberMemories: memories.flatMap((memory) => memory && !memory.archived && memory.userId === group.userId ? [{
      _id: memory._id,
      title: memory.title,
      content: memory.content,
      store: memory.store,
      category: memory.category,
      confidence: memory.confidence,
      strength: memory.strength,
      channel: memory.channel,
    }] : []),
  };
}

async function deactivateConflictTraces(ctx: any, group: ConflictGroup, metadata: ConflictMetadata) {
  const pairSourcePrefix = metadata.pairKey ? `pair:${metadata.pairKey}` : null;
  if (!pairSourcePrefix) return;
  const traces = await ctx.db
    .query("organicProspectiveTraces")
    .withIndex("by_user_type", (q: any) =>
      q.eq("userId", group.userId).eq("traceType", "contradiction")
    )
    .take(1000);

  const now = Date.now();
  await Promise.all(traces
    .filter((trace: any) => trace.validated === null)
    .filter((trace: any) => trace.sourcePattern === pairSourcePrefix || trace.sourcePattern.startsWith(`${pairSourcePrefix} `))
    .map((trace: any) => ctx.db.patch(trace._id, {
      validated: false,
      validatedAt: now,
    })));
}

export const listMyConflictGroups = query({
  args: { includeResolved: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);
    const groups = await ctx.db
      .query("organicEnsembles")
      .withIndex("by_user_type", (q) =>
        q.eq("userId", userId).eq("ensembleType", "conflict_group").eq("archived", false)
      )
      .collect();

    return Promise.all(groups
      .filter((group) => args.includeResolved || parseConflictMetadata(group).status === "unresolved")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((group) => serializeConflictGroup(ctx, group)));
  },
});

export const getMyConflictGroupDetail = query({
  args: { ensembleId: v.id("organicEnsembles") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);
    const group = await getMyConflictGroup(ctx, userId, args.ensembleId);
    return group ? serializeConflictGroup(ctx, group) : null;
  },
});

export const updateConflictStatus = mutation({
  args: {
    ensembleId: v.id("organicEnsembles"),
    action: resolutionAction,
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const group = await getMyConflictGroup(ctx, userId, args.ensembleId);
    if (!group) throw new Error("Conflict group not found");
    const metadata = parseConflictMetadata(group);

    const status: ConflictStatus =
      args.action === "dismissed" ? "dismissed" :
      args.action === "scoped" ? "scoped" :
      "resolved";
    const now = Date.now();
    await ctx.db.patch(group._id, {
      metadata: serializeMetadata(group, {
        status,
        resolvedAt: now,
        resolvedByAction: args.action,
        resolutionNote: args.note?.trim() || undefined,
      }),
      updatedAt: now,
    });
    await deactivateConflictTraces(ctx, group, metadata);
    return { success: true, status };
  },
});
