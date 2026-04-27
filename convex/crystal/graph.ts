import { stableUserId } from "./auth";
import { v } from "convex/values";
import { internalQuery, mutation, query } from "../_generated/server";

const nowMs = () => Date.now();
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const memoryNodeTypes = ["person", "project", "goal", "decision", "concept", "tool", "event", "resource", "channel"] as const;
type MemoryNodeType = (typeof memoryNodeTypes)[number];

type GraphRelationType =
  | "mentions"
  | "decided_in"
  | "leads_to"
  | "depends_on"
  | "owns"
  | "uses"
  | "conflicts_with"
  | "supports"
  | "occurs_with"
  | "assigned_to";

const relationTypeMap: Record<string, GraphRelationType> = {
  supports: "supports",
  contradicts: "conflicts_with",
  derives_from: "depends_on",
  co_occurred: "occurs_with",
  generalizes: "supports",
  precedes: "leads_to",
};

const normalizeText = (value: string) => value.trim().toLowerCase();
const normalizeChannel = (value?: string) => normalizeText(value ?? "unknown");

const uniqueStrings = (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const canonicalize = (prefix: string, value: string) => {
  const slug = normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${prefix}:${slug || "untitled"}`;
};

const mapAssociationType = (relationshipType: string): GraphRelationType => relationTypeMap[relationshipType] ?? "supports";

const ensureNode = async (
  ctx: any,
  userId: string,
  canonicalKey: string,
  label: string,
  nodeType: MemoryNodeType,
  sourceMemoryId: string,
  description = ""
): Promise<{ nodeId: string; created: boolean }> => {
  const existing = (
    await ctx.db
      .query("crystalNodes")
      .withIndex("by_user_canonical", (q: any) => q.eq("userId", userId).eq("canonicalKey", canonicalKey))
      .take(1)
  )[0] as { _id: string; sourceMemoryIds: string[] } | undefined;

  if (existing) {
    if (!existing.sourceMemoryIds.includes(sourceMemoryId)) {
      await ctx.db.patch(existing._id, {
        sourceMemoryIds: [...existing.sourceMemoryIds, sourceMemoryId],
        updatedAt: nowMs(),
      });
    }
    return { nodeId: existing._id, created: false };
  }

  const now = nowMs();
  const nodeId = await ctx.db.insert("crystalNodes", {
    userId,
    label,
    nodeType,
    alias: [],
    canonicalKey,
    description,
    strength: 0.5,
    confidence: 0.5,
    tags: [],
    metadata: "",
    createdAt: now,
    updatedAt: now,
    sourceMemoryIds: [sourceMemoryId],
    status: "active",
  });

  return { nodeId, created: true };
};

const upsertNodeLink = async (
  ctx: any,
  userId: string,
  memoryId: string,
  nodeId: string,
  role: "subject" | "object" | "topic",
  linkConfidence = 0.7
) => {
  const existing = (
    await ctx.db
      .query("crystalMemoryNodeLinks")
      .withIndex("by_memory", (q: any) => q.eq("memoryId", memoryId as never))
      .filter((q: any) => q.eq("nodeId", nodeId as never))
      .take(1)
  )[0] as { _id: string } | undefined;

  if (existing) {
    return existing._id;
  }

  return ctx.db.insert("crystalMemoryNodeLinks", {
    userId,
    memoryId,
    nodeId,
    role,
    linkConfidence,
    createdAt: nowMs(),
  });
};

const upsertRelation = async (
  ctx: any,
  userId: string,
  fromNodeId: string,
  toNodeId: string,
  relationType: GraphRelationType,
  evidenceMemoryIds: string[],
  channels: string[],
  weight = 0.7,
  proofNote = ""
): Promise<{ created: number; updated: number }> => {
  const existing = (
    await ctx.db
      .query("crystalRelations")
      .withIndex("by_from_to_relation", (q: any) =>
        q.eq("fromNodeId", fromNodeId as never).eq("toNodeId", toNodeId as never).eq("relationType", relationType)
      )
      .take(1)
  )[0] as
    | {
        _id: string;
        weight: number;
        confidence: number;
        channels: string[];
        evidenceMemoryIds: string[];
        proofNote?: string;
      }
    | undefined;

  const now = nowMs();
  if (existing) {
    await ctx.db.patch(existing._id, {
      updatedAt: now,
      weight: clamp(Math.max(existing.weight, weight), 0.1, 1),
      confidence: clamp(Math.max(existing.confidence, weight), 0.1, 1),
      proofNote: proofNote || existing.proofNote,
      evidenceMemoryIds: uniqueStrings([...existing.evidenceMemoryIds, ...evidenceMemoryIds]),
      channels: uniqueStrings([...existing.channels, ...channels]),
    });
    return { created: 0, updated: 1 };
  }

  await ctx.db.insert("crystalRelations", {
    userId,
    fromNodeId,
    toNodeId,
    relationType,
    weight: clamp(weight, 0.1, 1),
    evidenceMemoryIds: uniqueStrings(evidenceMemoryIds),
    evidenceWindow: undefined,
    channels: uniqueStrings(channels),
    proofNote,
    confidence: clamp(weight, 0.1, 1),
    confidenceReason: "Backfill migration from association graph.",
    createdAt: now,
    updatedAt: now,
    promotedFrom: undefined,
  });

  return { created: 1, updated: 0 };
};

export const getKnowledgeGraphFoundationStatus = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const memoriesPage = await ctx.db.query("crystalMemories").withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", false)).take(201);
    const memories = memoriesPage.slice(0, 200);
    const memoriesCapped = memoriesPage.length > 200;

    const nodesPage = await ctx.db.query("crystalNodes").filter((q) => q.eq(q.field("userId"), userId)).take(201);
    const nodes = nodesPage.slice(0, 200);
    const nodesCapped = nodesPage.length > 200;

    const relationsPage = await ctx.db.query("crystalRelations").filter((q) => q.eq(q.field("userId"), userId)).take(201);
    const relations = relationsPage.slice(0, 200);
    const relationsCapped = relationsPage.length > 200;

    const linksPage = await ctx.db.query("crystalMemoryNodeLinks").filter((q) => q.eq(q.field("userId"), userId)).take(201);
    const links = linksPage.slice(0, 200);
    const linksCapped = linksPage.length > 200;

    return {
      memories: memories.length,
      nodes: nodes.length,
      relations: relations.length,
      links: links.length,
      truncated: memoriesCapped || nodesCapped || relationsCapped || linksCapped,
      countsAreLowerBounds: {
        memories: memoriesCapped,
        nodes: nodesCapped,
        relations: relationsCapped,
        links: linksCapped,
      },
      generatedAt: nowMs(),
    };
  },
});

// Count enriched memories using the by_graph_enriched index.
// Uses .take() with a generous cap instead of .paginate() to avoid
// Convex's "only one paginated query per function" constraint.
// The index filters by graphEnriched+userId so we only scan matching rows.
const ENRICHED_COUNT_CAP = 10_000;

export const getUserGraphStatus = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    // Nodes and relations are small tables — collect is fine.
    // For memories we avoid .collect() (embeddings make rows ~24KB each)
    // and use the by_graph_enriched index with a bounded .take().
    const nodes = await ctx.db
      .query("crystalNodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const relations = await ctx.db
      .query("crystalRelations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    // Read enriched + total counts from the dashboard totals row.
    // This is a single small document — no embedding vectors, no table scan.
    const totalsRow = await ctx.db
      .query("crystalDashboardTotals")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .first();
    const totalMemoryCount = (totalsRow as any)?.activeMemories ?? 0;
    const enrichedCount = (totalsRow as any)?.enrichedMemories ?? 0;

    return {
      totalNodes: nodes.length,
      totalRelations: relations.length,
      enrichedMemories: enrichedCount,
      totalMemories: totalMemoryCount,
      enrichmentPercent: totalMemoryCount > 0 ? Math.round((enrichedCount / totalMemoryCount) * 100) : 0,
    };
  },
});

export const seedKnowledgeGraphFromMemory = mutation({
  args: v.object({
    maxMemories: v.optional(v.number()),
    maxAssociations: v.optional(v.number()),
    includeAssociations: v.optional(v.boolean()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const includeAssociations = args.includeAssociations ?? true;
    const maxMemories = Math.floor(clamp(args.maxMemories ?? 400, 1, 5000));
    const maxAssociations = Math.floor(clamp(args.maxAssociations ?? 400, 0, 10000));

    const memories = (
      await ctx.db
        .query("crystalMemories")
        .withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", false))
        // Skip already-enriched memories — handled by real-time pipeline in graphEnrich.ts
        .filter((q) => q.neq(q.field("graphEnriched"), true))
        .take(maxMemories)
    );

    const created = {
      nodes: 0,
      relations: 0,
      updatedRelations: 0,
      links: 0,
    };

    const getMemoryNode = async (memory: { _id: string; title?: string; content?: string; channel?: string }) => {
      const canonical = canonicalize("memory", memory._id);
      const existing = (
        await ctx.db
          .query("crystalNodes")
          .withIndex("by_user_canonical", (q: any) => q.eq("userId", userId).eq("canonicalKey", canonical))
          .take(1)
      )[0] as { _id: string } | undefined;
      if (existing) {
        return { nodeId: existing._id, created: false };
      }

      const label = normalizeText(memory.title || memory.content?.slice(0, 80) || "Untitled memory");
      return ensureNode(
        ctx,
        userId,
        canonical,
        label,
        "event",
        memory._id,
        "Auto-generated memory topic node from phase 0 seed."
      );
    };

    for (const memory of memories) {
      const memoryId = memory._id;
      const source = await getMemoryNode(memory as any);
      if (!source) {
        continue;
      }

      if (source.created) {
        created.nodes += 1;
      }

      await upsertNodeLink(ctx, userId, memoryId, source.nodeId, "topic", 0.95);
      created.links += 1;

      if (memory.channel) {
        const channelCanonical = canonicalize("channel", normalizeChannel(memory.channel));
        const channel = await ensureNode(
          ctx,
          userId,
          channelCanonical,
          normalizeChannel(memory.channel),
          "channel",
          memoryId,
          "Auto-generated channel node from phase 0 seed."
        );
        if (channel.created) {
          created.nodes += 1;
        }
        await upsertNodeLink(ctx, userId, memoryId, channel.nodeId, "topic", 0.65);
        created.links += 1;
      }

      for (const tag of memory.tags ?? []) {
        const normalizedTag = normalizeText(tag);
        if (!normalizedTag) {
          continue;
        }

        const tagCanonical = canonicalize("concept", normalizedTag);
        const tagNode = await ensureNode(
          ctx,
          userId,
          tagCanonical,
          normalizedTag,
          "concept",
          memoryId,
          "Auto-generated concept node from memory tags."
        );
        if (tagNode.created) {
          created.nodes += 1;
        }
        await upsertNodeLink(ctx, userId, memoryId, tagNode.nodeId, "topic", 0.8);
        created.links += 1;
      }
    }

    if (includeAssociations) {
      const associations = await ctx.db
        .query("crystalAssociations")
        .filter((q: any) => q.gte(q.field("weight"), 0))
        .take(maxAssociations);

      for (const association of associations) {
        const sourceMemory = (await ctx.db.get(association.fromMemoryId)) as { _id: string; userId: string; channel?: string } | null;
        const targetMemory = (await ctx.db.get(association.toMemoryId)) as { _id: string; userId: string; channel?: string } | null;
        if (!sourceMemory || !targetMemory || sourceMemory.userId !== userId || targetMemory.userId !== userId) {
          continue;
        }

        const sourceNode = await getMemoryNode(sourceMemory as never);
        const targetNode = await getMemoryNode(targetMemory as never);
        if (!sourceNode || !targetNode) {
          continue;
        }

        if (sourceNode.created) {
          created.nodes += 1;
        }
        if (targetNode.created) {
          created.nodes += 1;
        }

        const relation = await upsertRelation(
          ctx,
          userId,
          sourceNode.nodeId,
          targetNode.nodeId,
          mapAssociationType(association.relationshipType),
          [sourceMemory._id, targetMemory._id],
          [
            normalizeChannel(sourceMemory.channel),
            normalizeChannel(targetMemory.channel),
            "crystal-associate",
          ],
          association.weight,
          "Backfilled from crystalAssociations during phase 0."
        );

        created.relations += relation.created;
        created.updatedRelations += relation.updated;
        await upsertNodeLink(ctx, userId, sourceMemory._id, sourceNode.nodeId, "subject", 0.7);
        await upsertNodeLink(ctx, userId, targetMemory._id, targetNode.nodeId, "object", 0.7);
      }
    }

    const associationsPage = includeAssociations ? await ctx.db.query("crystalAssociations").take(201) : [];
    const associationTotal = Math.min(associationsPage.length, 200);
    const associationsCapped = associationsPage.length > 200;

    return {
      runAt: nowMs(),
      includeAssociations,
      requested: {
        memories: memories.length,
        associations: associationTotal,
        associationsCapped,
      },
      created,
    };
  },
});
