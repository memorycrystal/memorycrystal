import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { bumpCounter } from "./research";

export const transferEntity = v.union(
  v.literal("sources"), v.literal("artifacts"), v.literal("items"),
  v.literal("variants"), v.literal("datasets"), v.literal("runs"),
  v.literal("rollups"), v.literal("promotions"), v.literal("relations"), v.literal("rejections"),
);

async function requireCollection(ctx: any, userId: string, collectionId: any) {
  const collection = await ctx.db.get(collectionId);
  if (!collection || collection.userId !== userId) throw new Error("Research collection not found");
  return collection;
}

function stripEnvelope(row: any) {
  const { _id: _id, _creationTime: _creationTime, userId: _userId, collectionId: _collectionId, ...rest } = row;
  return rest;
}

export const exportPageInternal = internalQuery({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"),
    entity: transferEntity, cursor: v.optional(v.string()), limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 100);
    let query: any;
    if (args.entity === "sources") query = ctx.db.query("crystalResearchSources").withIndex("by_user_collection", (q: any) => q.eq("userId", args.userId).eq("collectionId", args.collectionId));
    if (args.entity === "artifacts") query = ctx.db.query("crystalResearchArtifacts").withIndex("by_user_collection", (q: any) => q.eq("userId", args.userId).eq("collectionId", args.collectionId));
    if (args.entity === "items") query = ctx.db.query("crystalResearchItems").withIndex("by_user_collection", (q: any) => q.eq("userId", args.userId).eq("collectionId", args.collectionId));
    if (args.entity === "variants") query = ctx.db.query("crystalResearchVariants").withIndex("by_user_collection", (q: any) => q.eq("userId", args.userId).eq("collectionId", args.collectionId));
    if (args.entity === "datasets") query = ctx.db.query("crystalResearchDatasets").withIndex("by_user_collection", (q: any) => q.eq("userId", args.userId).eq("collectionId", args.collectionId));
    if (args.entity === "runs") query = ctx.db.query("crystalResearchRuns").withIndex("by_user_collection", (q: any) => q.eq("userId", args.userId).eq("collectionId", args.collectionId));
    if (args.entity === "rollups") query = ctx.db.query("crystalResearchRollups").withIndex("by_user_collection", (q: any) => q.eq("userId", args.userId).eq("collectionId", args.collectionId));
    if (args.entity === "promotions") query = ctx.db.query("crystalResearchPromotions").withIndex("by_user_collection", (q: any) => q.eq("userId", args.userId).eq("collectionId", args.collectionId));
    if (args.entity === "relations") query = ctx.db.query("crystalResearchRelations").withIndex("by_collection_key", (q: any) => q.eq("collectionId", args.collectionId));
    if (args.entity === "rejections") query = ctx.db.query("crystalResearchRejections").withIndex("by_collection_created", (q: any) => q.eq("collectionId", args.collectionId));
    if (!query) throw new Error("Unsupported research export entity");
    const page = await query.paginate({ cursor: args.cursor ?? null, numItems: limit });
    const records = [];
    for (const row of page.page as any[]) {
      if (row.userId !== args.userId) continue;
      const clean: any = stripEnvelope(row);
      if (args.entity === "artifacts") {
        delete clean.storageId;
        const source: any = row.sourceId ? await ctx.db.get(row.sourceId as any) : null;
        clean.sourceStableKey = source?.userId === args.userId && source.collectionId === args.collectionId
          ? source.stableKey
          : undefined;
        delete clean.sourceId;
        clean.downloadPath = `/api/research/artifacts/${String(row._id)}/read`;
      } else if (args.entity === "items") {
        clean.sourceStableKeys = [];
        for (const sourceId of row.sourceIds) {
          const source: any = await ctx.db.get(sourceId as any);
          if (source?.userId === args.userId && source.collectionId === args.collectionId) clean.sourceStableKeys.push(source.stableKey);
        }
        delete clean.sourceIds;
      } else if (args.entity === "variants") {
        const item: any = await ctx.db.get(row.itemId as any);
        clean.itemStableKey = item?.stableKey;
        delete clean.itemId;
      } else if (args.entity === "datasets") {
        const artifact: any = row.artifactId ? await ctx.db.get(row.artifactId as any) : null;
        clean.artifactStableKey = artifact?.stableKey;
        delete clean.artifactId;
      } else if (args.entity === "runs") {
        const [item, variant, dataset]: any[] = await Promise.all([
          ctx.db.get(row.itemId as any), ctx.db.get(row.variantId as any), ctx.db.get(row.datasetId as any),
        ]);
        clean.itemStableKey = item?.stableKey;
        clean.variantStableKey = variant?.stableKey;
        clean.datasetStableKey = dataset?.stableKey;
        clean.artifactStableKeys = [];
        for (const artifactId of row.artifactIds) {
          const artifact: any = await ctx.db.get(artifactId as any);
          if (artifact?.userId === args.userId && artifact.collectionId === args.collectionId) clean.artifactStableKeys.push(artifact.stableKey);
        }
        delete clean.itemId;
        delete clean.variantId;
        delete clean.datasetId;
        delete clean.artifactIds;
      } else if (args.entity === "promotions") {
        const [item, run, dataset]: any[] = await Promise.all([
          ctx.db.get(row.itemId as any), ctx.db.get(row.runId as any), ctx.db.get(row.datasetId as any),
        ]);
        clean.itemStableKey = item?.stableKey;
        clean.runSpecHash = run?.runSpecHash;
        clean.datasetStableKey = dataset?.stableKey;
        delete clean.itemId;
        delete clean.runId;
        delete clean.datasetId;
        delete clean.knowledgeBaseId;
        delete clean.memoryId;
      }
      records.push(clean);
    }
    return {
      schemaVersion: 1,
      entity: args.entity,
      collectionId: String(args.collectionId),
      records,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const resolveStableReferencesInternal = internalQuery({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"),
    sourceStableKeys: v.optional(v.array(v.string())),
    itemStableKey: v.optional(v.string()), variantStableKey: v.optional(v.string()),
    datasetStableKey: v.optional(v.string()), runSpecHash: v.optional(v.string()),
    artifactStableKeys: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    const sourceIds = [];
    for (const stableKey of args.sourceStableKeys ?? []) {
      const row = await ctx.db.query("crystalResearchSources").withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", stableKey)).first();
      if (!row || row.userId !== args.userId) throw new Error(`Source stable key not restored: ${stableKey}`);
      sourceIds.push(row._id);
    }
    const item = args.itemStableKey
      ? await ctx.db.query("crystalResearchItems").withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", args.itemStableKey!)).first()
      : null;
    const variant = args.variantStableKey
      ? await ctx.db.query("crystalResearchVariants").withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", args.variantStableKey!)).first()
      : null;
    const dataset = args.datasetStableKey
      ? await ctx.db.query("crystalResearchDatasets").withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", args.datasetStableKey!)).first()
      : null;
    const run = args.runSpecHash
      ? await ctx.db.query("crystalResearchRuns").withIndex("by_collection_run_spec", (q) => q.eq("collectionId", args.collectionId).eq("runSpecHash", args.runSpecHash!)).first()
      : null;
    const artifactIds = [];
    for (const stableKey of args.artifactStableKeys ?? []) {
      const row = await ctx.db.query("crystalResearchArtifacts").withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", stableKey)).first();
      if (!row || row.userId !== args.userId) throw new Error(`Artifact stable key not restored: ${stableKey}`);
      artifactIds.push(row._id);
    }
    for (const [name, row] of [["item", item], ["variant", variant], ["dataset", dataset], ["run", run]] as const) {
      if (row && (row.userId !== args.userId || row.collectionId !== args.collectionId)) throw new Error(`${name} stable key crosses ownership boundary`);
    }
    return { sourceIds, itemId: item?._id, variantId: variant?._id, datasetId: dataset?._id, runId: run?._id, artifactIds };
  },
});

export const restoreRollupInternal = internalMutation({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"),
    dimensionType: v.string(), dimensionKey: v.string(), methodologyVersion: v.string(),
    runCount: v.number(), survivedCount: v.number(), qualifiedCount: v.number(), failedCount: v.number(),
    aggregateJson: v.string(), score: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    const existing = await ctx.db.query("crystalResearchRollups").withIndex("by_collection_dimension", (q) =>
      q.eq("collectionId", args.collectionId).eq("dimensionType", args.dimensionType).eq("dimensionKey", args.dimensionKey).eq("methodologyVersion", args.methodologyVersion),
    ).first();
    const row = { ...args, updatedAt: Date.now() };
    if (existing) { await ctx.db.patch(existing._id, row); return { rollupId: existing._id, created: false }; }
    return { rollupId: await ctx.db.insert("crystalResearchRollups", row), created: true };
  },
});

export const restoreRelationInternal = internalMutation({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"),
    fromType: v.string(), fromId: v.string(), relationType: v.string(), toType: v.string(), toId: v.string(),
    deterministicKey: v.string(), evidenceJson: v.string(),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    const existing = await ctx.db.query("crystalResearchRelations").withIndex("by_collection_key", (q) => q.eq("collectionId", args.collectionId).eq("deterministicKey", args.deterministicKey)).first();
    if (existing) return { relationId: existing._id, created: false };
    return { relationId: await ctx.db.insert("crystalResearchRelations", { ...args, createdAt: Date.now() }), created: true };
  },
});

export const restoreRejectionInternal = internalMutation({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"), entityType: v.string(),
    idempotencyKey: v.string(), payloadHash: v.optional(v.string()), reason: v.string(),
    securityDisposition: v.optional(v.string()), licenseDisposition: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    const existing = await ctx.db.query("crystalResearchRejections").withIndex("by_collection_idempotency", (q) =>
      q.eq("collectionId", args.collectionId).eq("idempotencyKey", args.idempotencyKey),
    ).first();
    if (existing) return { rejectionId: existing._id, created: false };
    const rejectionId = await ctx.db.insert("crystalResearchRejections", { ...args, createdAt: Date.now() });
    await bumpCounter(ctx, args.userId, args.collectionId, "rejected", args.idempotencyKey);
    return { rejectionId, created: true };
  },
});
