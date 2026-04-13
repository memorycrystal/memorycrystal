import { stableUserId } from "./auth";
import { internal } from "../_generated/api";
import { action, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { type Id, type Doc } from "../_generated/dataModel";

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
};

export const whoOwns: any = action({
  args: {
    entity: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

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
        });
      }
    }

    return {
      entity,
      owners,
      ownedBy,
      truncated:
        targetNodes.length === LABEL_SEARCH_LIMIT ||
        owners.length >= RELATION_QUERY_LIMIT ||
        ownedBy.length >= RELATION_QUERY_LIMIT,
    };
  },
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

export const explainConnection: any = action({
  args: {
    entityA: v.string(),
    entityB: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

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

    const supportingMemories = await dedupeAndLabelSupportMemories(ctx, userId, [...directRelations, ...indirectPaths.flatMap((path) => [path.path.first, path.path.second])]);

    return {
      entityA,
      entityB,
      directRelations,
      indirectPaths,
      supportingMemories,
      truncated:
        nodesA.length === LABEL_SEARCH_LIMIT ||
        nodesB.length === LABEL_SEARCH_LIMIT ||
        directRelations.length >= RELATION_QUERY_LIMIT ||
        indirectPaths.length >= RELATION_QUERY_LIMIT,
    };
  },
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

export const dependencyChain: any = action({
  args: {
    entity: v.string(),
    maxDepth: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

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

    return {
      entity,
      chain: sortedChain,
      totalNodes: sortedChain.length,
      truncated:
        startNodes.length === LABEL_SEARCH_LIMIT ||
        sortedChain.length >= RELATION_QUERY_LIMIT,
    };
  },
});
