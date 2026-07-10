import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { getCapacityPolicyForUser } from "./capacityPolicy";
import { addArtifactBytes, bumpCounter } from "./research";

const artifactStatus = v.union(
  v.literal("prepared"), v.literal("uploaded"), v.literal("accepted"),
  v.literal("rejected"), v.literal("quarantined"),
);

async function requireCollection(ctx: any, userId: string, collectionId: any) {
  const collection = await ctx.db.get(collectionId);
  if (!collection || collection.userId !== userId) throw new Error("Research collection not found");
  return collection;
}

export const createUploadUrlInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), expectedBytes: v.number() },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    const expectedBytes = Math.trunc(args.expectedBytes);
    if (expectedBytes <= 0) throw new Error("expectedBytes must be positive");
    const capacity = await getCapacityPolicyForUser(ctx, args.userId);
    if (capacity.storageAdmissionBytes !== null && expectedBytes > capacity.storageAdmissionBytes) {
      throw new Error("Artifact exceeds capacity-policy storage admission limit");
    }
    return { uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

export const registerInternal = internalMutation({
  args: {
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    sourceId: v.optional(v.id("crystalResearchSources")),
    stableKey: v.string(),
    idempotencyKey: v.string(),
    artifactType: v.string(),
    storageId: v.optional(v.id("_storage")),
    checksum: v.string(),
    mimeType: v.string(),
    compressedBytes: v.number(),
    uncompressedBytes: v.optional(v.number()),
    status: artifactStatus,
    rejectionReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    if (args.sourceId) {
      const source = await ctx.db.get(args.sourceId);
      if (!source || source.userId !== args.userId || source.collectionId !== args.collectionId) {
        throw new Error("Research artifact source lineage not found");
      }
    }
    if (args.compressedBytes < 0 || (args.uncompressedBytes ?? 0) < 0) throw new Error("Artifact byte counts cannot be negative");
    if ((args.status === "uploaded" || args.status === "accepted") && !args.storageId) {
      throw new Error("storageId is required for uploaded or accepted artifacts");
    }
    if ((args.status === "rejected" || args.status === "quarantined") && !args.rejectionReason) {
      throw new Error("rejectionReason is required for rejected or quarantined artifacts");
    }
    const existing = await ctx.db.query("crystalResearchArtifacts")
      .withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", args.stableKey))
      .first();
    if (existing) {
      if (existing.checksum !== args.checksum) throw new Error("Artifact stableKey conflict: checksum changed");
      return { artifactId: existing._id, created: false };
    }
    const now = Date.now();
    const artifactId = await ctx.db.insert("crystalResearchArtifacts", {
      userId: args.userId,
      workspaceId: collection.workspaceId,
      collectionId: args.collectionId,
      sourceId: args.sourceId,
      agentId: collection.agentId,
      channel: collection.channel,
      visibility: collection.visibility,
      stableKey: args.stableKey.normalize("NFKC").trim(),
      idempotencyKey: args.idempotencyKey.normalize("NFKC").trim(),
      artifactType: args.artifactType.normalize("NFKC").trim(),
      storageId: args.storageId,
      checksum: args.checksum.trim(),
      mimeType: args.mimeType.trim().toLowerCase(),
      compressedBytes: Math.trunc(args.compressedBytes),
      uncompressedBytes: args.uncompressedBytes === undefined ? undefined : Math.trunc(args.uncompressedBytes),
      status: args.status,
      rejectionReason: args.rejectionReason,
      createdAt: now,
      updatedAt: now,
    });
    await bumpCounter(ctx, args.userId, args.collectionId, "artifacts", args.stableKey);
    await addArtifactBytes(ctx, args.userId, args.collectionId, args.stableKey, Math.trunc(args.compressedBytes));
    if (args.status === "rejected" || args.status === "quarantined") {
      await bumpCounter(ctx, args.userId, args.collectionId, "quarantined", args.stableKey);
    }
    return { artifactId, created: true };
  },
});

export const getReadDescriptorInternal = internalQuery({
  args: { userId: v.string(), artifactId: v.id("crystalResearchArtifacts"), agentId: v.optional(v.string()), channel: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.userId !== args.userId || !artifact.storageId) return null;
    if (artifact.status !== "accepted" && artifact.status !== "uploaded") return null;
    if (artifact.agentId && artifact.agentId !== args.agentId) return null;
    if (artifact.channel && artifact.channel !== args.channel) return null;
    if (artifact.visibility === "scoped" && !artifact.agentId && !artifact.channel) return null;
    return { storageId: artifact.storageId, mimeType: artifact.mimeType };
  },
});
