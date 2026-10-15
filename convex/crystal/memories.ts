import { stableUserId } from "./auth";
import { agentStampKey, preservedMetadataOrThrow } from "./agentStamp";
import { findSameStampExactDuplicate } from "./exactDuplicate";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
  buildMemoryTransitionDelta,
  buildStrengthDelta,
} from "./publicDashboardTotals";
import { scanMemoryContent } from "./contentScanner";
import { sha256Hex } from "./crypto";
import { buildMemoryHashInput } from "./contentHash";
import { deriveTier } from "./publicUserProfiles";
import { rawContentExpiresAt, resolveSensoryRawTtlDays } from "./retention";
import { reinforceOnRecall } from "./decayModel";
import { deleteMemoryVector, upsertMemoryVector } from "./memoryVectors";
import { scheduleMemoryEmbedding } from "./embedRetry";
import {
  archiveMemoryAndSyncCleanupProjection,
  deleteCleanupProjectionForMemory,
  patchMemoryAndSyncCleanupProjection,
} from "./cleanupProjection";

const nowMs = () => Date.now();

function shouldScheduleMemoryBackgroundWork() {
  return !(typeof process !== "undefined" && process.env.VITEST);
}

const memoryStore = v.union(
  v.literal("sensory"),
  v.literal("episodic"),
  v.literal("semantic"),
  v.literal("procedural"),
  v.literal("prospective")
);

const memoryCategory = v.union(
  v.literal("decision"),
  v.literal("lesson"),
  v.literal("person"),
  v.literal("rule"),
  v.literal("event"),
  v.literal("fact"),
  v.literal("goal"),
  v.literal("skill"),
  v.literal("workflow"),
  v.literal("conversation")
);

const memorySource = v.union(
  v.literal("conversation"),
  v.literal("cron"),
  v.literal("observation"),
  v.literal("inference"),
  v.literal("external")
);

const createMemoryInput = v.object({
  store: memoryStore,
  category: memoryCategory,
  title: v.string(),
  content: v.string(),
  metadata: v.optional(v.string()),
  embedding: v.array(v.float64()),
  strength: v.optional(v.float64()),
  confidence: v.optional(v.float64()),
  valence: v.optional(v.float64()),
  arousal: v.optional(v.float64()),
  source: v.optional(memorySource),
  sessionId: v.optional(v.id("crystalSessions")),
  channel: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  archived: v.optional(v.boolean()),
  archivedAt: v.optional(v.number()),
  promotedFrom: v.optional(v.id("crystalMemories")),
  checkpointId: v.optional(v.id("crystalCheckpoints")),
});

const createMemoryInternalInput = v.object({
  ...createMemoryInput.fields,
  actionTriggers: v.optional(v.array(v.string())),
  userId: v.string(),
});

const memoryListInput = v.object({
  store: v.optional(memoryStore),
  category: v.optional(memoryCategory),
  channel: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  archived: v.optional(v.boolean()),
  minStrength: v.optional(v.float64()),
  maxStrength: v.optional(v.float64()),
  limit: v.optional(v.number()),
});

const updateMemoryInput = v.object({
  memoryId: v.id("crystalMemories"),
  store: v.optional(memoryStore),
  category: v.optional(memoryCategory),
  title: v.optional(v.string()),
  content: v.optional(v.string()),
  metadata: v.optional(v.string()),
  strength: v.optional(v.float64()),
  confidence: v.optional(v.float64()),
  valence: v.optional(v.float64()),
  arousal: v.optional(v.float64()),
  tags: v.optional(v.array(v.string())),
  actionTriggers: v.optional(v.array(v.string())),
  source: v.optional(memorySource),
  channel: v.optional(v.string()),
  archived: v.optional(v.boolean()),
  archivedAt: v.optional(v.number()),
  promotedFrom: v.optional(v.id("crystalMemories")),
  checkpointId: v.optional(v.id("crystalCheckpoints")),
});

const forgetMemoryInput = v.object({
  memoryId: v.id("crystalMemories"),
  permanent: v.optional(v.boolean()),
  reason: v.optional(v.string()),
});

const dedupeTags = (tags: string[]): string[] => {
  const normalized = tags
    .map((tag) => tag.trim())
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag.length > 0);
  return Array.from(new Set(normalized));
};

// ILL-108 G2 — compute coreTier from tags at write time. case-insensitive "core" → true.
function computeCoreTier(tags: string[]): boolean {
  return tags.some((tag) => tag.toLowerCase() === "core");
}

const normalizeActionTriggers = (triggers?: string[]): string[] =>
  Array.from(
    new Set(
      (triggers ?? [])
        .map((trigger) => trigger.trim())
        .filter((trigger) => trigger.length > 0)
    )
  );

async function deleteMemoryTriggerRows(ctx: any, memoryId: any) {
  const rows = await ctx.db
    .query("crystalMemoryTriggers")
    .withIndex("by_memory", (q: any) => q.eq("memoryId", memoryId))
    .collect();
  await Promise.all(rows.map((row: any) => ctx.db.delete(row._id)));
}

async function replaceMemoryTriggerRows(
  ctx: any,
  userId: string,
  memoryId: any,
  triggers?: string[],
  lastAccessedAt?: number
) {
  await deleteMemoryTriggerRows(ctx, memoryId);
  const normalized = normalizeActionTriggers(triggers);
  if (normalized.length === 0) return;

  const now = nowMs();
  await Promise.all(
    normalized.map((toolName) =>
      ctx.db.insert("crystalMemoryTriggers", {
        userId,
        memoryId,
        toolName,
        lastAccessedAt: lastAccessedAt ?? now,
        createdAt: now,
      })
    )
  );
}

async function scheduleNewMemoryNearDedupe(ctx: any, memoryId: any, archived: boolean) {
  if (archived || !shouldScheduleMemoryBackgroundWork()) return;
  await scheduleMemoryEmbedding(ctx, memoryId);
}

async function scheduleMemoryDerivedRefresh(ctx: any, memoryId: any, userId: string, store?: string) {
  if (!shouldScheduleMemoryBackgroundWork()) return;
  await scheduleMemoryEmbedding(ctx, memoryId);
  await ctx.scheduler.runAfter(50, internal.crystal.salience.computeAndStoreSalience, { memoryId });
  void userId;
  void store;
}

async function getSensoryRawRetentionFields(ctx: any, userId: string, store: string, createdAt: number) {
  if (store !== "sensory") {
    return { embeddingSource: "raw" as const };
  }
  const profiles = await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
  const profile = profiles.sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const tier = deriveTier(profile);
  const ttlDays = resolveSensoryRawTtlDays(tier, profile?.sensoryRawTtlDaysOverride ?? null);
  return {
    rawContentExpiresAt: rawContentExpiresAt(createdAt, ttlDays),
    rawRetentionState: "raw" as const,
    sensoryRawTtlDaysApplied: ttlDays,
    embeddingSource: "raw" as const,
  };
}

// ILL-11 — exact-duplicate lookup shared by both create paths. Primary:
// contentHash via by_user_content_hash_channel (same hash semantics as the
// remember/capsule/extraction paths). Fallback: the legacy title+content scan,
// which still catches rows written before the contentHash backfill completes.
// Channel scoping is EXACT in both passes (undefined only matches undefined) —
// merging across channel scopes is how client data leaks (2026-07-02).
async function findExactDuplicateMemory(
  ctx: any,
  args: {
    userId: string;
    store: string;
    category: string;
    title: string;
    content: string;
    channel?: string;
    source: string;
    contentHash: string;
    stampKey: string | null;
  },
) {
  const hashed = await findSameStampExactDuplicate(ctx, {
    userId: args.userId,
    contentHash: args.contentHash,
    channel: args.channel,
    stampKey: args.stampKey,
  });
  if (hashed) return hashed;

  const candidates = await ctx.db
    .query("crystalMemories")
    .withIndex("by_store_category_title", (q: any) =>
      q
        .eq("userId", args.userId)
        .eq("store", args.store)
        .eq("category", args.category)
        .eq("archived", false)
        .eq("title", args.title)
    )
    .take(5);
  return (
    candidates.find(
      (memory: any) =>
        memory.content === args.content &&
        (memory.channel ?? null) === (args.channel ?? null) &&
        memory.source === args.source &&
        agentStampKey(memory.metadata) === args.stampKey
    ) ?? null
  );
}

export const createMemory = mutation({
  args: createMemoryInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const titleScanResult = scanMemoryContent(args.title);
    if (!titleScanResult.allowed) {
      throw new Error(`Memory blocked: ${titleScanResult.reason} [${titleScanResult.threatId}]`);
    }
    const scanResult = scanMemoryContent(args.content);
    if (!scanResult.allowed) {
      throw new Error(`Memory blocked: ${scanResult.reason} [${scanResult.threatId}]`);
    }

    const now = nowMs();

    const contentHash = await sha256Hex(
      buildMemoryHashInput({ store: args.store, category: args.category, content: args.content })
    );
    const duplicate = await findExactDuplicateMemory(ctx, {
      userId,
      store: args.store,
      category: args.category,
      title: args.title,
      content: args.content,
      channel: args.channel,
      source: args.source ?? "conversation",
      contentHash,
      stampKey: agentStampKey(args.metadata),
    });

    if (duplicate) {
      const existingTags = dedupeTags((duplicate.tags ?? []).concat(args.tags ?? []));
      const nextStrength = Math.max(duplicate.strength, args.strength ?? duplicate.strength);
      const nextCoreTier = computeCoreTier(existingTags);
      await patchMemoryAndSyncCleanupProjection(ctx, duplicate, {
        lastAccessedAt: now,
        confidence: args.confidence ?? duplicate.confidence,
        strength: nextStrength,
        valence: args.valence ?? duplicate.valence,
        arousal: args.arousal ?? duplicate.arousal,
        tags: existingTags,
        coreTier: nextCoreTier,
        // Backfill the hash on legacy rows the fallback pass matched.
        ...(duplicate.contentHash ? {} : { contentHash }),
      }, now);
      if (nextStrength !== duplicate.strength) {
        await applyDashboardTotalsDelta(
          ctx,
          userId,
          buildStrengthDelta(duplicate.strength, nextStrength),
        );
      }
      return duplicate._id;
    }

    const retentionFields = await getSensoryRawRetentionFields(ctx, userId, args.store, now);
    const deduplicatedTags = dedupeTags(args.tags ?? []);
    const memoryId = await ctx.db.insert("crystalMemories", {
      userId,
      store: args.store,
      category: args.category,
      title: args.title,
      content: args.content,
      metadata: args.metadata,
      contentHash,
      strength: args.strength ?? 1,
      confidence: args.confidence ?? 0.7,
      valence: args.valence ?? 0,
      arousal: args.arousal ?? 0.3,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      source: args.source ?? "conversation",
      sessionId: args.sessionId,
      channel: args.channel,
      tags: deduplicatedTags,
      coreTier: computeCoreTier(deduplicatedTags),
      actionTriggers: [],
      archived: args.archived ?? false,
      archivedAt: args.archivedAt,
      promotedFrom: args.promotedFrom,
      checkpointId: args.checkpointId,
      ...retentionFields,
    });
    // Legacy callers may still send an empty or test-sized inline vector. Only
    // a complete authoritative vector is persisted in v0.9.0.
    if (!(args.archived ?? false) && args.embedding.length === 3072) {
      await upsertMemoryVector(ctx, { memoryId, userId, embedding: args.embedding });
    }

    await applyDashboardTotalsDelta(
      ctx,
      userId,
      buildMemoryCreateDelta({
        store: args.store,
        archived: args.archived ?? false,
        title: args.title,
        memoryId,
        createdAt: now,
        strength: args.strength ?? 1,
      })
    );

    await scheduleNewMemoryNearDedupe(ctx, memoryId, args.archived ?? false);
    return memoryId;
  },
});

// Internal version for background jobs that pass userId explicitly
export const createMemoryInternal = internalMutation({
  args: createMemoryInternalInput,
  handler: async (ctx, args) => {
    const titleScanResult = scanMemoryContent(args.title);
    if (!titleScanResult.allowed) {
      throw new Error(`Memory blocked: ${titleScanResult.reason} [${titleScanResult.threatId}]`);
    }
    const scanResult = scanMemoryContent(args.content);
    if (!scanResult.allowed) {
      throw new Error(`Memory blocked: ${scanResult.reason} [${scanResult.threatId}]`);
    }

    const now = nowMs();
    const { userId, ...rest } = args;

    const contentHash = await sha256Hex(
      buildMemoryHashInput({ store: args.store, category: args.category, content: args.content })
    );
    const duplicate = await findExactDuplicateMemory(ctx, {
      userId,
      store: args.store,
      category: args.category,
      title: args.title,
      content: args.content,
      channel: args.channel,
      source: args.source ?? "conversation",
      contentHash,
      stampKey: agentStampKey(args.metadata),
    });

    if (duplicate) {
      const existingTags = dedupeTags((duplicate.tags ?? []).concat(args.tags ?? []));
      const nextActionTriggers =
        args.actionTriggers !== undefined
          ? normalizeActionTriggers(args.actionTriggers)
          : duplicate.actionTriggers;
      const nextStrength = Math.max(duplicate.strength, args.strength ?? duplicate.strength);
      const nextCoreTier = computeCoreTier(existingTags);
      await patchMemoryAndSyncCleanupProjection(ctx, duplicate, {
        lastAccessedAt: now,
        confidence: args.confidence ?? duplicate.confidence,
        strength: nextStrength,
        valence: args.valence ?? duplicate.valence,
        arousal: args.arousal ?? duplicate.arousal,
        tags: existingTags,
        coreTier: nextCoreTier,
        ...(duplicate.contentHash ? {} : { contentHash }),
        ...(args.actionTriggers !== undefined ? { actionTriggers: nextActionTriggers } : {}),
      }, now);
      if (nextStrength !== duplicate.strength) {
        await applyDashboardTotalsDelta(
          ctx,
          userId,
          buildStrengthDelta(duplicate.strength, nextStrength),
        );
      }
      if (args.actionTriggers !== undefined && !duplicate.archived) {
        await replaceMemoryTriggerRows(ctx, userId, duplicate._id, nextActionTriggers, now);
      }
      return duplicate._id;
    }

    const retentionFields = await getSensoryRawRetentionFields(ctx, userId, rest.store, now);
    const deduplicatedTags = dedupeTags(rest.tags ?? []);
    const memoryId = await ctx.db.insert("crystalMemories", {
      userId,
      store: rest.store,
      category: rest.category,
      title: rest.title,
      content: rest.content,
      metadata: rest.metadata,
      contentHash,
      strength: rest.strength ?? 1,
      confidence: rest.confidence ?? 0.7,
      valence: rest.valence ?? 0,
      arousal: rest.arousal ?? 0.3,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      source: rest.source ?? "conversation",
      sessionId: rest.sessionId,
      channel: rest.channel,
      tags: deduplicatedTags,
      coreTier: computeCoreTier(deduplicatedTags),
      actionTriggers: normalizeActionTriggers(rest.actionTriggers),
      archived: rest.archived ?? false,
      archivedAt: rest.archivedAt,
      promotedFrom: rest.promotedFrom,
      checkpointId: rest.checkpointId,
      ...retentionFields,
    });
    // An empty vector defers to the embedMemory job scheduled below. Any
    // non-empty vector must be complete; upsertMemoryVector rejects the rest.
    if (!(rest.archived ?? false) && rest.embedding.length > 0) {
      await upsertMemoryVector(ctx, { memoryId, userId, embedding: rest.embedding });
    }

    if (!(rest.archived ?? false)) {
      await replaceMemoryTriggerRows(ctx, userId, memoryId, rest.actionTriggers, now);
    }

    await applyDashboardTotalsDelta(
      ctx,
      userId,
      buildMemoryCreateDelta({
        store: rest.store,
        archived: rest.archived ?? false,
        title: rest.title,
        memoryId,
        createdAt: now,
        strength: rest.strength ?? 1,
      })
    );

    await scheduleNewMemoryNearDedupe(ctx, memoryId, rest.archived ?? false);
    return memoryId;
  },
});

export const listMemories = query({
  args: memoryListInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const requestedLimit = args.limit ?? 50;
    const normalizedLimit = Math.min(Math.max(requestedLimit, 1), 200);
    const hasStrengthBounds = args.minStrength !== undefined || args.maxStrength !== undefined;

    // Use by_user index as the base, filter further in memory
    const fetchBuffer = Math.min(normalizedLimit * 4, 800);
    let baseQuery;

    if (hasStrengthBounds) {
      const archived = args.archived ?? false;
      baseQuery = ctx.db
        .query("crystalMemories")
        .withIndex("by_user_strength", (q) => {
          let qb = q as any;
          qb = qb.eq("userId", userId).eq("archived", archived);
          if (args.minStrength !== undefined) qb = qb.gte("strength", args.minStrength);
          if (args.maxStrength !== undefined) qb = qb.lte("strength", args.maxStrength);
          return qb;
        });
    } else {
      baseQuery = ctx.db
        .query("crystalMemories")
        .withIndex("by_user", (q) => {
          const archived = args.archived ?? false;
          return q.eq("userId", userId).eq("archived", archived);
        });
    }

    const memories = await (baseQuery as any).take(fetchBuffer);

    const filtered = memories.filter((memory: any) => {
      if (args.store !== undefined && memory.store !== args.store) return false;
      if (args.category !== undefined && memory.category !== args.category) return false;
      if (args.channel !== undefined && memory.channel !== args.channel) return false;
      if (args.tags?.length && !args.tags.every((tag: string) => (memory.tags ?? []).includes(tag))) return false;
      if (args.archived !== undefined && memory.archived !== args.archived) return false;
      if (args.minStrength !== undefined && memory.strength < args.minStrength) return false;
      if (args.maxStrength !== undefined && memory.strength > args.maxStrength) return false;
      return true;
    });

    return filtered.sort((a: any, b: any) => b.lastAccessedAt - a.lastAccessedAt).slice(0, normalizedLimit);
  },
});

export const getMemory = query({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const memory = await ctx.db.get(args.memoryId);
    if (!memory || memory.userId !== stableUserId(identity.subject)) return null;
    return memory;
  },
});

// Internal get — no auth check, used by background jobs and recall action
export const getMemoryInternal = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.memoryId);
  },
});

export const updateMemoryAccess = mutation({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.userId !== stableUserId(identity.subject)) return null;
    const now = Date.now();
    const patch: Record<string, unknown> = {
      accessCount: existing.accessCount + 1,
      lastAccessedAt: now,
      lastRecalledAt: now,
    };
    await ctx.db.patch(args.memoryId, patch);
    if (!existing.archived) {
      await applyDashboardTotalsDelta(ctx, existing.userId, {
        activeRecallCountDelta: 1,
        activeRecalledMemoriesDelta: existing.accessCount === 0 ? 1 : 0,
      });
    }
    return ctx.db.get(args.memoryId);
  },
});

// Internal version for background jobs / actions (no auth check)
export const updateMemoryAccessInternal = internalMutation({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing) return null;
    const now = Date.now();
    // ILL-103 — reinforcement-on-recall. A memory that is actually recalled/used
    // is first decayed for its idle interval, then reinforced, so `strength`
    // tracks usefulness rather than write-recency. Bounded/diminishing toward
    // the 1.0 ceiling (see decayModel.reinforceOnRecall). This only fires here,
    // which recall calls exclusively for the memories it actually returns
    // (recall.ts:1162/1315), so candidates that are never surfaced are not
    // reinforced. KB-managed memories are exempt — their strength is governed by
    // the knowledge-base lifecycle (as they are exempt from decay archival too).
    const ageDays = Math.max(0, (now - (existing.lastAccessedAt ?? existing.createdAt)) / 86400000);
    const reinforcedStrength = existing.knowledgeBaseId
      ? existing.strength
      : reinforceOnRecall({
          strength: existing.strength,
          ageDays,
          accessCount: existing.accessCount,
          valence: existing.valence,
          arousal: existing.arousal,
          confidence: existing.confidence,
        });
    const patch: Record<string, unknown> = {
      accessCount: existing.accessCount + 1,
      lastAccessedAt: now,
      lastRecalledAt: now,
    };
    if (reinforcedStrength !== existing.strength) {
      patch.strength = reinforcedStrength;
    }
    await ctx.db.patch(args.memoryId, patch);
    if (!existing.archived) {
      await applyDashboardTotalsDelta(ctx, existing.userId, {
        activeRecallCountDelta: 1,
        activeRecalledMemoriesDelta: existing.accessCount === 0 ? 1 : 0,
        // M7 — reflect the reinforcement strength change in the dashboard aggregate.
        ...buildStrengthDelta(existing.strength, reinforcedStrength),
      });
    }
    return ctx.db.get(args.memoryId);
  },
});

export const updateMemoryAccessBatchInternal = internalMutation({
  args: { memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, args) => {
    let updated = 0;
    for (const memoryId of args.memoryIds.slice(0, 50)) {
      const existing = await ctx.db.get(memoryId);
      if (!existing) continue;
      const now = Date.now();
      const ageDays = Math.max(0, (now - (existing.lastAccessedAt ?? existing.createdAt)) / 86400000);
      const strength = existing.knowledgeBaseId ? existing.strength : reinforceOnRecall({ strength: existing.strength, ageDays, accessCount: existing.accessCount, valence: existing.valence, arousal: existing.arousal, confidence: existing.confidence });
      await ctx.db.patch(memoryId, { accessCount: existing.accessCount + 1, lastAccessedAt: now, lastRecalledAt: now, ...(strength !== existing.strength ? { strength } : {}) });
      if (!existing.archived) await applyDashboardTotalsDelta(ctx, existing.userId, { activeRecallCountDelta: 1, activeRecalledMemoriesDelta: existing.accessCount === 0 ? 1 : 0, ...buildStrengthDelta(existing.strength, strength) });
      updated += 1;
    }
    return { updated };
  },
});

export const updateMemory = mutation({
  args: updateMemoryInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.userId !== stableUserId(identity.subject)) return null;

    if (args.title !== undefined) {
      const scanResult = scanMemoryContent(args.title);
      if (!scanResult.allowed) {
        throw new Error(`Memory blocked: ${scanResult.reason} [${scanResult.threatId}]`);
      }
    }

    if (args.content !== undefined) {
      const scanResult = scanMemoryContent(args.content);
      if (!scanResult.allowed) {
        throw new Error(`Memory blocked: ${scanResult.reason} [${scanResult.threatId}]`);
      }
    }

    const previousArchived = Boolean(existing.archived);
    const previousStore = existing.store;
    const nextArchived = args.archived !== undefined ? args.archived : existing.archived;
    const contentChanged = args.content !== undefined && args.content !== existing.content;
    const titleChanged = args.title !== undefined && args.title !== existing.title;
    const restored = args.archived === false && existing.archived;
    const refreshDerived = !nextArchived && (contentChanged || titleChanged || restored);
    const nextStore = args.store !== undefined ? args.store : existing.store;
    const editNow = nowMs();

    const patch: Record<string, unknown> = {};
    if (args.store !== undefined) patch.store = args.store;
    if (args.category !== undefined) patch.category = args.category;
    if (args.title !== undefined) patch.title = args.title;
    if (args.content !== undefined) patch.content = args.content;
    if (args.metadata !== undefined) {
      patch.metadata = preservedMetadataOrThrow(existing.metadata, args.metadata);
    }
    if (args.strength !== undefined) patch.strength = args.strength;
    if (args.confidence !== undefined) patch.confidence = args.confidence;
    if (args.valence !== undefined) patch.valence = args.valence;
    if (args.arousal !== undefined) patch.arousal = args.arousal;
    if (args.tags !== undefined) {
      const deduplicatedTags = dedupeTags(args.tags);
      patch.tags = deduplicatedTags;
      // ILL-108 G2 — recompute coreTier when tags change. Add core → true, remove → undefined.
      const nextCoreTier = computeCoreTier(deduplicatedTags);
      patch.coreTier = nextCoreTier ? true : undefined;
    }
    if (args.source !== undefined) patch.source = args.source;
    if (args.channel !== undefined) patch.channel = args.channel;
    if (args.archived !== undefined) patch.archived = args.archived;
    if (args.archivedAt !== undefined) patch.archivedAt = args.archivedAt;
    if (args.actionTriggers !== undefined) patch.actionTriggers = normalizeActionTriggers(args.actionTriggers);
    if (args.promotedFrom !== undefined) patch.promotedFrom = args.promotedFrom;
    if (args.checkpointId !== undefined) patch.checkpointId = args.checkpointId;
    if (refreshDerived) {
      patch.salienceScore = undefined;
      await deleteMemoryVector(ctx, args.memoryId);
    }
    if (contentChanged) {
      // A generated summary/compact form describes the previous raw revision.
      // Never let retention wipe freshly edited content under that stale text.
      patch.summary = undefined;
      patch.recallText = undefined;
      patch.summaryCreatedAt = undefined;
      patch.summarySource = undefined;
      patch.summaryModel = undefined;
      patch.summaryCostUsd = undefined;
      patch.reflectionRunId = undefined;
      if (nextStore === "sensory") {
        const retentionFields = await getSensoryRawRetentionFields(
          ctx,
          existing.userId,
          nextStore,
          editNow,
        );
        Object.assign(patch, retentionFields);
        patch.rawContentWipedAt = undefined;
        patch.contentWipedAt = undefined;
        patch.contentTombstone = undefined;
      }
    }

    if (args.archived === true) {
      await archiveMemoryAndSyncCleanupProjection(
        ctx,
        existing,
        args.archivedAt ?? existing.archivedAt ?? nowMs(),
        patch,
      );
    } else if (args.archived !== undefined) {
      await patchMemoryAndSyncCleanupProjection(ctx, existing, patch);
    } else {
      await patchMemoryAndSyncCleanupProjection(ctx, existing, patch, editNow);
    }

    if (nextArchived) {
      await deleteMemoryTriggerRows(ctx, args.memoryId);
    } else if (args.actionTriggers !== undefined || (args.archived === false && existing.archived)) {
      await replaceMemoryTriggerRows(
        ctx,
        existing.userId,
        args.memoryId,
        args.actionTriggers ?? existing.actionTriggers,
        existing.lastAccessedAt
      );
    }

    await applyDashboardTotalsDelta(
      ctx,
      existing.userId,
      buildMemoryTransitionDelta({
        oldArchived: previousArchived,
        oldStore: previousStore,
        oldGraphEnriched: false,
        oldAccessCount: existing.accessCount,
        oldKnowledgeBaseId: existing.knowledgeBaseId,
        newArchived: nextArchived,
        newStore: nextStore,
        newGraphEnriched: false,
        newAccessCount: existing.accessCount,
      })
    );

    // M7 — track totalStrength delta when strength is part of the patch.
    if (args.strength !== undefined && args.strength !== existing.strength) {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        buildStrengthDelta(existing.strength, args.strength),
      );
    }

    if (refreshDerived) {
      await scheduleMemoryDerivedRefresh(ctx, args.memoryId, existing.userId, nextStore);
    }

    return ctx.db.get(args.memoryId);
  },
});

export const forgetMemory = mutation({
  args: forgetMemoryInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.userId !== stableUserId(identity.subject)) return null;

    if (args.permanent) {
      const store = existing.store;
      const wasArchived = existing.archived;
      await deleteMemoryTriggerRows(ctx, args.memoryId);
      await deleteCleanupProjectionForMemory(ctx, args.memoryId);
      await deleteMemoryVector(ctx, args.memoryId);
      await ctx.db.delete(args.memoryId);
      await applyDashboardTotalsDelta(ctx, existing.userId, {
        totalMemoriesDelta: -1,
        activeMemoriesDelta: wasArchived ? 0 : -1,
        archivedMemoriesDelta: wasArchived ? -1 : 0,
        // ILL-179 — permanent delete of a live KB chunk drops it from the KB count.
        knowledgeBaseMemoriesDelta: !wasArchived && existing.knowledgeBaseId ? -1 : 0,
        activeMemoriesByStoreDelta: wasArchived ? {} : { [store]: -1 },
        activeRecallCountDelta: wasArchived ? 0 : -(existing.accessCount ?? 0),
        activeRecalledMemoriesDelta: !wasArchived && (existing.accessCount ?? 0) > 0 ? -1 : 0,
      });
      return {
        memoryId: args.memoryId,
        title: existing.title,
        reason: args.reason ?? "permanently deleted",
        action: "deleted" as const,
        archived: false,
      };
    }

    const wasAlreadyArchived = existing.archived;
    const archivedAt = existing.archivedAt ?? nowMs();
    await deleteMemoryTriggerRows(ctx, args.memoryId);
    await archiveMemoryAndSyncCleanupProjection(
      ctx,
      existing,
      archivedAt,
    );

    if (!wasAlreadyArchived) {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        buildMemoryTransitionDelta({
          oldArchived: false,
          oldStore: existing.store,
          oldGraphEnriched: false,
          oldAccessCount: existing.accessCount,
          oldKnowledgeBaseId: existing.knowledgeBaseId,
          newArchived: true,
          newStore: existing.store,
          newGraphEnriched: false,
          newAccessCount: existing.accessCount,
        })
      );
    }

    return {
      memoryId: args.memoryId,
      title: existing.title,
      reason: args.reason ?? "forgotten",
      action: "archived" as const,
      archived: true,
    };
  },
});

// ── ILL-11: contentHash backfill for legacy rows ─────────────────────────────
// Populates contentHash on active non-KB memories written before the write
// paths persisted it, so the by_user_content_hash_channel dedupe lookup covers
// the whole corpus (the legacy title-scan fallback then never fires).
// Invoked per user via `npx convex run`; each call processes a bounded slice
// and reports what remains, so a CLI loop can pace rounds (index writes on
// patched rows are throttled by the backend — keep batches small).

export const listMemoriesMissingContentHash = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.min(Math.max(args.numItems ?? 100, 1), 200);
    // Cursor pagination (NOT take + refetch): KB chunks also live in the
    // contentHash=undefined range and are skipped rather than patched, so a
    // take-based loop would re-read the same KB rows forever / stop early.
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_content_hash", (q) =>
        q.eq("userId", args.userId).eq("contentHash", undefined).eq("archived", false)
      )
      .paginate({ cursor: args.cursor ?? null, numItems });
    return {
      rows: page.page
        .filter((memory) => !memory.knowledgeBaseId)
        .map((memory) => ({
          id: memory._id,
          store: memory.store,
          category: memory.category,
          content: memory.content,
        })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const patchMemoryContentHashes = internalMutation({
  args: {
    userId: v.string(),
    items: v.array(
      v.object({ memoryId: v.id("crystalMemories"), contentHash: v.string() })
    ),
  },
  handler: async (ctx, args) => {
    if (args.items.length > 25) {
      throw new Error("patchMemoryContentHashes accepts at most 25 items per call (vector-index write throttle)");
    }
    let patched = 0;
    for (const item of args.items) {
      const memory = await ctx.db.get(item.memoryId);
      if (!memory || memory.userId !== args.userId) continue;
      if (memory.contentHash !== undefined || memory.knowledgeBaseId) continue;
      await ctx.db.patch(item.memoryId, { contentHash: item.contentHash });
      patched += 1;
    }
    return { patched };
  },
});

export const backfillMemoryContentHashes = internalAction({
  args: {
    userId: v.string(),
    maxRows: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ patched: number; done: boolean }> => {
    const maxRows = Math.min(Math.max(args.maxRows ?? 500, 1), 2000);
    let patched = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: {
        rows: Array<{ id: any; store: string; category: string; content: string }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.crystal.memories.listMemoriesMissingContentHash, {
        userId: args.userId,
        cursor,
        numItems: 100,
      });
      for (let offset = 0; offset < page.rows.length; offset += 25) {
        const slice = page.rows.slice(offset, offset + 25);
        const items = [];
        for (const row of slice) {
          items.push({
            memoryId: row.id,
            contentHash: await sha256Hex(
              buildMemoryHashInput({ store: row.store, category: row.category, content: row.content })
            ),
          });
        }
        const result: { patched: number } = await ctx.runMutation(
          internal.crystal.memories.patchMemoryContentHashes,
          { userId: args.userId, items },
        );
        patched += result.patched;
      }
      if (page.isDone) return { patched, done: true };
      if (patched >= maxRows) return { patched, done: false };
      cursor = page.continueCursor;
    }
  },
});

// ── ILL-108 G2: coreTier backfill for existing `core`-tagged rows ────────────
// Cursor-paginated, idempotent, safe at 33.7k-memory scale. Each call processes
// a bounded slice and reports what remains, so a CLI loop can pace rounds.

export const listMemoriesMissingCoreTier = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.min(Math.max(args.numItems ?? 100, 1), 200);
    // Seek memories where coreTier is absent (undefined) and archived is false.
    // We'll check tags in-memory to set coreTier true only for core-tagged rows.
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) =>
        q.eq("userId", args.userId).eq("archived", false)
      )
      .paginate({ cursor: args.cursor ?? null, numItems });
    // Filter to rows missing coreTier and having "core" tag
    const rows = page.page
      .filter((memory) => memory.coreTier === undefined)
      .filter((memory) => {
        const tags = memory.tags ?? [];
        return tags.some((tag) => String(tag).trim().toLowerCase() === "core");
      })
      .map((memory) => ({
        id: memory._id,
        tags: memory.tags ?? [],
      }));
    return {
      rows,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const patchMemoryCoreTier = internalMutation({
  args: {
    userId: v.string(),
    items: v.array(v.object({ memoryId: v.id("crystalMemories") })),
  },
  handler: async (ctx, args) => {
    if (args.items.length > 25) {
      throw new Error("patchMemoryCoreTier accepts at most 25 items per call");
    }
    let patched = 0;
    for (const item of args.items) {
      const memory = await ctx.db.get(item.memoryId);
      if (!memory || memory.userId !== args.userId) continue;
      if (memory.coreTier !== undefined) continue; // already set
      await ctx.db.patch(item.memoryId, { coreTier: true });
      patched += 1;
    }
    return { patched };
  },
});

export const backfillCoreTier = internalAction({
  args: {
    userId: v.string(),
    maxRows: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ scanned: number; updated: number; done: boolean }> => {
    const maxRows = Math.min(Math.max(args.maxRows ?? 500, 1), 2000);
    let scanned = 0;
    let updated = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: {
        rows: Array<{ id: any; tags: string[] }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.crystal.memories.listMemoriesMissingCoreTier, {
        userId: args.userId,
        cursor,
        numItems: 100,
      });
      scanned += page.rows.length;
      // If this page is empty (no more core-tagged memories with missing coreTier), we're done.
      if (page.rows.length === 0) return { scanned, updated, done: true };

      for (let offset = 0; offset < page.rows.length; offset += 25) {
        const slice = page.rows.slice(offset, offset + 25);
        const items = slice.map((row) => ({ memoryId: row.id }));
        const result: { patched: number } = await ctx.runMutation(
          internal.crystal.memories.patchMemoryCoreTier,
          { userId: args.userId, items },
        );
        updated += result.patched;
      }

      // If the full underlying pagination is exhausted, we're done.
      if (page.isDone) return { scanned, updated, done: true };
      
      // If we've hit the maxRows limit, check if there are more items to process.
      // Fetch one more page to determine if work remains.
      if (updated >= maxRows) {
        const peek: { rows: Array<{ id: any; tags: string[] }> } = await ctx.runQuery(
          internal.crystal.memories.listMemoriesMissingCoreTier,
          {
            userId: args.userId,
            cursor: page.continueCursor,
            numItems: 1,
          },
        );
        // If the next page is empty, we're done. Otherwise, more work remains.
        return { scanned, updated, done: peek.rows.length === 0 };
      }
      
      cursor = page.continueCursor;
    }
  },
});
