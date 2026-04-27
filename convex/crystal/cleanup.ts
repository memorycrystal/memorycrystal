import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  applyDashboardTotalsDelta,
  buildMemoryTransitionDelta,
} from "./dashboardTotals";

const nowMs = () => Date.now();
const MAX_BATCH = 200;
const PROCEDURAL_REINFORCEMENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PROCEDURAL_OBSERVATIONS_TO_KEEP_ACTIVE = 3;
const CONTINUATION_DELAY_MS = 5_000;

const cleanupInput = v.object({
  sensoryTtlHours: v.optional(v.number()),
  strengthFloor: v.optional(v.float64()),
});

export const getMemoriesForCleanup = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    // Oldest-first so time-based expirations (sensory TTL) are guaranteed to be reached
    // before the MAX_BATCH cap cuts the scan off. Previously this used `by_user` which
    // returned rows in insertion order from the head — meaning on users with thousands
    // of healthy memories, the expired sensory rows past position 200 were never seen.
    return ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("asc")
      .filter((q) => q.eq(q.field("archived"), false))
      .take(args.limit);
  },
});

export const getAssociationsByFrom = internalQuery({
  args: { memoryId: v.id("crystalMemories"), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("crystalAssociations")
      .withIndex("by_from", (q: any) => q.eq("fromMemoryId", args.memoryId as never))
      .take(args.limit);
  },
});

export const getAssociationsByTo = internalQuery({
  args: { memoryId: v.id("crystalMemories"), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("crystalAssociations")
      .withIndex("by_to", (q: any) => q.eq("toMemoryId", args.memoryId as never))
      .take(args.limit);
  },
});

export const deleteAssociation = internalMutation({
  args: { associationId: v.id("crystalAssociations") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.associationId);
  },
});

export const deleteMemory = internalMutation({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing) return;

    if (existing.archived) {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        {
          totalMemoriesDelta: -1,
          archivedMemoriesDelta: -1,
        }
      );
    } else {
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

    await ctx.db.delete(args.memoryId);
  },
});

export const archiveWeakMemory = internalMutation({
  args: { memoryId: v.id("crystalMemories"), archivedAt: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing) return;

    if (!existing.archived) {
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
      await ctx.db.patch(args.memoryId, { archived: true, archivedAt: args.archivedAt });
      return;
    }

    await ctx.db.patch(args.memoryId, { archived: true, archivedAt: args.archivedAt ?? existing.archivedAt });
  },
});

export const getExpiredTelemetry = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("crystalTelemetry")
      .withIndex("by_expires", (q) => q.lte("expiresAt", args.now))
      .take(args.limit);
  },
});

export const deleteTelemetry = internalMutation({
  args: { telemetryId: v.id("crystalTelemetry") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.telemetryId);
  },
});

export const getExpiredDryRunEmails = internalQuery({
  args: { cutoff: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("crystalDryRunEmails")
      .withIndex("by_createdAt", (q) => q.lte("createdAt", args.cutoff))
      .take(args.limit);
  },
});

export const deleteDryRunEmail = internalMutation({
  args: { emailId: v.id("crystalDryRunEmails") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.emailId);
  },
});

const deleteAssociationsForMemory = async (ctx: any, memoryId: string) => {
  let deleted = 0;
  while (true) {
    const outgoing = await ctx.runQuery(internal.crystal.cleanup.getAssociationsByFrom, { memoryId, limit: 200 });
    for (const association of outgoing) {
      await ctx.runMutation(internal.crystal.cleanup.deleteAssociation, { associationId: association._id });
      deleted += 1;
    }
    if (outgoing.length < 200) break;
  }
  while (true) {
    const incoming = await ctx.runQuery(internal.crystal.cleanup.getAssociationsByTo, { memoryId, limit: 200 });
    for (const association of incoming) {
      await ctx.runMutation(internal.crystal.cleanup.deleteAssociation, { associationId: association._id });
      deleted += 1;
    }
    if (incoming.length < 200) break;
  }
  return deleted;
};

export const getWeakProceduralArchiveEligibility = (
  memory: { store: string; category: string; metadata?: string | null },
  now: number
) => {
  if (memory.store !== "procedural" || memory.category !== "workflow") {
    return false;
  }
  if (!memory.metadata) {
    return false;
  }

  try {
    const parsed = JSON.parse(memory.metadata) as {
      observationCount?: unknown;
      lastObserved?: unknown;
    };
    const observationCount = typeof parsed.observationCount === "number" ? parsed.observationCount : null;
    const lastObserved = typeof parsed.lastObserved === "number" ? parsed.lastObserved : null;
    if (observationCount === null || lastObserved === null) {
      return false;
    }
    return observationCount < MIN_PROCEDURAL_OBSERVATIONS_TO_KEEP_ACTIVE &&
      now - lastObserved >= PROCEDURAL_REINFORCEMENT_WINDOW_MS;
  } catch {
    return false;
  }
};

export const runCleanup = internalAction({
  args: cleanupInput,
  handler: async (ctx, args) => {
    const now = nowMs();
    const sensoryTtlMs = Math.max(args.sensoryTtlHours ?? 24, 1) * 60 * 60 * 1000;
    const strengthFloor = Math.max(args.strengthFloor ?? 0.1, 0);

    const userIds: string[] = await ctx.runQuery(internal.crystal.userProfiles.listAllUserIds, {});

    let deletedSensory = 0;
    let archivedByStrength = 0;
    let archivedWeakProcedurals = 0;
    let removedAssociations = 0;
    let deletedTelemetry = 0;
    let deletedDryRunEmails = 0;
    let errors = 0;
    let anyDeferred = false;

    const telemetryBatch = await ctx.runQuery(internal.crystal.cleanup.getExpiredTelemetry, {
      now,
      limit: MAX_BATCH + 1,
    });
    if (telemetryBatch.length > MAX_BATCH) {
      anyDeferred = true;
    }
    for (const telemetry of telemetryBatch.slice(0, MAX_BATCH)) {
      await ctx.runMutation(internal.crystal.cleanup.deleteTelemetry, { telemetryId: telemetry._id });
      deletedTelemetry += 1;
    }

    const dryRunEmailBatch = await ctx.runQuery(internal.crystal.cleanup.getExpiredDryRunEmails, {
      cutoff: now - 24 * 60 * 60 * 1000,
      limit: MAX_BATCH + 1,
    });
    if (dryRunEmailBatch.length > MAX_BATCH) {
      anyDeferred = true;
    }
    for (const email of dryRunEmailBatch.slice(0, MAX_BATCH)) {
      await ctx.runMutation(internal.crystal.cleanup.deleteDryRunEmail, { emailId: email._id });
      deletedDryRunEmails += 1;
    }

    for (const userId of userIds) {
      const memoryBatch: any[] = await ctx.runQuery(internal.crystal.cleanup.getMemoriesForCleanup, {
        userId,
        limit: MAX_BATCH + 1,
      });

      const memories = memoryBatch.slice(0, MAX_BATCH);
      const deferred = Math.max(0, memoryBatch.length - MAX_BATCH);
      if (deferred > 0) {
        anyDeferred = true;
        console.log(`[runCleanup] user ${userId}: deferred ${deferred} memories to next run`);
      }

      for (const memory of memories) {
        try {
          if (memory.knowledgeBaseId) {
            continue;
          }

          const isExpiredSensory = memory.store === "sensory" && now - memory.createdAt >= sensoryTtlMs;
          const isWeakMemory = memory.strength < strengthFloor;
          const shouldArchiveWeakProcedural = getWeakProceduralArchiveEligibility(memory, now);

          if (isExpiredSensory) {
            removedAssociations += await deleteAssociationsForMemory(ctx, memory._id);
            await ctx.runMutation(internal.crystal.cleanup.deleteMemory, { memoryId: memory._id });
            deletedSensory += 1;
            continue;
          }

          if (isWeakMemory) {
            await ctx.runMutation(internal.crystal.cleanup.archiveWeakMemory, { memoryId: memory._id, archivedAt: now });
            archivedByStrength += 1;
            continue;
          }

          if (shouldArchiveWeakProcedural) {
            await ctx.runMutation(internal.crystal.cleanup.archiveWeakMemory, { memoryId: memory._id, archivedAt: now });
            archivedWeakProcedurals += 1;
          }
        } catch (error) {
          errors += 1;
          console.log(`[runCleanup] failed to process memory ${memory._id}`, error);
        }
      }
    }

    // If any user had memories past the per-run cap, self-schedule a continuation so
    // retention contracts converge without waiting a full day for the next cron tick.
    // Guarded by the cron itself (runs every 24h) so a broken scheduler cannot loop forever.
    if (anyDeferred) {
      await ctx.scheduler.runAfter(CONTINUATION_DELAY_MS, internal.crystal.cleanup.runCleanup, {
        sensoryTtlHours: args.sensoryTtlHours,
        strengthFloor: args.strengthFloor,
      });
    }

    return {
      deleted: deletedSensory,
      archived: archivedByStrength,
      archivedWeakProcedurals,
      removedAssociations,
      deletedTelemetry,
      deletedDryRunEmails,
      errors,
      deferred: anyDeferred,
    };
  },
});
