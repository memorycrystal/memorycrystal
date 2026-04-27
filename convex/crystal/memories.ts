import { stableUserId } from "./auth";
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { scanMemoryContent } from "./contentScanner";

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

async function scheduleMemoryDerivedRefresh(ctx: any, memoryId: any, userId: string) {
  if (!shouldScheduleMemoryBackgroundWork()) return;
  await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, { memoryId });
  await ctx.scheduler.runAfter(50, internal.crystal.salience.computeAndStoreSalience, { memoryId });
  await ctx.scheduler.runAfter(100, internal.crystal.graphEnrich.enrichMemoryGraph, {
    memoryId,
    userId,
  });
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

    const candidates = await ctx.db
      .query("crystalMemories")
      .withIndex("by_store_category_title", (q) =>
        q
          .eq("userId", userId)
          .eq("store", args.store)
          .eq("category", args.category)
          .eq("archived", false)
          .eq("title", args.title)
      )
      .take(5);

    const duplicate = candidates.find(
      (memory) =>
        memory.content === args.content &&
        (args.channel === undefined || args.channel === memory.channel) &&
        memory.source === (args.source ?? "conversation")
    );

    if (duplicate) {
      const existingTags = dedupeTags((duplicate.tags ?? []).concat(args.tags ?? []));
      await ctx.db.patch(duplicate._id, {
        lastAccessedAt: now,
        confidence: args.confidence ?? duplicate.confidence,
        strength: Math.max(duplicate.strength, args.strength ?? duplicate.strength),
        valence: args.valence ?? duplicate.valence,
        arousal: args.arousal ?? duplicate.arousal,
        tags: existingTags,
        channel: args.channel ?? duplicate.channel,
      });
      return duplicate._id;
    }

    const memoryId = await ctx.db.insert("crystalMemories", {
      userId,
      store: args.store,
      category: args.category,
      title: args.title,
      content: args.content,
      metadata: args.metadata,
      embedding: args.embedding,
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
      tags: dedupeTags(args.tags ?? []),
      actionTriggers: [],
      archived: args.archived ?? false,
      archivedAt: args.archivedAt,
      promotedFrom: args.promotedFrom,
      checkpointId: args.checkpointId,
    });

    await applyDashboardTotalsDelta(
      ctx,
      userId,
      buildMemoryCreateDelta({
        store: args.store,
        archived: args.archived ?? false,
        title: args.title,
        memoryId,
        createdAt: now,
      })
    );

    try {
      await ctx.runMutation(internal.crystal.organic.activityLog.logActivity, {
        userId,
        eventType: "memory_stored",
        memoryId,
      });
    } catch (_) { /* fire-and-forget */ }

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

    const candidates = await ctx.db
      .query("crystalMemories")
      .withIndex("by_store_category_title", (q) =>
        q
          .eq("userId", userId)
          .eq("store", args.store)
          .eq("category", args.category)
          .eq("archived", false)
          .eq("title", args.title)
      )
      .take(5);

    const duplicate = candidates.find(
      (memory) =>
        memory.content === args.content &&
        (args.channel === undefined || args.channel === memory.channel) &&
        memory.source === (args.source ?? "conversation")
    );

    if (duplicate) {
      const existingTags = dedupeTags((duplicate.tags ?? []).concat(args.tags ?? []));
      const nextActionTriggers =
        args.actionTriggers !== undefined
          ? normalizeActionTriggers(args.actionTriggers)
          : duplicate.actionTriggers;
      await ctx.db.patch(duplicate._id, {
        lastAccessedAt: now,
        confidence: args.confidence ?? duplicate.confidence,
        strength: Math.max(duplicate.strength, args.strength ?? duplicate.strength),
        valence: args.valence ?? duplicate.valence,
        arousal: args.arousal ?? duplicate.arousal,
        tags: existingTags,
        channel: args.channel ?? duplicate.channel,
        ...(args.actionTriggers !== undefined ? { actionTriggers: nextActionTriggers } : {}),
      });
      if (args.actionTriggers !== undefined && !duplicate.archived) {
        await replaceMemoryTriggerRows(ctx, userId, duplicate._id, nextActionTriggers, now);
      }
      return duplicate._id;
    }

    const memoryId = await ctx.db.insert("crystalMemories", {
      userId,
      store: rest.store,
      category: rest.category,
      title: rest.title,
      content: rest.content,
      metadata: rest.metadata,
      embedding: rest.embedding,
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
      tags: dedupeTags(rest.tags ?? []),
      actionTriggers: normalizeActionTriggers(rest.actionTriggers),
      archived: rest.archived ?? false,
      archivedAt: rest.archivedAt,
      promotedFrom: rest.promotedFrom,
      checkpointId: rest.checkpointId,
    });

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
      })
    );

    try {
      await ctx.runMutation(internal.crystal.organic.activityLog.logActivity, {
        userId,
        eventType: "memory_stored",
        memoryId,
      });
    } catch (_) { /* fire-and-forget */ }

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
    await ctx.db.patch(args.memoryId, {
      accessCount: existing.accessCount + 1,
      lastAccessedAt: now,
    });
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
    await ctx.db.patch(args.memoryId, {
      accessCount: existing.accessCount + 1,
      lastAccessedAt: now,
    });
    return ctx.db.get(args.memoryId);
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
    const refreshDerived = !nextArchived && (contentChanged || titleChanged);

    const patch: Record<string, unknown> = {};
    if (args.store !== undefined) patch.store = args.store;
    if (args.category !== undefined) patch.category = args.category;
    if (args.title !== undefined) patch.title = args.title;
    if (args.content !== undefined) patch.content = args.content;
    if (args.metadata !== undefined) patch.metadata = args.metadata;
    if (args.strength !== undefined) patch.strength = args.strength;
    if (args.confidence !== undefined) patch.confidence = args.confidence;
    if (args.valence !== undefined) patch.valence = args.valence;
    if (args.arousal !== undefined) patch.arousal = args.arousal;
    if (args.tags !== undefined) patch.tags = dedupeTags(args.tags);
    if (args.source !== undefined) patch.source = args.source;
    if (args.channel !== undefined) patch.channel = args.channel;
    if (args.archived !== undefined) patch.archived = args.archived;
    if (args.archivedAt !== undefined) patch.archivedAt = args.archivedAt;
    if (args.actionTriggers !== undefined) patch.actionTriggers = normalizeActionTriggers(args.actionTriggers);
    if (args.promotedFrom !== undefined) patch.promotedFrom = args.promotedFrom;
    if (args.checkpointId !== undefined) patch.checkpointId = args.checkpointId;
    if (contentChanged) patch.embedding = [];
    if (refreshDerived) {
      patch.graphEnriched = false;
      patch.graphEnrichedAt = undefined;
      patch.salienceScore = undefined;
    }

    await ctx.db.patch(args.memoryId, patch);

    const nextStore = args.store !== undefined ? args.store : existing.store;

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
        newArchived: nextArchived,
        newStore: nextStore,
      })
    );

    if (refreshDerived) {
      await scheduleMemoryDerivedRefresh(ctx, args.memoryId, existing.userId);
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
      await ctx.db.delete(args.memoryId);
      await applyDashboardTotalsDelta(ctx, existing.userId, {
        totalMemoriesDelta: -1,
        activeMemoriesDelta: wasArchived ? 0 : -1,
        archivedMemoriesDelta: wasArchived ? -1 : 0,
        activeMemoriesByStoreDelta: wasArchived ? {} : { [store]: -1 },
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
    await deleteMemoryTriggerRows(ctx, args.memoryId);
    await ctx.db.patch(args.memoryId, {
      archived: true,
      archivedAt: nowMs(),
    });

    try {
      await ctx.runMutation(internal.crystal.organic.activityLog.logActivity, {
        userId: existing.userId,
        eventType: "memory_archived",
        memoryId: args.memoryId,
      });
    } catch (_) { /* fire-and-forget */ }

    if (!wasAlreadyArchived) {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        buildMemoryTransitionDelta({
          oldArchived: false,
          oldStore: existing.store,
          newArchived: true,
          newStore: existing.store,
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
