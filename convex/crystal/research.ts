import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { stableUserId } from "./auth";
import { scanMemoryContent } from "./contentScanner";
import { getCapacityPolicyForUser } from "./capacityPolicy";
import { embedTextWithUserOpenRouter } from "./embeddings";

const visibility = v.union(v.literal("private"), v.literal("scoped"));
const collectionStatus = v.union(v.literal("active"), v.literal("paused"), v.literal("archived"));
const runStatus = v.union(
  v.literal("queued"), v.literal("running"), v.literal("completed"),
  v.literal("failed"), v.literal("rejected"), v.literal("cancelled"),
);

const scopeInput = {
  workspaceId: v.optional(v.string()),
  agentId: v.optional(v.string()),
  channel: v.optional(v.string()),
  visibility: v.optional(visibility),
};

const sourceInput = v.object({
  stableKey: v.string(),
  idempotencyKey: v.string(),
  sourceType: v.string(),
  host: v.string(),
  canonicalUrl: v.optional(v.string()),
  repositoryOwner: v.optional(v.string()),
  repositoryName: v.optional(v.string()),
  immutableVersion: v.optional(v.string()),
  filePath: v.optional(v.string()),
  retrievedAt: v.number(),
  contentHash: v.string(),
  contentSample: v.optional(v.string()),
  licenseId: v.optional(v.string()),
  licenseDisposition: v.union(
    v.literal("pending"), v.literal("acceptable"), v.literal("restricted"),
    v.literal("rejected"), v.literal("unknown"),
  ),
  securityDisposition: v.union(
    v.literal("pending"), v.literal("clean"), v.literal("suspicious"),
    v.literal("malicious"), v.literal("rejected"),
  ),
  quarantineState: v.union(v.literal("quarantined"), v.literal("released"), v.literal("rejected")),
  parserVersion: v.string(),
  rejectionReason: v.optional(v.string()),
});

const itemInput = v.object({
  stableKey: v.string(),
  idempotencyKey: v.string(),
  itemType: v.string(),
  contentHash: v.string(),
  ruleHash: v.string(),
  normalizedRuleJson: v.string(),
  strategyCard: v.string(),
  sourceIds: v.array(v.id("crystalResearchSources")),
  indicators: v.array(v.string()),
  entries: v.array(v.string()),
  exits: v.array(v.string()),
  riskControls: v.array(v.string()),
  directions: v.array(v.string()),
  markets: v.array(v.string()),
  assets: v.array(v.string()),
  timeframes: v.array(v.string()),
  causalTimestampPolicy: v.string(),
  parserVersion: v.string(),
  reviewStatus: v.union(
    v.literal("pending"), v.literal("reviewed"), v.literal("qualified"),
    v.literal("rejected"), v.literal("deprecated"),
  ),
  securityStatus: v.union(v.literal("pending"), v.literal("clean"), v.literal("quarantined"), v.literal("rejected")),
});

const variantInput = v.object({
  stableKey: v.string(),
  idempotencyKey: v.string(),
  itemId: v.id("crystalResearchItems"),
  parameterJson: v.string(),
  parameterHash: v.string(),
  market: v.string(),
  venue: v.optional(v.string()),
  symbol: v.string(),
  timeframe: v.string(),
  direction: v.string(),
  executionAssumptionsJson: v.string(),
  variantHash: v.string(),
});

const datasetInput = v.object({
  stableKey: v.string(),
  idempotencyKey: v.string(),
  provider: v.string(),
  venue: v.optional(v.string()),
  symbols: v.array(v.string()),
  resolution: v.string(),
  startTimestamp: v.number(),
  endTimestamp: v.number(),
  retrievedAt: v.number(),
  checksum: v.string(),
  adjustmentPolicy: v.string(),
  missingDataPolicy: v.string(),
  timezonePolicy: v.string(),
  causalityStatus: v.union(v.literal("pending"), v.literal("valid"), v.literal("invalid")),
  artifactId: v.optional(v.id("crystalResearchArtifacts")),
});

const runInput = v.object({
  itemId: v.id("crystalResearchItems"),
  variantId: v.id("crystalResearchVariants"),
  datasetId: v.id("crystalResearchDatasets"),
  runSpecHash: v.string(),
  idempotencyKey: v.string(),
  engineVersion: v.string(),
  codeVersion: v.string(),
  fold: v.optional(v.string()),
  seed: v.optional(v.number()),
  splitJson: v.string(),
  costAssumptionsJson: v.string(),
  startedAt: v.number(),
  completedAt: v.optional(v.number()),
  status: runStatus,
  netReturn: v.optional(v.float64()),
  sharpe: v.optional(v.float64()),
  maxDrawdown: v.optional(v.float64()),
  winRate: v.optional(v.float64()),
  tradeCount: v.optional(v.number()),
  rankingScore: v.optional(v.float64()),
  robustnessScore: v.optional(v.float64()),
  metricsJson: v.string(),
  failureReason: v.optional(v.string()),
  artifactIds: v.array(v.id("crystalResearchArtifacts")),
});

function normalizedString(value: string, field: string, max = 8_000): string {
  const result = value.normalize("NFKC").trim();
  if (!result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return result;
}

function parseJsonObject(value: string, field: string): string {
  const normalized = normalizedString(value, field, 64_000);
  const parsed = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must encode a JSON object`);
  }
  return JSON.stringify(parsed);
}

function assertFiniteMetrics(input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Malformed metric ${key}: expected a finite number`);
    }
  }
}

function buildRunDocument(args: { userId: string; collectionId: Id<"crystalResearchCollections">; run: any }, collection: any) {
  const metricsJson = parseJsonObject(args.run.metricsJson, "metricsJson");
  assertFiniteMetrics(JSON.parse(metricsJson));
  const now = Date.now();
  return {
    userId: args.userId,
    collectionId: args.collectionId,
    ...scopeFromCollection(collection),
    ...args.run,
    splitJson: parseJsonObject(args.run.splitJson, "splitJson"),
    costAssumptionsJson: parseJsonObject(args.run.costAssumptionsJson, "costAssumptionsJson"),
    metricsJson,
    createdAt: now,
    updatedAt: now,
  };
}

function scopeFromCollection(collection: any) {
  return {
    workspaceId: collection.workspaceId,
    agentId: collection.agentId,
    channel: collection.channel,
    visibility: collection.visibility,
  };
}

function isVisible(row: any, context: { agentId?: string; channel?: string }, allowOwnerWide = false): boolean {
  if (allowOwnerWide) return true;
  if (row.agentId && row.agentId !== context.agentId) return false;
  if (row.channel && row.channel !== context.channel) return false;
  if (row.visibility === "scoped" && !row.agentId && !row.channel) return false;
  return true;
}

async function requireCollection(ctx: any, userId: string, collectionId: Id<"crystalResearchCollections">) {
  const collection = await ctx.db.get(collectionId);
  if (!collection || collection.userId !== userId) throw new Error("Research collection not found");
  return collection;
}

function counterShard(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 64;
}

type CounterName = "sources" | "artifacts" | "items" | "variants" | "datasets" | "runs" | "jobs" | "rejected" | "quarantined";

export async function bumpCounter(
  ctx: any,
  userId: string,
  collectionId: Id<"crystalResearchCollections">,
  name: CounterName,
  key: string,
  delta = 1,
) {
  const shard = counterShard(key);
  return bumpCounterShard(ctx, userId, collectionId, name, shard, delta);
}

async function bumpCounterShard(
  ctx: any,
  userId: string,
  collectionId: Id<"crystalResearchCollections">,
  name: CounterName,
  shard: number,
  delta: number,
) {
  const existing = await ctx.db
    .query("crystalResearchCounterShards")
    .withIndex("by_collection_shard", (q: any) => q.eq("collectionId", collectionId).eq("shard", shard))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, { [name]: Math.max(0, (existing[name] ?? 0) + delta), updatedAt: Date.now() });
    return;
  }
  await ctx.db.insert("crystalResearchCounterShards", {
    userId,
    collectionId,
    shard,
    sources: name === "sources" ? delta : 0,
    artifacts: name === "artifacts" ? delta : 0,
    items: name === "items" ? delta : 0,
    variants: name === "variants" ? delta : 0,
    datasets: name === "datasets" ? delta : 0,
    runs: name === "runs" ? delta : 0,
    jobs: name === "jobs" ? delta : 0,
    rejected: name === "rejected" ? delta : 0,
    quarantined: name === "quarantined" ? delta : 0,
    artifactBytes: 0,
    updatedAt: Date.now(),
  });
}

export async function addArtifactBytes(
  ctx: any,
  userId: string,
  collectionId: Id<"crystalResearchCollections">,
  key: string,
  bytes: number,
) {
  const shard = counterShard(key);
  const existing = await ctx.db.query("crystalResearchCounterShards")
    .withIndex("by_collection_shard", (q: any) => q.eq("collectionId", collectionId).eq("shard", shard)).first();
  if (existing) {
    await ctx.db.patch(existing._id, { artifactBytes: Math.max(0, (existing.artifactBytes ?? 0) + bytes), updatedAt: Date.now() });
    return;
  }
  await ctx.db.insert("crystalResearchCounterShards", {
    userId, collectionId, shard,
    sources: 0, artifacts: 0, items: 0, variants: 0, datasets: 0, runs: 0, jobs: 0, rejected: 0, quarantined: 0,
    artifactBytes: Math.max(0, bytes), updatedAt: Date.now(),
  });
}

export const bumpResearchCounterInternal = internalMutation({
  args: {
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    name: v.union(
      v.literal("sources"), v.literal("artifacts"), v.literal("items"),
      v.literal("variants"), v.literal("datasets"), v.literal("runs"),
      v.literal("jobs"), v.literal("rejected"), v.literal("quarantined"),
    ),
    key: v.string(),
    delta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    await bumpCounter(ctx, args.userId, args.collectionId, args.name, args.key, args.delta ?? 1);
    return { ok: true };
  },
});

async function recordRejection(
  ctx: any,
  args: {
    userId: string;
    collectionId: Id<"crystalResearchCollections">;
    entityType: string;
    idempotencyKey: string;
    payloadHash?: string;
    reason: string;
    securityDisposition?: string;
    licenseDisposition?: string;
  },
) {
  const existing = await ctx.db
    .query("crystalResearchRejections")
    .withIndex("by_collection_idempotency", (q: any) =>
      q.eq("collectionId", args.collectionId).eq("idempotencyKey", args.idempotencyKey),
    )
    .first();
  if (existing) return existing._id;
  const id = await ctx.db.insert("crystalResearchRejections", { ...args, createdAt: Date.now() });
  await bumpCounter(ctx, args.userId, args.collectionId, "rejected", args.idempotencyKey);
  return id;
}

async function authenticatedUserId(ctx: any): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  return stableUserId(identity.subject);
}

async function createCollectionImpl(ctx: any, userId: string, args: any) {
  const capacity = await getCapacityPolicyForUser(ctx, userId);
  if (capacity.researchRecords === 0) throw new Error("Research plane is not enabled for this capacity policy");
  const now = Date.now();
  return ctx.db.insert("crystalResearchCollections", {
    userId,
    workspaceId: args.workspaceId?.trim() || undefined,
    agentId: args.agentId?.trim() || undefined,
    channel: args.channel?.trim() || undefined,
    visibility: args.visibility ?? (args.agentId || args.channel ? "scoped" : "private"),
    name: normalizedString(args.name, "name", 200),
    domain: normalizedString(args.domain, "domain", 100),
    description: args.description?.normalize("NFKC").trim().slice(0, 4_000) || undefined,
    status: "active",
    retentionPolicy: normalizedString(args.retentionPolicy ?? "durable", "retentionPolicy", 200),
    createdAt: now,
    updatedAt: now,
  });
}

export const createCollection = mutation({
  args: { name: v.string(), domain: v.string(), description: v.optional(v.string()), retentionPolicy: v.optional(v.string()), ...scopeInput },
  handler: async (ctx, args) => createCollectionImpl(ctx, await authenticatedUserId(ctx), args),
});

export const createCollectionInternal = internalMutation({
  args: { userId: v.string(), name: v.string(), domain: v.string(), description: v.optional(v.string()), retentionPolicy: v.optional(v.string()), ...scopeInput },
  handler: async (ctx, { userId, ...args }) => createCollectionImpl(ctx, userId, args),
});

export const archiveCollectionInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), archived: v.boolean() },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    await ctx.db.patch(args.collectionId, { status: args.archived ? "archived" : "active", updatedAt: Date.now() });
    return { ok: true };
  },
});

export const listCollectionsInternal = internalQuery({
  args: { userId: v.string(), status: v.optional(collectionStatus), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 100);
    const base = args.status
      ? ctx.db.query("crystalResearchCollections").withIndex("by_user_status_updated", (q: any) => q.eq("userId", args.userId).eq("status", args.status))
      : ctx.db.query("crystalResearchCollections").withIndex("by_user_updated", (q: any) => q.eq("userId", args.userId));
    const page = await base.order("desc").paginate({ cursor: args.cursor ?? null, numItems: limit });
    return { collections: page.page, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const listCollections = query({
  args: { status: v.optional(collectionStatus), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 100);
    const base = args.status
      ? ctx.db.query("crystalResearchCollections").withIndex("by_user_status_updated", (q) => q.eq("userId", userId).eq("status", args.status!))
      : ctx.db.query("crystalResearchCollections").withIndex("by_user_updated", (q) => q.eq("userId", userId));
    const page = await base.order("desc").paginate({ cursor: args.cursor ?? null, numItems: limit });
    return { collections: page.page, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const upsertSourceInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), source: sourceInput },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    const source = args.source;
    const existing = await ctx.db
      .query("crystalResearchSources")
      .withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", source.stableKey))
      .first();
    if (existing && existing.contentHash !== source.contentHash) {
      const reason = "stableKey conflict: immutable source content hash changed";
      await recordRejection(ctx, {
        userId: args.userId, collectionId: args.collectionId, entityType: "source",
        idempotencyKey: source.idempotencyKey, payloadHash: source.contentHash, reason,
        securityDisposition: source.securityDisposition, licenseDisposition: source.licenseDisposition,
      });
      return { rejected: true, reason };
    }
    const scan = source.contentSample ? scanMemoryContent(source.contentSample.normalize("NFKC")) : { allowed: true as const };
    if (existing) {
      const incomingRejected = !scan.allowed
        || source.licenseDisposition === "rejected"
        || source.securityDisposition === "malicious"
        || source.securityDisposition === "rejected";
      if (incomingRejected && existing.quarantineState === "released") {
        const reason = !scan.allowed ? `${scan.reason} [${scan.threatId}]` : source.rejectionReason ?? "source rejected by disposition";
        await ctx.db.patch(existing._id, {
          securityDisposition: !scan.allowed ? "malicious" : source.securityDisposition,
          licenseDisposition: source.licenseDisposition === "rejected" ? "rejected" : existing.licenseDisposition,
          quarantineState: "rejected",
          rejectionReason: reason,
          updatedAt: Date.now(),
        });
        await bumpCounter(ctx, args.userId, args.collectionId, "quarantined", source.stableKey);
        await recordRejection(ctx, {
          userId: args.userId, collectionId: args.collectionId, entityType: "source",
          idempotencyKey: source.idempotencyKey, payloadHash: source.contentHash, reason,
          securityDisposition: !scan.allowed ? "malicious" : source.securityDisposition,
          licenseDisposition: source.licenseDisposition,
        });
      }
      const rejected = incomingRejected
        || existing.quarantineState !== "released"
        || existing.securityDisposition === "malicious"
        || existing.securityDisposition === "rejected"
        || existing.licenseDisposition === "rejected";
      return { sourceId: existing._id, created: false, rejected };
    }

    const rejectedByLicense = source.licenseDisposition === "rejected";
    const rejected = !scan.allowed || rejectedByLicense || source.securityDisposition === "malicious" || source.securityDisposition === "rejected";
    const securityDisposition = !scan.allowed ? "malicious" as const : source.securityDisposition;
    const quarantineState = rejected ? "rejected" as const : source.quarantineState;
    const rejectionReason = !scan.allowed ? `${scan.reason} [${scan.threatId}]` : source.rejectionReason;
    const now = Date.now();
    const row = {
      ...scopeFromCollection(collection),
      stableKey: normalizedString(source.stableKey, "stableKey", 500),
      idempotencyKey: normalizedString(source.idempotencyKey, "idempotencyKey", 500),
      sourceType: normalizedString(source.sourceType, "sourceType", 100),
      host: normalizedString(source.host, "host", 300),
      canonicalUrl: source.canonicalUrl,
      repositoryOwner: source.repositoryOwner,
      repositoryName: source.repositoryName,
      immutableVersion: source.immutableVersion,
      filePath: source.filePath,
      retrievedAt: source.retrievedAt,
      contentHash: normalizedString(source.contentHash, "contentHash", 200),
      licenseId: source.licenseId,
      licenseDisposition: source.licenseDisposition,
      securityDisposition,
      quarantineState,
      parserVersion: normalizedString(source.parserVersion, "parserVersion", 100),
      rejectionReason,
      updatedAt: now,
    };
    const sourceId = await ctx.db.insert("crystalResearchSources", {
      userId: args.userId, collectionId: args.collectionId, ...row, createdAt: now,
    });
    await bumpCounter(ctx, args.userId, args.collectionId, "sources", source.stableKey);
    if (quarantineState === "quarantined" || quarantineState === "rejected") {
      await bumpCounter(ctx, args.userId, args.collectionId, "quarantined", source.stableKey);
    }
    if (rejected) {
      await recordRejection(ctx, {
        userId: args.userId, collectionId: args.collectionId, entityType: "source",
        idempotencyKey: source.idempotencyKey, payloadHash: source.contentHash,
        reason: rejectionReason ?? "source rejected by disposition",
        securityDisposition, licenseDisposition: source.licenseDisposition,
      });
    }
    return { sourceId, created: true, rejected };
  },
});

export const upsertItemInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), item: itemInput },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    for (const sourceId of args.item.sourceIds) {
      const source = await ctx.db.get(sourceId);
      if (!source || source.userId !== args.userId || source.collectionId !== args.collectionId) {
        throw new Error("Source lineage crosses research ownership boundary");
      }
    }
    const cardScan = scanMemoryContent(args.item.strategyCard.normalize("NFKC"));
    const ruleScan = scanMemoryContent(args.item.normalizedRuleJson.normalize("NFKC"));
    const rejected = !cardScan.allowed || !ruleScan.allowed;
    const now = Date.now();
    const normalizedRuleJson = parseJsonObject(args.item.normalizedRuleJson, "normalizedRuleJson");
    const existing = await ctx.db.query("crystalResearchItems")
      .withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", args.item.stableKey))
      .first();
    if (existing && existing.contentHash !== args.item.contentHash) {
      const reason = "stableKey conflict: canonical content hash changed";
      await recordRejection(ctx, { userId: args.userId, collectionId: args.collectionId, entityType: "item", idempotencyKey: args.item.idempotencyKey, payloadHash: args.item.contentHash, reason });
      return { rejected: true, reason };
    }
    if (existing) {
      if (rejected && existing.reviewStatus !== "rejected" && existing.securityStatus === "clean") {
        const scan = !cardScan.allowed ? cardScan : ruleScan;
        const reason = !scan.allowed ? `${scan.reason} [${scan.threatId}]` : "item rejected";
        await ctx.db.patch(existing._id, { reviewStatus: "rejected", securityStatus: "quarantined", updatedAt: Date.now() });
        await recordRejection(ctx, {
          userId: args.userId, collectionId: args.collectionId, entityType: "item",
          idempotencyKey: args.item.idempotencyKey, payloadHash: args.item.contentHash, reason,
        });
      }
      return {
        itemId: existing._id,
        created: false,
        rejected: rejected || existing.reviewStatus === "rejected" || existing.securityStatus !== "clean",
      };
    }
    const row = {
      ...scopeFromCollection(collection), ...args.item,
      normalizedRuleJson,
      strategyCard: args.item.strategyCard.normalize("NFKC"),
      reviewStatus: rejected ? "rejected" as const : args.item.reviewStatus,
      securityStatus: rejected ? "quarantined" as const : args.item.securityStatus,
      updatedAt: now,
    };
    const itemId = await ctx.db.insert("crystalResearchItems", { userId: args.userId, collectionId: args.collectionId, ...row, createdAt: now });
    await bumpCounter(ctx, args.userId, args.collectionId, "items", args.item.stableKey);
    if (rejected) {
      const scan = !cardScan.allowed ? cardScan : ruleScan;
      await recordRejection(ctx, { userId: args.userId, collectionId: args.collectionId, entityType: "item", idempotencyKey: args.item.idempotencyKey, payloadHash: args.item.contentHash, reason: !scan.allowed ? `${scan.reason} [${scan.threatId}]` : "item rejected" });
    }
    return { itemId, created: true, rejected };
  },
});

export const upsertVariantInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), variant: variantInput },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    const item = await ctx.db.get(args.variant.itemId);
    if (!item || item.userId !== args.userId || item.collectionId !== args.collectionId) throw new Error("Canonical item not found");
    const existing = await ctx.db.query("crystalResearchVariants")
      .withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", args.variant.stableKey)).first();
    if (existing) {
      if (existing.variantHash !== args.variant.variantHash) throw new Error("Variant stableKey conflict: variantHash changed");
      return { variantId: existing._id, created: false };
    }
    const now = Date.now();
    const variantId = await ctx.db.insert("crystalResearchVariants", {
      userId: args.userId, collectionId: args.collectionId, ...scopeFromCollection(collection), ...args.variant,
      parameterJson: parseJsonObject(args.variant.parameterJson, "parameterJson"),
      executionAssumptionsJson: parseJsonObject(args.variant.executionAssumptionsJson, "executionAssumptionsJson"),
      createdAt: now, updatedAt: now,
    });
    await bumpCounter(ctx, args.userId, args.collectionId, "variants", args.variant.stableKey);
    return { variantId, created: true };
  },
});

export const upsertDatasetInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), dataset: datasetInput },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    if (args.dataset.endTimestamp <= args.dataset.startTimestamp) throw new Error("Dataset endTimestamp must be after startTimestamp");
    if (args.dataset.artifactId) {
      const artifact = await ctx.db.get(args.dataset.artifactId);
      if (!artifact || artifact.userId !== args.userId || artifact.collectionId !== args.collectionId) throw new Error("Dataset artifact not found");
    }
    const existing = await ctx.db.query("crystalResearchDatasets")
      .withIndex("by_collection_stable_key", (q) => q.eq("collectionId", args.collectionId).eq("stableKey", args.dataset.stableKey)).first();
    if (existing) {
      if (existing.checksum !== args.dataset.checksum) throw new Error("Dataset stableKey conflict: checksum changed");
      return { datasetId: existing._id, created: false };
    }
    const now = Date.now();
    const datasetId = await ctx.db.insert("crystalResearchDatasets", {
      userId: args.userId, collectionId: args.collectionId, ...scopeFromCollection(collection), ...args.dataset,
      createdAt: now, updatedAt: now,
    });
    await bumpCounter(ctx, args.userId, args.collectionId, "datasets", args.dataset.stableKey);
    return { datasetId, created: true };
  },
});

async function insertRunImpl(
  ctx: any,
  args: { userId: string; collectionId: Id<"crystalResearchCollections">; run: any },
  options: {
    updateCounter?: boolean;
    collection?: any;
    lineageById?: Map<string, any>;
    artifactsById?: Map<string, any>;
    existingByRunSpec?: Map<string, any>;
  } = {},
) {
    const collection = options.collection ?? await requireCollection(ctx, args.userId, args.collectionId);
    const existing = options.existingByRunSpec?.has(args.run.runSpecHash)
      ? options.existingByRunSpec.get(args.run.runSpecHash)
      : await ctx.db.query("crystalResearchRuns")
        .withIndex("by_collection_run_spec", (q: any) => q.eq("collectionId", args.collectionId).eq("runSpecHash", args.run.runSpecHash)).first();
    if (existing) return { runId: existing._id, created: false };
    const getLineage = (id: any) => options.lineageById?.get(String(id));
    const [item, variant, dataset] = options.lineageById
      ? [getLineage(args.run.itemId), getLineage(args.run.variantId), getLineage(args.run.datasetId)]
      : await Promise.all([
        ctx.db.get(args.run.itemId), ctx.db.get(args.run.variantId), ctx.db.get(args.run.datasetId),
      ]);
    for (const row of [item, variant, dataset]) {
      if (!row || row.userId !== args.userId || row.collectionId !== args.collectionId) throw new Error("Run lineage crosses research ownership boundary");
    }
    if (variant.itemId !== item._id) throw new Error("Run variant does not belong to the canonical item");
    for (const artifactId of args.run.artifactIds) {
      const artifact = options.artifactsById
        ? options.artifactsById.get(String(artifactId))
        : await ctx.db.get(artifactId);
      if (!artifact || artifact.userId !== args.userId || artifact.collectionId !== args.collectionId) throw new Error("Run artifact not found");
    }
    const runId = await ctx.db.insert("crystalResearchRuns", buildRunDocument(args, collection));
    options.existingByRunSpec?.set(args.run.runSpecHash, { _id: runId });
    if (options.updateCounter !== false) {
      await bumpCounter(ctx, args.userId, args.collectionId, "runs", args.run.runSpecHash);
    }
    return { runId, created: true };
}

export const insertRunInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), run: runInput },
  handler: insertRunImpl,
});

export const bulkInsertRunsInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), runs: v.array(runInput) },
  handler: async (ctx, args) => {
    if (args.runs.length === 0 || args.runs.length > 100) throw new Error("runs must contain 1 to 100 summaries per committed batch");
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    const lineageIds = new Map<string, any>();
    const artifactIds = new Map<string, any>();
    for (const run of args.runs) {
      for (const id of [run.itemId, run.variantId, run.datasetId]) lineageIds.set(String(id), id);
      for (const id of run.artifactIds) artifactIds.set(String(id), id);
    }
    const [lineageEntries, artifactEntries, existingEntries] = await Promise.all([
      Promise.all([...lineageIds].map(async ([key, id]) => [key, await ctx.db.get(id)] as const)),
      Promise.all([...artifactIds].map(async ([key, id]) => [key, await ctx.db.get(id)] as const)),
      Promise.all(args.runs.map(async (run) => [run.runSpecHash, await ctx.db.query("crystalResearchRuns")
        .withIndex("by_collection_run_spec", (q: any) => q.eq("collectionId", args.collectionId).eq("runSpecHash", run.runSpecHash)).first()] as const)),
    ]);
    const lineageById = new Map(lineageEntries);
    const artifactsById = new Map(artifactEntries);
    const existingByRunSpec = new Map(existingEntries);
    const results: Array<{ runId: Id<"crystalResearchRuns">; created: boolean } | undefined> = Array(args.runs.length);
    const prepared = new Map<string, { document: any; indices: number[] }>();
    for (let index = 0; index < args.runs.length; index += 1) {
      const run = args.runs[index];
      const existing = existingByRunSpec.get(run.runSpecHash);
      if (existing) {
        results[index] = { runId: existing._id, created: false };
        continue;
      }
      const duplicate = prepared.get(run.runSpecHash);
      if (duplicate) {
        duplicate.indices.push(index);
        continue;
      }
      const item: any = lineageById.get(String(run.itemId));
      const variant: any = lineageById.get(String(run.variantId));
      const dataset: any = lineageById.get(String(run.datasetId));
      for (const row of [item, variant, dataset]) {
        if (!row || row.userId !== args.userId || row.collectionId !== args.collectionId) throw new Error("Run lineage crosses research ownership boundary");
      }
      if (variant.itemId !== item._id) throw new Error("Run variant does not belong to the canonical item");
      for (const artifactId of run.artifactIds) {
        const artifact: any = artifactsById.get(String(artifactId));
        if (!artifact || artifact.userId !== args.userId || artifact.collectionId !== args.collectionId) throw new Error("Run artifact not found");
      }
      prepared.set(run.runSpecHash, {
        document: buildRunDocument({ userId: args.userId, collectionId: args.collectionId, run }, collection),
        indices: [index],
      });
    }
    const inserted = await Promise.all([...prepared].map(async ([runSpecHash, entry]) => ({
      runSpecHash,
      indices: entry.indices,
      runId: await ctx.db.insert("crystalResearchRuns", entry.document),
    })));
    for (const entry of inserted) {
      results[entry.indices[0]] = { runId: entry.runId, created: true };
      for (const duplicateIndex of entry.indices.slice(1)) results[duplicateIndex] = { runId: entry.runId, created: false };
    }
    const finalizedResults = results as Array<{ runId: Id<"crystalResearchRuns">; created: boolean }>;
    const createdRunSpecs: string[] = [];
    for (let index = 0; index < finalizedResults.length; index += 1) {
      if (!finalizedResults[index].created) continue;
      createdRunSpecs.push(args.runs[index].runSpecHash);
    }
    if (createdRunSpecs.length > 0) {
      await bumpCounter(
        ctx,
        args.userId,
        args.collectionId,
        "runs",
        `bulk:${createdRunSpecs[0]}:${createdRunSpecs[createdRunSpecs.length - 1]}`,
        createdRunSpecs.length,
      );
    }
    return {
      submitted: args.runs.length,
      inserted: finalizedResults.filter((result) => result.created).length,
      duplicate: finalizedResults.filter((result) => !result.created).length,
      runIds: finalizedResults.map((result) => result.runId),
    };
  },
});

export const queryItemsInternal = internalQuery({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"),
    itemType: v.optional(v.string()), reviewStatus: v.optional(v.string()),
    agentId: v.optional(v.string()), channel: v.optional(v.string()), allowOwnerWide: v.optional(v.boolean()),
    cursor: v.optional(v.string()), limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 25), 1), 100);
    const status = args.reviewStatus ?? "qualified";
    const base = args.itemType
      ? ctx.db.query("crystalResearchItems").withIndex("by_collection_type_status", (q: any) => q.eq("collectionId", args.collectionId).eq("itemType", args.itemType).eq("reviewStatus", status))
      : ctx.db.query("crystalResearchItems").withIndex("by_collection_review", (q: any) => q.eq("collectionId", args.collectionId).eq("reviewStatus", status));
    const page = await base.order("desc").paginate({ cursor: args.cursor ?? null, numItems: limit });
    return {
      items: page.page.filter((row: any) => row.userId === args.userId && isVisible(row, args, args.allowOwnerWide)),
      continueCursor: page.continueCursor, isDone: page.isDone,
    };
  },
});

export const upsertItemEmbeddingInternal = internalMutation({
  args: {
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    itemId: v.id("crystalResearchItems"),
    contentHash: v.string(),
    model: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item || item.userId !== args.userId || item.collectionId !== args.collectionId) throw new Error("Canonical research item not found");
    if (item.contentHash !== args.contentHash) throw new Error("Embedding content hash does not match canonical item");
    if (args.embedding.length !== 3072 || args.embedding.some((value) => !Number.isFinite(value))) {
      throw new Error("Research item embedding must contain 3072 finite values");
    }
    const existing = await ctx.db.query("crystalResearchItemEmbeddings")
      .withIndex("by_item_model", (q) => q.eq("itemId", args.itemId).eq("model", args.model)).first();
    if (existing) {
      if (existing.userId !== args.userId || existing.collectionId !== args.collectionId) throw new Error("Embedding ownership collision");
      if (existing.contentHash !== args.contentHash) throw new Error("Embedding content hash does not match the existing item/model embedding");
      return { embeddingId: existing._id, created: false };
    }
    const embeddingId = await ctx.db.insert("crystalResearchItemEmbeddings", {
      userId: args.userId, collectionId: args.collectionId, itemId: args.itemId,
      scopeKey: `${args.userId}:${String(args.collectionId)}:${args.model}`,
      contentHash: args.contentHash, model: args.model, embedding: args.embedding, createdAt: Date.now(),
    });
    return { embeddingId, created: true };
  },
});

export const hydrateSemanticItemsInternal = internalQuery({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"),
    embeddingIds: v.array(v.id("crystalResearchItemEmbeddings")),
    agentId: v.optional(v.string()), channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const results = [];
    for (const embeddingId of args.embeddingIds) {
      const sidecar = await ctx.db.get(embeddingId);
      if (!sidecar || sidecar.userId !== args.userId || sidecar.collectionId !== args.collectionId) continue;
      const item = await ctx.db.get(sidecar.itemId);
      if (!item || item.userId !== args.userId || item.collectionId !== args.collectionId || !isVisible(item, args)) continue;
      if (item.reviewStatus === "rejected" || item.securityStatus !== "clean") continue;
      results.push({ item, embeddingId: sidecar._id });
    }
    return results;
  },
});

export const semanticSearchInternal: any = internalAction({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"),
    query: v.optional(v.string()), embedding: v.optional(v.array(v.float64())), model: v.string(),
    agentId: v.optional(v.string()), channel: v.optional(v.string()), limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ items: any[]; count: number }> => {
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 10), 1), 50);
    let vector = args.embedding;
    if (!vector && args.query?.trim()) {
      vector = await embedTextWithUserOpenRouter(ctx, args.query, {
        userId: args.userId, source: "research.semanticSearch", allowSharedFallback: true,
      }) ?? undefined;
    }
    if (!vector || vector.length !== 3072 || vector.some((value) => !Number.isFinite(value))) {
      throw new Error("A 3072-value embedding or an embeddable query is required");
    }
    const matches = await ctx.vectorSearch("crystalResearchItemEmbeddings", "by_embedding", {
      vector,
      limit,
      filter: (q) => q.eq("scopeKey", `${args.userId}:${String(args.collectionId)}:${args.model}`),
    });
    const items: any[] = await ctx.runQuery((internal as any).crystal.research.hydrateSemanticItemsInternal, {
      userId: args.userId, collectionId: args.collectionId,
      embeddingIds: matches.map((match) => match._id), agentId: args.agentId, channel: args.channel,
    });
    const scores = new Map(matches.map((match) => [String(match._id), match._score]));
    return {
      items: items.map((entry: any) => ({ ...entry.item, semanticScore: scores.get(String(entry.embeddingId)) })),
      count: items.length,
    };
  },
});

export const queryRunsInternal = internalQuery({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"), status: v.optional(runStatus),
    agentId: v.optional(v.string()), channel: v.optional(v.string()), allowOwnerWide: v.optional(v.boolean()),
    cursor: v.optional(v.string()), limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.userId, args.collectionId);
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 25), 1), 100);
    const status = args.status ?? "completed";
    const page = await ctx.db.query("crystalResearchRuns")
      .withIndex("by_collection_status_score", (q) => q.eq("collectionId", args.collectionId).eq("status", status))
      .order("desc").paginate({ cursor: args.cursor ?? null, numItems: limit });
    return {
      runs: page.page.filter((row) => row.userId === args.userId && isVisible(row, args, args.allowOwnerWide)),
      continueCursor: page.continueCursor, isDone: page.isDone,
    };
  },
});

export const getCollectionStatsInternal = internalQuery({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections") },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    const shards = await ctx.db.query("crystalResearchCounterShards")
      .withIndex("by_user_collection", (q) => q.eq("userId", args.userId).eq("collectionId", args.collectionId)).take(64);
    const totals = { sources: 0, artifacts: 0, items: 0, variants: 0, datasets: 0, runs: 0, jobs: 0, rejected: 0, quarantined: 0, artifactBytes: 0 };
    for (const shard of shards) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += shard[key] ?? 0;
    return { collection, totals, shardCount: shards.length };
  },
});

export const requireCollectionInternal = internalQuery({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections") },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    return { collectionId: collection._id };
  },
});

export const getCollectionStats = query({
  args: { collectionId: v.id("crystalResearchCollections") },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const collection = await requireCollection(ctx, userId, args.collectionId);
    const shards = await ctx.db.query("crystalResearchCounterShards")
      .withIndex("by_user_collection", (q) => q.eq("userId", userId).eq("collectionId", args.collectionId)).take(64);
    const totals = { sources: 0, artifacts: 0, items: 0, variants: 0, datasets: 0, runs: 0, jobs: 0, rejected: 0, quarantined: 0, artifactBytes: 0 };
    for (const shard of shards) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += shard[key] ?? 0;
    return { collection, totals, shardCount: shards.length };
  },
});

async function createJobImpl(ctx: any, args: any) {
  const collection = await requireCollection(ctx, args.userId, args.collectionId);
  const existing = await ctx.db.query("crystalResearchJobs")
    .withIndex("by_collection_idempotency", (q: any) => q.eq("collectionId", args.collectionId).eq("idempotencyKey", args.idempotencyKey)).first();
  if (existing) return { jobId: existing._id, created: false };
  const now = Date.now();
  const jobId = await ctx.db.insert("crystalResearchJobs", {
    userId: args.userId, collectionId: args.collectionId, ...scopeFromCollection(collection),
    jobType: normalizedString(args.jobType, "jobType", 100),
    idempotencyKey: normalizedString(args.idempotencyKey, "idempotencyKey", 500),
    manifestJson: parseJsonObject(args.manifestJson, "manifestJson"),
    status: "queued", totalCount: Math.max(0, Math.trunc(args.totalCount)),
    preparedCount: 0, importedCount: 0, rejectedCount: 0, quarantinedCount: 0, failedCount: 0,
    createdAt: now, updatedAt: now,
  });
  await bumpCounter(ctx, args.userId, args.collectionId, "jobs", args.idempotencyKey);
  return { jobId, created: true };
}

export const createJobInternal = internalMutation({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), jobType: v.string(), idempotencyKey: v.string(), manifestJson: v.string(), totalCount: v.number() },
  handler: createJobImpl,
});

export const enqueueShardInternal = internalMutation({
  args: { userId: v.string(), jobId: v.id("crystalResearchJobs"), shardKey: v.string(), ordinal: v.number(), totalCount: v.number(), maxAttempts: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== args.userId) throw new Error("Research job not found");
    const existing = await ctx.db.query("crystalResearchJobShards")
      .withIndex("by_job_shard", (q) => q.eq("jobId", args.jobId).eq("shardKey", args.shardKey)).first();
    if (existing) return { shardId: existing._id, created: false };
    const now = Date.now();
    const shardId = await ctx.db.insert("crystalResearchJobShards", {
      userId: args.userId, collectionId: job.collectionId, jobId: args.jobId,
      shardKey: normalizedString(args.shardKey, "shardKey", 500), ordinal: Math.trunc(args.ordinal), status: "queued",
      attempts: 0, maxAttempts: Math.min(Math.max(Math.trunc(args.maxAttempts ?? 5), 1), 20),
      progressCount: 0, totalCount: Math.max(0, Math.trunc(args.totalCount)), createdAt: now, updatedAt: now,
    });
    return { shardId, created: true };
  },
});

export const claimShardInternal = internalMutation({
  args: { userId: v.string(), jobId: v.id("crystalResearchJobs"), workerId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== args.userId) throw new Error("Research job not found");
    if (job.status === "paused" || job.status === "cancelled" || job.status === "completed" || job.status === "dead_letter") return null;
    let shard = await ctx.db.query("crystalResearchJobShards")
      .withIndex("by_job_status_ordinal", (q) => q.eq("jobId", args.jobId).eq("status", "queued")).first();
    if (!shard) {
      const leased = await ctx.db.query("crystalResearchJobShards")
        .withIndex("by_job_status_ordinal", (q) => q.eq("jobId", args.jobId).eq("status", "leased")).take(100);
      shard = leased.find((candidate) => (candidate.leaseExpiresAt ?? 0) <= Date.now()) ?? null;
    }
    if (!shard) return null;
    const now = Date.now();
    const attempts = shard.attempts + 1;
    if (attempts > shard.maxAttempts) {
      await ctx.db.patch(shard._id, { status: "dead_letter", lastError: "maximum attempts exceeded", updatedAt: now });
      await ctx.db.patch(args.jobId, { status: "dead_letter", lastError: "one or more shards exhausted retries", updatedAt: now });
      return null;
    }
    const leaseMs = Math.min(Math.max(Math.trunc(args.leaseMs ?? 60_000), 5_000), 15 * 60_000);
    await ctx.db.patch(shard._id, { status: "leased", leaseOwner: args.workerId, leaseExpiresAt: now + leaseMs, heartbeatAt: now, attempts, updatedAt: now });
    if (job.status === "queued") await ctx.db.patch(job._id, { status: "running", updatedAt: now });
    return { ...shard, status: "leased", leaseOwner: args.workerId, leaseExpiresAt: now + leaseMs, attempts };
  },
});

export const heartbeatShardInternal = internalMutation({
  args: { userId: v.string(), shardId: v.id("crystalResearchJobShards"), workerId: v.string(), progressCount: v.number(), cursor: v.optional(v.string()), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const shard = await ctx.db.get(args.shardId);
    if (!shard || shard.userId !== args.userId || shard.status !== "leased" || shard.leaseOwner !== args.workerId) throw new Error("Research shard lease not held by worker");
    const now = Date.now();
    const leaseMs = Math.min(Math.max(Math.trunc(args.leaseMs ?? 60_000), 5_000), 15 * 60_000);
    await ctx.db.patch(args.shardId, { progressCount: Math.max(shard.progressCount, Math.trunc(args.progressCount)), cursor: args.cursor, heartbeatAt: now, leaseExpiresAt: now + leaseMs, updatedAt: now });
    return { ok: true, leaseExpiresAt: now + leaseMs };
  },
});

export const completeShardInternal = internalMutation({
  args: {
    userId: v.string(), shardId: v.id("crystalResearchJobShards"), workerId: v.string(),
    importedCount: v.number(), rejectedCount: v.number(), quarantinedCount: v.number(), failedCount: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const shard = await ctx.db.get(args.shardId);
    if (!shard || shard.userId !== args.userId || shard.status !== "leased" || shard.leaseOwner !== args.workerId) throw new Error("Research shard lease not held by worker");
    const job = await ctx.db.get(shard.jobId);
    if (!job || job.userId !== args.userId) throw new Error("Research job not found");
    const now = Date.now();
    const terminalStatus = args.error ? (shard.attempts >= shard.maxAttempts ? "dead_letter" : "queued") : "completed";
    await ctx.db.patch(args.shardId, { status: terminalStatus, progressCount: Math.min(shard.totalCount, args.importedCount + args.rejectedCount + args.quarantinedCount + args.failedCount), leaseOwner: undefined, leaseExpiresAt: undefined, lastError: args.error, updatedAt: now });
    await ctx.db.patch(job._id, {
      importedCount: job.importedCount + Math.max(0, Math.trunc(args.importedCount)),
      rejectedCount: job.rejectedCount + Math.max(0, Math.trunc(args.rejectedCount)),
      quarantinedCount: job.quarantinedCount + Math.max(0, Math.trunc(args.quarantinedCount)),
      failedCount: job.failedCount + Math.max(0, Math.trunc(args.failedCount)),
      lastError: args.error, status: terminalStatus === "dead_letter" ? "dead_letter" : job.status, updatedAt: now,
    });
    if (terminalStatus === "completed") {
      const [queued, leased] = await Promise.all([
        ctx.db.query("crystalResearchJobShards").withIndex("by_job_status_ordinal", (q) => q.eq("jobId", shard.jobId).eq("status", "queued")).first(),
        ctx.db.query("crystalResearchJobShards").withIndex("by_job_status_ordinal", (q) => q.eq("jobId", shard.jobId).eq("status", "leased")).first(),
      ]);
      if (!queued && !leased && job.status !== "dead_letter") await ctx.db.patch(job._id, { status: "completed", updatedAt: now });
    }
    return { status: terminalStatus };
  },
});

export const setJobStateInternal = internalMutation({
  args: { userId: v.string(), jobId: v.id("crystalResearchJobs"), state: v.union(v.literal("paused"), v.literal("queued"), v.literal("cancelled")) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== args.userId) throw new Error("Research job not found");
    await ctx.db.patch(job._id, { status: args.state, updatedAt: Date.now() });
    return { ok: true };
  },
});

export const getJobStatusInternal = internalQuery({
  args: { userId: v.string(), jobId: v.id("crystalResearchJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== args.userId) return null;
    return job;
  },
});

export const getOperationsDashboard = query({
  args: { collectionId: v.id("crystalResearchCollections") },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const collection = await requireCollection(ctx, userId, args.collectionId);
    const [shards, queued, running, failed, deadLetters, candidates, rollups, capacity] = await Promise.all([
      ctx.db.query("crystalResearchCounterShards").withIndex("by_user_collection", (q) => q.eq("userId", userId).eq("collectionId", args.collectionId)).take(64),
      ctx.db.query("crystalResearchJobs").withIndex("by_collection_status_updated", (q) => q.eq("collectionId", args.collectionId).eq("status", "queued")).order("desc").take(20),
      ctx.db.query("crystalResearchJobs").withIndex("by_collection_status_updated", (q) => q.eq("collectionId", args.collectionId).eq("status", "running")).order("desc").take(20),
      ctx.db.query("crystalResearchJobs").withIndex("by_collection_status_updated", (q) => q.eq("collectionId", args.collectionId).eq("status", "failed")).order("desc").take(20),
      ctx.db.query("crystalResearchJobs").withIndex("by_collection_status_updated", (q) => q.eq("collectionId", args.collectionId).eq("status", "dead_letter")).order("desc").take(20),
      ctx.db.query("crystalResearchRuns").withIndex("by_collection_status_score", (q) => q.eq("collectionId", args.collectionId).eq("status", "completed")).order("desc").take(20),
      ctx.db.query("crystalResearchRollups").withIndex("by_collection_dimension_score", (q) => q.eq("collectionId", args.collectionId).eq("dimensionType", "survival_funnel")).order("desc").take(20),
      getCapacityPolicyForUser(ctx, userId),
    ]);
    const totals = { sources: 0, artifacts: 0, items: 0, variants: 0, datasets: 0, runs: 0, jobs: 0, rejected: 0, quarantined: 0, artifactBytes: 0 };
    for (const shard of shards) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += shard[key] ?? 0;
    return {
      collection,
      totals,
      capacity,
      jobs: [...running, ...queued, ...failed, ...deadLetters]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 30),
      queueDepth: queued.reduce((sum, job) => sum + Math.max(0, job.totalCount - job.importedCount - job.rejectedCount - job.quarantinedCount - job.failedCount), 0),
      retries: [...running, ...queued].reduce((sum, job) => sum + job.failedCount, 0),
      deadLetterCount: deadLetters.length,
      candidates,
      survivalFunnel: rollups,
      lastBackupAt: null,
      lastRestoreVerifiedAt: null,
    };
  },
});

export const getTraceInternal = internalQuery({
  args: { userId: v.string(), runId: v.id("crystalResearchRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.userId !== args.userId) return null;
    const [item, variant, dataset] = await Promise.all([ctx.db.get(run.itemId), ctx.db.get(run.variantId), ctx.db.get(run.datasetId)]);
    if (!item || !variant || !dataset || item.userId !== args.userId || variant.userId !== args.userId || dataset.userId !== args.userId) return null;
    const sources = await Promise.all(item.sourceIds.map((id) => ctx.db.get(id)));
    const artifacts = await Promise.all(run.artifactIds.map((id) => ctx.db.get(id)));
    return {
      run, item, variant, dataset,
      sources: sources.filter((row) => row?.userId === args.userId).map(({ storageId: _storageId, ...row }: any) => row),
      artifacts: artifacts.filter((row) => row?.userId === args.userId).map(({ storageId: _storageId, ...row }: any) => row),
    };
  },
});

export const getPromotionContextInternal = internalQuery({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), itemId: v.id("crystalResearchItems"), runId: v.id("crystalResearchRuns"), datasetId: v.id("crystalResearchDatasets"), knowledgeBaseId: v.optional(v.id("knowledgeBases")) },
  handler: async (ctx, args) => {
    const collection = await requireCollection(ctx, args.userId, args.collectionId);
    const [item, run, dataset, knowledgeBase] = await Promise.all([
      ctx.db.get(args.itemId), ctx.db.get(args.runId), ctx.db.get(args.datasetId), args.knowledgeBaseId ? ctx.db.get(args.knowledgeBaseId) : null,
    ]);
    if (!item || !run || !dataset || item.userId !== args.userId || run.userId !== args.userId || dataset.userId !== args.userId) throw new Error("Promotion lineage not found");
    if (item.collectionId !== args.collectionId || run.collectionId !== args.collectionId || dataset.collectionId !== args.collectionId) throw new Error("Promotion lineage crosses collection boundary");
    if (run.itemId !== item._id || run.datasetId !== dataset._id) throw new Error("Promotion evidence does not match the run lineage");
    if (item.reviewStatus !== "qualified" || item.securityStatus !== "clean" || run.status !== "completed" || dataset.causalityStatus !== "valid") throw new Error("Promotion evidence has not passed qualification, security, completion, and causality gates");
    if (knowledgeBase && knowledgeBase.userId !== args.userId) throw new Error("Knowledge base not found");
    const sources = await Promise.all(item.sourceIds.map((id: any) => ctx.db.get(id)));
    if (sources.some((source: any) => !source || source.userId !== args.userId || source.licenseDisposition !== "acceptable" || source.securityDisposition !== "clean" || source.quarantineState !== "released")) {
      throw new Error("Promotion source lineage contains unapproved license or security disposition");
    }
    return { collection, item, run, dataset, knowledgeBase, sources };
  },
});

export const writePromotionInternal = internalMutation({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"), itemId: v.id("crystalResearchItems"),
    runId: v.id("crystalResearchRuns"), datasetId: v.id("crystalResearchDatasets"), knowledgeBaseId: v.id("knowledgeBases"),
    memoryId: v.id("crystalMemories"), dedupeKey: v.string(), reason: v.string(), lineageJson: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("crystalResearchPromotions")
      .withIndex("by_collection_dedupe", (q) => q.eq("collectionId", args.collectionId).eq("dedupeKey", args.dedupeKey)).first();
    const now = Date.now();
    const row = { itemId: args.itemId, runId: args.runId, datasetId: args.datasetId, knowledgeBaseId: args.knowledgeBaseId, memoryId: args.memoryId, status: "promoted" as const, reason: args.reason, paperTradingState: "eligible" as const, lineageJson: args.lineageJson, updatedAt: now };
    if (existing) {
      await ctx.db.patch(existing._id, row);
      return existing._id;
    }
    return ctx.db.insert("crystalResearchPromotions", { userId: args.userId, collectionId: args.collectionId, dedupeKey: args.dedupeKey, ...row, createdAt: now });
  },
});

export const getActivePromotionByDedupeInternal = internalQuery({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), dedupeKey: v.string() },
  handler: async (ctx, args) => {
    const promotion = await ctx.db.query("crystalResearchPromotions")
      .withIndex("by_collection_dedupe", (q) => q.eq("collectionId", args.collectionId).eq("dedupeKey", args.dedupeKey))
      .first();
    if (!promotion || promotion.userId !== args.userId || promotion.status !== "promoted" || !promotion.memoryId) return null;
    const [knowledgeBase, memory] = await Promise.all([
      ctx.db.get(promotion.knowledgeBaseId),
      ctx.db.get(promotion.memoryId),
    ]);
    if (!knowledgeBase || knowledgeBase.userId !== args.userId || !knowledgeBase.isActive) return null;
    if (!memory || memory.userId !== args.userId || memory.archived === true) return null;
    return promotion;
  },
});

async function promoteImpl(ctx: any, args: any): Promise<{
  promotionId: Id<"crystalResearchPromotions">;
  knowledgeBaseId: Id<"knowledgeBases">;
  memoryId: Id<"crystalMemories">;
  dedupeKey: string;
}> {
  const context: any = await ctx.runQuery((internal as any).crystal.research.getPromotionContextInternal, {
    userId: args.userId,
    collectionId: args.collectionId,
    itemId: args.itemId,
    runId: args.runId,
    datasetId: args.datasetId,
    knowledgeBaseId: args.knowledgeBaseId,
  });
  const dedupeKey = `research:${String(args.itemId)}:${String(args.runId)}`;
  const existing: any = await ctx.runQuery((internal as any).crystal.research.getActivePromotionByDedupeInternal, {
    userId: args.userId,
    collectionId: args.collectionId,
    dedupeKey,
  });
  if (existing?.memoryId) {
    return {
      promotionId: existing._id,
      knowledgeBaseId: existing.knowledgeBaseId,
      memoryId: existing.memoryId,
      dedupeKey,
    };
  }
  let knowledgeBaseId = args.knowledgeBaseId as Id<"knowledgeBases"> | undefined;
  if (!knowledgeBaseId) {
    knowledgeBaseId = await ctx.runMutation(internal.crystal.knowledgeBases.createKnowledgeBaseInternal, {
      userId: args.userId,
      name: `Research: ${context.collection.name}`,
      description: `Curated, qualified findings promoted from research collection ${String(args.collectionId)}.`,
      agentIds: context.collection.agentId ? [context.collection.agentId] : undefined,
      scope: context.collection.channel,
      sourceType: "research_promotion",
      sourceRole: "canonical_reference",
      peerScopePolicy: "strict",
    });
  }
  if (!knowledgeBaseId) throw new Error("Knowledge base promotion target was not created");
  const lineage = {
    collectionId: String(args.collectionId), itemId: String(args.itemId), runId: String(args.runId), datasetId: String(args.datasetId),
    runSpecHash: context.run.runSpecHash, datasetChecksum: context.dataset.checksum,
    sourceIds: context.sources.map((source: any) => String(source._id)),
    sourceContentHashes: context.sources.map((source: any) => source.contentHash),
    metrics: JSON.parse(context.run.metricsJson), costs: JSON.parse(context.run.costAssumptionsJson),
  };
  const card: string = `${context.item.strategyCard}\n\nResearch evidence (informational):\n${JSON.stringify(lineage, null, 2)}`;
  const inserted: { memoryId: Id<"crystalMemories"> } = await ctx.runMutation(internal.crystal.knowledgeBases.insertKnowledgeBaseChunkInternal, {
    userId: args.userId, knowledgeBaseId, content: card,
    metadata: { sourceType: "research_promotion" }, isKbParent: true, dedupeKey,
  });
  const promotionId: Id<"crystalResearchPromotions"> = await ctx.runMutation((internal as any).crystal.research.writePromotionInternal, {
    ...args, knowledgeBaseId, memoryId: inserted.memoryId, dedupeKey,
    reason: normalizedString(args.reason, "reason", 2_000), lineageJson: JSON.stringify(lineage),
  });
  return { promotionId, knowledgeBaseId, memoryId: inserted.memoryId, dedupeKey };
}

export const promoteInternal: any = internalAction({
  args: { userId: v.string(), collectionId: v.id("crystalResearchCollections"), itemId: v.id("crystalResearchItems"), runId: v.id("crystalResearchRuns"), datasetId: v.id("crystalResearchDatasets"), knowledgeBaseId: v.optional(v.id("knowledgeBases")), reason: v.string() },
  handler: promoteImpl,
});

export const promote = action({
  args: { collectionId: v.id("crystalResearchCollections"), itemId: v.id("crystalResearchItems"), runId: v.id("crystalResearchRuns"), datasetId: v.id("crystalResearchDatasets"), knowledgeBaseId: v.optional(v.id("knowledgeBases")), reason: v.string() },
  handler: async (ctx, args) => promoteImpl(ctx, { ...args, userId: await authenticatedUserId(ctx) }),
});

export const demoteInternal = internalMutation({
  args: { userId: v.string(), promotionId: v.id("crystalResearchPromotions"), reason: v.string() },
  handler: async (ctx, args) => {
    const promotion = await ctx.db.get(args.promotionId);
    if (!promotion || promotion.userId !== args.userId) throw new Error("Research promotion not found");
    if (promotion.memoryId) {
      await ctx.runMutation(internal.crystal.knowledgeBases.archiveKnowledgeBaseMemoryInternal, { memoryId: promotion.memoryId, archivedAt: Date.now() });
    }
    await ctx.db.patch(promotion._id, { status: "demoted", reason: normalizedString(args.reason, "reason", 2_000), paperTradingState: "stopped", updatedAt: Date.now() });
    return { ok: true };
  },
});

export const recordDurableFindingInternal: any = internalAction({
  args: {
    userId: v.string(), collectionId: v.id("crystalResearchCollections"),
    category: v.union(v.literal("decision"), v.literal("lesson"), v.literal("event")),
    title: v.string(), content: v.string(), channel: v.optional(v.string()), tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<Id<"crystalMemories">> => {
    await ctx.runQuery((internal as any).crystal.research.requireCollectionInternal, {
      userId: args.userId,
      collectionId: args.collectionId,
    });
    return ctx.runMutation(internal.crystal.memories.createMemoryInternal, {
      userId: args.userId, store: args.category === "event" ? "episodic" : "semantic", category: args.category,
      title: args.title, content: args.content,
      metadata: JSON.stringify({ researchCollectionId: String(args.collectionId) }), embedding: [],
      source: "external", channel: args.channel, tags: [...(args.tags ?? []), "research-plane"],
    });
  },
});
