import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isDistillationPaused } from "./distillationPause.helper";
import { logError, logLabel } from "./crypto";
import {
  isProactiveDistillationChannelEligible,
  MISSING_USER_OPENROUTER_KEY_REASON,
} from "./ltmExtraction";

/**
 * Reflection Cycle — Distillation phase (ADR 0008, ILL-180).
 *
 * One nightly job visits a bounded, rotating page of due messages and writes
 * one crystalReflectionRuns record for each unique user represented in that
 * page. The persisted index cursor prevents a large undistilled backlog (for
 * example, a tenant without credentials) from monopolizing every nightly run.
 * Each selected user gets its own action envelope.
 *
 * Forgetting (ILL-183) runs after Distillation per user, including users
 * Distillation skipped for a missing OpenRouter key. Enforcement is OFF
 * unless CRYSTAL_FORGETTING_ENFORCEMENT=1 — the nightly cycle then no-ops
 * Forgetting so this PR cannot archive production memories.
 */

const REFLECTION_CYCLE_TRIGGER = "reflection_cycle";
const DUE_MESSAGES_PAGE_SIZE = 500;
const DUE_USERS_PER_RUN = 100;
const DUE_MESSAGES_CURSOR_STATE_PREFIX = "due-users-v1:";
// Per-user message budget for one cycle run. Bounds a single user's backlog so
// it cannot starve the rest of the cycle; draining full historical backlogs is
// ILL-181's job. Matches the candidates query cap (MAX_MESSAGES_PER_USER=200)
// and sits well above the old 40-message proactive budget.
const DEFAULT_MESSAGES_PER_USER = 200;
const MAX_MESSAGES_PER_USER = 200;
const mockMemoryValidator = v.array(v.object({
  title: v.string(),
  content: v.string(),
  store: v.union(v.literal("episodic"), v.literal("semantic"), v.literal("procedural"), v.literal("prospective")),
  category: v.union(
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
  ),
  tags: v.array(v.string()),
  confidence: v.number(),
  strength: v.number(),
}));

type KeySource = "platform" | "user_byok" | "provider_export" | "manual" | "unknown";
type CostPayer = "company" | "user" | "unknown";
type DistillationTrigger = "reflection_cycle" | "session_distillation";

type CycleExtractionResult = {
  scanned: number;
  windows: number;
  inserted: number;
  deduped: number;
  skipped: number;
  blockedContentSkipped: number;
  discardedMessages: number;
  errors: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  reason?: string;
  waitUntil?: number;
  paused?: boolean;
};

type CycleCandidate = {
  _id: Id<"crystalMessages">;
  channel?: string;
};

type DueUserPage = {
  userIds: string[];
  continueCursor: string;
  isDone: boolean;
};

type DueUserCursorState = {
  scanCursor?: string;
  scanDone: boolean;
  pendingUserIds: string[];
};

export type DueUserSchedulingPlan = {
  needsQuery: boolean;
  queryCursor?: string;
  scheduledUserIds: string[];
  nextCursor?: string;
};

function decodeDueUserCursor(cursor: string | null): DueUserCursorState {
  if (!cursor?.startsWith(DUE_MESSAGES_CURSOR_STATE_PREFIX)) {
    return { scanCursor: cursor ?? undefined, scanDone: false, pendingUserIds: [] };
  }
  try {
    const value = JSON.parse(cursor.slice(DUE_MESSAGES_CURSOR_STATE_PREFIX.length));
    if (
      value?.version !== 1
      || typeof value.scanDone !== "boolean"
      || !Array.isArray(value.pendingUserIds)
      || value.pendingUserIds.some((userId: unknown) => typeof userId !== "string")
      || (value.scanCursor !== undefined && typeof value.scanCursor !== "string")
    ) {
      throw new Error("invalid due-user cursor state");
    }
    return {
      scanCursor: value.scanCursor,
      scanDone: value.scanDone,
      pendingUserIds: value.pendingUserIds,
    };
  } catch {
    // Fail closed to a fresh rotation rather than passing corrupt application
    // state to Convex as an opaque pagination cursor.
    return { scanDone: false, pendingUserIds: [] };
  }
}

function encodeDueUserCursor(state: DueUserCursorState): string | undefined {
  if (state.pendingUserIds.length === 0) {
    return state.scanDone ? undefined : state.scanCursor;
  }
  return `${DUE_MESSAGES_CURSOR_STATE_PREFIX}${JSON.stringify({
    version: 1,
    scanCursor: state.scanCursor,
    scanDone: state.scanDone,
    pendingUserIds: state.pendingUserIds,
  })}`;
}

/**
 * Select one bounded tenant batch while retaining overflow from a scanned page.
 * Calling without a page tells the orchestrator whether another indexed scan is
 * needed. A page may contain up to 500 distinct tenants, but every returned
 * scheduling batch is capped at 100 and the remainder is carried deterministically.
 */
export function planDueUserScheduling(
  storedCursor: string | null,
  duePage?: DueUserPage,
): DueUserSchedulingPlan {
  const state = decodeDueUserCursor(storedCursor);
  if (state.pendingUserIds.length > 0) {
    const scheduledUserIds = state.pendingUserIds.slice(0, DUE_USERS_PER_RUN);
    return {
      needsQuery: false,
      scheduledUserIds,
      nextCursor: encodeDueUserCursor({
        scanCursor: state.scanCursor,
        scanDone: state.scanDone,
        pendingUserIds: state.pendingUserIds.slice(DUE_USERS_PER_RUN),
      }),
    };
  }
  if (!duePage) {
    return {
      needsQuery: true,
      queryCursor: state.scanCursor,
      scheduledUserIds: [],
    };
  }
  const scheduledUserIds = duePage.userIds.slice(0, DUE_USERS_PER_RUN);
  return {
    needsQuery: false,
    scheduledUserIds,
    nextCursor: encodeDueUserCursor({
      scanCursor: duePage.continueCursor,
      scanDone: duePage.isDone,
      pendingUserIds: duePage.userIds.slice(DUE_USERS_PER_RUN),
    }),
  };
}

export type ReflectionCycleUserResult = {
  userId: string;
  reflectionRunId?: string;
  candidates: number;
  scoped: number;
  unscoped: number;
  skipped: number;
  inserted?: number;
  deduped?: number;
  discardedMessages?: number;
  errors?: number;
  estimatedCostUsd?: number;
  windows?: number;
  waitUntil?: number;
  reason?: string;
  error?: string;
  forgetting?: {
    archived?: number;
    skipped?: boolean;
    reason?: string;
    error?: string;
  };
};

const zeroExtractionResult: CycleExtractionResult = {
  scanned: 0,
  windows: 0,
  inserted: 0,
  deduped: 0,
  skipped: 0,
  blockedContentSkipped: 0,
  discardedMessages: 0,
  errors: 0,
  estimatedInputTokens: 0,
  estimatedOutputTokens: 0,
  estimatedCostUsd: 0,
};

function attributionForSource(source: "personal" | "shared" | null): {
  keySource: KeySource;
  payer: CostPayer;
} {
  if (source === "personal") return { keySource: "user_byok", payer: "user" };
  if (source === "shared") return { keySource: "platform", payer: "company" };
  return { keySource: "unknown", payer: "unknown" };
}

function clampMessagesPerUser(value: number | undefined): number {
  const raw = Number.isFinite(value ?? NaN) ? Math.trunc(value as number) : NaN;
  if (!Number.isFinite(raw)) return DEFAULT_MESSAGES_PER_USER;
  return Math.min(Math.max(raw, 1), MAX_MESSAGES_PER_USER);
}

type ForgettingSummary = NonNullable<ReflectionCycleUserResult["forgetting"]>;

/**
 * Forgetting is not credential-gated. Distillation needs an OpenRouter key;
 * Forgetting does not. Missing-key and Distillation-error users still get a
 * cycle slot. The call omits `enforce`, so default OFF returns
 * enforcement_off before reading candidates.
 */
async function runForgettingAfterDistillation(
  ctx: { runAction: (fn: any, args?: any) => Promise<any> },
  args: { userId: string; now: number; dryRun?: boolean },
): Promise<ForgettingSummary> {
  try {
    return (await ctx.runAction(internal.crystal.forgetting.runForgettingForUser, {
      userId: args.userId,
      now: args.now,
      dryRun: args.dryRun,
    })) as ForgettingSummary;
  } catch (forgettingError) {
    const message = forgettingError instanceof Error ? forgettingError.message : String(forgettingError);
    console.error("[reflectionCycle] forgetting failed", {
      userId: await logLabel(args.userId),
      error: await logError(forgettingError, args.userId),
    });
    return { error: message.slice(0, 500) };
  }
}

export const runDistillationForUser = internalAction({
  args: {
    userId: v.string(),
    now: v.optional(v.number()),
    messagesPerUser: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    mockMemories: v.optional(mockMemoryValidator),
    trigger: v.optional(v.union(v.literal("reflection_cycle"), v.literal("session_distillation"))),
    sessionKey: v.optional(v.string()),
    maxWindows: v.optional(v.number()),
    skipForgetting: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ReflectionCycleUserResult> => {
    const now = args.now ?? Date.now();
    const messagesPerUser = clampMessagesPerUser(args.messagesPerUser);
    const trigger: DistillationTrigger = args.trigger ?? REFLECTION_CYCLE_TRIGGER;

    const tierInfo = await ctx.runQuery(
      (internal as any).crystal.userProfiles.getUserTierInfo,
      { userId: args.userId },
    ).catch(() => ({ tier: "unknown", sensoryRawTtlDays: 7 })) as { tier: string; sensoryRawTtlDays: number };

    // Fail closed on credential lookup errors: never fall through to a shared /
    // platform key. A thrown resolve is treated as "no personal key".
    const credential = await ctx.runQuery(
      (internal as any).crystal.providerSettings.resolveOpenRouterKeyForUser,
      { userId: args.userId, includeShared: false },
    ).catch(() => ({ apiKey: null, source: null })) as {
      apiKey: string | null;
      source: "personal" | "shared" | null;
    };

    // Distillation uses the account's own OpenRouter credential only. A user
    // without one is skipped and recorded (keySource/payer "unknown") — never
    // billed to the platform.
    const attribution = attributionForSource(credential.source);
    const model = await ctx.runQuery(internal.crystal.distillationModels.getForUser, { userId: args.userId });
    const reflectionRunId = await ctx.runMutation(
      internal.crystal.reflectionLog.createRun,
      {
        userId: args.userId,
        trigger,
        tier: tierInfo.tier,
        sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
        dryRun: args.dryRun,
        costProvider: "openrouter",
        costModel: model.modelId,
        keySource: attribution.keySource,
        payer: attribution.payer,
        metadata: JSON.stringify({
          source: trigger,
          progressUpdatedAt: now,
        }),
      },
    ) as Id<"crystalReflectionRuns">;

    const finishRun = async (payload: { status: "running" | "completed" | "failed" } & Record<string, unknown>) => {
      await ctx.runMutation(internal.crystal.reflectionLog.finishRun, {
        runId: reflectionRunId,
        ...payload,
      }).catch(() => {});
    };

    // Everything after createRun is wrapped so a mid-flight failure still
    // finishes the reflection_cycle record (Req 9 / AC5). The outer cycle loop
    // must not leave users with stuck "running" rows and no completed slot.
    let result: ReflectionCycleUserResult;
    try {
      if (!args.mockMemories && !credential.apiKey) {
        await finishRun({
          status: "completed",
          skipped: 1,
          errorMessage: MISSING_USER_OPENROUTER_KEY_REASON,
          keySource: attribution.keySource,
          payer: attribution.payer,
          estimatedCostUsd: 0,
          metadata: JSON.stringify({
            source: trigger,
            reason: MISSING_USER_OPENROUTER_KEY_REASON,
            progressUpdatedAt: Date.now(),
          }),
        });
        result = {
          userId: args.userId,
          reflectionRunId,
          candidates: 0,
          scoped: 0,
          unscoped: 0,
          skipped: 1,
          reason: MISSING_USER_OPENROUTER_KEY_REASON,
        };
      } else {
        const candidates = await ctx.runQuery(
          (internal as any).crystal.ltmExtraction.getReflectionCycleCandidates,
          { userId: args.userId, beforeTimestamp: now, limit: messagesPerUser, sessionKey: args.sessionKey },
        ) as CycleCandidate[];

        // Fail-closed channel eligibility: messages that cannot be scoped safely
        // (missing channel or ambiguous bare peer/group scopes) are terminally
        // skipped as unscoped_channel, never distilled, never recalled, and
        // deleted at TTL with no capsule (ILL-190 residual policy).
        const scoped = candidates.filter((message) => isProactiveDistillationChannelEligible(message.channel));
        const unscoped = candidates.filter((message) => !isProactiveDistillationChannelEligible(message.channel));

        if (!args.dryRun && unscoped.length > 0) {
          await ctx.runMutation(internal.crystal.messages.markMessagesLtmExtracted, {
            messageIds: unscoped.map((message) => message._id),
            extractedAt: now,
            skippedReason: "unscoped_channel",
          });
        }

        const extraction: CycleExtractionResult = scoped.length > 0
          ? await ctx.runAction(
              (internal as any).crystal.ltmExtraction.runOnDemandLtmExtraction,
              {
                userId: args.userId,
                messageIds: scoped.map((message) => message._id),
                dryRun: args.dryRun,
                bypassThrottle: true,
                context: "reflection_cycle",
                reflectionRunId,
                mockMemories: args.mockMemories,
                maxWindows: args.maxWindows,
              },
            ) as CycleExtractionResult
          : { ...zeroExtractionResult };

        await finishRun({
          status: extraction.errors > 0 ? "failed" : "completed",
          messagesProcessed: unscoped.length + extraction.scanned,
          memoriesCreated: extraction.inserted,
          deduped: extraction.deduped,
          messagesDiscarded: unscoped.length + extraction.discardedMessages,
          skipped: extraction.skipped + unscoped.length,
          errors: extraction.errors,
          estimatedInputTokens: extraction.estimatedInputTokens,
          estimatedOutputTokens: extraction.estimatedOutputTokens,
          estimatedCostUsd: extraction.estimatedCostUsd,
          costProvider: "openrouter",
          costModel: model.modelId,
          keySource: attribution.keySource,
          payer: attribution.payer,
          metadata: JSON.stringify({
            source: trigger,
            beforeTimestamp: now,
            messagesPerUser,
            unscopedSkipped: unscoped.length,
            windows: extraction.windows,
            progressUpdatedAt: Date.now(),
            reason: extraction.reason,
          }),
          errorMessage: extraction.errors > 0 ? "One or more extraction windows failed" : undefined,
        });

        result = {
          userId: args.userId,
          reflectionRunId,
          candidates: candidates.length,
          scoped: scoped.length,
          unscoped: unscoped.length,
          ...extraction,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await finishRun({
        status: "failed",
        errors: 1,
        errorMessage: errorMessage.slice(0, 500),
        keySource: attribution.keySource,
        payer: attribution.payer,
        estimatedCostUsd: 0,
        costProvider: "openrouter",
        costModel: model.modelId,
        metadata: JSON.stringify({
          source: trigger,
          progressUpdatedAt: Date.now(),
          reason: errorMessage.slice(0, 500),
        }),
      });
      result = {
        userId: args.userId,
        reflectionRunId,
        candidates: 0,
        scoped: 0,
        unscoped: 0,
        skipped: 1,
        error: errorMessage,
      };
    }

    // After Distillation (including missing-key skip / Distillation error).
    // Omits enforce. A Forgetting failure must not rewrite the run record.
    if (!args.skipForgetting) result.forgetting = await runForgettingAfterDistillation(ctx, {
      userId: args.userId,
      now,
      dryRun: args.dryRun,
    });
    return result;
  },
});

export const runReflectionCycle = internalAction({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.string()),
    messagesPerUser: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    mockMemories: v.optional(mockMemoryValidator),
  },
  handler: async (ctx, args): Promise<{ users: number; scheduledUsers: number }> => {
    if (isDistillationPaused()) return { users: 0, scheduledUsers: 0 };
    const now = args.now ?? Date.now();
    // Each scan owns its continuation. Overlapping scans may enqueue the same
    // tenant idempotently, but cannot overwrite one another's cursor.
    const storedCursor = args.cursor ?? null;
    const initialPlan = planDueUserScheduling(storedCursor);
    const plan = initialPlan.needsQuery
      ? planDueUserScheduling(
          storedCursor,
          await ctx.runQuery(
            (internal as any).crystal.ltmExtraction.getDueDistillationUserIds,
            {
              beforeTimestamp: now,
              limit: DUE_MESSAGES_PAGE_SIZE,
              cursor: initialPlan.queryCursor,
            },
          ) as DueUserPage,
        )
      : initialPlan;
    const userIds = plan.scheduledUserIds;

    for (const userId of userIds) {
      if (!args.dryRun) await ctx.runMutation(internal.crystal.distillationQueue.enqueue, { userId, cutoff: now });
    }
    if (!args.dryRun && plan.nextCursor && !isDistillationPaused()) await ctx.scheduler.runAfter(1000, internal.crystal.reflectionCycle.runReflectionCycle, { now, cursor: plan.nextCursor });
    return { users: userIds.length, scheduledUsers: userIds.length };
  },
});
