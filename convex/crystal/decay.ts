import { stableUserId } from "./auth";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  applyDashboardTotalsDelta,
  buildMemoryTransitionDelta,
  buildStrengthDelta,
} from "./publicDashboardTotals";
import { archiveMemoryAndSyncCleanupProjection } from "./cleanupProjection";
// The gradual-decay model lives in decayModel.ts and is wired into
// reinforcement-on-recall. applyDecay is now a thin operator wrapper around
// ILL-183 Forgetting (default OFF). computeDecay is untouched.
import { computeDecay } from "./decayModel";
export { computeDecay };

// ILL-183 — UNLIMITED_CAP and TIER_MEMORY_LIMITS ?? fallbacks are gone.
// Memory Allowance lives in shared/tierLimits.ts via getMemoryAllowance.

export const getMemoriesForDecay = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.trunc(args.limit), 1), 500);
    // Fetch the oldest-accessed rows first. The previous `by_user` index returned
    // rows in insertion order, so users with thousands of healthy memories never
    // had their real decay tail reached — decay silently became a no-op at scale.
    return ctx.db
      .query("crystalMemories")
      .withIndex("by_user_archived_last_accessed", (q) =>
        q.eq("userId", args.userId).eq("archived", false)
      )
      .order("asc")
      .take(limit);
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
          oldGraphEnriched: false,
          oldAccessCount: existing.accessCount,
          oldKnowledgeBaseId: existing.knowledgeBaseId,
          newArchived: willArchive,
          newStore: existing.store,
          newGraphEnriched: false,
          newAccessCount: existing.accessCount,
        })
      );
    }

    // M7 — track totalStrength delta for the dashboard aggregate.
    if (args.strength !== existing.strength) {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        buildStrengthDelta(existing.strength, args.strength),
      );
    }

    if (willArchive) {
      await archiveMemoryAndSyncCleanupProjection(
        ctx,
        existing,
        patch.archivedAt as number,
        patch,
      );
    } else {
      await ctx.db.patch(args.memoryId, patch);
    }
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
          oldGraphEnriched: false,
          oldAccessCount: memory.accessCount,
          oldKnowledgeBaseId: memory.knowledgeBaseId,
          newArchived: willArchive,
          newStore: memory.store,
          newGraphEnriched: false,
          newAccessCount: memory.accessCount,
        })
      );
    }

    // M7 — track totalStrength delta for the dashboard aggregate.
    if (args.strength !== memory.strength) {
      await applyDashboardTotalsDelta(
        ctx,
        memory.userId,
        buildStrengthDelta(memory.strength, args.strength),
      );
    }

    if (willArchive) {
      await archiveMemoryAndSyncCleanupProjection(
        ctx,
        memory,
        patch.archivedAt as number,
        patch,
      );
    } else {
      await ctx.db.patch(args.memoryId, patch);
    }
  },
});

/**
 * ILL-183 — the crystal-decay 25-users-per-tick rotation is retired.
 * Forgetting runs in the Reflection Cycle after Distillation, every user
 * every night, behind CRYSTAL_FORGETTING_ENFORCEMENT (default OFF).
 *
 * Internal operator wrapper only. It never accepts `enforce` — a public
 * client must not be able to archive. Tests that need writes call
 * `internal.crystal.forgetting.runForgettingForUser({ enforce: true })`.
 * Without the env switch this is a no-op unless dryRun is set (report only).
 */
export const applyDecay = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    userId: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    archived: v.number(),
    dryRun: v.boolean(),
    users: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    archived: number;
    dryRun: boolean;
    users: number;
  }> => {
    const dryRun = args.dryRun === true;
    const userIds: string[] = [];

    if (args.userId) {
      userIds.push(args.userId);
    } else {
      let cursor: string | undefined;
      let isDone = false;
      const seen = new Set<string>();
      while (!isDone) {
        const page = (await ctx.runQuery((internal as any).crystal.userProfiles.listUserIdsPage, {
          cursor,
          numItems: 200,
        })) as { userIds: string[]; continueCursor: string; isDone: boolean };
        isDone = page.isDone;
        cursor = page.continueCursor;
        for (const userId of page.userIds) {
          if (seen.has(userId)) continue;
          seen.add(userId);
          userIds.push(userId);
        }
      }
    }

    let totalArchived = 0;
    for (const userId of userIds) {
      const result = (await ctx.runAction(internal.crystal.forgetting.runForgettingForUser, {
        userId,
        now: args.now,
        dryRun,
      })) as { archived: number };
      totalArchived += result.archived;
    }

    return {
      archived: totalArchived,
      dryRun,
      users: userIds.length,
    };
  },
});
