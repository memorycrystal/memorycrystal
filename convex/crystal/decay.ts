import { stableUserId } from "./auth";
import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { TIER_LIMITS } from "../../shared/tierLimits";
import {
  applyDashboardTotalsDelta,
  buildMemoryTransitionDelta,
} from "./dashboardTotals";

const clamp = (value: number) => Math.max(0, Math.min(1, value));

// null in TIER_LIMITS means "unlimited" — decay still needs a concrete ceiling
// so pressure-based archival can function. 999_999 is the effective "no-limit" cap.
const UNLIMITED_CAP = 999_999;

const TIER_MEMORY_LIMITS: Record<string, number> = {
  free: TIER_LIMITS.free.memories ?? UNLIMITED_CAP,
  starter: TIER_LIMITS.starter.memories ?? UNLIMITED_CAP,
  pro: TIER_LIMITS.pro.memories ?? UNLIMITED_CAP,
  ultra: TIER_LIMITS.ultra.memories ?? UNLIMITED_CAP,
  unlimited: TIER_LIMITS.unlimited.memories ?? UNLIMITED_CAP,
};

// computeDecay is kept for potential future use (e.g. internal strength adjustments)
export const computeDecay = (
  strength: number,
  ageDays: number,
  accessCount: number,
  valence: number,
  arousal: number
) => {
  const isHighEmotion = Math.abs(valence) > 0.7 && arousal > 0.7;
  const baseDecay = isHighEmotion ? 0.01 : 0.02;
  const recallBoost = Math.min(accessCount * 0.002, 0.01);
  const adjustedDecay = Math.max(0.005, baseDecay - recallBoost);
  const amount = adjustedDecay * ageDays;
  return clamp(strength - amount);
};

export const getMemoriesForDecay = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    // Fetch the oldest-accessed rows first. The previous `by_user` index returned
    // rows in insertion order, so users with thousands of healthy memories never
    // had their real decay tail reached — decay silently became a no-op at scale.
    return ctx.db
      .query("crystalMemories")
      .withIndex("by_last_accessed", (q) => q.eq("userId", args.userId))
      .order("asc")
      .filter((q) => q.eq(q.field("archived"), false))
      .take(args.limit);
  },
});

export const applyDecayPatch = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    strength: v.float64(),
    archived: v.boolean(),
    archivedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing) throw new Error("Memory not found");

    const patch: Record<string, unknown> = { strength: args.strength };
    const willArchive = Boolean(args.archived);
    const willUnarchive = !args.archived && existing.archived;

    if (args.archived) {
      patch.archived = true;
      patch.archivedAt = args.archivedAt ?? Date.now();
    }

    if (willArchive || willUnarchive) {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        buildMemoryTransitionDelta({
          oldArchived: existing.archived,
          oldStore: existing.store,
          newArchived: willArchive,
          newStore: existing.store,
        })
      );
    }

    await ctx.db.patch(args.memoryId, patch);
  },
});

// Public query still available for single-user contexts (authenticated)
export const getMemoriesForDecayAuth = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", stableUserId(identity.subject)).eq("archived", false))
      .take(args.limit);
  },
});

// Public patch for single-user authenticated contexts
export const applyDecayPatchAuth = mutation({
  args: {
    memoryId: v.id("crystalMemories"),
    strength: v.float64(),
    archived: v.boolean(),
    archivedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const memory = await ctx.db.get(args.memoryId);
    if (!memory || memory.userId !== stableUserId(identity.subject)) return;

    const patch: Record<string, unknown> = { strength: args.strength };
    const willArchive = Boolean(args.archived);
    const willUnarchive = !args.archived && memory.archived;

    if (args.archived) {
      patch.archived = true;
      patch.archivedAt = args.archivedAt ?? Date.now();
    }

    if (willArchive || willUnarchive) {
      await applyDashboardTotalsDelta(
        ctx,
        memory.userId,
        buildMemoryTransitionDelta({
          oldArchived: memory.archived,
          oldStore: memory.store,
          newArchived: willArchive,
          newStore: memory.store,
        })
      );
    }

    await ctx.db.patch(args.memoryId, patch);
  },
});

/**
 * Storage-pressure-based decay.
 *
 * Decay only fires for a user when they are at ≥90% of their tier memory limit.
 * When triggered, the oldest/weakest memories are archived to bring them back
 * to 85% of their limit.
 *
 * Scoring: combinedScore = strength * 0.4 + recencyScore * 0.6
 * (lower score = archived first)
 */
export const applyDecay = action({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const userIds: string[] = await ctx.runQuery(internal.crystal.userProfiles.listAllUserIds, {});
    let totalArchived = 0;

    for (const userId of userIds) {
      const tier: string = await ctx.runQuery(internal.crystal.userProfiles.getUserTier, { userId });
      const limit = TIER_MEMORY_LIMITS[tier] ?? TIER_MEMORY_LIMITS.free;

      // Fetch enough to determine if we're over threshold (limit + 1 so we know if there are more)
      const allMemories: any[] = await ctx.runQuery(internal.crystal.decay.getMemoriesForDecay, {
        userId,
        limit: limit + 1,
      });
      // Exempt KB memories from decay — they are managed by the knowledge base lifecycle
      const memories = allMemories.filter((m: any) => !m.knowledgeBaseId);
      const activeCount = memories.length;

      // Skip if below 90% full
      if (activeCount < limit * 0.9) continue;

      const targetCount = Math.floor(limit * 0.85);
      const toArchive = activeCount - targetCount;
      if (toArchive <= 0) continue;

      console.log(
        `[applyDecay] tier=${tier}: ${activeCount}/${limit} active (${Math.round(activeCount / limit * 100)}% full), archiving ${toArchive} to reach ${targetCount}`
      );

      const now = Date.now();
      const scored = memories
        .map((m) => {
          // Guard against clock skew / future-dated lastAccessedAt which would make
          // recencyScore > 1 and bump combinedScore above strength's natural range.
          const rawAgeDays = (now - (m.lastAccessedAt ?? m.createdAt)) / 86400000;
          const ageDays = Math.max(0, rawAgeDays);
          const recencyScore = Math.exp(-0.05 * ageDays); // slow decay curve
          const combinedScore = m.strength * 0.4 + recencyScore * 0.6;
          return { ...m, combinedScore };
        })
        .sort((a, b) => a.combinedScore - b.combinedScore); // lowest score first

      const candidates = scored.slice(0, toArchive);

      for (const memory of candidates) {
        if (!dryRun) {
          await ctx.runMutation(internal.crystal.decay.applyDecayPatch, {
            memoryId: memory._id,
            strength: memory.strength * 0.5, // halve strength as final warning before archival
            archived: true,
            archivedAt: now,
          });
        }
        totalArchived++;
      }
    }

    return { archived: totalArchived, dryRun: dryRun ?? false };
  },
});
