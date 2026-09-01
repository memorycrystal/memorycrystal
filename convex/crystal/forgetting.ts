import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getMemoryAllowance } from "../../shared/tierLimits";
import {
  applyDashboardTotalsDelta,
  buildMemoryTransitionDelta,
  getNonKbActiveMemories,
} from "./dashboardTotals";
import { archiveMemoryAndSyncCleanupProjection } from "./cleanupProjection";

/**
 * ILL-183 — Forgetting phase of the Reflection Cycle.
 *
 * After Distillation, if an account is past its non-KB Memory Allowance,
 * archive exactly the overage, lowest Memory Value first. Never touches KB
 * chunks. Never touches memories younger than one Reflection Cycle (~24h).
 *
 * Enforcement is OFF unless CRYSTAL_FORGETTING_ENFORCEMENT=1 or a caller
 * passes enforce:true. Dry-run reports the would-archive list and writes
 * nothing. Production dry-run + flip is an operator step after this ships.
 */

export const FORGETTING_ENFORCEMENT_ENV = "CRYSTAL_FORGETTING_ENFORCEMENT";
export const REFLECTION_CYCLE_MS = 24 * 60 * 60 * 1000;
export const RECENCY_DECAY_LAMBDA = 0.05;
export const ACCESS_COUNT_SATURATION = 20;
export const CANDIDATE_PAGE_SIZE = 250;
export const MAX_CANDIDATE_PAGES = 8;
export const ARCHIVE_BATCH_SIZE = 50;

export const MEMORY_VALUE_WEIGHTS = {
  strength: 0.45,
  recency: 0.25,
  access: 0.3,
} as const;

export function isForgettingEnforcementEnabled(): boolean {
  return process.env[FORGETTING_ENFORCEMENT_ENV] === "1";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Decayed recency of genuine recall. Never-recalled memories score 0. */
export function genuineRecallRecencyScore(
  lastRecalledAt: number | undefined,
  now: number,
): number {
  if (lastRecalledAt == null || !Number.isFinite(lastRecalledAt)) return 0;
  const ageDays = Math.max(0, (now - lastRecalledAt) / 86_400_000);
  return Math.exp(-RECENCY_DECAY_LAMBDA * ageDays);
}

/** Saturating access-count score: 0 → 0, 50 → ~0.918, 100 → ~0.993. */
export function accessCountScore(accessCount: number): number {
  const count = Math.max(0, Number.isFinite(accessCount) ? accessCount : 0);
  return 1 - Math.exp(-count / ACCESS_COUNT_SATURATION);
}

/**
 * Memory Value = 0.45·strength + 0.25·genuine-recall recency + 0.30·accessCount.
 *
 * Weights: strength is the existing usefulness signal; accessCount is the
 * missing "proven use" term that inverts the old lastAccessedAt-at-creation
 * bias; recency of lastRecalledAt is a smaller term so a 50-recall memory
 * idle for 60 days still outranks a never-recalled 90-day-old peer.
 */
export function computeMemoryValue(input: {
  strength: number;
  accessCount: number;
  lastRecalledAt?: number;
  now: number;
}): number {
  return (
    MEMORY_VALUE_WEIGHTS.strength * clamp01(input.strength) +
    MEMORY_VALUE_WEIGHTS.recency * genuineRecallRecencyScore(input.lastRecalledAt, input.now) +
    MEMORY_VALUE_WEIGHTS.access * accessCountScore(input.accessCount)
  );
}

export function isYoungerThanOneCycle(createdAt: number, now: number): boolean {
  return createdAt > now - REFLECTION_CYCLE_MS;
}

export function forgettingOverage(nonKbActive: number, allowance: number): number {
  return Math.max(0, nonKbActive - allowance);
}

export function compareForgettingCandidates(
  a: { memoryValue: number; createdAt: number; memoryId: string },
  b: { memoryValue: number; createdAt: number; memoryId: string },
): number {
  if (a.memoryValue !== b.memoryValue) return a.memoryValue - b.memoryValue;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
}

export function candidateScoreLimit(overage: number): number {
  return Math.min(Math.max(overage * 8, 200), CANDIDATE_PAGE_SIZE * MAX_CANDIDATE_PAGES);
}

const forgettingCandidateValidator = v.object({
  memoryId: v.id("crystalMemories"),
  title: v.string(),
  memoryValue: v.number(),
  strength: v.number(),
  accessCount: v.number(),
  lastRecalledAt: v.optional(v.number()),
  createdAt: v.number(),
});

export const forgettingUserResultValidator = v.object({
  userId: v.string(),
  dryRun: v.boolean(),
  skipped: v.boolean(),
  reason: v.optional(v.string()),
  nonKbActive: v.number(),
  allowance: v.number(),
  overage: v.number(),
  archived: v.number(),
  wouldArchive: v.array(forgettingCandidateValidator),
});

export type ForgettingCandidate = {
  memoryId: Id<"crystalMemories">;
  title: string;
  memoryValue: number;
  strength: number;
  accessCount: number;
  lastRecalledAt?: number;
  createdAt: number;
};

export type ForgettingUserResult = {
  userId: string;
  dryRun: boolean;
  skipped: boolean;
  reason?: string;
  nonKbActive: number;
  allowance: number;
  overage: number;
  archived: number;
  wouldArchive: ForgettingCandidate[];
};

function skippedResult(userId: string, reason: string): ForgettingUserResult {
  return {
    userId,
    dryRun: false,
    skipped: true,
    reason,
    nonKbActive: 0,
    allowance: 0,
    overage: 0,
    archived: 0,
    wouldArchive: [],
  };
}

export const getNonKbActiveMemoryCount = internalQuery({
  args: { userId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => getNonKbActiveMemories(ctx, args.userId),
});

export const listForgettingCandidatePage = internalQuery({
  args: {
    userId: v.string(),
    now: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    candidates: v.array(forgettingCandidateValidator),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(Math.trunc(args.numItems ?? CANDIDATE_PAGE_SIZE), 1),
      CANDIDATE_PAGE_SIZE,
    );
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_archived_last_accessed", (q) =>
        q.eq("userId", args.userId).eq("archived", false),
      )
      .order("asc")
      .paginate({ numItems, cursor: args.cursor ?? null });

    const candidates: ForgettingCandidate[] = [];
    for (const memory of page.page) {
      if (memory.knowledgeBaseId) continue;
      if (isYoungerThanOneCycle(memory.createdAt, args.now)) continue;
      candidates.push({
        memoryId: memory._id,
        title: memory.title,
        memoryValue: computeMemoryValue({
          strength: memory.strength,
          accessCount: memory.accessCount,
          lastRecalledAt: memory.lastRecalledAt,
          now: args.now,
        }),
        strength: memory.strength,
        accessCount: memory.accessCount,
        lastRecalledAt: memory.lastRecalledAt,
        createdAt: memory.createdAt,
      });
    }

    return {
      candidates,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const archiveForgettingMemories = internalMutation({
  args: {
    memoryIds: v.array(v.id("crystalMemories")),
    now: v.number(),
  },
  returns: v.object({ archived: v.number() }),
  handler: async (ctx, args) => {
    let archived = 0;
    for (const memoryId of args.memoryIds) {
      const memory = await ctx.db.get(memoryId);
      if (!memory || memory.archived || memory.knowledgeBaseId) continue;
      if (isYoungerThanOneCycle(memory.createdAt, args.now)) continue;
      await archiveMemoryAndSyncCleanupProjection(ctx, memory, args.now);
      await applyDashboardTotalsDelta(
        ctx,
        memory.userId,
        buildMemoryTransitionDelta({
          oldArchived: false,
          oldStore: memory.store,
          oldGraphEnriched: memory.graphEnriched === true,
          oldEnrichmentSkippedReason: memory.enrichmentSkippedReason,
          oldAccessCount: memory.accessCount,
          oldKnowledgeBaseId: memory.knowledgeBaseId,
          newArchived: true,
          newStore: memory.store,
          newGraphEnriched: memory.graphEnriched === true,
          newEnrichmentSkippedReason: memory.enrichmentSkippedReason,
          newAccessCount: memory.accessCount,
        }),
      );
      archived += 1;
    }
    return { archived };
  },
});

async function selectLowestValueCandidates(
  ctx: { runQuery: (fn: any, args?: any) => Promise<any> },
  args: { userId: string; now: number; overage: number },
): Promise<ForgettingCandidate[]> {
  const scored: ForgettingCandidate[] = [];
  const scoreLimit = candidateScoreLimit(args.overage);
  let cursor: string | null = null;
  let isDone = false;
  let pages = 0;

  while (!isDone && pages < MAX_CANDIDATE_PAGES && scored.length < scoreLimit) {
    const page = (await ctx.runQuery(internal.crystal.forgetting.listForgettingCandidatePage, {
      userId: args.userId,
      now: args.now,
      cursor,
      numItems: CANDIDATE_PAGE_SIZE,
    })) as {
      candidates: ForgettingCandidate[];
      continueCursor: string;
      isDone: boolean;
    };
    scored.push(...page.candidates);
    isDone = page.isDone;
    cursor = page.continueCursor;
    pages += 1;
  }

  scored.sort(compareForgettingCandidates);
  return scored.slice(0, args.overage);
}

export const runForgettingForUser = internalAction({
  args: {
    userId: v.string(),
    now: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    enforce: v.optional(v.boolean()),
  },
  returns: forgettingUserResultValidator,
  handler: async (ctx, args): Promise<ForgettingUserResult> => {
    const now = args.now ?? Date.now();
    const dryRun = args.dryRun === true;
    const enforce = args.enforce === true || isForgettingEnforcementEnabled();
    if (!dryRun && !enforce) {
      return skippedResult(args.userId, "enforcement_off");
    }

    const tier = (await ctx.runQuery(internal.crystal.userProfiles.getUserTier, {
      userId: args.userId,
    })) as string;
    const allowance = getMemoryAllowance(tier);
    const nonKbActive = (await ctx.runQuery(
      internal.crystal.forgetting.getNonKbActiveMemoryCount,
      { userId: args.userId },
    )) as number;
    const overage = forgettingOverage(nonKbActive, allowance);
    if (overage <= 0) {
      return {
        userId: args.userId,
        dryRun,
        skipped: false,
        nonKbActive,
        allowance,
        overage: 0,
        archived: 0,
        wouldArchive: [],
      };
    }

    const wouldArchive = await selectLowestValueCandidates(ctx, {
      userId: args.userId,
      now,
      overage,
    });

    let archived = 0;
    if (!dryRun) {
      for (let i = 0; i < wouldArchive.length; i += ARCHIVE_BATCH_SIZE) {
        const batch = wouldArchive.slice(i, i + ARCHIVE_BATCH_SIZE).map((row) => row.memoryId);
        const result = (await ctx.runMutation(internal.crystal.forgetting.archiveForgettingMemories, {
          memoryIds: batch,
          now,
        })) as { archived: number };
        archived += result.archived;
      }
    }

    return {
      userId: args.userId,
      dryRun,
      skipped: false,
      nonKbActive,
      allowance,
      overage,
      archived,
      wouldArchive,
    };
  },
});

export const runForgettingDryRun = internalAction({
  args: {
    userId: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.literal(true),
    accounts: v.array(forgettingUserResultValidator),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const accounts: ForgettingUserResult[] = [];

    if (args.userId) {
      accounts.push(
        (await ctx.runAction(internal.crystal.forgetting.runForgettingForUser, {
          userId: args.userId,
          now,
          dryRun: true,
        })) as ForgettingUserResult,
      );
      return { dryRun: true as const, accounts };
    }

    const seenUserIds = new Set<string>();
    let cursor: string | undefined;
    let isDone = false;
    while (!isDone) {
      const page = (await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
        cursor,
        numItems: 200,
      })) as { userIds: string[]; continueCursor: string; isDone: boolean };
      isDone = page.isDone;
      cursor = page.continueCursor;
      for (const userId of page.userIds) {
        if (seenUserIds.has(userId)) continue;
        seenUserIds.add(userId);
        accounts.push(
          (await ctx.runAction(internal.crystal.forgetting.runForgettingForUser, {
            userId,
            now,
            dryRun: true,
          })) as ForgettingUserResult,
        );
      }
    }

    return { dryRun: true as const, accounts };
  },
});
