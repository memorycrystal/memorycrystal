import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { OPENROUTER_GEMINI_EMBEDDING_MODEL, embedTextWithUserOpenRouter } from "./embeddings";
import { stableUserId } from "./auth";
import { applyDashboardTotalsDelta, buildMemoryCreateDelta } from "./dashboardTotals";
import { shouldEnrich } from "./organic/enrichmentEligibility";

const STORAGE_QUOTAS_BYTES = {
  free: 250 * 1024 * 1024,
  starter: 2 * 1024 * 1024 * 1024,
  pro: 2 * 1024 * 1024 * 1024,
  ultra: 10 * 1024 * 1024 * 1024,
  unlimited: Number.MAX_SAFE_INTEGER,
} as const;
const MAX_PROCESSING_ATTEMPTS = 3;

type AssetKind = "image" | "audio" | "video" | "pdf" | "text";
type AssetModality = "image" | "audio" | "video" | "pdf" | "document" | "other";
type ProcessableAssetStatus = "uploaded" | "queued" | "processing";
type DashboardAssetStatus = "uploaded" | "queued" | "processing" | "ready" | "failed" | "soft_deleted" | "hard_deleted" | "skipped" | "other";

const DASHBOARD_ASSET_STATUSES: DashboardAssetStatus[] = [
  "uploaded",
  "queued",
  "processing",
  "ready",
  "failed",
  "soft_deleted",
  "hard_deleted",
  "skipped",
  "other",
];

function modalityFromKind(kind: AssetKind): AssetModality {
  return kind === "text" ? "document" : kind;
}

function normalizeAssetKindForDashboard(kind: unknown): AssetKind | "other" {
  return kind === "image" || kind === "audio" || kind === "video" || kind === "pdf" || kind === "text" ? kind : "other";
}

function normalizeAssetModalityForDashboard(kind: unknown, modality: unknown): AssetModality {
  if (modality === "image" || modality === "audio" || modality === "video" || modality === "pdf" || modality === "document" || modality === "other") {
    return modality;
  }
  const normalizedKind = normalizeAssetKindForDashboard(kind);
  return normalizedKind === "text" ? "document" : normalizedKind === "other" ? "other" : normalizedKind;
}

function normalizeAssetStatusForDashboard(status: unknown, embedded?: boolean): DashboardAssetStatus {
  const normalizedStatus = typeof status === "string" ? status : embedded ? "ready" : "uploaded";
  return DASHBOARD_ASSET_STATUSES.includes(normalizedStatus as DashboardAssetStatus) ? normalizedStatus as DashboardAssetStatus : "other";
}

function normalizeMimeTypeForDashboard(mimeType: unknown): string {
  return typeof mimeType === "string" && mimeType.trim().length > 0 ? mimeType : "application/octet-stream";
}

function buildAssetRetryQueuedPatch(now: number) {
  return {
    status: "queued" as const,
    queuedAt: now,
    processingAttempts: 0,
    processingError: undefined,
    updatedAt: now,
  };
}

type AssetVisibilityContext = {
  channel?: string;
  knowledgeBaseIds?: string[];
  peerScope?: string;
};

function isAssetVisibleInContext(asset: {
  channel?: string;
  knowledgeBaseIds?: unknown[];
  peerScope?: string;
}, context: AssetVisibilityContext = {}): boolean {
  if (asset.channel && asset.channel !== context.channel) return false;

  const assetKnowledgeBaseIds = (asset.knowledgeBaseIds ?? []).map(String);
  if (assetKnowledgeBaseIds.length > 0) {
    const allowedKnowledgeBaseIds = new Set((context.knowledgeBaseIds ?? []).map(String));
    if (!assetKnowledgeBaseIds.some((knowledgeBaseId) => allowedKnowledgeBaseIds.has(knowledgeBaseId))) return false;
  }

  if (asset.peerScope) {
    const peerContext = context.peerScope ?? context.channel;
    if (asset.peerScope !== peerContext) return false;
  }

  return true;
}

function isLikelyConvexStorageId(storageKey: string): boolean {
  return /^[a-z0-9]+$/.test(storageKey);
}

function positiveBytes(bytes?: number): number {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
}

function isProcessableAssetStatus(status?: string): status is ProcessableAssetStatus {
  return status === undefined || status === "uploaded" || status === "queued" || status === "processing";
}

function canStartAssetProcessing(status?: string): boolean {
  return isProcessableAssetStatus(status) || status === "failed";
}

function buildAssetTextFallback(asset: {
  title?: string;
  transcript?: string;
  summary?: string;
  extractedText?: string;
  tags?: string[];
  kind: string;
  modality?: string;
  mimeType: string;
}): string {
  return [
    asset.title ? `title: ${asset.title}` : "",
    `modality: ${asset.modality ?? asset.kind}`,
    `kind: ${asset.kind}`,
    `mimeType: ${asset.mimeType}`,
    asset.summary ? `summary: ${asset.summary}` : "",
    asset.extractedText ? `extractedText: ${asset.extractedText}` : "",
    asset.transcript ? `transcript: ${asset.transcript}` : "",
    asset.tags?.length ? `tags: ${asset.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function embedAssetDoc(asset: {
  storageKey: string;
  mimeType: string;
  title?: string;
  transcript?: string;
  summary?: string;
  extractedText?: string;
  tags?: string[];
  kind: "image" | "audio" | "video" | "pdf" | "text";
  modality?: AssetModality;
}, ctx?: Pick<any, "runMutation" | "runQuery">, accounting?: { userId?: string; source?: string }): Promise<number[] | null> {
  if (!ctx || !accounting?.userId) return null;
  const fallbackText = buildAssetTextFallback(asset);
  return embedTextWithUserOpenRouter(ctx, fallbackText, {
    userId: accounting.userId,
    source: accounting.source ?? "assets.embedAssetDoc",
  });
}

export const storeAsset = internalMutation({
  args: {
    userId: v.string(),
    kind: v.union(v.literal("image"), v.literal("audio"), v.literal("video"), v.literal("pdf"), v.literal("text")),
    storageKey: v.string(),
    mimeType: v.string(),
    title: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    turnId: v.optional(v.string()),
    bytes: v.optional(v.number()),
    checksum: v.optional(v.string()),
    storageProvider: v.optional(v.union(v.literal("convex"), v.literal("local"), v.literal("r2"))),
    modality: v.optional(v.union(v.literal("image"), v.literal("audio"), v.literal("video"), v.literal("pdf"), v.literal("document"), v.literal("other"))),
    status: v.optional(v.union(
      v.literal("uploaded"),
      v.literal("queued"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("soft_deleted"),
      v.literal("hard_deleted"),
      v.literal("skipped"),
    )),
    visibility: v.optional(v.union(v.literal("private"))),
    source: v.optional(v.union(v.literal("conversation"), v.literal("mcp"), v.literal("dashboard"), v.literal("external"), v.literal("inference"))),
    idempotencyKey: v.optional(v.string()),
    captureManifestId: v.optional(v.string()),
    sourceAttachmentId: v.optional(v.string()),
    extension: v.optional(v.string()),
    originalFilenameHash: v.optional(v.string()),
    safeDisplayName: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!args.storageKey.trim()) {
      throw new Error("storageKey is required");
    }
    if (!args.mimeType.trim()) {
      throw new Error("mimeType is required");
    }
    if (args.storageProvider && args.storageProvider !== "convex") {
      throw new Error("unsupported storageProvider; use convex storage");
    }

    if (args.idempotencyKey?.trim()) {
      const existing = await ctx.db
        .query("crystalAssets")
        .withIndex("by_user_idempotency", (q) => q.eq("userId", args.userId).eq("idempotencyKey", args.idempotencyKey))
        .first();
      if (existing) return existing._id;
    }

    const bytes = positiveBytes(args.bytes);
    if (bytes > 0) {
      await reserveAssetBytes(ctx, args.userId, bytes);
    }

    const now = Date.now();
    return await ctx.db.insert("crystalAssets", {
      userId: args.userId,
      kind: args.kind,
      modality: args.modality ?? modalityFromKind(args.kind),
      storageKey: args.storageKey,
      storageProvider: args.storageProvider ?? "convex",
      mimeType: args.mimeType,
      extension: args.extension,
      originalFilenameHash: args.originalFilenameHash,
      safeDisplayName: args.safeDisplayName,
      bytes,
      checksum: args.checksum,
      status: args.status ?? "uploaded",
      visibility: args.visibility ?? "private",
      source: args.source ?? "mcp",
      title: args.title,
      transcript: args.transcript,
      summary: args.summary,
      embedded: false,
      channel: args.channel,
      sessionKey: args.sessionKey,
      turnId: args.turnId,
      tags: args.tags,
      idempotencyKey: args.idempotencyKey,
      captureManifestId: args.captureManifestId,
      sourceAttachmentId: args.sourceAttachmentId,
      createdAt: now,
      updatedAt: now,
      expiresAt: args.expiresAt,
    });
  },
});

export const getAssetQuotaAvailability = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const usage = await ctx.db
      .query("crystalAssetUsage")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const usedBytes = usage?.usedBytes ?? 0;
    const quotaBytes = await resolveAssetQuotaBytes(ctx, userId);
    return {
      usedBytes,
      quotaBytes,
      availableBytes: Math.max(0, quotaBytes - usedBytes),
    };
  },
});

export const getAssetIdByUserIdempotency = internalQuery({
  args: { userId: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, { userId, idempotencyKey }) => {
    const existing = await ctx.db
      .query("crystalAssets")
      .withIndex("by_user_idempotency", (q) => q.eq("userId", userId).eq("idempotencyKey", idempotencyKey))
      .first();
    return existing?._id ?? null;
  },
});

export const getAssetStorageKeyForOwner = internalQuery({
  args: { userId: v.string(), assetId: v.id("crystalAssets") },
  handler: async (ctx, { userId, assetId }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset || asset.userId !== userId) return null;
    return { storageKey: asset.storageKey };
  },
});

async function resolveAssetQuotaBytes(ctx: any, userId: string): Promise<number> {
  const usage = await ctx.db
    .query("crystalAssetUsage")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();
  if (typeof usage?.quotaBytesOverride === "number") return usage.quotaBytesOverride;

  const profile = await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();
  const plan = String(profile?.plan ?? "free").toLowerCase() as keyof typeof STORAGE_QUOTAS_BYTES;
  return STORAGE_QUOTAS_BYTES[plan] ?? STORAGE_QUOTAS_BYTES.free;
}

async function reserveAssetBytes(ctx: any, userId: string, bytes: number) {
  const usage = await ctx.db
    .query("crystalAssetUsage")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();
  const currentUsed = usage?.usedBytes ?? 0;
  const quotaBytes = await resolveAssetQuotaBytes(ctx, userId);
  if (currentUsed + bytes > quotaBytes) {
    throw new Error(`Asset storage quota exceeded: ${currentUsed + bytes} bytes requested, ${quotaBytes} bytes allowed`);
  }

  const updatedAt = Date.now();
  if (usage) {
    await ctx.db.patch(usage._id, {
      usedBytes: currentUsed + bytes,
      pendingDeletionBytes: usage.pendingDeletionBytes ?? 0,
      assetCount: (usage.assetCount ?? 0) + 1,
      failedCount: usage.failedCount ?? 0,
      pendingDeletionCount: usage.pendingDeletionCount ?? 0,
      updatedAt,
    });
    return;
  }

  await ctx.db.insert("crystalAssetUsage", {
    userId,
    usedBytes: bytes,
    pendingDeletionBytes: 0,
    assetCount: 1,
    failedCount: 0,
    pendingDeletionCount: 0,
    updatedAt,
  });
}

async function reconcileAssetUsageAfterMutation(ctx: any, userId: string) {
  await reconcileAssetUsageForUser(ctx, userId, false);
}

export const getAssetUsage = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const usage = await ctx.db
      .query("crystalAssetUsage")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    return usage ?? { userId, usedBytes: 0, pendingDeletionBytes: 0, updatedAt: 0 };
  },
});

export const listMyAssets = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const rows = await ctx.db
      .query("crystalAssets")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .take(Math.min(limit * 10, 1000));
    return rows.filter((asset) => {
      const status = normalizeAssetStatusForDashboard(asset.status, asset.embedded);
      return status !== "soft_deleted" && status !== "hard_deleted";
    }).slice(0, limit).map((asset) => {
      const status = normalizeAssetStatusForDashboard(asset.status, asset.embedded);
      return {
        id: asset._id,
        kind: normalizeAssetKindForDashboard(asset.kind),
        modality: normalizeAssetModalityForDashboard(asset.kind, asset.modality),
        mimeType: normalizeMimeTypeForDashboard(asset.mimeType),
        title: asset.title,
        summary: asset.summary,
        status,
        storageProvider: asset.storageProvider ?? "convex",
        bytes: positiveBytes(asset.bytes),
        channel: asset.channel,
        sessionKey: asset.sessionKey,
        tags: asset.tags ?? [],
        processingError: asset.processingError,
        processingAttempts: asset.processingAttempts ?? 0,
        createdAt: asset.createdAt ?? asset._creationTime,
        updatedAt: asset.updatedAt ?? asset.createdAt ?? asset._creationTime,
      };
    });
  },
});

export const getMyAssetStorageSummary = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);
    const [rows, quotaBytes] = await Promise.all([
      ctx.db
        .query("crystalAssets")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
      resolveAssetQuotaBytes(ctx, userId),
    ]);

    const statusCounts: Record<DashboardAssetStatus, number> = {
      uploaded: 0,
      queued: 0,
      processing: 0,
      ready: 0,
      failed: 0,
      soft_deleted: 0,
      hard_deleted: 0,
      skipped: 0,
      other: 0,
    };
    const breakdownByKind: Record<string, { kind: string; modality: string; count: number; bytes: number }> = {};
    let usedBytes = 0;
    let pendingDeletionBytes = 0;
    let assetCount = 0;
    let failedCount = 0;
    let pendingDeletionCount = 0;

    for (const asset of rows) {
      const status = normalizeAssetStatusForDashboard(asset.status, asset.embedded);
      if (status === "hard_deleted") continue;

      const bytes = positiveBytes(asset.bytes);
      const kind = normalizeAssetKindForDashboard(asset.kind);
      const modality = normalizeAssetModalityForDashboard(asset.kind, asset.modality);
      const breakdownKey = `${kind}:${modality}`;

      assetCount += 1;
      usedBytes += bytes;
      statusCounts[status] += 1;
      breakdownByKind[breakdownKey] ??= { kind, modality, count: 0, bytes: 0 };
      breakdownByKind[breakdownKey].count += 1;
      breakdownByKind[breakdownKey].bytes += bytes;

      if (status === "failed") failedCount += 1;
      if (status === "soft_deleted") {
        pendingDeletionCount += 1;
        pendingDeletionBytes += bytes;
      }
    }

    return {
      usedBytes,
      pendingDeletionBytes,
      quotaBytes,
      assetCount,
      failedCount,
      pendingDeletionCount,
      statusCounts,
      kindBreakdown: Object.values(breakdownByKind).sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind)),
    };
  },
});

export const getMyAssetUsage = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);
    const usage = await ctx.db
      .query("crystalAssetUsage")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const quotaBytes = await resolveAssetQuotaBytes(ctx, userId);
    return {
      usedBytes: usage?.usedBytes ?? 0,
      pendingDeletionBytes: usage?.pendingDeletionBytes ?? 0,
      quotaBytes,
    };
  },
});

export const retryMyAsset = mutation({
  args: { assetId: v.id("crystalAssets") },
  handler: async (ctx, { assetId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    const userId = stableUserId(identity.subject);
    const asset = await ctx.db.get(assetId);
    if (!asset || asset.userId !== userId) throw new Error("Asset not found");
    if ((asset.status ?? "uploaded") !== "failed") return { ok: false as const, reason: "not_failed" as const };

    const now = Date.now();
    await ctx.db.patch(assetId, buildAssetRetryQueuedPatch(now));
    await ctx.scheduler.runAfter(0, internal.crystal.assets.processAssetText, { assetId });
    return { ok: true as const };
  },
});

export const deleteMyAsset = mutation({
  args: { assetId: v.id("crystalAssets") },
  handler: async (ctx, { assetId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    const userId = stableUserId(identity.subject);
    const asset = await ctx.db.get(assetId);
    if (!asset || asset.userId !== userId) throw new Error("Asset not found");
    const now = Date.now();
    await ctx.db.patch(assetId, {
      status: "soft_deleted",
      softDeletedAt: now,
      retentionUntil: now + 7 * 24 * 60 * 60 * 1000,
      updatedAt: now,
    });
    await reconcileAssetUsageAfterMutation(ctx, userId);
    return { ok: true };
  },
});

export const getAdminAssetOverview = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);
    const profile = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!profile?.roles?.includes("admin") && !profile?.roles?.includes("manager")) return null;
    const usage = await ctx.db.query("crystalAssetUsage").collect();
    const hasCompleteUsageCounts = usage.every((row) =>
      typeof row.assetCount === "number"
      && typeof row.failedCount === "number"
      && typeof row.pendingDeletionCount === "number"
    );
    if (!hasCompleteUsageCounts) {
      const assets = await ctx.db.query("crystalAssets").collect();
      return {
        assetCount: assets.filter((asset) => asset.status !== "hard_deleted").length,
        failedCount: assets.filter((asset) => asset.status === "failed").length,
        pendingDeletionCount: assets.filter((asset) => asset.status === "soft_deleted").length,
        usedBytes: usage.reduce((sum, row) => sum + row.usedBytes, 0),
        pendingDeletionBytes: usage.reduce((sum, row) => sum + row.pendingDeletionBytes, 0),
        userCount: usage.length,
      };
    }
    return {
      assetCount: usage.reduce((sum, row) => sum + (row.assetCount ?? 0), 0),
      failedCount: usage.reduce((sum, row) => sum + (row.failedCount ?? 0), 0),
      pendingDeletionCount: usage.reduce((sum, row) => sum + (row.pendingDeletionCount ?? 0), 0),
      usedBytes: usage.reduce((sum, row) => sum + row.usedBytes, 0),
      pendingDeletionBytes: usage.reduce((sum, row) => sum + row.pendingDeletionBytes, 0),
      userCount: usage.length,
    };
  },
});

async function reconcileAssetUsageForUser(ctx: any, userId: string, dryRun?: boolean) {
  const assets = await ctx.db
    .query("crystalAssets")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
  const usedBytes = assets
    .filter((asset: any) => asset.status !== "hard_deleted")
    .reduce((sum: number, asset: any) => sum + positiveBytes(asset.bytes), 0);
  const pendingDeletionBytes = assets
    .filter((asset: any) => asset.status === "soft_deleted")
    .reduce((sum: number, asset: any) => sum + positiveBytes(asset.bytes), 0);
  const assetCount = assets.filter((asset: any) => asset.status !== "hard_deleted").length;
  const failedCount = assets.filter((asset: any) => asset.status === "failed").length;
  const pendingDeletionCount = assets.filter((asset: any) => asset.status === "soft_deleted").length;
  const existing = await ctx.db
    .query("crystalAssetUsage")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();
  if (!dryRun) {
    if (existing) {
      await ctx.db.patch(existing._id, { usedBytes, pendingDeletionBytes, assetCount, failedCount, pendingDeletionCount, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("crystalAssetUsage", { userId, usedBytes, pendingDeletionBytes, assetCount, failedCount, pendingDeletionCount, updatedAt: Date.now() });
    }
  }
  return {
    userId,
    usedBytes,
    pendingDeletionBytes,
    assetCount,
    failedCount,
    pendingDeletionCount,
    previousUsedBytes: existing?.usedBytes ?? 0,
    previousPendingDeletionBytes: existing?.pendingDeletionBytes ?? 0,
    dryRun: Boolean(dryRun),
  };
}

export const reconcileAssetUsage = internalMutation({
  args: { userId: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { userId, dryRun }) => reconcileAssetUsageForUser(ctx, userId, dryRun),
});

export const hardDeleteExpiredAssets = internalMutation({
  args: { now: v.optional(v.number()), dryRun: v.optional(v.boolean()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const candidates = await ctx.db
      .query("crystalAssets")
      .withIndex("by_deletion_cleanup", (q) => q.eq("status", "soft_deleted"))
      .filter((q) => q.lte(q.field("retentionUntil"), now))
      .take(limit);
    const due = candidates.filter((asset) => typeof asset.retentionUntil === "number");
    if (!args.dryRun) {
      for (const asset of due) {
        if ((asset.storageProvider ?? "convex") === "convex" && isLikelyConvexStorageId(asset.storageKey)) {
          await ctx.storage.delete(asset.storageKey as Id<"_storage">).catch((err: unknown) => {
            console.warn("[asset.cleanup] failed to delete expired asset bytes:", err);
          });
        }
        await ctx.db.patch(asset._id, {
          status: "hard_deleted",
          hardDeletedAt: now,
          updatedAt: now,
        });
      }
      for (const userId of Array.from(new Set(due.map((asset) => asset.userId)))) {
        await reconcileAssetUsageForUser(ctx, userId, false);
      }
    }
    return {
      dryRun: Boolean(args.dryRun),
      scanned: candidates.length,
      due: due.length,
      assetIds: due.map((asset) => String(asset._id)),
    };
  },
});

export const createAssetCopyManifestDryRun = internalMutation({
  args: {
    manifestId: v.string(),
    userId: v.string(),
    sourceUserId: v.string(),
    targetUserId: v.string(),
    selectedKnowledgeBaseIds: v.array(v.string()),
    selectedAssetIds: v.array(v.string()),
    privateKnowledgeBaseAllowlist: v.array(v.string()),
    peerKnowledgeBaseAllowlist: v.array(v.string()),
    idempotencyKeys: v.array(v.string()),
    sourceDigest: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("crystalAssetManifests")
      .withIndex("by_manifestId", (q) => q.eq("manifestId", args.manifestId))
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("crystalAssetManifests", {
      ...args,
      mode: "dry_run",
      status: "dry_run",
      createdAt: Date.now(),
    });
  },
});

export const validateAssetCopyManifestForApply = internalQuery({
  args: {
    approvedManifestId: v.string(),
    sourceUserId: v.string(),
    targetUserId: v.string(),
    selectedKnowledgeBaseIds: v.array(v.string()),
    selectedAssetIds: v.array(v.string()),
    privateKnowledgeBaseAllowlist: v.array(v.string()),
    peerKnowledgeBaseAllowlist: v.array(v.string()),
    sourceDigest: v.string(),
  },
  handler: async (ctx, args) => {
    const manifest = await ctx.db
      .query("crystalAssetManifests")
      .withIndex("by_manifestId", (q) => q.eq("manifestId", args.approvedManifestId))
      .first();
    if (!manifest) throw new Error("approvedManifestId not found");
    if (manifest.expiresAt <= Date.now()) throw new Error("approvedManifestId expired");
    if (manifest.mode !== "dry_run") throw new Error("approvedManifestId mode mismatch");
    if (manifest.status !== "approved" || typeof manifest.approvedAt !== "number") throw new Error("approvedManifestId not approved");
    if (manifest.sourceUserId !== args.sourceUserId) throw new Error("approvedManifestId source mismatch");
    if (manifest.targetUserId !== args.targetUserId) throw new Error("approvedManifestId target mismatch");
    if (manifest.sourceDigest !== args.sourceDigest) throw new Error("approvedManifestId source digest mismatch");
    assertSameStringSet(manifest.selectedKnowledgeBaseIds, args.selectedKnowledgeBaseIds, "selectedKnowledgeBaseIds");
    assertSameStringSet(manifest.selectedAssetIds, args.selectedAssetIds, "selectedAssetIds");
    assertSameStringSet(manifest.privateKnowledgeBaseAllowlist, args.privateKnowledgeBaseAllowlist, "privateKnowledgeBaseAllowlist");
    assertSameStringSet(manifest.peerKnowledgeBaseAllowlist, args.peerKnowledgeBaseAllowlist, "peerKnowledgeBaseAllowlist");
    return { ok: true, manifestId: manifest._id };
  },
});

function assertSameStringSet(left: string[], right: string[], label: string) {
  const normalize = (values: string[]) => [...new Set(values)].sort();
  const a = normalize(left);
  const b = normalize(right);
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
    throw new Error(`approvedManifestId ${label} mismatch`);
  }
}

export const getAssetById = internalQuery({
  args: { assetId: v.id("crystalAssets") },
  handler: async (ctx, { assetId }) => ctx.db.get(assetId),
});

export const getAssetMetadataForOwner = internalQuery({
  args: {
    userId: v.string(),
    assetId: v.id("crystalAssets"),
    channel: v.optional(v.string()),
    knowledgeBaseIds: v.optional(v.array(v.string())),
    peerScope: v.optional(v.string()),
  },
  handler: async (ctx, { userId, assetId, channel, knowledgeBaseIds, peerScope }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset || asset.userId !== userId) return null;
    if (!isAssetVisibleInContext(asset, { channel, knowledgeBaseIds, peerScope })) return null;
    const status = asset.status ?? (asset.embedded ? "ready" : "uploaded");
    if (status === "soft_deleted" || status === "hard_deleted") return null;
    return {
      id: asset._id,
      userId: asset.userId,
      kind: asset.kind,
      modality: asset.modality ?? modalityFromKind(asset.kind),
      mimeType: asset.mimeType,
      title: asset.title,
      summary: asset.summary,
      transcript: asset.transcript,
      status,
      storageProvider: asset.storageProvider ?? "convex",
      bytes: asset.bytes ?? 0,
      checksum: asset.checksum,
      channel: asset.channel,
      sessionKey: asset.sessionKey,
      tags: asset.tags,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    };
  },
});

export const getAssetStorageForOwner = internalQuery({
  args: {
    userId: v.string(),
    assetId: v.id("crystalAssets"),
    channel: v.optional(v.string()),
    knowledgeBaseIds: v.optional(v.array(v.string())),
    peerScope: v.optional(v.string()),
  },
  handler: async (ctx, { userId, assetId, channel, knowledgeBaseIds, peerScope }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset || asset.userId !== userId) return null;
    if (!isAssetVisibleInContext(asset, { channel, knowledgeBaseIds, peerScope })) return null;
    const status = asset.status ?? (asset.embedded ? "ready" : "uploaded");
    if (status === "soft_deleted" || status === "hard_deleted") return null;
    return {
      id: asset._id,
      storageKey: asset.storageKey,
      storageProvider: asset.storageProvider ?? "convex",
    };
  },
});

export const softDeleteAssetForOwner = internalMutation({
  args: {
    userId: v.string(),
    assetId: v.id("crystalAssets"),
    retentionUntil: v.number(),
    channel: v.optional(v.string()),
    knowledgeBaseIds: v.optional(v.array(v.string())),
    peerScope: v.optional(v.string()),
  },
  handler: async (ctx, { userId, assetId, retentionUntil, channel, knowledgeBaseIds, peerScope }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset || asset.userId !== userId) return { ok: false, reason: "not_found" as const };
    if (!isAssetVisibleInContext(asset, { channel, knowledgeBaseIds, peerScope })) return { ok: false, reason: "not_found" as const };
    const now = Date.now();
    await ctx.db.patch(assetId, {
      status: "soft_deleted",
      softDeletedAt: now,
      retentionUntil,
      updatedAt: now,
    });
    await reconcileAssetUsageAfterMutation(ctx, userId);
    return { ok: true as const };
  },
});

export const markAssetRetryQueuedForOwner = internalMutation({
  args: {
    userId: v.string(),
    assetId: v.id("crystalAssets"),
    channel: v.optional(v.string()),
    knowledgeBaseIds: v.optional(v.array(v.string())),
    peerScope: v.optional(v.string()),
  },
  handler: async (ctx, { userId, assetId, channel, knowledgeBaseIds, peerScope }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset || asset.userId !== userId) return { ok: false, reason: "not_found" as const };
    if (!isAssetVisibleInContext(asset, { channel, knowledgeBaseIds, peerScope })) return { ok: false, reason: "not_found" as const };
    if ((asset.status ?? "uploaded") !== "failed") return { ok: false, reason: "not_failed" as const };
    const now = Date.now();
    await ctx.db.patch(assetId, buildAssetRetryQueuedPatch(now));
    return { ok: true as const };
  },
});

export const searchRecallableAssets = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
    channel: v.optional(v.string()),
    knowledgeBaseIds: v.optional(v.array(v.string())),
    peerScope: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { userId, query, channel, knowledgeBaseIds, peerScope, limit }) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const readyRows = await ctx.db
      .query("crystalAssets")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "ready"))
      .collect();
    const legacyRows = await ctx.db
      .query("crystalAssets")
      .withIndex("by_user_embedded", (q) => q.eq("userId", userId).eq("embedded", true))
      .collect();
    const rows = Array.from(
      new Map(
        [...readyRows, ...legacyRows.filter((asset) => asset.status === undefined)]
          .map((asset) => [String(asset._id), asset])
      ).values()
    );
    const seen = new Set<string>();
    return rows
      .sort((left, right) => right.createdAt - left.createdAt)
      .filter((asset) => {
        if (!isAssetVisibleInContext(asset, { channel, knowledgeBaseIds, peerScope })) return false;
        const text = [asset.title, asset.summary, asset.extractedText, asset.transcript, ...(asset.tags ?? [])]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        return text.includes(normalizedQuery);
      })
      .map((asset) => {
        const diversityKey = asset.checksum || String(asset._id);
        if (seen.has(diversityKey)) return null;
        seen.add(diversityKey);
        return {
          id: asset._id,
          modality: asset.modality ?? modalityFromKind(asset.kind),
          kind: asset.kind,
          title: asset.title,
          summary: asset.summary,
          extractedText: asset.extractedText,
          transcript: asset.transcript,
          source: asset.source,
          channel: asset.channel,
          sessionKey: asset.sessionKey,
          tags: asset.tags ?? [],
          createdAt: asset.createdAt,
        };
      })
      .filter(Boolean)
      .slice(0, Math.min(Math.max(limit ?? 5, 1), 10));
  },
});

export const markAssetProcessing = internalMutation({
  args: { assetId: v.id("crystalAssets") },
  handler: async (ctx, { assetId }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) return { ok: false, reason: "not_found" as const };
    if (!canStartAssetProcessing(asset.status)) {
      return { ok: false, reason: "not_processable" as const };
    }
    const attempts = (asset.processingAttempts ?? 0) + 1;
    if (attempts > MAX_PROCESSING_ATTEMPTS) {
      await ctx.db.patch(assetId, {
        status: "failed",
        processingError: "retry limit exceeded",
        updatedAt: Date.now(),
      });
      return { ok: false, reason: "retry_limit" as const };
    }
    await ctx.db.patch(assetId, {
      status: "processing",
      processingAttempts: attempts,
      processingError: undefined,
      updatedAt: Date.now(),
    });
    return { ok: true as const, asset, attempts };
  },
});

export const failAssetProcessing = internalMutation({
  args: { assetId: v.id("crystalAssets"), error: v.string() },
  handler: async (ctx, { assetId, error }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) return { ok: false, reason: "not_found" as const };
    if (!isProcessableAssetStatus(asset.status)) {
      return { ok: false, reason: "not_processable" as const };
    }
    await ctx.db.patch(assetId, {
      status: "failed",
      processingError: error,
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

export const completeAssetProcessing = internalMutation({
  args: {
    assetId: v.id("crystalAssets"),
    extractedText: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    embedding: v.array(v.float64()),
    createDerivedMemory: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get(args.assetId);
    if (!asset) return { ok: false, reason: "not_found" as const };
    if (!isProcessableAssetStatus(asset.status)) {
      return { ok: false, reason: "not_processable" as const };
    }
    const now = Date.now();
    const patch: Record<string, unknown> = {
      extractedText: args.extractedText,
      transcript: args.transcript ?? asset.transcript,
      summary: args.summary ?? asset.summary,
      embedding: args.embedding,
      embedded: true,
      status: "ready",
      processedAt: now,
      updatedAt: now,
      processingError: undefined,
    };

    const derivedMemoryIds = [...(asset.derivedMemoryIds ?? [])];
    const memoryContent = (args.summary || args.extractedText || args.transcript || "").trim();
    if (args.createDerivedMemory && memoryContent && derivedMemoryIds.length === 0) {
      const memoryId = await ctx.db.insert("crystalMemories", {
        userId: asset.userId,
        store: "semantic",
        category: "fact",
        title: asset.title || `Asset memory ${String(args.assetId)}`,
        content: memoryContent,
        metadata: JSON.stringify({
          sourceAssetId: String(args.assetId),
          sourceSessionId: asset.sourceSessionId ? String(asset.sourceSessionId) : undefined,
          sourceMessageId: asset.sourceMessageId ? String(asset.sourceMessageId) : undefined,
        }),
        embedding: args.embedding,
        strength: 0.6,
        confidence: 0.7,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: "external",
        sessionId: asset.sourceSessionId,
        channel: asset.channel,
        tags: Array.from(new Set([...(asset.tags ?? []), "asset-derived"])),
        archived: false,
        sourceMessageIds: asset.sourceMessageId ? [asset.sourceMessageId] : undefined,
      });
      await upsertMemoryEmbedding(ctx, memoryId, args.embedding);
      await applyDashboardTotalsDelta(
        ctx,
        asset.userId,
        buildMemoryCreateDelta({
          store: "semantic",
          archived: false,
          title: asset.title || `Asset memory ${String(args.assetId)}`,
          memoryId: String(memoryId),
          createdAt: now,
          strength: 0.6,
        })
      );
      const eligibility = shouldEnrich({ store: "semantic", strength: 0.6, accessCount: 0 });
      if (!eligibility.ok) {
        await ctx.runMutation(
          internal.crystal.observability.functionCallMetrics.recordCall,
          { name: "enrichMemoryGraph_skip", userId: asset.userId, tier: "semantic" },
        ).catch(() => null);
      } else {
        await ctx.scheduler.runAfter(100, internal.crystal.graphEnrich.enrichMemoryGraph, {
          memoryId,
          userId: asset.userId,
        });
      }
      derivedMemoryIds.push(memoryId);
      patch.derivedMemoryIds = derivedMemoryIds;
      patch.sourceMemoryId = memoryId;
      patch.sourceMemoryIds = derivedMemoryIds;
    }

    await ctx.db.patch(args.assetId, patch);
    return { ok: true as const, derivedMemoryIds };
  },
});

export const processAssetText = internalAction({
  args: {
    assetId: v.id("crystalAssets"),
    extractedText: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    createDerivedMemory: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const started: any = await ctx.runMutation(internal.crystal.assets.markAssetProcessing, { assetId: args.assetId });
    if (!started.ok) return started;
    const asset = started.asset;
    const embedding = await embedAssetDoc({
      storageKey: asset.storageKey,
      mimeType: asset.mimeType,
      title: asset.title,
      transcript: args.transcript ?? asset.transcript,
      summary: args.summary ?? asset.summary,
      extractedText: args.extractedText ?? asset.extractedText,
      tags: asset.tags,
      kind: asset.kind,
      modality: asset.modality ?? modalityFromKind(asset.kind),
    }, ctx, {
      userId: asset.userId,
      source: "assets.processAssetText",
    });

    if (!Array.isArray(embedding)) {
      await ctx.runMutation(internal.crystal.assets.failAssetProcessing, {
        assetId: args.assetId,
        error: "embedding_unavailable",
      });
      return { ok: false, reason: "embedding_unavailable" as const };
    }

    return await ctx.runMutation(internal.crystal.assets.completeAssetProcessing, {
      ...args,
      embedding,
    });
  },
});

async function upsertMemoryEmbedding(ctx: any, memoryId: any, embedding: number[]) {
  const existing = await ctx.db
    .query("crystalMemoryEmbeddings")
    .withIndex("by_memoryId", (q: any) => q.eq("memoryId", memoryId))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, {
      embedding,
      model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
      dimensions: embedding.length,
      createdAt: existing.createdAt,
    });
    return;
  }
  await ctx.db.insert("crystalMemoryEmbeddings", {
    memoryId,
    embedding,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    dimensions: embedding.length,
    createdAt: Date.now(),
  });
}

export const patchAssetEmbedding = internalMutation({
  args: { assetId: v.id("crystalAssets"), embedding: v.array(v.float64()) },
  handler: async (ctx, { assetId, embedding }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) return { ok: false, reason: "not_found" as const };
    if (!isProcessableAssetStatus(asset.status)) {
      return { ok: false, reason: "not_processable" as const };
    }
    const now = Date.now();
    await ctx.db.patch(assetId, {
      embedding,
      embedded: true,
      status: "ready",
      processedAt: now,
      updatedAt: now,
    });
    return { ok: true as const };
  },
});

export const listUnembeddedAssets = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const rows = await ctx.db
      .query("crystalAssets")
      .withIndex("by_embedded", (q) => q.eq("embedded", false))
      .order("asc")
      .take(Math.min(boundedLimit * 20, 1000));
    return rows
      .filter((asset) => {
        const status = asset.status ?? "uploaded";
        return status === "uploaded" || status === "queued";
      })
      .slice(0, boundedLimit);
  },
});

type EmbedAssetResult =
  | { ok: true }
  | { ok: false; reason: "missing_or_already_embedded" | "not_processable" | "embedding_unavailable" | "not_found" };

export const embedAsset = internalAction({
  args: { assetId: v.id("crystalAssets") },
  handler: async (ctx, { assetId }): Promise<EmbedAssetResult> => {
    const asset = await ctx.runQuery(internal.crystal.assets.getAssetById, { assetId });
    if (!asset || asset.embedded) {
      return { ok: false, reason: "missing_or_already_embedded" as const };
    }
    if (!isProcessableAssetStatus(asset.status)) {
      return { ok: false, reason: "not_processable" as const };
    }

    const embedding = await embedAssetDoc({
      storageKey: asset.storageKey,
      mimeType: asset.mimeType,
      title: asset.title,
      transcript: asset.transcript,
      summary: asset.summary,
      extractedText: asset.extractedText,
      tags: asset.tags,
      kind: asset.kind,
      modality: asset.modality ?? modalityFromKind(asset.kind),
    }, ctx, {
      userId: asset.userId,
      source: "assets.embedAsset",
    });

    if (!Array.isArray(embedding)) {
      return { ok: false, reason: "embedding_unavailable" as const };
    }

    const patched: { ok: boolean; reason?: "not_found" | "not_processable" } = await ctx.runMutation(internal.crystal.assets.patchAssetEmbedding, {
      assetId,
      embedding,
    });
    if (!patched.ok) return { ok: false, reason: patched.reason ?? "not_processable" };

    return { ok: true };
  },
});

export const assetEmbedder = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 20);
    const assets = await ctx.runQuery(internal.crystal.assets.listUnembeddedAssets, { limit });

    const stats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };

    for (const asset of assets) {
      stats.processed += 1;
      try {
        const result = await ctx.runAction(internal.crystal.assets.embedAsset, { assetId: asset._id });
        if (result?.ok) {
          stats.succeeded += 1;
        } else if (result?.reason === "missing_or_already_embedded") {
          stats.skipped += 1;
        } else {
          stats.failed += 1;
        }
      } catch {
        stats.failed += 1;
      }
    }

    return stats;
  },
});
