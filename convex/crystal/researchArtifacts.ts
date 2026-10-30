import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { getCapacityPolicyForUser } from "./capacityPolicy";
import { addArtifactBytes, bumpCounter } from "./research";
import { scanMemoryContent } from "./contentScanner";
import { gunzipSync } from "fflate";

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
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"), expectedBytes: v.number(),
    sourceId: v.optional(v.id("crystalResearchSources")), stableKey: v.string(), idempotencyKey: v.string(),
    artifactType: v.string(), checksum: v.string(), mimeType: v.string(),
    uncompressedBytes: v.optional(v.number()), compressionType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    const expectedBytes = Math.trunc(args.expectedBytes);
    if (expectedBytes <= 0) throw new Error("expectedBytes must be positive");
    const capacity = await getCapacityPolicyForUser(ctx, args.userId);
    if (capacity.storageAdmissionBytes !== null && expectedBytes > capacity.storageAdmissionBytes) {
      throw new Error("Artifact exceeds capacity-policy storage admission limit");
    }
    if (args.sourceId) {
      const source = await ctx.db.get(args.sourceId);
      if (!source || source.userId !== args.userId || source.collectionId !== args.collectionId) {
        throw new Error("Research artifact source lineage not found");
      }
    }
    const existing = await ctx.db.query("crystalResearchArtifacts")
      .withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", args.stableKey)).first();
    if (existing) {
      if (existing.checksum !== args.checksum || existing.compressedBytes !== expectedBytes) {
        throw new Error("Artifact stableKey conflict: reserved metadata changed");
      }
      return { artifactId: existing._id, uploadUrl: await ctx.storage.generateUploadUrl(), created: false };
    }
    const now = Date.now();
    const artifactId = await ctx.db.insert("crystalResearchArtifacts", {
      userId: args.userId, collectionId: args.collectionId, workspaceId: collection.workspaceId,
      sourceId: args.sourceId, agentId: collection.agentId, channel: collection.channel, visibility: collection.visibility,
      stableKey: args.stableKey.normalize("NFKC").trim(), idempotencyKey: args.idempotencyKey.normalize("NFKC").trim(),
      artifactType: args.artifactType.normalize("NFKC").trim(), checksum: args.checksum.trim().toLowerCase(),
      mimeType: args.mimeType.trim().toLowerCase(), compressedBytes: expectedBytes,
      uncompressedBytes: args.uncompressedBytes === undefined ? undefined : Math.trunc(args.uncompressedBytes),
      compressionType: args.compressionType?.trim().toLowerCase(), status: "prepared", createdAt: now, updatedAt: now,
    });
    await bumpCounter(ctx, args.userId, args.collectionId, "artifacts", args.stableKey);
    return { artifactId, uploadUrl: await ctx.storage.generateUploadUrl(), created: true };
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
    if (args.status === "accepted") throw new Error("Artifacts can only become accepted through server verification");
    if (args.status === "uploaded" && !args.storageId) {
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
    if (args.status === "rejected" || args.status === "quarantined") {
      await bumpCounter(ctx, args.userId, args.collectionId, "quarantined", args.stableKey);
    }
    return { artifactId, created: true };
  },
});

export const getVerificationContextInternal = internalQuery({
  args: { userId: v.string(), artifactId: v.id("crystalResearchArtifacts") },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.userId !== args.userId) throw new Error("Research artifact not found");
    return artifact;
  },
});

export const finalizeVerificationInternal = internalMutation({
  args: {
    userId: v.string(), artifactId: v.id("crystalResearchArtifacts"), storageId: v.id("_storage"),
    actualBytes: v.number(), actualChecksum: v.string(), actualMimeType: v.string(),
    actualUncompressedBytes: v.optional(v.number()), accepted: v.boolean(), scanResult: v.string(),
    rejectionReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.userId !== args.userId) throw new Error("Research artifact not found");
    if (["accepted", "quarantined", "rejected"].includes(artifact.status)) {
      return { artifactId: artifact._id, status: artifact.status, created: false };
    }
    const capacity = await getCapacityPolicyForUser(ctx, args.userId);
    const shards = await ctx.db.query("crystalResearchCounterShards")
      .withIndex("by_user_collection", (q) => q.eq("userId", args.userId).eq("collectionId", artifact.collectionId)).take(64);
    const currentBytes = shards.reduce((sum, shard) => sum + (shard.artifactBytes ?? 0), 0);
    if (capacity.storageAdmissionBytes !== null && currentBytes + args.actualBytes > capacity.storageAdmissionBytes) {
      throw new Error("Artifact exceeds cumulative capacity-policy storage admission limit");
    }
    const now = Date.now();
    const status = args.accepted ? "accepted" as const : "quarantined" as const;
    await ctx.db.patch(artifact._id, {
      storageId: args.storageId, actualBytes: args.actualBytes, actualChecksum: args.actualChecksum,
      uncompressedBytes: args.actualUncompressedBytes ?? artifact.uncompressedBytes,
      scanResult: args.scanResult, status, rejectionReason: args.rejectionReason,
      acceptedAt: args.accepted ? now : undefined, updatedAt: now,
    });
    await addArtifactBytes(ctx, args.userId, artifact.collectionId, artifact.stableKey, args.actualBytes);
    if (!args.accepted) await bumpCounter(ctx, args.userId, artifact.collectionId, "quarantined", artifact.stableKey);
    return { artifactId: artifact._id, status, created: true };
  },
});

export const verifyAndAcceptInternal: any = internalAction({
  args: { userId: v.string(), artifactId: v.id("crystalResearchArtifacts"), storageId: v.id("_storage") },
  handler: async (ctx, args): Promise<any> => {
    const artifact: any = await ctx.runQuery((internal as any).crystal.researchArtifacts.getVerificationContextInternal, {
      userId: args.userId, artifactId: args.artifactId,
    });
    const metadata: any = await ctx.storage.getMetadata(args.storageId);
    const url = await ctx.storage.getUrl(args.storageId);
    if (!metadata || !url) throw new Error("Artifact storage object does not exist");
    const response = await fetch(url);
    if (!response.ok) throw new Error("Artifact storage object could not be read");
    const compressed = new Uint8Array(await response.arrayBuffer());
    const actualBytes = compressed.byteLength;
    const actualChecksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", compressed)))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    const actualMimeType = String(metadata.contentType ?? response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
    let accepted = true;
    const reasons: string[] = [];
    if (actualBytes !== artifact.compressedBytes) { accepted = false; reasons.push("compressed byte count mismatch"); }
    if (actualChecksum !== artifact.checksum.toLowerCase()) { accepted = false; reasons.push("checksum mismatch"); }
    if (actualMimeType !== artifact.mimeType) { accepted = false; reasons.push("MIME type mismatch"); }
    let inspected = compressed;
    if (artifact.compressionType === "gzip") {
      try {
        inspected = Uint8Array.from(gunzipSync(compressed));
      } catch {
        accepted = false; reasons.push("gzip decompression failed"); inspected = new Uint8Array();
      }
      const declared = artifact.uncompressedBytes ?? 0;
      if (declared > 0 && inspected.byteLength !== declared) { accepted = false; reasons.push("decompressed byte count mismatch"); }
      if (inspected.byteLength > 50 * 1024 * 1024 || inspected.byteLength > actualBytes * 100) {
        accepted = false; reasons.push("decompression ratio exceeds safety limit");
      }
    }
    if (artifact.mimeType.startsWith("text/") || artifact.mimeType.includes("json") || artifact.mimeType.includes("javascript")) {
      const scan = scanMemoryContent(new TextDecoder().decode(inspected.slice(0, 1_000_000)).normalize("NFKC"));
      if (!scan.allowed) { accepted = false; reasons.push(`${scan.reason} [${scan.threatId}]`); }
    }
    return ctx.runMutation((internal as any).crystal.researchArtifacts.finalizeVerificationInternal, {
      userId: args.userId, artifactId: args.artifactId, storageId: args.storageId,
      actualBytes, actualChecksum, actualMimeType, actualUncompressedBytes: inspected.byteLength,
      accepted, scanResult: accepted ? "clean" : "quarantined", rejectionReason: reasons.length ? reasons.join("; ") : undefined,
    });
  },
});

export const getReadDescriptorInternal = internalQuery({
  args: { userId: v.string(), artifactId: v.id("crystalResearchArtifacts"), agentId: v.optional(v.string()), channel: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.userId !== args.userId || !artifact.storageId) return null;
    if (artifact.status !== "accepted") return null;
    if (artifact.agentId && artifact.agentId !== args.agentId) return null;
    if (artifact.channel && artifact.channel !== args.channel) return null;
    if (artifact.visibility === "scoped" && !artifact.agentId && !artifact.channel) return null;
    return { storageId: artifact.storageId, mimeType: artifact.mimeType, collectionId: artifact.collectionId };
  },
});
