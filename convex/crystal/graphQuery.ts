import { stableUserId } from "./auth";
import { internal } from "../_generated/api";
import { action, internalAction, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { type Id, type Doc } from "../_generated/dataModel";
import {
  isKnowledgeBaseVisibleToAgent,
  isNonKnowledgeBaseMemoryVisibleInChannel,
  resolveKnowledgeBaseAgentId,
} from "./knowledgeBases";
import { sha256Hex } from "./crypto";

const LABEL_SEARCH_LIMIT = 25;
const RELATION_QUERY_LIMIT = 200;

const nodeTypeList = [
  "person",
  "project",
  "goal",
  "decision",
  "concept",
  "tool",
  "event",
  "resource",
  "channel",
] as const;

const relationTypeList = [
  "mentions",
  "decided_in",
  "leads_to",
  "depends_on",
  "owns",
  "uses",
  "conflicts_with",
  "supports",
  "occurs_with",
  "assigned_to",
] as const;

const ownershipRelations = ["owns", "assigned_to", "leads_to"] as const;
const dependencyRelations = ["depends_on", "leads_to", "decided_in"] as const;

const direction = v.union(v.literal("from"), v.literal("to"), v.literal("both"));

const normalizeText = (value: string) => value.trim().toLowerCase();
const clampLimit = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
};

const normalizeProjectId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^proj_[a-f0-9]{12,64}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
};

const normalizeRepoSlug = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) return undefined;
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120) || undefined;
};

const normalizeProjectContext = async (projectIdValue: unknown, repoSlugValue: unknown) => {
  const explicitProjectId = normalizeProjectId(projectIdValue);
  const repoSlug = normalizeRepoSlug(repoSlugValue);
  if (explicitProjectId || !repoSlug) {
    return { projectId: explicitProjectId, repoSlug };
  }
  const digest = await sha256Hex(`repo:${repoSlug.toLowerCase()}`);
  return { projectId: `proj_${digest.slice(0, 24)}`, repoSlug };
};

const parseJsonObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
};

const getMemoryProjectId = (memory: any): string | undefined =>
  normalizeProjectId(memory?.projectId) ?? normalizeProjectId(parseJsonObject(memory?.metadata).projectId);

type GraphScope = {
  channel?: string;
  agentId?: string;
  projectId?: string;
  repoSlug?: string;
};

type VisibleEvidenceResult = {
  visibleMemoryIds: string[];
  visibleEvidenceCount: number;
  hiddenEvidenceCount: number;
};

const emptyVisibleEvidence = (): VisibleEvidenceResult => ({
  visibleMemoryIds: [],
  visibleEvidenceCount: 0,
  hiddenEvidenceCount: 0,
});

const hasCanonicalMatch = (node: Doc<"crystalNodes">, query: string) => {
  const canonical = normalizeText(node.canonicalKey);
  return canonical === query || canonical.includes(query);
};

const hasLabelMatch = (node: Doc<"crystalNodes">, query: string) =>
  normalizeText(node.label).includes(query);

export type RelationWithNodes = {
  relation: Doc<"crystalRelations">;
  fromNode: Doc<"crystalNodes">;
  toNode: Doc<"crystalNodes">;
};

const toRelationIds = (ids: Id<"crystalMemories">[]) => ids.map((id) => id.toString());

export const findNodesByLabel = internalQuery({
  args: {
    userId: v.string(),
    labelQuery: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const query = normalizeText(args.labelQuery);
    const limit = clampLimit(args.limit ?? LABEL_SEARCH_LIMIT, 1, 100, LABEL_SEARCH_LIMIT);

    if (!query) {
      return [];
    }

    const searchLimit = Math.min(limit * 4, 100);

    try {
      const searchResults = await (ctx.db.query("crystalNodes") as any)
        .withSearchIndex("search_label", (q: any) => q.search("label", query).eq("userId", args.userId))
        .take(searchLimit);

      if (searchResults.length > 0) {
        return searchResults
          .filter((node: Doc<"crystalNodes">) => hasLabelMatch(node as Doc<"crystalNodes">, query) || hasCanonicalMatch(node as Doc<"crystalNodes">, query))
          .slice(0, limit);
      }
    } catch {
      // search index may not be configured for crystalNodes in older deployments.
    }

    return (
      await ctx.db
        .query("crystalNodes")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .take(searchLimit)
    )
      .filter((node: Doc<"crystalNodes">) => hasLabelMatch(node as Doc<"crystalNodes">, query) || hasCanonicalMatch(node as Doc<"crystalNodes">, query))
      .slice(0, limit);
  },
});

export const getRelationsForNode = internalQuery({
  args: {
    userId: v.string(),
    nodeId: v.id("crystalNodes"),
    direction,
  },
  handler: async (ctx, args) => {
    const queryLimit = Math.min(RELATION_QUERY_LIMIT, 500);

    const fromNodes = (await ctx.db
      .query("crystalRelations")
      .withIndex("by_from_node", (q) => q.eq("fromNodeId", args.nodeId))
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .take(queryLimit)) as Doc<"crystalRelations">[];

    const toNodes = (await ctx.db
      .query("crystalRelations")
      .withIndex("by_to_node", (q) => q.eq("toNodeId", args.nodeId))
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .take(queryLimit)) as Doc<"crystalRelations">[];

    const relationMap = new Map<string, RelationWithNodes>();

    const addRelation = async (relation: Doc<"crystalRelations">) => {
      const fromNode = await ctx.db.get(relation.fromNodeId);
      const toNode = await ctx.db.get(relation.toNodeId);

      if (!fromNode || !toNode) {
        return;
      }

      if (fromNode.userId !== args.userId || toNode.userId !== args.userId) {
        return;
      }

      relationMap.set(relation._id, {
        relation,
        fromNode: { ...(fromNode as Doc<"crystalNodes">) },
        toNode: { ...(toNode as Doc<"crystalNodes">) },
      });
    };

    if (args.direction === "from" || args.direction === "both") {
      for (const relation of fromNodes) {
        await addRelation(relation);
      }
    }

    if (args.direction === "to" || args.direction === "both") {
      for (const relation of toNodes) {
        await addRelation(relation);
      }
    }

    return [...relationMap.values()];
  },
});

async function visibleEvidenceForMemoryIds(
  ctx: any,
  args: {
    userId: string;
    memoryIds: Array<Id<"crystalMemories"> | string>;
    channel?: string;
    agentId?: string;
    projectId?: string;
  },
): Promise<VisibleEvidenceResult> {
  const ids = Array.from(
    new Set(args.memoryIds.map((id) => String(id)).filter(Boolean)),
  );
  if (ids.length === 0) return emptyVisibleEvidence();

  const effectiveAgentId = resolveKnowledgeBaseAgentId(args.agentId, args.channel);
  const visibleMemoryIds: string[] = [];
  let hiddenEvidenceCount = 0;

  const knowledgeBaseCache = new Map<string, any | null>();
  const getKnowledgeBase = async (knowledgeBaseId: string) => {
    if (!knowledgeBaseCache.has(knowledgeBaseId)) {
      const knowledgeBase = await ctx.db.get(knowledgeBaseId as any).catch(() => null);
      knowledgeBaseCache.set(knowledgeBaseId, knowledgeBase);
    }
    return knowledgeBaseCache.get(knowledgeBaseId);
  };

  for (const id of ids) {
    const memory = await ctx.db.get(id as Id<"crystalMemories">).catch(() => null);
    if (!memory || memory.userId !== args.userId || memory.archived) {
      hiddenEvidenceCount += 1;
      continue;
    }

    const memoryProjectId = getMemoryProjectId(memory);
    if (args.projectId && memoryProjectId && memoryProjectId !== args.projectId) {
      hiddenEvidenceCount += 1;
      continue;
    }

    if (memory.knowledgeBaseId) {
      const knowledgeBase = await getKnowledgeBase(String(memory.knowledgeBaseId));
      if (
        knowledgeBase &&
        knowledgeBase.userId === args.userId &&
        isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, args.channel ?? "")
      ) {
        visibleMemoryIds.push(id);
      } else {
        hiddenEvidenceCount += 1;
      }
      continue;
    }

    if (isNonKnowledgeBaseMemoryVisibleInChannel(memory.channel, args.channel)) {
      visibleMemoryIds.push(id);
    } else {
      hiddenEvidenceCount += 1;
    }
  }

  return {
    visibleMemoryIds,
    visibleEvidenceCount: visibleMemoryIds.length,
    hiddenEvidenceCount,
  };
}

export const getVisibleEvidenceMemoryIdsInternal = internalQuery({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.id("crystalMemories")),
    channel: v.optional(v.string()),
    agentId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<VisibleEvidenceResult> =>
    visibleEvidenceForMemoryIds(ctx, args),
});

export const getGraphContextForMemoriesInternal = internalQuery({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.id("crystalMemories")),
    channel: v.optional(v.string()),
    agentId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    maxEntities: v.optional(v.number()),
    maxRelations: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const memoryIds = Array.from(new Set(args.memoryIds.map((id) => String(id)))).slice(0, 20);
    const maxEntities = clampLimit(args.maxEntities ?? 30, 1, 60, 30);
    const maxRelations = clampLimit(args.maxRelations ?? 20, 1, 50, 20);
    if (memoryIds.length === 0) {
      return {
        byMemoryId: {},
        relations: [],
        coverage: { memoryCount: 0, linkedMemoryCount: 0, entityCount: 0, relationCount: 0 },
      };
    }

    const visible = await visibleEvidenceForMemoryIds(ctx, {
      userId: args.userId,
      memoryIds,
      channel: args.channel,
      agentId: args.agentId,
      projectId: args.projectId,
    });
    const visibleMemoryIdSet = new Set(visible.visibleMemoryIds);
    const byMemoryId: Record<string, { entities: Array<{ nodeId: string; label: string; nodeType: string; role: string; confidence: number }> }> = {};
    const nodeIds = new Set<string>();
    const nodeById = new Map<string, Doc<"crystalNodes">>();

    for (const memoryId of memoryIds) {
      byMemoryId[memoryId] = { entities: [] };
      if (!visibleMemoryIdSet.has(memoryId)) continue;
      const links = await ctx.db
        .query("crystalMemoryNodeLinks")
        .withIndex("by_memory", (q: any) => q.eq("memoryId", memoryId as Id<"crystalMemories">))
        .filter((q: any) => q.eq(q.field("userId"), args.userId))
        .take(10);
      for (const link of links) {
        const node = await ctx.db.get(link.nodeId);
        if (!node || node.userId !== args.userId) continue;
        nodeIds.add(String(node._id));
        nodeById.set(String(node._id), node as Doc<"crystalNodes">);
        if (byMemoryId[memoryId].entities.length < maxEntities) {
          byMemoryId[memoryId].entities.push({
            nodeId: String(node._id),
            label: node.label,
            nodeType: node.nodeType,
            role: link.role,
            confidence: link.linkConfidence,
          });
        }
      }
    }

    const relationMap = new Map<string, Doc<"crystalRelations">>();
    for (const nodeId of Array.from(nodeIds).slice(0, maxEntities)) {
      const [fromRelations, toRelations] = await Promise.all([
        ctx.db
          .query("crystalRelations")
          .withIndex("by_from_node", (q: any) => q.eq("fromNodeId", nodeId as Id<"crystalNodes">))
          .filter((q: any) => q.eq(q.field("userId"), args.userId))
          .take(10),
        ctx.db
          .query("crystalRelations")
          .withIndex("by_to_node", (q: any) => q.eq("toNodeId", nodeId as Id<"crystalNodes">))
          .filter((q: any) => q.eq(q.field("userId"), args.userId))
          .take(10),
      ]);
      for (const relation of [...fromRelations, ...toRelations]) {
        relationMap.set(String(relation._id), relation as Doc<"crystalRelations">);
      }
    }

    const evidenceIds = Array.from(
      new Set(
        Array.from(relationMap.values()).flatMap((relation) =>
          relation.evidenceMemoryIds.map((id) => String(id)),
        ),
      ),
    );
    const relationEvidence = await visibleEvidenceForMemoryIds(ctx, {
      userId: args.userId,
      memoryIds: evidenceIds,
      channel: args.channel,
      agentId: args.agentId,
      projectId: args.projectId,
    });
    const visibleEvidenceSet = new Set(relationEvidence.visibleMemoryIds);

    const relations: Array<{
      fromLabel: string;
      toLabel: string;
      relationType: string;
      confidence: number;
      evidenceMemoryIds: string[];
    }> = [];
    for (const relation of Array.from(relationMap.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxRelations * 2)) {
      const visibleEvidenceIds = relation.evidenceMemoryIds
        .map((id) => String(id))
        .filter((id) => visibleEvidenceSet.has(id));
      if (visibleEvidenceIds.length === 0) continue;
      const fromNode =
        nodeById.get(String(relation.fromNodeId)) ??
        (await ctx.db.get(relation.fromNodeId));
      const toNode =
        nodeById.get(String(relation.toNodeId)) ??
        (await ctx.db.get(relation.toNodeId));
      if (!fromNode || !toNode || fromNode.userId !== args.userId || toNode.userId !== args.userId) continue;
      relations.push({
        fromLabel: fromNode.label,
        toLabel: toNode.label,
        relationType: relation.relationType,
        confidence: relation.confidence,
        evidenceMemoryIds: visibleEvidenceIds,
      });
      if (relations.length >= maxRelations) break;
    }

    return {
      byMemoryId,
      relations,
      coverage: {
        memoryCount: memoryIds.length,
        linkedMemoryCount: Object.values(byMemoryId).filter((entry) => entry.entities.length > 0).length,
        entityCount: nodeIds.size,
        relationCount: relations.length,
        hiddenEvidenceCount: visible.hiddenEvidenceCount + relationEvidence.hiddenEvidenceCount,
      },
    };
  },
});

type OwnerResult = {
  label: string;
  nodeType: (typeof nodeTypeList)[number];
  relationType: (typeof relationTypeList)[number];
  confidence: number;
  evidenceMemoryIds: string[];
};

type OwnedByResult = {
  label: string;
  nodeType: (typeof nodeTypeList)[number];
  relationType: (typeof relationTypeList)[number];
  confidence: number;
  evidenceMemoryIds: string[];
};

const graphScopeArgs = {
  channel: v.optional(v.string()),
  agentId: v.optional(v.string()),
  projectId: v.optional(v.string()),
  repoSlug: v.optional(v.string()),
};

const graphVisibilitySummary = (
  visibility: VisibleEvidenceResult,
  relationEvidenceCount: number,
) => ({
  visibleEvidenceCount: visibility.visibleEvidenceCount,
  hiddenEvidenceCount: visibility.hiddenEvidenceCount,
  relationEvidenceCount,
});

async function visibleEvidenceSetForRelations(
  ctx: any,
  userId: string,
  relations: Array<{ evidenceMemoryIds: string[] }>,
  scope: GraphScope,
): Promise<{ visibleSet: Set<string>; summary: ReturnType<typeof graphVisibilitySummary> }> {
  const ids = Array.from(
    new Set(relations.flatMap((relation) => relation.evidenceMemoryIds).filter(Boolean)),
  ) as Array<Id<"crystalMemories">>;
  if (ids.length === 0) {
    return {
      visibleSet: new Set(),
      summary: graphVisibilitySummary(emptyVisibleEvidence(), 0),
    };
  }
  const visibility = await ctx.runQuery(internal.crystal.graphQuery.getVisibleEvidenceMemoryIdsInternal, {
    userId,
    memoryIds: ids,
    channel: scope.channel,
    agentId: scope.agentId,
    projectId: scope.projectId,
  }) as VisibleEvidenceResult;
  return {
    visibleSet: new Set(visibility.visibleMemoryIds),
    summary: graphVisibilitySummary(visibility, ids.length),
  };
}

function filterRelationEvidence<T extends { evidenceMemoryIds: string[] }>(
  relation: T,
  visibleSet: Set<string>,
): T | null {
  const evidenceMemoryIds = relation.evidenceMemoryIds.filter((id) => visibleSet.has(id));
  return evidenceMemoryIds.length > 0 ? { ...relation, evidenceMemoryIds } : null;
}

async function runWhoOwns(
  ctx: any,
  userId: string,
  args: { entity: string } & GraphScope,
): Promise<any> {
  const { projectId, repoSlug } = await normalizeProjectContext(args.projectId, args.repoSlug);
  const scope = { channel: args.channel, agentId: args.agentId, projectId, repoSlug };

    const entity = args.entity.trim();
    if (!entity) {
      throw new Error("entity is required");
    }

    const targetNodes: Doc<"crystalNodes">[] = await ctx.runQuery(internal.crystal.graphQuery.findNodesByLabel, {
      userId,
      labelQuery: entity,
      limit: LABEL_SEARCH_LIMIT,
    });

    if (targetNodes.length === 0) {
      return {
        entity,
        owners: [],
        ownedBy: [],
        primarySource: "graph",
        fallbackUsed: false,
        visibleEvidenceCount: 0,
        hiddenEvidenceCount: 0,
        relationEvidenceCount: 0,
        truncated: false,
      };
    }

    const owners: OwnerResult[] = [];
    const ownedBy: OwnedByResult[] = [];
    const ownerKeys = new Set<string>();
    const ownedByKeys = new Set<string>();
    const ownershipSet = new Set<string>(ownershipRelations);

    for (const node of targetNodes) {
      const incomingRelations = await ctx.runQuery(internal.crystal.graphQuery.getRelationsForNode, {
        userId,
        nodeId: node._id,
        direction: "to",
      });

      const outgoingRelations = await ctx.runQuery(internal.crystal.graphQuery.getRelationsForNode, {
        userId,
        nodeId: node._id,
        direction: "from",
      });

      for (const relationRecord of incomingRelations as RelationWithNodes[]) {
        if (!ownershipSet.has(relationRecord.relation.relationType)) {
          continue;
        }
        const key = relationRecord.relation._id;
        if (ownerKeys.has(key)) {
          continue;
        }
        ownerKeys.add(key);
        owners.push({
          label: relationRecord.fromNode.label,
          nodeType: relationRecord.fromNode.nodeType,
          relationType: relationRecord.relation.relationType,
          confidence: relationRecord.relation.confidence,
          evidenceMemoryIds: toRelationIds(relationRecord.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
        });
      }

      for (const relationRecord of outgoingRelations as RelationWithNodes[]) {
        if (relationRecord.relation.relationType !== "owns" && relationRecord.relation.relationType !== "assigned_to") {
          continue;
        }

        const key = relationRecord.relation._id;
        if (ownedByKeys.has(key)) {
          continue;
        }
        ownedByKeys.add(key);
        ownedBy.push({
          label: relationRecord.toNode.label,
          nodeType: relationRecord.toNode.nodeType,
          relationType: relationRecord.relation.relationType,
          confidence: relationRecord.relation.confidence,
          evidenceMemoryIds: toRelationIds(relationRecord.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
        });
      }
    }

    const { visibleSet, summary } = await visibleEvidenceSetForRelations(
      ctx,
      userId,
      [...owners, ...ownedBy],
      scope,
    );
    const visibleOwners = owners
      .map((owner) => filterRelationEvidence(owner, visibleSet))
      .filter((owner): owner is OwnerResult => owner !== null);
    const visibleOwnedBy = ownedBy
      .map((owned) => filterRelationEvidence(owned, visibleSet))
      .filter((owned): owned is OwnedByResult => owned !== null);

    return {
      entity,
      owners: visibleOwners,
      ownedBy: visibleOwnedBy,
      primarySource: "graph",
      fallbackUsed: false,
      ...summary,
      truncated:
        targetNodes.length === LABEL_SEARCH_LIMIT ||
        visibleOwners.length >= RELATION_QUERY_LIMIT ||
        visibleOwnedBy.length >= RELATION_QUERY_LIMIT,
    };
}

export const whoOwns: any = action({
  args: {
    entity: v.string(),
    ...graphScopeArgs,
  },
  handler: async (ctx, args): Promise<any> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return runWhoOwns(ctx, stableUserId(identity.subject), args);
  },
});

export const whoOwnsInternal: any = internalAction({
  args: {
    userId: v.string(),
    entity: v.string(),
    ...graphScopeArgs,
  },
  handler: async (ctx, args): Promise<any> => runWhoOwns(ctx, args.userId, args),
});

type RelationResult = {
  fromLabel: string;
  toLabel: string;
  relationType: (typeof relationTypeList)[number];
  confidence: number;
  evidenceMemoryIds: string[];
};

type PathResult = {
  type: "A_to_X_to_B" | "A_from_X_to_B";
  viaLabel: string;
  viaNodeType: (typeof nodeTypeList)[number];
  path: {
    first: RelationResult;
    second: RelationResult;
  };
};

const collectRelationIdsForSupportingMemory = (relations: RelationResult[]) => {
  const seen = new Set<string>();
  return relations.flatMap((relation) =>
    relation.evidenceMemoryIds.filter((evidenceId) => {
      if (seen.has(evidenceId)) {
        return false;
      }
      seen.add(evidenceId);
      return true;
    })
  );
};

const dedupeAndLabelSupportMemories = async (
  ctx: any,
  userId: string,
  relationEvidence: RelationResult[]
): Promise<Array<{ title: string; store: string }>> => {
  const ids = collectRelationIdsForSupportingMemory(relationEvidence);
  const records = await Promise.all(
    ids.map((id) =>
      ctx
        .runQuery(internal.crystal.memories.getMemoryInternal, {
          memoryId: id as Id<"crystalMemories">,
        })
        .catch(() => null)
    )
  );

  const out = records
    .filter((memory: any) => memory !== null && memory.userId === userId)
    .map((memory: any) => ({
      title: memory.title,
      store: memory.store,
    }));

  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = `${entry.title}|${entry.store}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

async function runExplainConnection(
  ctx: any,
  userId: string,
  args: { entityA: string; entityB: string } & GraphScope,
): Promise<any> {
    const { projectId, repoSlug } = await normalizeProjectContext(args.projectId, args.repoSlug);
    const scope = { channel: args.channel, agentId: args.agentId, projectId, repoSlug };
    const entityA = args.entityA.trim();
    const entityB = args.entityB.trim();

    if (!entityA || !entityB) {
      throw new Error("entityA and entityB are required");
    }

    const [nodesA, nodesB]: [Doc<"crystalNodes">[], Doc<"crystalNodes">[]] = await Promise.all([
      ctx.runQuery(internal.crystal.graphQuery.findNodesByLabel, {
        userId,
        labelQuery: entityA,
        limit: LABEL_SEARCH_LIMIT,
      }),
      ctx.runQuery(internal.crystal.graphQuery.findNodesByLabel, {
        userId,
        labelQuery: entityB,
        limit: LABEL_SEARCH_LIMIT,
      }),
    ]);

    if (nodesA.length === 0 || nodesB.length === 0) {
      return {
        entityA,
        entityB,
        directRelations: [],
        indirectPaths: [],
        supportingMemories: [],
        primarySource: "graph",
        fallbackUsed: false,
        visibleEvidenceCount: 0,
        hiddenEvidenceCount: 0,
        relationEvidenceCount: 0,
        truncated: false,
      };
    }

    const nodeRelationCache = new Map<string, RelationWithNodes[]>();

    const getDirections = async (nodeId: Id<"crystalNodes">) => {
      if (!nodeRelationCache.has(nodeId)) {
        const relations = (await ctx.runQuery(internal.crystal.graphQuery.getRelationsForNode, {
          userId,
          nodeId,
          direction: "both",
        })) as RelationWithNodes[];
        nodeRelationCache.set(nodeId, relations);
      }
      return nodeRelationCache.get(nodeId)!;
    };

    const nodesAWithRelations = new Map<string, RelationWithNodes[]>();
    const nodesBWithRelations = new Map<string, RelationWithNodes[]>();

    for (const node of nodesA) {
      nodesAWithRelations.set(node._id, await getDirections(node._id));
    }
    for (const node of nodesB) {
      nodesBWithRelations.set(node._id, await getDirections(node._id));
    }

    const directRelations: RelationResult[] = [];
    const directSeen = new Set<string>();
    const indirectPaths: PathResult[] = [];
    const pathSeen = new Set<string>();

    for (const nodeA of nodesA) {
      const relationsA = nodesAWithRelations.get(nodeA._id) ?? [];
      const relationsAFrom = relationsA.filter((relation) => relation.fromNode._id === nodeA._id);
      const relationsATo = relationsA.filter((relation) => relation.toNode._id === nodeA._id);

      for (const nodeB of nodesB) {
        const relationsB = nodesBWithRelations.get(nodeB._id) ?? [];
        const relationsBTo = relationsB.filter((relation) => relation.toNode._id === nodeB._id);
        let hasDirect = false;

        for (const relation of relationsAFrom) {
          if (relation.toNode._id === nodeB._id) {
            const key = relation.relation._id;
            if (!directSeen.has(key)) {
              directSeen.add(key);
              directRelations.push({
                fromLabel: relation.fromNode.label,
                toLabel: relation.toNode.label,
                relationType: relation.relation.relationType,
                confidence: relation.relation.confidence,
                evidenceMemoryIds: toRelationIds(relation.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
              });
              hasDirect = true;
            }
          }
        }

        for (const relation of relationsATo) {
          if (relation.fromNode._id === nodeB._id) {
            const key = relation.relation._id;
            if (!directSeen.has(key)) {
              directSeen.add(key);
              directRelations.push({
                fromLabel: relation.fromNode.label,
                toLabel: relation.toNode.label,
                relationType: relation.relation.relationType,
                confidence: relation.relation.confidence,
                evidenceMemoryIds: toRelationIds(relation.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
              });
              hasDirect = true;
            }
          }
        }

        if (hasDirect) {
          continue;
        }

        // Path pattern: A -> X -> B
        const relationsAtoX = relationsAFrom;
        for (const relationA of relationsAtoX) {
          const viaId = relationA.toNode._id;
          const viaNode = relationA.toNode;
          if (viaId === nodeB._id) {
            continue;
          }

          for (const relationXToB of relationsBTo) {
            if (relationXToB.fromNode._id !== viaId) {
              continue;
            }

            const pathKey = `${"A_to_X_to_B"}:${relationA.relation._id}:${relationXToB.relation._id}`;
            if (pathSeen.has(pathKey)) continue;
            pathSeen.add(pathKey);

            const first: RelationResult = {
              fromLabel: relationA.fromNode.label,
              toLabel: relationA.toNode.label,
              relationType: relationA.relation.relationType,
              confidence: relationA.relation.confidence,
              evidenceMemoryIds: toRelationIds(relationA.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
            };
            const second: RelationResult = {
              fromLabel: relationXToB.fromNode.label,
              toLabel: relationXToB.toNode.label,
              relationType: relationXToB.relation.relationType,
              confidence: relationXToB.relation.confidence,
              evidenceMemoryIds: toRelationIds(relationXToB.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
            };

            indirectPaths.push({
              type: "A_to_X_to_B",
              viaLabel: viaNode.label,
              viaNodeType: viaNode.nodeType,
              path: {
                first,
                second,
              },
            });
          }
        }

        // Path pattern: A <- X -> B
        for (const relationXA of relationsATo) {
          const viaId = relationXA.fromNode._id;
          const viaNode = relationXA.fromNode;

          for (const relationXB of relationsBTo) {
            if (relationXB.fromNode._id !== viaId) {
              continue;
            }

            const pathKey = `${"A_from_X_to_B"}:${relationXA.relation._id}:${relationXB.relation._id}`;
            if (pathSeen.has(pathKey)) continue;
            pathSeen.add(pathKey);

            const first: RelationResult = {
              fromLabel: relationXA.fromNode.label,
              toLabel: relationXA.toNode.label,
              relationType: relationXA.relation.relationType,
              confidence: relationXA.relation.confidence,
              evidenceMemoryIds: toRelationIds(relationXA.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
            };
            const second: RelationResult = {
              fromLabel: relationXB.fromNode.label,
              toLabel: relationXB.toNode.label,
              relationType: relationXB.relation.relationType,
              confidence: relationXB.relation.confidence,
              evidenceMemoryIds: toRelationIds(relationXB.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
            };

            indirectPaths.push({
              type: "A_from_X_to_B",
              viaLabel: viaNode.label,
              viaNodeType: viaNode.nodeType,
              path: {
                first,
                second,
              },
            });
          }
        }
      }
    }

    const allRelationEvidence = [
      ...directRelations,
      ...indirectPaths.flatMap((path) => [path.path.first, path.path.second]),
    ];
    const { visibleSet, summary } = await visibleEvidenceSetForRelations(
      ctx,
      userId,
      allRelationEvidence,
      scope,
    );
    const visibleDirectRelations = directRelations
      .map((relation) => filterRelationEvidence(relation, visibleSet))
      .filter((relation): relation is RelationResult => relation !== null);
    const visibleIndirectPaths = indirectPaths
      .map((path) => {
        const first = filterRelationEvidence(path.path.first, visibleSet);
        const second = filterRelationEvidence(path.path.second, visibleSet);
        return first && second
          ? { ...path, path: { first, second } }
          : null;
      })
      .filter((path): path is PathResult => path !== null);

    const supportingMemories = await dedupeAndLabelSupportMemories(ctx, userId, [
      ...visibleDirectRelations,
      ...visibleIndirectPaths.flatMap((path) => [path.path.first, path.path.second]),
    ]);

    return {
      entityA,
      entityB,
      directRelations: visibleDirectRelations,
      indirectPaths: visibleIndirectPaths,
      supportingMemories,
      primarySource: "graph",
      fallbackUsed: false,
      ...summary,
      truncated:
        nodesA.length === LABEL_SEARCH_LIMIT ||
        nodesB.length === LABEL_SEARCH_LIMIT ||
        visibleDirectRelations.length >= RELATION_QUERY_LIMIT ||
        visibleIndirectPaths.length >= RELATION_QUERY_LIMIT,
    };
}

export const explainConnection: any = action({
  args: {
    entityA: v.string(),
    entityB: v.string(),
    ...graphScopeArgs,
  },
  handler: async (ctx, args): Promise<any> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return runExplainConnection(ctx, stableUserId(identity.subject), args);
  },
});

export const explainConnectionInternal: any = internalAction({
  args: {
    userId: v.string(),
    entityA: v.string(),
    entityB: v.string(),
    ...graphScopeArgs,
  },
  handler: async (ctx, args): Promise<any> =>
    runExplainConnection(ctx, args.userId, args),
});

type DependencyChainResult = {
  depth: number;
  label: string;
  nodeType: (typeof nodeTypeList)[number];
  relationType: (typeof relationTypeList)[number];
  confidence: number;
  evidenceMemoryIds: string[];
};

const getDependencyTraversalResults = async (
  ctx: any,
  userId: string,
  node: Doc<"crystalNodes">,
  depth: number,
  maxDepth: number,
  chain: DependencyChainResult[],
  seen: Set<string>
) => {
  if (depth >= maxDepth) {
    return;
  }

  const outgoingRelations = (await ctx.runQuery(internal.crystal.graphQuery.getRelationsForNode, {
    userId,
    nodeId: node._id,
    direction: "from",
  })) as RelationWithNodes[];

  const seenThisStep = new Set<string>();
  for (const relationRecord of outgoingRelations) {
    if (!dependencyRelations.includes(relationRecord.relation.relationType as (typeof dependencyRelations)[number])) {
      continue;
    }

    const nextNode = relationRecord.toNode;
    if (seen.has(nextNode._id) || seenThisStep.has(nextNode._id)) {
      continue;
    }

    seenThisStep.add(nextNode._id);
    seen.add(nextNode._id);
    chain.push({
      depth: depth + 1,
      label: nextNode.label,
      nodeType: nextNode.nodeType,
      relationType: relationRecord.relation.relationType,
      confidence: relationRecord.relation.confidence,
      evidenceMemoryIds: toRelationIds(relationRecord.relation.evidenceMemoryIds as Id<"crystalMemories">[]),
    });

    await getDependencyTraversalResults(
      ctx,
      userId,
      nextNode,
      depth + 1,
      maxDepth,
      chain,
      seen
    );
  }
};

async function runDependencyChain(
  ctx: any,
  userId: string,
  args: { entity: string; maxDepth?: number } & GraphScope,
): Promise<any> {
    const { projectId, repoSlug } = await normalizeProjectContext(args.projectId, args.repoSlug);
    const scope = { channel: args.channel, agentId: args.agentId, projectId, repoSlug };
    const entity = args.entity.trim();
    if (!entity) {
      throw new Error("entity is required");
    }

    const maxDepth = clampLimit(args.maxDepth ?? 3, 1, 5, 3);
    const startNodes: Doc<"crystalNodes">[] = await ctx.runQuery(internal.crystal.graphQuery.findNodesByLabel, {
      userId,
      labelQuery: entity,
      limit: LABEL_SEARCH_LIMIT,
    });

    if (startNodes.length === 0) {
      return {
        entity,
        chain: [],
        totalNodes: 0,
        primarySource: "graph",
        fallbackUsed: false,
        visibleEvidenceCount: 0,
        hiddenEvidenceCount: 0,
        relationEvidenceCount: 0,
        truncated: false,
      };
    }

    const chain: DependencyChainResult[] = [];
    const seen = new Set<string>(startNodes.map((node: Doc<"crystalNodes">) => node._id));

    for (const node of startNodes) {
      await getDependencyTraversalResults(ctx, userId, node, 0, maxDepth, chain, seen);
    }

    // Dedupe on (depth, label, nodeType, relationType) so distinct paths with
    // different relation types survive. Merge evidenceMemoryIds on collision so
    // callers see the full provenance rather than losing one path's evidence to
    // the first-seen winner.
    const sortedChain: DependencyChainResult[] = [];
    const keyIndex = new Map<string, number>();
    const sortedSource = chain.slice().sort((a, b) => a.depth - b.depth);
    for (const entry of sortedSource) {
      const key = `${entry.depth}|${entry.nodeType}|${entry.label}|${entry.relationType}`;
      const existingIndex = keyIndex.get(key);
      if (existingIndex === undefined) {
        keyIndex.set(key, sortedChain.length);
        sortedChain.push({ ...entry, evidenceMemoryIds: [...entry.evidenceMemoryIds] });
        continue;
      }
      const existing = sortedChain[existingIndex];
      const evidenceSet = new Set(existing.evidenceMemoryIds);
      for (const id of entry.evidenceMemoryIds) evidenceSet.add(id);
      existing.evidenceMemoryIds = Array.from(evidenceSet);
      existing.confidence = Math.max(existing.confidence, entry.confidence);
    }

    const { visibleSet, summary } = await visibleEvidenceSetForRelations(
      ctx,
      userId,
      sortedChain,
      scope,
    );
    const visibleChain = sortedChain
      .map((entry) => filterRelationEvidence(entry, visibleSet))
      .filter((entry): entry is DependencyChainResult => entry !== null);

    return {
      entity,
      chain: visibleChain,
      totalNodes: visibleChain.length,
      primarySource: "graph",
      fallbackUsed: false,
      ...summary,
      truncated:
        startNodes.length === LABEL_SEARCH_LIMIT ||
        visibleChain.length >= RELATION_QUERY_LIMIT,
    };
}

export const dependencyChain: any = action({
  args: {
    entity: v.string(),
    maxDepth: v.optional(v.number()),
    ...graphScopeArgs,
  },
  handler: async (ctx, args): Promise<any> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return runDependencyChain(ctx, stableUserId(identity.subject), args);
  },
});

export const dependencyChainInternal: any = internalAction({
  args: {
    userId: v.string(),
    entity: v.string(),
    maxDepth: v.optional(v.number()),
    ...graphScopeArgs,
  },
  handler: async (ctx, args): Promise<any> =>
    runDependencyChain(ctx, args.userId, args),
});
