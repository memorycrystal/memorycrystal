import { stableUserId } from "./auth";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { CHECKPOINT_LIMITS, type UserTier } from "../../shared/tierLimits";
import { deriveTier } from "./userProfiles";

const CHECKPOINT_SOURCE_VERSION = 1;
const CHECKPOINT_BYTE_LIMIT = 750_000;
const MAX_CONTENT_CHARS = 1200;
const FALLBACK_CONTENT_CHARS = 240;
const LEGACY_COMPAT_FETCH_LIMIT = 250;

const createInput = v.object({
  label: v.string(),
  description: v.optional(v.string()),
});

const scopedCreateInput = v.object({
  userId: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
  channel: v.optional(v.string()),
  sessionKey: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  createdVia: v.optional(v.union(v.literal("dashboard"), v.literal("mcp"), v.literal("seed"), v.literal("migration"))),
  memoryIds: v.optional(v.array(v.id("crystalMemories"))),
});

const normalizeText = (value: string | undefined, fallback = "") => {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
};

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

async function getTierForUser(ctx: any, userId: string): Promise<UserTier> {
  const profiles = await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
  const profile = profiles.sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  return deriveTier(profile);
}

const isUserMemoryCheckpoint = (checkpoint: any, userId: string) => {
  if (checkpoint.kind === "memory_checkpoint") return true;
  if (checkpoint.kind) return false;
  return checkpoint.createdBy === userId && Array.isArray(checkpoint.memorySnapshot) && checkpoint.memorySnapshot.length > 0;
};

async function listRetainedCheckpoints(ctx: any, userId: string) {
  const classified = await ctx.db
    .query("crystalCheckpoints")
    .withIndex("by_user_kind_created", (q: any) => q.eq("userId", userId).eq("kind", "memory_checkpoint").gte("createdAt", 0))
    .order("desc")
    .take(100);

  const legacy = await ctx.db
    .query("crystalCheckpoints")
    .withIndex("by_user", (q: any) => q.eq("userId", userId).gte("createdAt", 0))
    .order("desc")
    .take(LEGACY_COMPAT_FETCH_LIMIT);

  const byId = new Map<string, any>();
  for (const checkpoint of [...classified, ...legacy]) {
    if (isUserMemoryCheckpoint(checkpoint, userId)) byId.set(String(checkpoint._id), checkpoint);
  }

  return Array.from(byId.values())
    .sort((a, b) => b.createdAt - a.createdAt);
}

function shapeMemorySnapshotEntry(memory: any, sessionKey: string | undefined, maxContentChars: number) {
  return {
    memoryId: memory._id as Id<"crystalMemories">,
    title: String(memory.title ?? "").slice(0, 160),
    content: String(memory.content ?? "").slice(0, maxContentChars),
    store: memory.store,
    category: memory.category,
    source: memory.source,
    strength: memory.strength,
    tags: Array.isArray(memory.tags) ? memory.tags.slice(0, 12).map((tag: string) => String(tag).slice(0, 64)) : [],
    channel: memory.channel,
    sessionKey,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastAccessedAt: memory.lastAccessedAt,
  };
}

function buildBoundedSnapshot(memories: any[], sessionKey: string | undefined, entryCap: number) {
  const snapshot = [];
  for (const memory of memories.slice(0, entryCap)) {
    const fullEntry = shapeMemorySnapshotEntry(memory, sessionKey, MAX_CONTENT_CHARS);
    const fullCandidate = [...snapshot, fullEntry];
    if (byteLength(fullCandidate) <= CHECKPOINT_BYTE_LIMIT) {
      snapshot.push(fullEntry);
      continue;
    }

    const smallEntry = shapeMemorySnapshotEntry(memory, sessionKey, FALLBACK_CONTENT_CHARS);
    const smallCandidate = [...snapshot, smallEntry];
    if (byteLength(smallCandidate) <= CHECKPOINT_BYTE_LIMIT) {
      snapshot.push(smallEntry);
      continue;
    }

    break;
  }
  return snapshot;
}

async function selectMemoriesForCheckpoint(ctx: any, args: {
  userId: string;
  channel?: string;
  memoryIds?: Id<"crystalMemories">[];
  cap: number;
}) {
  if (args.memoryIds?.length) {
    const memories = [];
    for (const memoryId of args.memoryIds.slice(0, args.cap)) {
      const memory = await ctx.db.get(memoryId);
      if (!memory || memory.userId !== args.userId || memory.archived) continue;
      if (args.channel && memory.channel !== args.channel) continue;
      memories.push(memory);
    }
    return memories;
  }

  const query = args.channel
    ? ctx.db
      .query("crystalMemories")
      .withIndex("by_user_channel_archived_last_accessed", (q: any) =>
        q.eq("userId", args.userId).eq("channel", args.channel).eq("archived", false)
      )
    : ctx.db
      .query("crystalMemories")
      .withIndex("by_user_archived_last_accessed", (q: any) =>
        q.eq("userId", args.userId).eq("archived", false)
      );

  return await query.order("desc").take(args.cap);
}

async function createCheckpointForUser(ctx: any, args: {
  userId: string;
  label: string;
  description?: string;
  channel?: string;
  sessionKey?: string;
  tags?: string[];
  createdVia: "dashboard" | "mcp" | "seed" | "migration";
  memoryIds?: Id<"crystalMemories">[];
}) {
  const label = normalizeText(args.label);
  if (!label) throw new Error("label is required");

  const tier = await getTierForUser(ctx, args.userId);
  const limits = CHECKPOINT_LIMITS[tier];
  const retained = await listRetainedCheckpoints(ctx, args.userId);
  if (retained.length >= limits.retainedCheckpoints) {
    throw new Error(`Checkpoint allowance reached (${retained.length}/${limits.retainedCheckpoints}). Delete an older checkpoint or upgrade to retain more.`);
  }

  const memories = await selectMemoriesForCheckpoint(ctx, {
    userId: args.userId,
    channel: args.channel,
    memoryIds: args.memoryIds,
    cap: limits.memorySnapshotEntries,
  });
  const snapshot = buildBoundedSnapshot(memories, args.sessionKey, limits.memorySnapshotEntries);
  const summary = snapshot
    .slice(0, 3)
    .map((entry) => `${entry.store}: ${(entry.title || entry.content).slice(0, 100)}`)
    .join("\n");
  const tags = Array.from(new Set((args.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean))).slice(0, 12);
  const id = await ctx.db.insert("crystalCheckpoints", {
    userId: args.userId,
    label,
    description: args.description,
    createdAt: Date.now(),
    createdBy: args.userId,
    channel: args.channel,
    sessionKey: args.sessionKey,
    memorySnapshot: snapshot,
    semanticSummary: summary || args.description || label,
    tags,
    kind: "memory_checkpoint",
    createdVia: args.createdVia,
    memoryCount: snapshot.length,
    snapshotCap: limits.memorySnapshotEntries,
    snapshotByteLimit: CHECKPOINT_BYTE_LIMIT,
    sourceVersion: CHECKPOINT_SOURCE_VERSION,
  });

  return {
    id,
    checkpointId: id,
    memoryCount: snapshot.length,
    allowance: limits.retainedCheckpoints,
    retainedCount: retained.length + 1,
    snapshotCap: limits.memorySnapshotEntries,
    snapshotByteLimit: CHECKPOINT_BYTE_LIMIT,
    tier,
  };
}

export const createCheckpoint = mutation({
  args: createInput,
  handler: async (ctx, { label, description }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    return await createCheckpointForUser(ctx, {
      userId,
      label,
      description,
      createdVia: "dashboard",
    });
  },
});

export const createCheckpointForUserInternal = internalMutation({
  args: scopedCreateInput,
  handler: async (ctx, args) => {
    return await createCheckpointForUser(ctx, {
      userId: args.userId,
      label: args.label,
      description: args.description,
      channel: args.channel,
      sessionKey: args.sessionKey,
      tags: args.tags,
      createdVia: args.createdVia ?? "mcp",
      memoryIds: args.memoryIds,
    });
  },
});

export const getCheckpoint = query({
  args: { checkpointId: v.id("crystalCheckpoints") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const checkpoint = await ctx.db.get(args.checkpointId);
    if (!checkpoint || checkpoint.userId !== stableUserId(identity.subject)) return null;
    return checkpoint;
  },
});

export const listCheckpoints = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const tier = await getTierForUser(ctx, userId);
    const limits = CHECKPOINT_LIMITS[tier];
    const retained = await listRetainedCheckpoints(ctx, userId);
    const checkpoints = retained.slice(0, Math.min(Math.max(limit ?? 50, 1), 100));
    return {
      checkpoints,
      allowance: limits.retainedCheckpoints,
      retainedCount: retained.length,
      snapshotCap: limits.memorySnapshotEntries,
      snapshotByteLimit: CHECKPOINT_BYTE_LIMIT,
      tier,
      atLimit: retained.length >= limits.retainedCheckpoints,
    };
  },
});

export const deleteCheckpoint = mutation({
  args: { checkpointId: v.id("crystalCheckpoints") },
  handler: async (ctx, { checkpointId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const checkpoint = await ctx.db.get(checkpointId);
    if (!checkpoint || checkpoint.userId !== userId) throw new Error("Checkpoint not found");
    await ctx.db.delete(checkpointId);
    return { ok: true, checkpointId };
  },
});

export const listCheckpointsForUserInternal = internalQuery({
  args: {
    userId: v.string(),
    limit: v.number(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
  },
  handler: async (ctx, { userId, limit, channel, sessionKey }) => {
    const tier = await getTierForUser(ctx, userId);
    const limits = CHECKPOINT_LIMITS[tier];
    const retained = await listRetainedCheckpoints(ctx, userId);
    const checkpoints = retained
      .filter((checkpoint: any) =>
        (!channel || checkpoint.channel === channel) &&
        (!sessionKey || checkpoint.sessionKey === sessionKey)
      )
      .slice(0, Math.min(Math.max(limit, 1), 100));
    return {
      checkpoints,
      allowance: limits.retainedCheckpoints,
      retainedCount: retained.length,
      snapshotCap: limits.memorySnapshotEntries,
      snapshotByteLimit: CHECKPOINT_BYTE_LIMIT,
      tier,
      atLimit: retained.length >= limits.retainedCheckpoints,
    };
  },
});
