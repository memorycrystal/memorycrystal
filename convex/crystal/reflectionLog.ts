import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { stableUserId } from "./auth";

const STALE_RUNNING_RUN_MS = 30 * 60 * 1000;

function parseRunMetadata(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const reflectionTrigger = v.union(
  v.literal("cron"),
  v.literal("manual"),
  v.literal("organic_pulse"),
  v.literal("on_write"),
  v.literal("backfill_dry_run"),
  v.literal("backfill_execute"),
  v.literal("cleanup")
);

const reflectionStatus = v.union(v.literal("running"), v.literal("completed"), v.literal("failed"));
const costKeySource = v.union(
  v.literal("platform"),
  v.literal("user_byok"),
  v.literal("provider_export"),
  v.literal("manual"),
  v.literal("unknown")
);
const costPayer = v.union(v.literal("company"), v.literal("user"), v.literal("unknown"));

const sampleShape = v.object({
  memoryId: v.id("crystalMemories"),
  title: v.string(),
  action: v.string(),
  reason: v.optional(v.string()),
});

export const createRun = internalMutation({
  args: {
    userId: v.string(),
    trigger: reflectionTrigger,
    tier: v.string(),
    sensoryRawTtlDays: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    metadata: v.optional(v.string()),
    costProvider: v.optional(v.string()),
    costModel: v.optional(v.string()),
    keySource: v.optional(costKeySource),
    payer: v.optional(costPayer),
    estimatedInputTokens: v.optional(v.float64()),
    estimatedOutputTokens: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return ctx.db.insert("crystalReflectionRuns", {
      userId: args.userId,
      trigger: args.trigger,
      status: "running",
      startedAt: now,
      tier: args.tier,
      sensoryRawTtlDays: args.sensoryRawTtlDays,
      summarized: 0,
      wiped: 0,
      wipedWithoutSummary: 0,
      skipped: 0,
      promoted: 0,
      archived: 0,
      errors: 0,
      estimatedCostUsd: 0,
      costProvider: args.costProvider,
      costModel: args.costModel,
      keySource: args.keySource,
      payer: args.payer,
      estimatedInputTokens: args.estimatedInputTokens,
      estimatedOutputTokens: args.estimatedOutputTokens,
      dryRun: args.dryRun,
      metadata: args.metadata,
    });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("crystalReflectionRuns"),
    status: reflectionStatus,
    summarized: v.optional(v.number()),
    wiped: v.optional(v.number()),
    wipedWithoutSummary: v.optional(v.number()),
    skipped: v.optional(v.number()),
    promoted: v.optional(v.number()),
    archived: v.optional(v.number()),
    errors: v.optional(v.number()),
    estimatedCostUsd: v.optional(v.float64()),
    costProvider: v.optional(v.string()),
    costModel: v.optional(v.string()),
    keySource: v.optional(costKeySource),
    payer: v.optional(costPayer),
    estimatedInputTokens: v.optional(v.float64()),
    estimatedOutputTokens: v.optional(v.float64()),
    memoryIds: v.optional(v.array(v.id("crystalMemories"))),
    samples: v.optional(v.array(sampleShape)),
    errorMessage: v.optional(v.string()),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { runId, ...rest } = args;
    await ctx.db.patch(runId, {
      ...rest,
      completedAt: Date.now(),
    });
  },
});

export const updateRunProgress = internalMutation({
  args: {
    runId: v.id("crystalReflectionRuns"),
    summarized: v.optional(v.number()),
    wiped: v.optional(v.number()),
    wipedWithoutSummary: v.optional(v.number()),
    skipped: v.optional(v.number()),
    promoted: v.optional(v.number()),
    archived: v.optional(v.number()),
    errors: v.optional(v.number()),
    estimatedCostUsd: v.optional(v.float64()),
    costProvider: v.optional(v.string()),
    costModel: v.optional(v.string()),
    keySource: v.optional(costKeySource),
    payer: v.optional(costPayer),
    estimatedInputTokens: v.optional(v.float64()),
    estimatedOutputTokens: v.optional(v.float64()),
    memoryIds: v.optional(v.array(v.id("crystalMemories"))),
    samples: v.optional(v.array(sampleShape)),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { runId, ...rest } = args;
    await ctx.db.patch(runId, rest);
  },
});

export const listMyRuns = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { page: [], continueCursor: null, isDone: true };
    const userId = stableUserId(identity.subject);
    const pageSize = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const result = await ctx.db
      .query("crystalReflectionRuns")
      .withIndex("by_user_started", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: pageSize });
    const now = Date.now();
    return {
      ...result,
      page: result.page.map((run) => {
        const metadata = parseRunMetadata(run.metadata);
        const metadataProgressAt = Number(metadata.progressUpdatedAt);
        const lastProgressAt = Number.isFinite(metadataProgressAt) ? metadataProgressAt : run.startedAt;
        const isStaleRunning = run.status === "running" && now - lastProgressAt > STALE_RUNNING_RUN_MS;
        return {
          ...run,
          isStaleRunning,
          staleAfterMs: isStaleRunning ? STALE_RUNNING_RUN_MS : undefined,
          lastProgressAt,
        };
      }),
    };
  },
});
