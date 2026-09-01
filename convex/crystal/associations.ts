import { stableUserId } from "./auth";
import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";

const relationTypes = v.union(
  v.literal("supports"),
  v.literal("contradicts"),
  v.literal("derives_from"),
  v.literal("co_occurred"),
  v.literal("generalizes"),
  v.literal("precedes")
);
const associationDirection = v.union(v.literal("from"), v.literal("to"));
const SKIP_IF_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAMPLE_CAP = 100;
const MAX_BATCH = 200;
// Cursor rotation for the 6h `crystal-associate` cron: each tick reads ONE page
// of user profiles (crystalJobCursors keeps the position) instead of collecting
// the whole table. Rotation is behavior-safe here because the 7-day
// SKIP_IF_RECENT_MS guard already makes per-memory work elapsed-time based, and
// upsertAssociationRecord is a convergent upsert (max-weight patch, ordered-id
// dedupe) — visiting a user later loses nothing.
const JOB_NAME = "build-associations";
const DEFAULT_USERS_PER_TICK = 25;
const MAX_USERS_PER_TICK = 200;

const clampInt = (value: number | undefined, min: number, max: number, fallback: number) => {
  const raw = Number.isFinite(value ?? NaN) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(raw, min), max);
};

const associationInput = v.object({
  fromMemoryId: v.id("crystalMemories"),
  toMemoryId: v.id("crystalMemories"),
  relationshipType: relationTypes,
  weight: v.float64(),
});

const associationQueryInput = v.object({
  memoryId: v.id("crystalMemories"),
  direction: v.optional(associationDirection),
  limit: v.optional(v.number()),
});

const buildAssociationsInput = v.object({
  maxSamples: v.optional(v.number()),
  neighborsPerMemory: v.optional(v.number()),
  similarityThreshold: v.optional(v.number()),
  // Rotation / admin overrides (additive — the cron passes {}):
  userId: v.optional(v.string()),
  usersLimit: v.optional(v.number()),
  dryRun: v.optional(v.boolean()),
});

const clampAssociationWeight = (weight: number) => Math.max(0.1, Math.min(1, weight));

export const upsertAssociation = mutation({
  args: associationInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    if (args.fromMemoryId === args.toMemoryId) throw new Error("Cannot associate a memory with itself");

    const [fromMem, toMem] = await Promise.all([ctx.db.get(args.fromMemoryId), ctx.db.get(args.toMemoryId)]);
    if (!fromMem || fromMem.userId !== userId) throw new Error("Memory not found");
    if (!toMem || toMem.userId !== userId) throw new Error("Memory not found");

    const existing = await ctx.db
      .query("crystalAssociations")
      .withIndex("by_from", (q) => q.eq("fromMemoryId", args.fromMemoryId))
      .filter((q) => q.eq(q.field("toMemoryId"), args.toMemoryId))
      .take(1);

    if (existing.length > 0) {
      const existingAssoc = existing[0];
      await ctx.db.patch(existingAssoc._id, {
        relationshipType: args.relationshipType,
        weight: Math.max(existingAssoc.weight, args.weight),
        updatedAt: Date.now(),
      });
      return existingAssoc._id;
    }

    return ctx.db.insert("crystalAssociations", {
      fromMemoryId: args.fromMemoryId,
      toMemoryId: args.toMemoryId,
      relationshipType: args.relationshipType,
      weight: args.weight,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const getAssociationsForMemory = query({
  args: associationQueryInput,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const memory = await ctx.db.get(args.memoryId);
    if (!memory || memory.userId !== userId) return [];

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const direction = args.direction ?? "from";

    const associations = direction === "from"
      ? await ctx.db.query("crystalAssociations").withIndex("by_from", (q) => q.eq("fromMemoryId", args.memoryId)).take(limit)
      : await ctx.db.query("crystalAssociations").withIndex("by_to", (q) => q.eq("toMemoryId", args.memoryId)).take(limit);

    const filtered = [];
    for (const association of associations) {
      const [fromMem, toMem] = await Promise.all([ctx.db.get(association.fromMemoryId), ctx.db.get(association.toMemoryId)]);
      if (!fromMem || !toMem) continue;
      if (fromMem.userId !== userId || toMem.userId !== userId) continue;
      filtered.push(association);
    }

    return filtered.sort((a, b) => b.weight - a.weight).map((association) => ({
      associationId: association._id,
      fromMemoryId: association.fromMemoryId,
      toMemoryId: association.toMemoryId,
      relationshipType: association.relationshipType,
      weight: association.weight,
    }));
  },
});

export const removeAssociation = mutation({
  args: { associationId: v.id("crystalAssociations") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const existing = await ctx.db.get(args.associationId);
    if (!existing) return null;

    const [fromMem, toMem] = await Promise.all([ctx.db.get(existing.fromMemoryId), ctx.db.get(existing.toMemoryId)]);
    if (!fromMem || !toMem || fromMem.userId !== userId || toMem.userId !== userId) throw new Error("Not authorized");

    await ctx.db.delete(args.associationId);
    return { deleted: args.associationId };
  },
});

export const getMemoriesForAssociation = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .take(args.limit);
  },
});

export const getMemoryByIdForAssociation = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.memoryId);
  },
});

export const getMemoriesByIdsForAssociation = internalQuery({
  args: { memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, args) => {
    return Promise.all(args.memoryIds.map((memoryId) => ctx.db.get(memoryId)));
  },
});

export const hasRecentAssociationQuery = internalQuery({
  args: { userId: v.string(), memoryId: v.id("crystalMemories"), cutoffMs: v.number() },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (!memory || memory.userId !== args.userId) return true;

    const recentAsSource = await ctx.db
      .query("crystalAssociations")
      .withIndex("by_from", (q) => q.eq("fromMemoryId", args.memoryId))
      .filter((q) => q.gt(q.field("updatedAt"), args.cutoffMs))
      .take(20);
    for (const assoc of recentAsSource) {
      const target = await ctx.db.get(assoc.toMemoryId);
      if (target && target.userId === args.userId) return true;
    }

    const recentAsTarget = await ctx.db
      .query("crystalAssociations")
      .withIndex("by_to", (q) => q.eq("toMemoryId", args.memoryId))
      .filter((q) => q.gt(q.field("updatedAt"), args.cutoffMs))
      .take(20);
    for (const assoc of recentAsTarget) {
      const source = await ctx.db.get(assoc.fromMemoryId);
      if (source && source.userId === args.userId) return true;
    }

    return false;
  },
});

export const upsertAssociationRecord = internalMutation({
  args: {
    userId: v.string(),
    fromMemoryId: v.id("crystalMemories"),
    toMemoryId: v.id("crystalMemories"),
    relationshipType: relationTypes,
    weight: v.float64(),
  },
  handler: async (ctx, args) => {
    const [fromMem, toMem] = await Promise.all([ctx.db.get(args.fromMemoryId), ctx.db.get(args.toMemoryId)]);
    if (!fromMem || !toMem || fromMem.userId !== args.userId || toMem.userId !== args.userId) return { created: false };

    const existing = await ctx.db
      .query("crystalAssociations")
      .withIndex("by_from", (q) => q.eq("fromMemoryId", args.fromMemoryId))
      .filter((q) => q.eq(q.field("toMemoryId"), args.toMemoryId))
      .take(1);

    const weight = clampAssociationWeight(args.weight);
    if (existing.length > 0) {
      await ctx.db.patch(existing[0]._id, {
        relationshipType: args.relationshipType,
        weight: Math.max(existing[0].weight, weight),
        updatedAt: Date.now(),
      });
      return { created: false };
    }

    await ctx.db.insert("crystalAssociations", {
      fromMemoryId: args.fromMemoryId,
      toMemoryId: args.toMemoryId,
      relationshipType: args.relationshipType,
      weight,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { created: true };
  },
});

export const buildAssociations = action({
  args: buildAssociationsInput,
  handler: async (ctx, args) => {
    const maxSamples = Math.min(Math.max(args.maxSamples ?? 180, 20), MAX_SAMPLE_CAP);
    const neighborsPerMemory = Math.min(Math.max(args.neighborsPerMemory ?? 6, 2), 20);
    const threshold = Math.min(Math.max(args.similarityThreshold ?? 0.75, 0.6), 0.99);
    const skipIfRecentBefore = Date.now() - SKIP_IF_RECENT_MS;
    const usersLimit = clampInt(args.usersLimit, 1, MAX_USERS_PER_TICK, DEFAULT_USERS_PER_TICK);
    const dryRun = args.dryRun === true;

    // Rotation: process ONE page of users per tick, resuming from the persisted
    // cursor. Explicit single-user runs bypass pagination entirely.
    let userIds: string[];
    let nextCursor: string | undefined;
    if (args.userId) {
      userIds = [args.userId];
    } else {
      const cursor = (await ctx.runQuery(internal.crystal.jobCursors.getJobCursor, {
        jobName: JOB_NAME,
      })) as string | null;
      let page: { userIds: string[]; continueCursor: string; isDone: boolean };
      try {
        page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          cursor: cursor ?? undefined,
          numItems: usersLimit,
        });
      } catch {
        // Stale/invalidated pagination cursor (table churn between ticks):
        // restart the rotation from the beginning rather than failing the tick.
        page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          numItems: usersLimit,
        });
      }
      userIds = page.userIds;
      nextCursor = page.isDone ? undefined : page.continueCursor;
    }

    let created = 0;
    let skipped = 0;
    let processed = 0;
    let wouldUpsert = 0;

    for (const userId of userIds) {
      const memories = (
        await ctx.runQuery(internal.crystal.associations.getMemoriesForAssociation, {
          userId,
          limit: Math.min(maxSamples, MAX_BATCH),
        })
      )
        // Skip already-enriched memories — handled by real-time pipeline in graphEnrich.ts
        .filter((memory: { graphEnriched?: boolean }) => memory.graphEnriched !== true)
        .sort((a: { lastAccessedAt: number }, b: { lastAccessedAt: number }) => b.lastAccessedAt - a.lastAccessedAt);

      for (const source of memories) {
        const hasRecent = await ctx.runQuery(internal.crystal.associations.hasRecentAssociationQuery, {
          userId,
          memoryId: source._id,
          cutoffMs: skipIfRecentBefore,
        });
        if (hasRecent) {
          skipped += 1;
          continue;
        }

        processed += 1;

        if (!Array.isArray(source.embedding) || source.embedding.length === 0) continue;

        const vectorTake = Math.min((neighborsPerMemory + 1) * 8, 256);
        const nearest = (await ctx.vectorSearch("crystalMemories", "by_embedding", {
          vector: source.embedding,
          limit: vectorTake,
          filter: (q) => q.eq("userId", userId),
        })) as Array<{ _id: string; _score?: number; score?: number }>;

        const candidatesAboveThreshold = [];
        for (const candidate of nearest) {
          if (candidate._id === source._id) continue;
          const score = candidate._score ?? candidate.score ?? 0;
          if (score < threshold) break;
          candidatesAboveThreshold.push({ ...candidate, score });
        }

        const candidateMemories = await ctx.runQuery(internal.crystal.associations.getMemoriesByIdsForAssociation, {
          memoryIds: candidatesAboveThreshold.map((candidate) => candidate._id as any),
        });

        for (let index = 0; index < candidatesAboveThreshold.length; index += 1) {
          const candidate = candidatesAboveThreshold[index];
          const candidateMemory = candidateMemories[index];
          if (!candidateMemory || candidateMemory.userId !== userId || candidateMemory.archived) continue;

          const score = candidate.score;

          const orderedFrom = source._id < candidate._id ? source._id : candidate._id;
          const orderedTo = source._id < candidate._id ? candidate._id : source._id;

          if (dryRun) {
            wouldUpsert += 1;
            continue;
          }

          const result = await ctx.runMutation(internal.crystal.associations.upsertAssociationRecord, {
            userId,
            fromMemoryId: orderedFrom as any,
            toMemoryId: orderedTo as any,
            relationshipType: score > 0.93 ? "supports" : "co_occurred",
            weight: score,
          });

          if (result.created) created += 1;
          else skipped += 1;
        }
      }
    }

    // Advance (or reset at end-of-table) the rotation only for real cron
    // sweeps: explicit single-user runs and dry runs must not move the cursor.
    if (!args.userId && !dryRun) {
      await ctx.runMutation(internal.crystal.jobCursors.setJobCursor, {
        jobName: JOB_NAME,
        cursor: nextCursor,
      });
    }

    return {
      processed,
      created,
      skipped,
      users: userIds.length,
      dryRun,
      wouldUpsert: dryRun ? wouldUpsert : undefined,
    };
  },
});

// Helper queries for recall action (actions cannot use ctx.db directly)
export const listByFrom = internalQuery({
  args: { userId: v.string(), fromMemoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.fromMemoryId);
    if (!source || source.userId !== args.userId) return [];

    const associations = await ctx.db
      .query("crystalAssociations")
      .withIndex("by_from", (q) => q.eq("fromMemoryId", args.fromMemoryId))
      .take(100);

    const out = [];
    for (const association of associations) {
      const target = await ctx.db.get(association.toMemoryId);
      if (target && target.userId === args.userId) out.push(association);
    }
    return out;
  },
});

export const listByTo = internalQuery({
  args: { userId: v.string(), toMemoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.toMemoryId);
    if (!target || target.userId !== args.userId) return [];

    const associations = await ctx.db
      .query("crystalAssociations")
      .withIndex("by_to", (q) => q.eq("toMemoryId", args.toMemoryId))
      .take(100);

    const out = [];
    for (const association of associations) {
      const source = await ctx.db.get(association.fromMemoryId);
      if (source && source.userId === args.userId) out.push(association);
    }
    return out;
  },
});
