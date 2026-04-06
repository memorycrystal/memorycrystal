/**
 * Admin mutations for Organic Memory provisioning.
 * Public queries/mutations for the dashboard Organic tab.
 * Separate from tick.ts to avoid bundler issues with mixed internal/public exports.
 */
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { Doc, Id } from "../../_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, MutationCtx, QueryCtx } from "../../_generated/server";
import { stableUserId } from "../auth";
import {
  clampTickIntervalMs,
  DEFAULT_TICK_INTERVAL_MS,
  estimateRunsPerPeriod,
  PULSE_INTERVAL_TIERS_MS,
  roundUsd,
} from "./spend";
import { MODEL_PRESETS, MODEL_PRESET_KEYS, getModelPreset } from "./models";

type SkillPatternType = "workflow" | "problem_solving" | "decision_chain";

function shouldAutoQueueOrganicTick() {
  return !(typeof process !== "undefined" && process.env.VITEST);
}

function parseSkillMetadata(metadata?: string | null): {
  skillFormat: true;
  triggerConditions: string[];
  steps: Array<{ order: number; action: string; command?: string }>;
  pitfalls: string[];
  verification: string;
  patternType: SkillPatternType;
  observationCount: number;
  lastObserved: number;
} | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    if (parsed.skillFormat !== true) return null;
    const patternType = parsed.patternType;
    return {
      skillFormat: true,
      triggerConditions: Array.isArray(parsed.triggerConditions)
        ? parsed.triggerConditions.filter((item): item is string => typeof item === "string")
        : [],
      steps: Array.isArray(parsed.steps)
        ? parsed.steps
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            .map((step, index) => ({
              order: typeof step.order === "number" ? step.order : index + 1,
              action: typeof step.action === "string" ? step.action : "",
              ...(typeof step.command === "string" ? { command: step.command } : {}),
            }))
            .filter((step) => step.action.length > 0)
        : [],
      pitfalls: Array.isArray(parsed.pitfalls)
        ? parsed.pitfalls.filter((item): item is string => typeof item === "string")
        : [],
      verification: typeof parsed.verification === "string" ? parsed.verification : "",
      patternType:
        patternType === "problem_solving" || patternType === "decision_chain" ? patternType : "workflow",
      observationCount:
        typeof parsed.observationCount === "number" ? Math.max(1, Math.round(parsed.observationCount)) : 1,
      lastObserved: typeof parsed.lastObserved === "number" ? parsed.lastObserved : 0,
    };
  } catch {
    return null;
  }
}

function toPulseState(tickState: {
  enabled: boolean;
  lastTickAt: number;
  tickCount: number;
  totalTracesGenerated: number;
  totalTracesValidated: number;
  hitRate: number;
  tickIntervalMs: number;
  isRunning: boolean;
  organicModel?: string;
  notificationEmail: boolean;
  notificationEmailDelay?: number;
  ideaFrequency?: string;
}) {
  return {
    enabled: tickState.enabled,
    lastPulseAt: tickState.lastTickAt,
    pulseCount: tickState.tickCount,
    totalTracesGenerated: tickState.totalTracesGenerated,
    totalTracesValidated: tickState.totalTracesValidated,
    hitRate: tickState.hitRate,
    pulseIntervalMs: tickState.tickIntervalMs,
    isRunning: tickState.isRunning,
    organicModel: tickState.organicModel,
    notificationEmail: tickState.notificationEmail,
    notificationEmailDelay: tickState.notificationEmailDelay,
    ideaFrequency: tickState.ideaFrequency,
  };
}

async function updateOrganicInterval(
  ctx: MutationCtx,
  userId: string,
  intervalMs: number
) {
  const tickState = await ctx.db
    .query("organicTickState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  if (!tickState || !tickState.enabled) {
    throw new Error("Organic Memory is not enabled");
  }

  const tickIntervalMs = clampTickIntervalMs(intervalMs);
  await ctx.db.patch(tickState._id, {
    tickIntervalMs,
    updatedAt: Date.now(),
  });

  // Kick off a self-scheduled tick immediately so the new interval takes effect
  const now = Date.now();
  const leaseActive = Boolean(tickState.isRunning && (tickState.leaseExpiresAt ?? 0) > now);
  if (!leaseActive && shouldAutoQueueOrganicTick()) {
    try {
      await ctx.scheduler.runAfter(0, internal.crystal.organic.tick.processUserTick, {
        userId,
        lastTickAt: tickState.lastTickAt,
        triggerSource: "scheduled" as const,
        tickIntervalMs,
      });
    } catch {
      // scheduler may not be available in test environments
    }
  }

  return { tickIntervalMs };
}

async function getMyOrganicDashboardData(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const userId = stableUserId(identity.subject);

  const tickState = await ctx.db
    .query("organicTickState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  if (!tickState || !tickState.enabled) return null;

  const normalizedTickState = {
    enabled: tickState.enabled,
    lastTickAt: tickState.lastTickAt,
    tickCount: tickState.tickCount,
    totalTracesGenerated: tickState.totalTracesGenerated,
    totalTracesValidated: tickState.totalTracesValidated,
    hitRate: tickState.hitRate,
    tickIntervalMs: tickState.tickIntervalMs,
    isRunning: "isRunning" in tickState ? tickState.isRunning ?? false : false,
    organicModel: tickState.organicModel,
    notificationEmail: tickState.notificationEmail ?? false,
    notificationEmailDelay: tickState.notificationEmailDelay,
    ideaFrequency: tickState.ideaFrequency,
  };

  // All ensembles (archived=false)
  const ensembles = await ctx.db
    .query("organicEnsembles")
    .withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", false))
    .take(500);

  // Conflict groups = contradictions (filter out empty groups with no members)
  const conflictGroups = ensembles.filter((e) => e.ensembleType === "conflict_group" && e.memberMemoryIds.length > 0);
  const clusterEnsembles = ensembles.filter((e) => e.ensembleType !== "conflict_group" && e.memberMemoryIds.length > 0);

  // Active traces (not yet expired, validated === null means still pending)
  const now = Date.now();
  const traces = await ctx.db
    .query("organicProspectiveTraces")
    .withIndex("by_user_expires", (q) =>
      q.eq("userId", userId).gt("expiresAt", now)
    )
    .take(1000);
  const activeTraces = traces.filter((t) => t.validated === null);

  // Recent activity (last 20 entries)
  const activity = await ctx.db
    .query("organicActivityLog")
    .withIndex("by_user_time", (q) => q.eq("userId", userId))
    .order("desc")
    .take(20);

  const recentRuns = await ctx.db
    .query("organicTickRuns")
    .withIndex("by_user_started", (q) => q.eq("userId", userId))
    .order("desc")
    .take(20);
  const completedRuns = recentRuns.filter((run) => run.status === "completed");
  const completedRunCount = completedRuns.length;

  // Compute average token usage so spend cards can re-price when model changes
  const totalInputTokens = completedRuns.reduce((sum, run) => sum + run.estimatedInputTokens, 0);
  const totalOutputTokens = completedRuns.reduce((sum, run) => sum + run.estimatedOutputTokens, 0);
  const avgInputTokens = completedRunCount > 0 ? totalInputTokens / completedRunCount : 0;
  const avgOutputTokens = completedRunCount > 0 ? totalOutputTokens / completedRunCount : 0;

  // Project cost using the currently-selected model's rates
  const currentPreset = getModelPreset(normalizedTickState.organicModel);
  const projectedAvgCost = completedRunCount > 0
    ? (avgInputTokens / 1_000_000) * currentPreset.inputCostPer1M +
      (avgOutputTokens / 1_000_000) * currentPreset.outputCostPer1M
    : 0;

  const estimatedRuns = estimateRunsPerPeriod(normalizedTickState.tickIntervalMs);

  return {
    tickState: normalizedTickState,
    pulseState: toPulseState(normalizedTickState),
    spend: {
      averageTickCostUsd: roundUsd(projectedAvgCost),
      estimatedDailyCostUsd: roundUsd(projectedAvgCost * estimatedRuns.daily),
      estimatedWeeklyCostUsd: roundUsd(projectedAvgCost * estimatedRuns.weekly),
      estimatedMonthlyCostUsd: roundUsd(projectedAvgCost * estimatedRuns.monthly),
      completedRunCount,
      averagePulseCostUsd: roundUsd(projectedAvgCost),
      estimatedDailyPulseCostUsd: roundUsd(projectedAvgCost * estimatedRuns.daily),
      estimatedWeeklyPulseCostUsd: roundUsd(projectedAvgCost * estimatedRuns.weekly),
      estimatedMonthlyPulseCostUsd: roundUsd(projectedAvgCost * estimatedRuns.monthly),
      // Average token usage for client-side re-projection if needed
      avgInputTokens: Math.round(avgInputTokens),
      avgOutputTokens: Math.round(avgOutputTokens),
    },
    modelPresets: Object.values(MODEL_PRESETS).map((p) => ({
      key: p.key,
      label: p.label,
      provider: p.provider,
      inputCostPer1M: p.inputCostPer1M,
      outputCostPer1M: p.outputCostPer1M,
    })),
    pulseIntervalTiers: PULSE_INTERVAL_TIERS_MS,
    hasOpenRouterKey: Boolean(tickState.openrouterApiKey),
    openRouterKeyPrefix: tickState.openrouterApiKey ? tickState.openrouterApiKey.slice(0, 8) + "..." : null,
    ensembleCount: clusterEnsembles.length,
    activeTraceCount: activeTraces.length,
    contradictionCount: conflictGroups.length,
    recentActivity: activity.map((a) => ({
      _id: a._id,
      eventType: a.eventType,
      timestamp: a.timestamp,
      memoryId: a.memoryId,
      metadata: a.metadata ?? null,
    })),
    topEnsembles: clusterEnsembles
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5)
      .map((e) => ({
        _id: e._id,
        label: e.label,
        memberCount: e.memberMemoryIds.length,
        ensembleType: e.ensembleType,
        updatedAt: e.updatedAt,
        strength: e.strength,
      })),
    activeTraces: activeTraces.slice(0, 10).map((t) => ({
      _id: t._id,
      predictedQuery: t.predictedQuery,
      predictedContext: t.predictedContext,
      confidence: t.confidence,
      expiresAt: t.expiresAt,
      traceType: t.traceType,
      sourcePattern: t.sourcePattern,
      createdAt: t._creationTime,
    })),
    conflictGroups: conflictGroups.slice(0, 5).map((e) => ({
      _id: e._id,
      label: e.label,
      memberCount: e.memberMemoryIds.length,
      updatedAt: e.updatedAt,
      strength: e.strength,
    })),
    recentRuns: recentRuns.map((run) => ({
      _id: run._id,
      tickId: run.tickId,
      pulseId: run.tickId,
      triggerSource: run.triggerSource,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? null,
      durationMs: run.durationMs ?? null,
      tickIntervalMs: run.tickIntervalMs,
      pulseIntervalMs: run.tickIntervalMs,
      tracesGenerated: run.tracesGenerated,
      tracesValidated: run.tracesValidated,
      tracesExpired: run.tracesExpired,
      estimatedInputTokens: run.estimatedInputTokens,
      estimatedOutputTokens: run.estimatedOutputTokens,
      estimatedCostUsd: run.estimatedCostUsd,
      contradictionChecks: run.contradictionChecks,
      contradictionsFound: run.contradictionsFound,
      resonanceChecks: run.resonanceChecks,
      resonancesFound: run.resonancesFound,
      ideasCreated: run.ideasCreated,
      errorMessage: run.errorMessage ?? null,
    })),
  };
}

/**
 * Enable or disable Organic Memory for a user. Creates tickState if it doesn't exist.
 * Internal only — must be called from server-side code (admin scripts, crons, etc.).
 */
export const setOrganicEnabled = internalMutation({
  args: { userId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { enabled: args.enabled, updatedAt: Date.now() });
      return existing._id;
    }

    const now = Date.now();
    return ctx.db.insert("organicTickState", {
      userId: args.userId,
      lastTickAt: 0,
      lastTickId: "",
      tickCount: 0,
      totalTracesGenerated: 0,
      totalTracesValidated: 0,
      hitRate: 0.0,
      enabled: args.enabled,
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      isRunning: false,
      notificationEmail: false,
      updatedAt: now,
    });
  },
});

export const setMyOrganicTickInterval = mutation({
  args: { tickIntervalMs: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }

    const userId = stableUserId(identity.subject);
    return updateOrganicInterval(ctx, userId, args.tickIntervalMs);
  },
});

export const setMyOrganicPulseInterval = mutation({
  args: { pulseIntervalMs: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }

    const userId = stableUserId(identity.subject);
    const { tickIntervalMs } = await updateOrganicInterval(ctx, userId, args.pulseIntervalMs);
    return {
      pulseIntervalMs: tickIntervalMs,
      tickIntervalMs,
    };
  },
});

export const setMyOrganicModel = mutation({
  args: { organicModel: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    if (!MODEL_PRESETS[args.organicModel]) {
      throw new Error(`Invalid model preset: ${args.organicModel}. Valid: ${MODEL_PRESET_KEYS.join(", ")}`);
    }

    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!tickState) throw new Error("Organic Memory is not enabled");

    await ctx.db.patch(tickState._id, {
      organicModel: args.organicModel,
      updatedAt: Date.now(),
    });

    const preset = getModelPreset(args.organicModel);
    return { organicModel: args.organicModel, label: preset.label };
  },
});

export const setMyOrganicPulseModel = mutation({
  args: { organicModel: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    if (!MODEL_PRESETS[args.organicModel]) {
      throw new Error(`Invalid model preset: ${args.organicModel}. Valid: ${MODEL_PRESET_KEYS.join(", ")}`);
    }

    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!tickState) throw new Error("Organic Memory is not enabled");

    await ctx.db.patch(tickState._id, {
      organicModel: args.organicModel,
      updatedAt: Date.now(),
    });

    const preset = getModelPreset(args.organicModel);
    return { organicModel: args.organicModel, label: preset.label };
  },
});

export const setMyNotificationPreferences = mutation({
  args: {
    notificationEmail: v.boolean(),
    notificationEmailDelay: v.optional(v.number()),
    ideaFrequency: v.optional(v.union(
      v.literal("aggressive"),
      v.literal("balanced"),
      v.literal("conservative")
    )),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!tickState) throw new Error("Organic Memory is not enabled");

    const patch: Record<string, unknown> = {
      notificationEmail: args.notificationEmail,
      updatedAt: Date.now(),
    };
    if (args.notificationEmailDelay !== undefined) {
      patch.notificationEmailDelay = args.notificationEmailDelay;
    }
    if (args.ideaFrequency !== undefined) {
      patch.ideaFrequency = args.ideaFrequency;
    }

    await ctx.db.patch(tickState._id, patch);
    return { success: true };
  },
});

/**
 * Get the organic tick state for a user (admin/debug).
 * Internal only — use getMyOrganicDashboard for public access.
 */
export const getOrganicStatus = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
  },
});

/**
 * Get the organic dashboard data for the currently authenticated user.
 * Returns tick state, ensemble count, active trace count, and recent activity.
 */
export const getMyOrganicDashboard = query({
  args: {},
  handler: async (ctx) => {
    return getMyOrganicDashboardData(ctx);
  },
});

export const getMyOrganicPulseDashboard = query({
  args: {},
  handler: async (ctx) => {
    return getMyOrganicDashboardData(ctx);
  },
});

export const getMyOrganicSkills = query({
  args: {
    category: v.optional(v.union(v.literal("skill"), v.literal("workflow"))),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);

    const categories = args.category ? [args.category] : ["skill", "workflow"] as const;
    const skillSets = await Promise.all(
      categories.map((category) =>
        ctx.db
          .query("crystalMemories")
          .withIndex("by_store_category", (q) =>
            q.eq("userId", userId).eq("store", "procedural").eq("category", category).eq("archived", false)
          )
          .take(200)
      )
    );
    const skills = skillSets.flat();

    return skills
      .map((memory) => {
        const parsedMetadata = parseSkillMetadata(memory.metadata);
        return {
          _id: memory._id,
          title: memory.title,
          content: memory.content,
          createdAt: memory.createdAt,
          lastAccessedAt: memory.lastAccessedAt,
          confidence: memory.confidence,
          strength: memory.strength,
          tags: memory.tags,
          metadata: parsedMetadata,
        };
      })
      .sort((a, b) => {
        const aCount = a.metadata?.observationCount ?? 0;
        const bCount = b.metadata?.observationCount ?? 0;
        if (bCount !== aCount) return bCount - aCount;
        return b.lastAccessedAt - a.lastAccessedAt;
      });
  },
});

export const getAllMyActiveTraces = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);
    const now = Date.now();
    const traces = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_user_expires", (q) =>
        q.eq("userId", userId).gt("expiresAt", now)
      )
      .take(1000);
    const active = traces.filter((t) => t.validated === null);
    return active.map((t) => ({
      _id: t._id,
      predictedQuery: t.predictedQuery,
      predictedContext: t.predictedContext,
      confidence: t.confidence,
      expiresAt: t.expiresAt,
      traceType: t.traceType,
      sourcePattern: t.sourcePattern,
      createdAt: t._creationTime,
    }));
  },
});

type TriggerMyOrganicTickResult = {
  queued: boolean;
  alreadyRunning: boolean;
  scheduledForUserId: string;
  requestedAt: number;
};

async function queueMyOrganicTick(ctx: MutationCtx): Promise<TriggerMyOrganicTickResult> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated");
  }

  const userId = stableUserId(identity.subject);
  let tickState: Doc<"organicTickState"> | null = await ctx.db
    .query("organicTickState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  if (!tickState) {
    const tickStateId = await ctx.runMutation(internal.crystal.organic.tick.initTickState, {
      userId,
    }) as Id<"organicTickState">;
    tickState = await ctx.db.get(tickStateId);
  }

  if (!tickState || !tickState.enabled) {
    throw new Error("Organic Memory is not enabled");
  }

  const now = Date.now();
  const leaseActive: boolean = Boolean(tickState.isRunning && (tickState.leaseExpiresAt ?? 0) > now);
  if (!leaseActive) {
    await ctx.scheduler.runAfter(0, internal.crystal.organic.tick.processUserTick, {
      userId,
      lastTickAt: tickState.lastTickAt,
      triggerSource: "manual",
      tickIntervalMs: tickState.tickIntervalMs,
    });
  }

  return {
    queued: !leaseActive,
    alreadyRunning: leaseActive,
    scheduledForUserId: userId,
    requestedAt: now,
  };
}

export const triggerMyOrganicTick = mutation({
  args: {},
  handler: async (ctx: MutationCtx): Promise<TriggerMyOrganicTickResult> => {
    return queueMyOrganicTick(ctx);
  },
});

export const triggerMyOrganicPulse = mutation({
  args: {},
  handler: async (ctx: MutationCtx): Promise<TriggerMyOrganicTickResult> => {
    return queueMyOrganicTick(ctx);
  },
});

// Admin action: backfill structured fields on existing skills
export const adminBackfillSkillFields = action({
  args: {
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ updated: number; skipped: number; failed: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = stableUserId(identity.subject);

    const result = await ctx.runAction(
      internal.crystal.organic.proceduralExtraction.backfillSkillStructuredFields,
      { userId, dryRun: args.dryRun }
    );
    return result as { updated: number; skipped: number; failed: number };
  },
});

// ── OpenRouter API Key Management ────────────────────────────────────────────

export const setOpenRouterApiKey = mutation({
  args: { apiKey: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const trimmed = args.apiKey.trim();
    if (!trimmed || !trimmed.startsWith("sk-or-")) {
      throw new Error("Invalid OpenRouter API key. Keys must start with 'sk-or-'.");
    }

    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!tickState) throw new Error("Organic Memory is not enabled");

    await ctx.db.patch(tickState._id, {
      openrouterApiKey: trimmed,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const removeOpenRouterApiKey = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!tickState) throw new Error("Organic Memory is not enabled");

    await ctx.db.patch(tickState._id, {
      openrouterApiKey: undefined,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const getOpenRouterApiKeyStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);

    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!tickState) return { hasKey: false, keyPrefix: null };

    const key = tickState.openrouterApiKey;
    if (!key) return { hasKey: false, keyPrefix: null };

    return {
      hasKey: true,
      keyPrefix: key.slice(0, 8) + "...",
    };
  },
});
