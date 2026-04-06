import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Doc } from "../../_generated/dataModel";
import { callOrganicModel, isRecord, parseGeminiJson, embedText } from "./utils";
import { getModelPreset, type ModelPreset } from "./models";
import { runDiscoveryFiber } from "./discoveryFiber";
import {
  DEFAULT_TICK_INTERVAL_MS,
  estimateModelSpend,
  roundUsd,
  summarizeRunSpend,
} from "./spend";
import { POLICY_TUNE_INTERVAL } from "./policyTuner";

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_MEMORIES_FOR_TICK = 10;
const MAX_ACTIVITY_BATCH = 100;
const MAX_RECENT_MEMORIES = 50;
const MIN_TRACE_WORD_COUNT = 5;
const DEDUP_CONFIDENCE_BOOST = 0.05;
const MAX_CONFIDENCE = 0.95;

const GENERIC_TRACE_BLOCKLIST = [
  "what can you do",
  "how do i use",
  "how do you work",
  "what are you",
  "help me",
  "who are you",
  "what is this",
  "how does this work",
  "tell me about yourself",
  "what do you know",
  "can you help",
  "what are your capabilities",
  "how can you help",
  "what should i do",
  "get started",
];

function isGenericTrace(query: string): boolean {
  const lower = query.toLowerCase().trim();
  return GENERIC_TRACE_BLOCKLIST.some((pattern) => lower.includes(pattern));
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── Types ────────────────────────────────────────────────────────────────────

type ProspectiveTrace = {
  predictedQuery: string;
  predictedContext: string;
  documentDescription: string;
  traceType: "query" | "context" | "contradiction" | "action" | "resonance";
  confidence: number;
  ttlHours: number;
  sourcePattern: string;
};

type ActivityLogDoc = Doc<"organicActivityLog">;
type MemoryDoc = Doc<"crystalMemories">;
type ProspectiveTraceDoc = Doc<"organicProspectiveTraces">;

// ── Prompt ────────────────────────────────────────────────────────────────────

const buildTickPrompt = (activitySummary: string, recentMemoriesSummary: string, coverageContext?: string): string => `
You are an anticipatory memory assistant. Based on recent memory activity, predict what content the user will need next.

Recent activity (last tick):
${activitySummary}

Recent memories stored:
${recentMemoriesSummary}
${coverageContext ? `\nRecall coverage analysis:\n${coverageContext}` : ""}

CRITICAL: Your job is to describe DOCUMENTS, not predict questions. The "documentDescription" field is the most important — it describes what content should be pre-assembled, written as a document summary (NOT as a question).

BAD documentDescription (question-style, will never match):
- "What are the deployment best practices?"
- "How does the auth middleware work?"

GOOD documentDescription (document-style, matches real queries):
- "Deployment best practices including rollback procedures, canary releases, and the March 15 incident post-mortem"
- "Auth middleware architecture: JWT validation flow, session token storage, and the compliance-driven refactor decision"

Generic predictions like "What are best practices" or "How does this work" are FORBIDDEN.

Generate exactly 3 predictions. Each must be specific, actionable, and reference concrete concepts from the memories above.

JSON array format:
{
  "predictedQuery": "what the user might ask (for display only)",
  "documentDescription": "document-style description of content that would answer related queries — this is what gets matched against",
  "predictedContext": "pre-assembled context that would answer it (2-3 sentences max)",
  "traceType": "query" | "context" | "contradiction" | "action" | "resonance",
  "confidence": 0.0-1.0,
  "ttlHours": 1-72,
  "sourcePattern": "brief explanation of why this was predicted"
}

Return ONLY valid JSON array. No markdown, no explanation.`;

// ── Gemini API ───────────────────────────────────────────────────────────────

async function callOrganicWithTelemetry(prompt: string, preset: ModelPreset, apiKeyOverride?: string): Promise<{
  traces: ProspectiveTrace[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}> {
  const text = await callOrganicModel(prompt, preset, apiKeyOverride);
  const spend = estimateModelSpend(prompt, text, preset);
  if (!text) {
    return {
      traces: [],
      ...spend,
    };
  }

  const parsed = parseGeminiJson<unknown>(text);
  const traces = extractTraceArray(parsed);
  if (traces.length === 0) {
    console.error(`[organic-tick] Failed to parse model response: ${text.slice(0, 200)}`);
  }

  return {
    traces: traces.slice(0, 5) as ProspectiveTrace[],
    ...spend,
  };
}

// ── Queries ──────────────────────────────────────────────────────────────────

export const getTickActivity = internalQuery({
  args: { userId: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicActivityLog")
      .withIndex("by_user_time", (q) => q.eq("userId", args.userId).gte("timestamp", args.since))
      .take(MAX_ACTIVITY_BATCH);
  },
});

export const getEnabledTickStates = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db
      .query("organicTickState")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(500);
  },
});

export const getTickStateByUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
  },
});

export const getRecentMemories = internalQuery({
  args: { userId: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) =>
        q.eq("userId", args.userId).gte("createdAt", args.since)
      )
      .order("desc")
      .take(MAX_RECENT_MEMORIES * 2);
    return results.filter((m) => !m.archived).slice(0, MAX_RECENT_MEMORIES);
  },
});

export const getUserMemoryCount = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .take(MIN_MEMORIES_FOR_TICK + 1);
    return memories.length;
  },
});

export const getStaleTraces = internalQuery({
  args: { userId: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_user_expires", (q) =>
        q.eq("userId", args.userId).lt("expiresAt", args.now)
      )
      .take(200);
    return candidates.filter((t) => t.validated === null);
  },
});

/**
 * getRecentRecallQueries — returns last N recall queries for predict-calibrate (Fix 3).
 */
export const getRecentRecallQueries = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicRecallLog")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit);
  },
});

/**
 * updateWarmCache — write pre-fetched memory IDs to organicTickState (Fix 4).
 */
export const updateWarmCache = internalMutation({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.string()),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        warmCacheMemoryIds: args.memoryIds,
        warmCacheExpiresAt: args.expiresAt,
      });
    }
  },
});

/**
 * getWarmCache — retrieve warm-cached memory IDs if not expired.
 */
export const getWarmCache = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (!state?.warmCacheMemoryIds || !state.warmCacheExpiresAt) return null;
    if (Date.now() > state.warmCacheExpiresAt) return null;
    return state.warmCacheMemoryIds;
  },
});

// ── Mutations ────────────────────────────────────────────────────────────────

export const writePredictions = internalMutation({
  args: {
    userId: v.string(),
    tickId: v.string(),
    traces: v.array(
      v.object({
        predictedQuery: v.string(),
        predictedContext: v.string(),
        documentDescription: v.optional(v.string()),
        documentEmbedding: v.optional(v.array(v.float64())),
        traceType: v.union(
          v.literal("query"),
          v.literal("context"),
          v.literal("contradiction"),
          v.literal("action"),
          v.literal("resonance")
        ),
        confidence: v.float64(),
        ttlHours: v.number(),
        sourcePattern: v.string(),
      })
    ),
    sourceMemoryIds: v.optional(v.array(v.id("crystalMemories"))),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const memoryIds = args.sourceMemoryIds ?? [];
    let inserted = 0;
    let skippedQuality = 0;
    let skippedDedup = 0;

    for (const trace of args.traces) {
      // Quality gate: skip short or generic traces (check both predictedQuery and documentDescription)
      const descText = trace.documentDescription || trace.predictedQuery;
      if (wordCount(descText) < MIN_TRACE_WORD_COUNT) {
        skippedQuality++;
        continue;
      }
      if (isGenericTrace(trace.predictedQuery)) {
        skippedQuality++;
        continue;
      }

      // Dedup: check for existing active trace with similar predictedQuery
      const existing = await ctx.db
        .query("organicProspectiveTraces")
        .withSearchIndex("search_predicted_query", (q) =>
          q.search("predictedQuery", trace.predictedQuery).eq("userId", args.userId)
        )
        .take(5);

      const activeDupe = existing.find(
        (t) => t.validated === null && t.expiresAt > now
      );
      if (activeDupe) {
        // Boost existing trace confidence instead of inserting duplicate
        const boosted = Math.min(activeDupe.confidence + DEDUP_CONFIDENCE_BOOST, MAX_CONFIDENCE);
        await ctx.db.patch(activeDupe._id, { confidence: boosted });
        skippedDedup++;
        continue;
      }

      await ctx.db.insert("organicProspectiveTraces", {
        userId: args.userId,
        createdAt: now,
        tickId: args.tickId,
        predictedQuery: trace.predictedQuery,
        predictedContext: trace.predictedContext,
        documentDescription: trace.documentDescription,
        documentEmbedding: trace.documentEmbedding,
        matchThreshold: 0.40,
        traceType: trace.traceType,
        confidence: trace.confidence,
        expiresAt: now + trace.ttlHours * 60 * 60 * 1000,
        validated: null,
        sourceMemoryIds: memoryIds,
        sourcePattern: trace.sourcePattern,
        accessCount: 0,
        usefulness: 0.0,
      });
      inserted++;
    }

    if (skippedQuality > 0 || skippedDedup > 0) {
      console.log(
        `[organic-tick] writePredictions: inserted=${inserted}, skippedQuality=${skippedQuality}, skippedDedup=${skippedDedup}`
      );
    }
    return inserted;
  },
});

export const expireTraces = internalMutation({
  args: { traceIds: v.array(v.id("organicProspectiveTraces")) },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const id of args.traceIds) {
      const trace = await ctx.db.get(id);
      if (trace && trace.validated === null) {
        await ctx.db.patch(id, { validated: false, validatedAt: now });
      }
    }
    return args.traceIds.length;
  },
});

export const countValidatedTracesSince = internalQuery({
  args: { userId: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    // Use by_user_validated index to scan only validated traces, then filter by time
    const traces = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_user_validated", (q) =>
        q.eq("userId", args.userId).eq("validated", true)
      )
      .take(500);
    return traces.filter(
      (t) => (t.validatedAt ?? 0) >= args.since
    ).length;
  },
});

export const stampTickStart = internalMutation({
  args: { userId: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { lastTickAt: args.now, updatedAt: args.now });
    }
  },
});

export const updateTickState = internalMutation({
  args: {
    userId: v.string(),
    tickId: v.string(),
    tracesGenerated: v.number(),
    tracesValidated: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (!existing) {
      console.error(`[organic-tick] No tickState for user ${args.userId}`);
      return;
    }

    const newValidated = existing.totalTracesValidated + (args.tracesValidated ?? 0);
    const newGenerated = existing.totalTracesGenerated + args.tracesGenerated;
    const newHitRate = newGenerated > 0 ? newValidated / newGenerated : 0;

    await ctx.db.patch(existing._id, {
      lastTickAt: now,
      lastTickId: args.tickId,
      tickCount: existing.tickCount + 1,
      totalTracesGenerated: newGenerated,
      totalTracesValidated: newValidated,
      hitRate: newHitRate,
      updatedAt: now,
    });
  },
});

export const createTickRun = internalMutation({
  args: {
    userId: v.string(),
    tickId: v.string(),
    triggerSource: v.union(v.literal("scheduled"), v.literal("manual"), v.literal("conversation")),
    tickIntervalMs: v.number(),
    previousTickAt: v.number(),
    startedAt: v.number(),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("organicTickRuns", {
      userId: args.userId,
      tickId: args.tickId,
      triggerSource: args.triggerSource,
      status: "running",
      startedAt: args.startedAt,
      tickIntervalMs: args.tickIntervalMs,
      previousTickAt: args.previousTickAt,
      tracesGenerated: 0,
      tracesValidated: 0,
      tracesExpired: 0,
      ensemblesCreated: 0,
      ensemblesUpdated: 0,
      ensemblesArchived: 0,
      contradictionChecks: 0,
      contradictionsFound: 0,
      resonanceChecks: 0,
      resonancesFound: 0,
      ideasCreated: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
    });
  },
});

export const finalizeTickRun = internalMutation({
  args: {
    tickId: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed")),
    completedAt: v.number(),
    tracesGenerated: v.number(),
    tracesValidated: v.number(),
    tracesExpired: v.number(),
    ensemblesCreated: v.number(),
    ensemblesUpdated: v.number(),
    ensemblesArchived: v.number(),
    contradictionChecks: v.number(),
    contradictionsFound: v.number(),
    resonanceChecks: v.number(),
    resonancesFound: v.number(),
    ideasCreated: v.number(),
    estimatedInputTokens: v.number(),
    estimatedOutputTokens: v.number(),
    estimatedCostUsd: v.float64(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("organicTickRuns")
      .withIndex("by_tick", (q) => q.eq("tickId", args.tickId))
      .first();
    if (!run) {
      return null;
    }

    await ctx.db.patch(run._id, {
      status: args.status,
      completedAt: args.completedAt,
      durationMs: Math.max(0, args.completedAt - run.startedAt),
      tracesGenerated: args.tracesGenerated,
      tracesValidated: args.tracesValidated,
      tracesExpired: args.tracesExpired,
      ensemblesCreated: args.ensemblesCreated,
      ensemblesUpdated: args.ensemblesUpdated,
      ensemblesArchived: args.ensemblesArchived,
      contradictionChecks: args.contradictionChecks,
      contradictionsFound: args.contradictionsFound,
      resonanceChecks: args.resonanceChecks,
      resonancesFound: args.resonancesFound,
      ideasCreated: args.ideasCreated,
      estimatedInputTokens: args.estimatedInputTokens,
      estimatedOutputTokens: args.estimatedOutputTokens,
      estimatedCostUsd: roundUsd(args.estimatedCostUsd),
      errorMessage: args.errorMessage,
    });
    return run._id;
  },
});

export const getRecentTickRuns = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicTickRuns")
      .withIndex("by_user_started", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit);
  },
});

export const initTickState = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Use take() to detect and clean up duplicate rows from concurrent inserts
    const rows = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(10);

    if (rows.length > 0) {
      // Keep the most recently updated row, delete any duplicates
      const sorted = rows.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const row of sorted.slice(1)) {
        await ctx.db.delete(row._id);
      }
      return sorted[0]._id;
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
      enabled: false,
      tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      updatedAt: now,
    });
  },
});

// ── Tick lease ──────────────────────────────────────────────────────────────

export const acquireTickLease = internalMutation({
  args: { userId: v.string(), leaseDurationMs: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (!existing) return false;

    // If a lease is active and not expired, refuse
    if (existing.isRunning && (existing.leaseExpiresAt ?? 0) > now) {
      console.log(`[organic-tick] ${args.userId}: tick already running, skipping`);
      return false;
    }

    await ctx.db.patch(existing._id, {
      isRunning: true,
      leaseExpiresAt: now + args.leaseDurationMs,
    });
    return true;
  },
});

export const releaseTickLease = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        isRunning: false,
        leaseExpiresAt: undefined,
      });
    }
  },
});

// ── Per-user tick processing ─────────────────────────────────────────────────

export const processUserTick = internalAction({
  args: {
    userId: v.string(),
    lastTickAt: v.number(),
    triggerSource: v.union(v.literal("scheduled"), v.literal("manual"), v.literal("conversation")),
    tickIntervalMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, lastTickAt } = args;
    const startedAt = Date.now();
    const tickId = `tick_${userId}_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
    let spendItems: Array<{ estimatedInputTokens: number; estimatedOutputTokens: number; estimatedCostUsd: number }> = [];
    let tracesGenerated = 0;
    let tracesExpired = 0;
    let tracesValidated = 0;
    let ensemblesCreated = 0;
    let ensemblesUpdated = 0;
    let ensemblesArchived = 0;
    let contradictionChecks = 0;
    let contradictionsFound = 0;
    let resonanceChecks = 0;
    let resonancesFound = 0;
    let ideasCreated = 0;

    // Read tick state early for lease duration calculation
    const preTickState = await ctx.runQuery(internal.crystal.organic.tick.getTickStateByUser, { userId });
    if (!preTickState) {
      console.log(`[organic-tick] ${userId}: missing tick state, skipping`);
      return;
    }
    const tickIntervalMs = args.tickIntervalMs ?? preTickState.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;

    // For high-frequency intervals, reduce lease duration
    const leaseDurationMs = tickIntervalMs < 60_000
      ? Math.max(tickIntervalMs * 3, 60_000)
      : 20 * 60 * 1000;

    // Acquire execution lease to prevent concurrent ticks for same user
    const acquired = await ctx.runMutation(internal.crystal.organic.tick.acquireTickLease, {
      userId,
      leaseDurationMs,
    });
    if (!acquired) {
      console.log(`[organic-tick] ${userId}: skipped (lease active)`);
      return;
    }

    // H-3 dedup: check if another tick ran recently (within half the interval).
    // If so, this is a duplicate chain — exit without rescheduling.
    // Manual triggers bypass dedup so the "Run Pulse Now" button always works.
    if (args.triggerSource === "scheduled") {
      const recentRunDedup = await ctx.runQuery(internal.crystal.organic.tick.getRecentTickRuns, {
        userId,
        limit: 1,
      });
      if (recentRunDedup.length > 0) {
        const lastRunStarted = recentRunDedup[0].startedAt;
        const dedupWindow = tickIntervalMs * 0.5;
        if (startedAt - lastRunStarted < dedupWindow) {
          console.log(`[organic-tick] ${userId}: duplicate chain detected, exiting without rescheduling`);
          await ctx.runMutation(internal.crystal.organic.tick.releaseTickLease, { userId }).catch(() => {});
          return;
        }
      }
    }

    // Track whether tick completed successfully for self-scheduling
    let tickSucceeded = false;

    try {
      const now = startedAt;
      const tickState = await ctx.runQuery(internal.crystal.organic.tick.getTickStateByUser, { userId });
      if (!tickState) {
        console.log(`[organic-tick] ${userId}: missing tick state, skipping`);
        return;
      }
      if (tickState.lastTickAt > lastTickAt) {
        console.log(`[organic-tick] ${userId}: stale queued tick skipped`);
        return;
      }

      // Check for per-user OpenRouter API key
      const openrouterApiKey = tickState.openrouterApiKey ?? undefined;
      if (!openrouterApiKey && !process.env.OPENROUTER_API_KEY) {
        console.warn(`[organic-tick] ${userId}: no OpenRouter API key set, skipping tick`);
        await ctx.runMutation(internal.crystal.organic.tick.releaseTickLease, { userId }).catch(() => {});
        return { status: "skipped", reason: "no_openrouter_key" };
      }

      // Resolve model preset for this user
      const preset = getModelPreset(tickState.organicModel);

      // Set lastTickAt at START to fix drift (prevents cron re-dispatch during processing)
      await ctx.runMutation(internal.crystal.organic.tick.stampTickStart, {
        userId,
        now,
      });

      await ctx.runMutation(internal.crystal.organic.tick.createTickRun, {
        userId,
        tickId,
        triggerSource: args.triggerSource,
        tickIntervalMs,
        previousTickAt: lastTickAt,
        startedAt,
      });

      // 1. Read recent activity
      const activity = await ctx.runQuery(
        internal.crystal.organic.tick.getTickActivity,
        { userId, since: lastTickAt }
      );

      // 2. Read recent memories
      const recentMemories = await ctx.runQuery(
        internal.crystal.organic.tick.getRecentMemories,
        { userId, since: lastTickAt }
      );

      // 3. Check skip conditions: no activity AND low memory count
      if (activity.length === 0 && recentMemories.length === 0) {
        const memoryCount: number = await ctx.runQuery(
          internal.crystal.organic.tick.getUserMemoryCount,
          { userId }
        );
        if (memoryCount < MIN_MEMORIES_FOR_TICK) {
          console.log(`[organic-tick] Skipping ${userId}: no activity, ${memoryCount} memories`);
          await ctx.runMutation(internal.crystal.organic.tick.updateTickState, {
            userId,
            tickId,
            tracesGenerated: 0,
          });
          await ctx.runMutation(internal.crystal.organic.tick.finalizeTickRun, {
            tickId,
            status: "completed",
            completedAt: Date.now(),
            tracesGenerated: 0,
            tracesValidated: 0,
            tracesExpired: 0,
            ensemblesCreated: 0,
            ensemblesUpdated: 0,
            ensemblesArchived: 0,
            contradictionChecks: 0,
            contradictionsFound: 0,
            resonanceChecks: 0,
            resonancesFound: 0,
            ideasCreated: 0,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            estimatedCostUsd: 0,
          });
          tickSucceeded = true;
          return;
        }
      }

      // 4. Load KB context
      let kbContextSummary = "";
      try {
        const kbs = await ctx.runQuery(
          internal.crystal.knowledgeBases.getActiveKBsForUser,
          { userId }
        );
        if (kbs.length > 0) {
          const kbLines: string[] = [];
          for (const kb of kbs) {
            const kbMemories: MemoryDoc[] = await ctx.runQuery(
              internal.crystal.knowledgeBases.getKBMemoriesInternal,
              { knowledgeBaseId: kb._id, limit: 20 }
            );
            for (const m of kbMemories) {
              kbLines.push(`[${kb.name}] ${m.title}: ${m.content.slice(0, 120)}`);
            }
          }
          if (kbLines.length > 0) {
            kbContextSummary = `\n\nKnowledge base context:\n${kbLines.join("\n")}`;
          }
        }
      } catch {
        // KB module may not be deployed yet; continue without
      }

      // 5. Build context summaries
      const activitySummary = activity.length > 0
        ? activity
          .map((a: ActivityLogDoc) => `${a.eventType} at ${new Date(a.timestamp).toISOString()}${a.metadata ? ` (${a.metadata})` : ""}`)
          .join("\n")
        : "No recent activity.";

      const recentMemoriesSummary = recentMemories.length > 0
        ? recentMemories
          .map((m: MemoryDoc) =>
            `[${m.store}/${m.category}] ${m.title}: ${m.content.slice(0, 120)}`
          )
          .join("\n")
        : "No new memories stored.";

      // 5b. Predict-calibrate: check recall coverage gaps (Fix 3)
      let coverageContext = "";
      try {
        const recentRecalls = await ctx.runQuery(
          internal.crystal.organic.tick.getRecentRecallQueries,
          { userId, limit: 10 }
        );
        if (recentRecalls.length > 0) {
          const wellCovered = recentRecalls
            .filter((r: any) => r.resultCount >= 3)
            .map((r: any) => r.query.slice(0, 80));
          const gaps = recentRecalls
            .filter((r: any) => r.resultCount < 2)
            .map((r: any) => r.query.slice(0, 80));
          if (wellCovered.length > 0 || gaps.length > 0) {
            const lines: string[] = [];
            if (wellCovered.length > 0) {
              lines.push(`These topics are well-covered (skip these): ${wellCovered.join("; ")}`);
            }
            if (gaps.length > 0) {
              lines.push(`These topics had poor recall (focus predictions here): ${gaps.join("; ")}`);
            }
            coverageContext = lines.join("\n");
          }
        }
      } catch { /* continue without coverage data */ }

      // 6. Call model
      const prompt = buildTickPrompt(activitySummary, recentMemoriesSummary, coverageContext || undefined) + kbContextSummary;
      const tickGemini = await callOrganicWithTelemetry(prompt, preset, openrouterApiKey);
      const traces = tickGemini.traces;
      spendItems.push(tickGemini);
      tracesGenerated = traces.length;

      // 6b. Write predictions with document embeddings (Fix 1)
      if (traces.length > 0) {
        const validTraces = await Promise.all(traces.map(async (t) => {
          const docDesc = t.documentDescription || t.predictedQuery || "";
          const embedding = docDesc.trim() ? await embedText(docDesc).catch(() => null) : null;
          return {
            predictedQuery: t.predictedQuery || "",
            predictedContext: t.predictedContext || "",
            documentDescription: docDesc,
            documentEmbedding: embedding ?? undefined,
            traceType: validateTraceType(t.traceType),
            confidence: clamp(t.confidence ?? 0.5, 0.0, 1.0),
            ttlHours: clamp(t.ttlHours ?? 24, 1, 72),
            sourcePattern: t.sourcePattern || "unknown",
          };
        }));

        await ctx.runMutation(internal.crystal.organic.tick.writePredictions, {
          userId,
          tickId,
          traces: validTraces,
          sourceMemoryIds: recentMemories.map((m: MemoryDoc) => m._id),
        });
      }

      // 6c. Warm cache: pre-fetch memory IDs for fast recall (Fix 4)
      if (recentMemories.length > 0) {
        try {
          await ctx.runMutation(internal.crystal.organic.tick.updateWarmCache, {
            userId,
            memoryIds: recentMemories.slice(0, 10).map((m: MemoryDoc) => String(m._id)),
            expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes
          });
        } catch { /* fire-and-forget */ }
      }

      // 7. Expire stale traces
      const staleTraces = await ctx.runQuery(
        internal.crystal.organic.tick.getStaleTraces,
        { userId, now }
      );
      if (staleTraces.length > 0) {
        await ctx.runMutation(internal.crystal.organic.tick.expireTraces, {
          traceIds: staleTraces.map((t: ProspectiveTraceDoc) => t._id),
        });
      }
      tracesExpired = staleTraces.length;

      // 8. Update tick state (count traces validated since last tick for hitRate)
      const validatedCount = await ctx.runQuery(
        internal.crystal.organic.tick.countValidatedTracesSince,
        { userId, since: lastTickAt }
      );
      tracesValidated = validatedCount;
      await ctx.runMutation(internal.crystal.organic.tick.updateTickState, {
        userId,
        tickId,
        tracesGenerated: traces.length,
        tracesValidated: validatedCount,
      });

      // 9. Run ensemble, contradiction, resonance, and procedural extraction phases in parallel
      const organicModel = tickState.organicModel;
      const [ensembleResult, contradictionResult, resonanceResult, proceduralResult] = await Promise.allSettled([
        ctx.runAction(internal.crystal.organic.ensembles.processEnsembleTick, {
          userId,
          tickId,
          organicModel,
          openrouterApiKey,
        }),
        ctx.runAction(internal.crystal.organic.contradictions.scanContradictions, {
          userId,
          lastTickTime: lastTickAt,
          tickId,
          budget: 20,
          organicModel,
          openrouterApiKey,
        }),
        ctx.runAction(internal.crystal.organic.resonance.detectResonance, {
          userId,
          tickId,
          budget: 2,
          organicModel,
          openrouterApiKey,
        }),
        ctx.runAction(internal.crystal.organic.proceduralExtraction.extractProcedurals, {
          userId,
          tickId,
          organicModel,
          openrouterApiKey,
        }),
      ]);
      if (ensembleResult.status === "rejected") console.error("ensemble tick failed:", ensembleResult.reason);
      if (contradictionResult.status === "rejected") console.error("contradiction scan failed:", contradictionResult.reason);
      if (resonanceResult.status === "rejected") console.error("resonance detection failed:", resonanceResult.reason);
      if (proceduralResult.status === "rejected") console.error("procedural extraction failed:", proceduralResult.reason);
      if (ensembleResult.status === "fulfilled") {
        ensemblesCreated = ensembleResult.value.created;
        ensemblesUpdated = ensembleResult.value.updated;
        ensemblesArchived = ensembleResult.value.archived;
        spendItems.push({
          estimatedInputTokens: ensembleResult.value.estimatedInputTokens,
          estimatedOutputTokens: ensembleResult.value.estimatedOutputTokens,
          estimatedCostUsd: ensembleResult.value.estimatedCostUsd,
        });
      }
      if (contradictionResult.status === "fulfilled") {
        contradictionChecks = contradictionResult.value.checksPerformed;
        contradictionsFound = contradictionResult.value.contradictionsFound;
        spendItems.push({
          estimatedInputTokens: contradictionResult.value.estimatedInputTokens,
          estimatedOutputTokens: contradictionResult.value.estimatedOutputTokens,
          estimatedCostUsd: contradictionResult.value.estimatedCostUsd,
        });
      }
      if (resonanceResult.status === "fulfilled") {
        resonanceChecks = resonanceResult.value.verificationsPerformed;
        resonancesFound = resonanceResult.value.resonancesFound;
        spendItems.push({
          estimatedInputTokens: resonanceResult.value.estimatedInputTokens,
          estimatedOutputTokens: resonanceResult.value.estimatedOutputTokens,
          estimatedCostUsd: resonanceResult.value.estimatedCostUsd,
        });
      }
      if (proceduralResult.status === "fulfilled") {
        spendItems.push({
          estimatedInputTokens: proceduralResult.value.estimatedInputTokens,
          estimatedOutputTokens: proceduralResult.value.estimatedOutputTokens,
          estimatedCostUsd: proceduralResult.value.estimatedCostUsd,
        });
      }
      try {
        const discoveryResult = await runDiscoveryFiber(ctx, {
          userId,
          tickId,
          since: lastTickAt,
          organicModel,
          openrouterApiKey,
          ensemblesCreated,
          contradictionsFound,
          resonancesFound,
          contradictionFindings:
            contradictionResult.status === "fulfilled" ? contradictionResult.value.findings : [],
          resonanceFindings:
            resonanceResult.status === "fulfilled" ? resonanceResult.value.findings : [],
        });
        ideasCreated = discoveryResult.ideasCreated;
        spendItems.push({
          estimatedInputTokens: discoveryResult.estimatedInputTokens,
          estimatedOutputTokens: discoveryResult.estimatedOutputTokens,
          estimatedCostUsd: discoveryResult.estimatedCostUsd,
        });
      } catch (error) {
        console.error("discovery fiber failed:", error);
      }

      const lastPolicyTune = preTickState.lastPolicyTuneAt ?? 0;
      if (Date.now() - lastPolicyTune > POLICY_TUNE_INTERVAL) {
        try {
          const tuneResult = await ctx.runAction(
            ((internal as any).crystal.organic.policyTuner.runPolicyTuning),
            { userId, organicModel: organicModel ?? "" }
          );
          console.log(
            `[organic-tick] ${userId}: policy tuning: evaluated=${tuneResult.evaluated}, promoted=${tuneResult.promoted}`
          );
        } catch (e) {
          console.error("[organic-tick] policy tuning failed:", e);
        }
      }

      const runSpend = summarizeRunSpend(spendItems);
      await ctx.runMutation(internal.crystal.organic.tick.finalizeTickRun, {
        tickId,
        status: "completed",
        completedAt: Date.now(),
        tracesGenerated,
        tracesValidated,
        tracesExpired,
        ensemblesCreated,
        ensemblesUpdated,
        ensemblesArchived,
        contradictionChecks,
        contradictionsFound,
        resonanceChecks,
        resonancesFound,
        ideasCreated,
        estimatedInputTokens: runSpend.estimatedInputTokens,
        estimatedOutputTokens: runSpend.estimatedOutputTokens,
        estimatedCostUsd: runSpend.estimatedCostUsd,
      });

      tickSucceeded = true;
      console.log(
        `[organic-tick] ${userId}: ${traces.length} traces generated, ${staleTraces.length} expired`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown organic tick failure";
      const failedAt = Date.now();
      const runSpend = summarizeRunSpend(spendItems);
      await ctx.runMutation(internal.crystal.organic.tick.finalizeTickRun, {
        tickId,
        status: "failed",
        completedAt: failedAt,
        tracesGenerated,
        tracesValidated,
        tracesExpired,
        ensemblesCreated,
        ensemblesUpdated,
        ensemblesArchived,
        contradictionChecks,
        contradictionsFound,
        resonanceChecks,
        resonancesFound,
        ideasCreated,
        estimatedInputTokens: runSpend.estimatedInputTokens,
        estimatedOutputTokens: runSpend.estimatedOutputTokens,
        estimatedCostUsd: runSpend.estimatedCostUsd,
        errorMessage: message,
      }).catch(() => {});
      throw error;
    } finally {
      await ctx.runMutation(internal.crystal.organic.tick.releaseTickLease, { userId }).catch(() => {});

      // Self-schedule next tick on success
      if (tickSucceeded) {
        try {
          const freshState = await ctx.runQuery(internal.crystal.organic.tick.getTickStateByUser, { userId });
          if (freshState && freshState.enabled) {
            const nextIntervalMs = freshState.tickIntervalMs;
            await ctx.scheduler.runAfter(
              nextIntervalMs,
              internal.crystal.organic.tick.processUserTick,
              {
                userId,
                lastTickAt: Date.now(),
                triggerSource: "scheduled" as const,
                tickIntervalMs: nextIntervalMs,
              }
            );
          }
        } catch (schedErr) {
          console.error(`[organic-tick] ${userId}: self-schedule failed:`, schedErr);
        }
      }
    }
  },
});

// ── Main tick loop ───────────────────────────────────────────────────────────

export const runTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.crystal.organic.recallLog.pruneOldRecallLogEntries, {}).catch(() => {});

    const tickStates = await ctx.db
      .query("organicTickState")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(500);

    if (tickStates.length === 0) {
      console.log("[organic-tick] No enabled users, skipping tick");
      return;
    }

    const now = Date.now();

    // Recovery mode: only dispatch users where self-scheduling appears to have stopped.
    // Grace period = max(2 * tickIntervalMs, 5 minutes) after the expected next tick.
    const recoveryStates = tickStates.filter((state) => {
      if (state.lastTickAt === 0) return true; // never ran, bootstrap
      const gracePeriod = Math.max(state.tickIntervalMs * 2, 5 * 60 * 1000);
      const expectedNextAt = state.lastTickAt + state.tickIntervalMs;
      return now > expectedNextAt + gracePeriod;
    });

    // Skip users currently running (lease active)
    const dueStates = recoveryStates.filter((state) => {
      if (state.isRunning && (state.leaseExpiresAt ?? 0) > now) return false;
      return true;
    });

    if (dueStates.length === 0) {
      return;
    }

    console.log(`[organic-tick] Recovery: dispatching ${dueStates.length} user ticks`);

    for (const state of dueStates) {
      await ctx.scheduler.runAfter(0, internal.crystal.organic.tick.processUserTick, {
        userId: state.userId,
        lastTickAt: state.lastTickAt,
        triggerSource: "scheduled",
        tickIntervalMs: state.tickIntervalMs,
      });
    }
  },
});

// ── Conversation Pulse ──────────────────────────────────────────────────────

const CONVERSATION_PULSE_COOLDOWN_MS = 60_000; // 1 per 60s per user

const buildConversationPulsePrompt = (
  conversationSummary: string,
  relatedMemoriesSummary: string,
  intent?: string,
): string => `
You are an anticipatory memory assistant. A user just had a conversation. Based on what was discussed, predict what content the user will need next.

Conversation (recent messages):
${conversationSummary}
${intent ? `\nDetected intent: ${intent}` : ""}

Related existing memories:
${relatedMemoriesSummary || "No related memories found."}

CRITICAL: Your job is to describe DOCUMENTS, not predict questions. The "documentDescription" field is the most important — it describes what content should be pre-assembled, written as a document summary (NOT as a question).

Focus on:
- What content should be pre-assembled for predicted follow-up topics?
- What existing memories should be updated or refined?
- Are there any contradictions between what was said and what is stored?

BAD documentDescription: "What were the test results for the payment integration?"
GOOD documentDescription: "Payment integration test results: Stripe webhook validation, error handling for declined cards, and the load test metrics from the March sprint"

Generic predictions are FORBIDDEN. Each must reference concrete concepts from the conversation.

Generate exactly 3 predictions as JSON array:
{
  "predictedQuery": "what the user might ask (for display only)",
  "documentDescription": "document-style description of content that would answer related queries — this is what gets matched against",
  "predictedContext": "pre-assembled context that would answer it (2-3 sentences max)",
  "traceType": "query" | "context" | "contradiction" | "action" | "resonance",
  "confidence": 0.0-1.0,
  "ttlHours": 1-72,
  "sourcePattern": "brief explanation of why this was predicted"
}

Return ONLY valid JSON array. No markdown, no explanation.`;

/**
 * Atomic rate-limit check + tick run creation for conversation pulses.
 * Scans 50 recent runs (not 5) to find conversation pulses among scheduled ones,
 * and creates the tick run in the same transaction to prevent TOCTOU races.
 */
export const rateLimitAndCreateConversationPulse = internalMutation({
  args: {
    userId: v.string(),
    tickId: v.string(),
    tickIntervalMs: v.number(),
    startedAt: v.number(),
    cooldownMs: v.number(),
  },
  handler: async (ctx, args) => {
    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (tickState?.isRunning && (tickState.leaseExpiresAt ?? 0) > args.startedAt) {
      return { allowed: false as const, lastPulseTime: tickState.lastTickAt };
    }

    const recent = await ctx.db
      .query("organicTickRuns")
      .withIndex("by_user_started", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(50);
    const lastConvPulse = recent.find((r) => r.triggerSource === "conversation");
    const lastPulseTime = lastConvPulse?.startedAt ?? 0;

    if (args.startedAt - lastPulseTime < args.cooldownMs) {
      return { allowed: false as const, lastPulseTime };
    }

    await ctx.db.insert("organicTickRuns", {
      userId: args.userId,
      tickId: args.tickId,
      triggerSource: "conversation",
      status: "running",
      startedAt: args.startedAt,
      tickIntervalMs: args.tickIntervalMs,
      previousTickAt: lastPulseTime,
      tracesGenerated: 0,
      tracesValidated: 0,
      tracesExpired: 0,
      ensemblesCreated: 0,
      ensemblesUpdated: 0,
      ensemblesArchived: 0,
      contradictionChecks: 0,
      contradictionsFound: 0,
      resonanceChecks: 0,
      resonancesFound: 0,
      ideasCreated: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
    });

    return { allowed: true as const, lastPulseTime };
  },
});

export const triggerConversationPulse = internalAction({
  args: {
    userId: v.string(),
    messages: v.array(v.object({ role: v.string(), content: v.string() })),
    intent: v.optional(v.string()),
    channelKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, messages, intent, channelKey } = args;
    const tickState = await ctx.runQuery(
      internal.crystal.organic.tick.getTickStateByUser,
      { userId }
    );
    if (tickState?.enabled !== true) {
      return {
        success: false,
        error: "Conversation pulse skipped because Organic is disabled",
        tracesCreated: 0,
        topics: [],
      };
    }

    const startedAt = Date.now();
    const tickId = `convpulse_${userId}_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
    let leaseAcquired = false;

    // Atomic rate limit check + tick run creation (prevents TOCTOU race)
    const rateCheck = await ctx.runMutation(
      internal.crystal.organic.tick.rateLimitAndCreateConversationPulse,
      { userId, tickId, tickIntervalMs: 0, startedAt, cooldownMs: CONVERSATION_PULSE_COOLDOWN_MS }
    );
    if (!rateCheck.allowed) {
      return {
        success: false,
        error: "Conversation pulse rate limited (max 1 per 60s)",
        tracesCreated: 0,
        topics: [],
      };
    }

    const acquired = await ctx.runMutation(internal.crystal.organic.tick.acquireTickLease, {
      userId,
      leaseDurationMs: 60_000,
    });
    if (!acquired) {
      await ctx.runMutation(internal.crystal.organic.tick.finalizeTickRun, {
        tickId,
        status: "failed",
        completedAt: Date.now(),
        tracesGenerated: 0,
        tracesValidated: 0,
        tracesExpired: 0,
        ensemblesCreated: 0,
        ensemblesUpdated: 0,
        ensemblesArchived: 0,
        contradictionChecks: 0,
        contradictionsFound: 0,
        resonanceChecks: 0,
        resonancesFound: 0,
        ideasCreated: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        errorMessage: "Conversation pulse skipped because another tick holds the lease",
      }).catch(() => {});
      return {
        success: false,
        error: "Conversation pulse skipped because another tick is already running",
        tracesCreated: 0,
        topics: [],
      };
    }
    leaseAcquired = true;
    // Resolve model preset (reuse tickState from above)
    const preset = getModelPreset(tickState?.organicModel);

    // Build conversation summary
    const conversationSummary = messages
      .slice(-20) // last 20 messages max
      .map((m) => `${m.role}: ${m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content}`)
      .join("\n");

    // Extract topics from messages for memory search
    const userMessages = messages.filter((m) => m.role === "user");
    const topicQuery = userMessages
      .slice(-3)
      .map((m) => m.content.slice(0, 200))
      .join(" ");

    // Search for related memories and collect sourceMemoryIds for provenance
    let relatedMemoriesSummary = "";
    const topics: string[] = [];
    let sourceMemoryIds: Array<MemoryDoc["_id"]> = [];
    try {
      const recentMemories = await ctx.runQuery(
        internal.crystal.organic.tick.getRecentMemories,
        { userId, since: startedAt - 7 * 24 * 60 * 60 * 1000 } // last 7 days
      );
      if (recentMemories.length > 0) {
        // Simple keyword matching: find memories that overlap with conversation topics
        const topicWords = new Set(
          topicQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
        );
        const related = recentMemories.filter((m: MemoryDoc) => {
          const memWords = `${m.title} ${m.content}`.toLowerCase();
          return Array.from(topicWords).some((w) => memWords.includes(w));
        }).slice(0, 15);

        if (related.length > 0) {
          relatedMemoriesSummary = related
            .map((m: MemoryDoc) => `[${m.store}/${m.category}] ${m.title}: ${m.content.slice(0, 120)}`)
            .join("\n");
          sourceMemoryIds = related.map((m: MemoryDoc) => m._id);
        }

        // Extract topic labels from related memories
        for (const m of related.slice(0, 5)) {
          if (m.tags && m.tags.length > 0) {
            topics.push(...m.tags.slice(0, 2));
          } else {
            topics.push(m.title.slice(0, 50));
          }
        }
      }
    } catch {
      // Continue without related memories
    }

    let tracesGenerated = 0;
    const spendItems: Array<{ estimatedInputTokens: number; estimatedOutputTokens: number; estimatedCostUsd: number }> = [];

    try {
      // Call model
      const prompt = buildConversationPulsePrompt(conversationSummary, relatedMemoriesSummary, intent);
      const result = await callOrganicWithTelemetry(prompt, preset);
      spendItems.push(result);
      tracesGenerated = result.traces.length;

      // Write traces with document embeddings (Fix 1)
      if (result.traces.length > 0) {
        const validTraces = await Promise.all(result.traces.map(async (t) => {
          const docDesc = t.documentDescription || t.predictedQuery || "";
          const embedding = docDesc.trim() ? await embedText(docDesc).catch(() => null) : null;
          return {
            predictedQuery: t.predictedQuery || "",
            predictedContext: t.predictedContext || "",
            documentDescription: docDesc,
            documentEmbedding: embedding ?? undefined,
            traceType: validateTraceType(t.traceType),
            confidence: clamp(t.confidence ?? 0.5, 0.0, 1.0),
            ttlHours: clamp(t.ttlHours ?? 24, 1, 72),
            sourcePattern: `conversation_pulse${channelKey ? `:${channelKey}` : ""}${intent ? ` [${intent}]` : ""}: ${t.sourcePattern || "unknown"}`,
          };
        }));

        await ctx.runMutation(internal.crystal.organic.tick.writePredictions, {
          userId,
          tickId,
          traces: validTraces,
          sourceMemoryIds,
        });
      }

      // Warm cache: pre-fetch related memory IDs for fast recall (Fix 4)
      if (sourceMemoryIds.length > 0) {
        try {
          await ctx.runMutation(internal.crystal.organic.tick.updateWarmCache, {
            userId,
            memoryIds: sourceMemoryIds.map((id) => String(id)).slice(0, 10),
            expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes
          });
        } catch { /* fire-and-forget */ }
      }

      // Finalize success
      const runSpend = summarizeRunSpend(spendItems);
      await ctx.runMutation(internal.crystal.organic.tick.finalizeTickRun, {
        tickId,
        status: "completed",
        completedAt: Date.now(),
        tracesGenerated,
        tracesValidated: 0,
        tracesExpired: 0,
        ensemblesCreated: 0,
        ensemblesUpdated: 0,
        ensemblesArchived: 0,
        contradictionChecks: 0,
        contradictionsFound: 0,
        resonanceChecks: 0,
        resonancesFound: 0,
        ideasCreated: 0,
        estimatedInputTokens: runSpend.estimatedInputTokens,
        estimatedOutputTokens: runSpend.estimatedOutputTokens,
        estimatedCostUsd: runSpend.estimatedCostUsd,
      });

      // Activity is tracked via the tick run record (triggerSource: "conversation")

      console.log(`[organic-conversation-pulse] ${userId}: ${tracesGenerated} traces generated`);

      return {
        success: true,
        tracesCreated: tracesGenerated,
        topics: [...new Set(topics)].slice(0, 10),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown conversation pulse failure";
      const runSpend = summarizeRunSpend(spendItems);
      await ctx.runMutation(internal.crystal.organic.tick.finalizeTickRun, {
        tickId,
        status: "failed",
        completedAt: Date.now(),
        tracesGenerated,
        tracesValidated: 0,
        tracesExpired: 0,
        ensemblesCreated: 0,
        ensemblesUpdated: 0,
        ensemblesArchived: 0,
        contradictionChecks: 0,
        contradictionsFound: 0,
        resonanceChecks: 0,
        resonancesFound: 0,
        ideasCreated: 0,
        estimatedInputTokens: runSpend.estimatedInputTokens,
        estimatedOutputTokens: runSpend.estimatedOutputTokens,
        estimatedCostUsd: runSpend.estimatedCostUsd,
        errorMessage: message,
      }).catch(() => {});
      throw error;
    } finally {
      if (leaseAcquired) {
        await ctx.runMutation(internal.crystal.organic.tick.releaseTickLease, { userId }).catch(() => {});
      }
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_TRACE_TYPES = new Set(["query", "context", "contradiction", "action", "resonance"]);

function extractTraceArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (!isRecord(parsed)) {
    return [];
  }

  for (const key of ["traces", "predictions", "items", "results"]) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function validateTraceType(t: string): ProspectiveTrace["traceType"] {
  return VALID_TRACE_TYPES.has(t) ? (t as ProspectiveTrace["traceType"]) : "query";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
