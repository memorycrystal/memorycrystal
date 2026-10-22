import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { applyDashboardTotalsDelta } from "./publicDashboardTotals";
import { stableUserId } from "./auth";
import { getMemoryEffectiveText, RAW_CONTENT_TOMBSTONE } from "./memoryText";
import { rawContentExpiresAt } from "./retention";
import { isProtectedSensoryCapture } from "./sensoryPolicy";
import { embedTextWithUserOpenRouter, type OpenRouterCredential } from "./embeddings";
import { deleteMemoryVector, upsertMemoryVector } from "./memoryVectors";
import {
  deleteCleanupProjectionForMemory,
  upsertCleanupProjectionForMemory,
} from "./cleanupProjection";
import { requestOpenRouter, recordMissingOpenRouterKey } from "./providerGateway";
import { sha256Hex } from "./crypto";
import { logError, logLabel } from "./crypto";

export { isProtectedSensoryCapture } from "./sensoryPolicy";

const nowMs = () => Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH = 500;
export const CLEANUP_DUE_USER_LIMIT = 100;
const MANUAL_REFLECTION_SAMPLE_LIMIT = 100;
const MANUAL_SUMMARY_BATCH_SIZE = 10;
const MANUAL_SUMMARY_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const MANUAL_SUMMARY_INPUT_USD_PER_1M = 0.15;
const MANUAL_SUMMARY_OUTPUT_USD_PER_1M = 0.60;
const MANUAL_SUMMARY_OUTPUT_TOKENS_PER_MEMORY = 45;
const OPENROUTER_COMPLETIONS_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const CONTINUATION_DELAY_MS = 5_000;
const CLEANUP_HARD_TIMEOUT_NOTE = "recoverable failures are finalized here; hard Convex action termination can still leave stale rows";

const cleanupInput = v.object({
  sensoryTtlHours: v.optional(v.number()),
  strengthFloor: v.optional(v.float64()),
});

const manualRetentionDays = v.union(v.literal(7), v.literal(14), v.literal(30));

function manualSummaryTokenEstimate(memories: Array<{ content?: string | null }>) {
  const inputTokens = memories.reduce((total, memory) => {
    const contentChars = (memory.content ?? "").trim().slice(0, 1800).length;
    return total + Math.ceil(contentChars / 4) + 80;
  }, 0);
  return {
    inputTokens,
    outputTokens: memories.length * MANUAL_SUMMARY_OUTPUT_TOKENS_PER_MEMORY,
  };
}

function estimateManualSummaryCostUsd(memories: Array<{ content?: string | null }>) {
  const { inputTokens, outputTokens } = manualSummaryTokenEstimate(memories);
  return (inputTokens / 1_000_000) * MANUAL_SUMMARY_INPUT_USD_PER_1M
    + (outputTokens / 1_000_000) * MANUAL_SUMMARY_OUTPUT_USD_PER_1M;
}

function costAttributionForOpenRouter(source: "personal" | "shared" | null | undefined) {
  if (source === "personal") return { keySource: "user_byok" as const, payer: "user" as const };
  if (source === "shared") return { keySource: "platform" as const, payer: "company" as const };
  return { keySource: "unknown" as const, payer: "unknown" as const };
}

async function embedText(
  text: string,
  ctx: Pick<any, "runMutation" | "runQuery">,
  accounting: { userId: string; source: string; openRouterCredential?: OpenRouterCredential },
): Promise<number[]> {
  try {
    return await embedTextWithUserOpenRouter(ctx, text, accounting) ?? [];
  } catch (error: any) {
    // ILL-184: the embedding layer raises an explicit missing-openrouter-key
    // failure (already recorded at the choke point); retention cleanup keeps
    // tombstoning raw content without a fresh embedding, matching prior
    // behavior for accounts with no credential.
    if (error?.data?.code === "missing_openrouter_key") return [];
    throw error;
  }
}

async function hydrateProjectionRows(
  ctx: any,
  rows: Array<{ memoryId: any }>,
  limit: number,
  isEligible: (memory: any) => boolean = () => true,
) {
  const memories = [];
  for (const row of rows) {
    const memory = await ctx.db.get(row.memoryId);
    if (memory && isEligible(memory)) memories.push(memory);
    if (memories.length >= limit) break;
  }
  return memories;
}

async function summarizeBatchForManualBackfill(
  memories: Array<{ _id: string; title?: string; content?: string | null }>,
  ctx: Pick<any, "runMutation">,
  userId: string,
  openrouterApiKey: string,
  keyLast4: string | null,
): Promise<Map<string, { summary: string; expectedSourceEffectiveTextHash: string }>> {
  const summaries = new Map<string, { summary: string; expectedSourceEffectiveTextHash: string }>();
  const inputs = memories
    .map((memory) => ({
      id: String(memory._id),
      title: memory.title ?? "Untitled",
      content: (memory.content ?? "").trim().slice(0, 1800),
      sourceEffectiveText: getMemoryEffectiveText(memory),
    }))
    .filter((item) => item.content && item.content !== RAW_CONTENT_TOMBSTONE)
    .map((item, index) => ({ ...item, index }));
  if (!openrouterApiKey || inputs.length === 0) return summaries;

  const result = await requestOpenRouter(ctx, {
    userId,
    apiKey: openrouterApiKey,
    keyLast4,
    endpoint: OPENROUTER_COMPLETIONS_ENDPOINT,
    source: "cleanup.summarizeBatchForManualBackfill",
    body: {
      model: MANUAL_SUMMARY_OPENROUTER_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            "Create concise retained-memory summaries for these sensory memories.",
            "Keep durable facts, decisions, user preferences, project state, and reusable context.",
            "Return ONLY valid JSON in this shape: {\"summaries\":[{\"index\":0,\"summary\":\"...\"}]}",
            "Use the zero-based indexes exactly as shown. Keep each summary to one sentence.",
            "",
            inputs.map((item) => `${item.index}. ${item.title}\n${item.content}`).join("\n\n"),
          ].join("\n"),
        },
      ],
    },
  });

  if (!result.ok) {
    console.log(`[manual-backfill] OpenRouter summary failed: status=${result.status} provider_error`);
    return summaries;
  }
  const payload = result.payload as any;
  const rawContent = String(payload?.choices?.[0]?.message?.content ?? "").trim();
  const cleaned = rawContent
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  let parsed: { summaries?: Array<{ index?: number; summary?: string }> };
  try {
    parsed = JSON.parse(cleaned) as { summaries?: Array<{ index?: number; summary?: string }> };
  } catch (error) {
    console.log("[manual-backfill] OpenRouter summary response was not valid JSON", await logError(error));
    return summaries;
  }
  for (const item of parsed.summaries ?? []) {
    const input = inputs[Number(item.index)];
    const summary = String(item.summary ?? "").trim();
    if (input && summary) summaries.set(input.id, {
      summary,
      expectedSourceEffectiveTextHash: await sha256Hex(input.sourceEffectiveText),
    });
  }
  return summaries;
}

export const getDueCleanupUserIds = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const scanLimit = Math.min(Math.max(args.limit * 4, args.limit + 1), 500);
    const dueRows: any[] = [];
    for (const state of ["raw", "summarized", undefined] as const) {
      dueRows.push(...await ctx.db
        .query("crystalMemories")
        .withIndex("by_raw_retention_due_personal", (q) =>
          q.eq("store", "sensory")
            .eq("archived", false)
            .eq("knowledgeBaseId", undefined)
            .eq("rawRetentionState", state)
            .lte("rawContentExpiresAt", args.now)
        )
        .take(scanLimit));
      // Legacy rows without a materialized due timestamp are bounded migration
      // work. Their tenant is visited once to persist the tier-derived dueAt;
      // subsequent idle ticks no longer touch that tenant until it is due.
      dueRows.push(...await ctx.db
        .query("crystalMemories")
        .withIndex("by_raw_retention_due_personal", (q) =>
          q.eq("store", "sensory")
            .eq("archived", false)
            .eq("knowledgeBaseId", undefined)
            .eq("rawRetentionState", state)
            .eq("rawContentExpiresAt", undefined)
        )
        .take(scanLimit));
    }
    const userIds = Array.from(new Set(dueRows
      .filter((memory) => !memory.knowledgeBaseId)
      .map((memory) => memory.userId as string)))
      .slice(0, args.limit);
    return {
      userIds,
      deferred: userIds.length >= args.limit || dueRows.length >= scanLimit,
    };
  },
});

export const initializeLegacySensoryRetentionDue = internalMutation({
  args: { userId: v.string(), sensoryRawTtlDays: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows: any[] = [];
    for (const state of ["raw", "summarized", undefined] as const) {
      rows.push(...await ctx.db
        .query("crystalMemories")
        .withIndex("by_user_raw_retention_due", (q) =>
          q.eq("userId", args.userId)
            .eq("store", "sensory")
            .eq("archived", false)
            .eq("rawRetentionState", state)
            .eq("rawContentExpiresAt", undefined)
        )
        .take(args.limit + 1));
    }
    const unique = Array.from(new Map(rows.map((row) => [String(row._id), row])).values());
    for (const memory of unique.slice(0, args.limit)) {
      const ttlDays = memory.sensoryRawTtlDaysApplied ?? args.sensoryRawTtlDays;
      await ctx.db.patch(memory._id, {
        rawContentExpiresAt: rawContentExpiresAt(memory.createdAt, ttlDays),
        sensoryRawTtlDaysApplied: ttlDays,
      });
    }
    return { initialized: Math.min(unique.length, args.limit), deferred: unique.length > args.limit };
  },
});

export const getSensoryRawCandidatesForCleanup = internalQuery({
  args: { userId: v.string(), now: v.number(), sensoryRawTtlDays: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const states = ["raw", "summarized", undefined] as const;
    const dueByIndex: any[] = [];
    for (const state of states) {
      const rows = await ctx.db
        .query("crystalMemories")
        .withIndex("by_user_raw_retention_due", (q) =>
          q
            .eq("userId", args.userId)
            .eq("store", "sensory")
            .eq("archived", false)
            .eq("rawRetentionState", state)
            .lte("rawContentExpiresAt", args.now)
        )
        .take(args.limit);
      dueByIndex.push(...rows);
    }

    const seen = new Set<string>();
    const due = dueByIndex.filter((row) => {
      const id = String(row._id);
      if (seen.has(id) || row.knowledgeBaseId || row.rawContentWipedAt) return false;
      seen.add(id);
      return true;
    });

    if (due.length >= args.limit) {
      return due
        .sort((a, b) => (a.rawContentExpiresAt ?? 0) - (b.rawContentExpiresAt ?? 0))
        .slice(0, args.limit);
    }

    // Legacy sensory rows may not have rawContentExpiresAt yet. For those rows,
    // createdAt + the current tier TTL is the fallback due date; oldest-first is
    // safe here because every row in this fallback uses the same TTL.
    const legacyRows = await ctx.db
      .query("crystalMemories")
      .withIndex("by_store_archived_created", (q) =>
        q.eq("userId", args.userId).eq("store", "sensory").eq("archived", false)
      )
      .order("asc")
      .filter((q) =>
        q.and(
          q.eq(q.field("rawContentWipedAt"), undefined),
          q.eq(q.field("rawContentExpiresAt"), undefined),
          q.neq(q.field("rawRetentionState"), "protected")
        )
      )
      .take(Math.min(args.limit * 10, 5_000));
    const legacyDue = legacyRows.filter((row) =>
      rawContentExpiresAt(row.createdAt, args.sensoryRawTtlDays) <= args.now
    );

    for (const row of legacyDue) {
      const id = String(row._id);
      if (seen.has(id)) continue;
      seen.add(id);
      due.push(row);
      if (due.length >= args.limit) break;
    }

    return due
      .sort((a, b) => {
        const aDue = a.rawContentExpiresAt ?? rawContentExpiresAt(a.createdAt, args.sensoryRawTtlDays);
        const bDue = b.rawContentExpiresAt ?? rawContentExpiresAt(b.createdAt, args.sensoryRawTtlDays);
        return aDue - bDue;
      })
      .filter((memory) => !memory.knowledgeBaseId)
      .slice(0, args.limit);
  },
});

export const getManualSensoryRawCandidatesForCleanup = internalQuery({
  args: { userId: v.string(), now: v.number(), sensoryRawTtlDays: manualRetentionDays, limit: v.number() },
  handler: async (ctx, args) => {
    const cutoff = args.now - args.sensoryRawTtlDays * 24 * 60 * 60 * 1000;
    const byId = new Map<string, any>();
    const addCandidate = (memory: any) => {
      if (
        memory.store !== "sensory" ||
        memory.archived === true ||
        memory.rawContentWipedAt ||
        memory.rawRetentionState === "protected" ||
        memory.createdAt > cutoff
      ) {
        return;
      }
      byId.set(String(memory._id), memory);
    };

    const projectionRows = await ctx.db
      .query("crystalMemoryCleanupIndex")
      .withIndex("by_user_archived_store_created", (q) =>
        q
          .eq("userId", args.userId)
          .eq("archived", false)
          .eq("store", "sensory")
          .lte("createdAt", cutoff)
      )
      .order("asc")
      .filter((q) =>
        q.and(
          q.eq(q.field("rawContentWipedAt"), undefined),
          q.neq(q.field("rawRetentionState"), "protected")
        )
      )
      .take(Math.min(args.limit * 10, 5_000));
    const projectedMemories = await hydrateProjectionRows(ctx, projectionRows, args.limit, (memory) =>
      memory.store === "sensory" &&
      memory.archived === false &&
      !memory.rawContentWipedAt &&
      memory.rawRetentionState !== "protected" &&
      memory.createdAt <= cutoff
    );
    for (const memory of projectedMemories) addCandidate(memory);

    // Imported memories can be backdated. If the projection state has already
    // completed past a newer createdAt, those older imports will not be in
    // crystalMemoryCleanupIndex yet. The manual Reflection dry run should still
    // show them, so fall back to a bounded source-table scan when projection
    // coverage is short.
    if (byId.size < args.limit) {
      const directRows = await ctx.db
        .query("crystalMemories")
        .withIndex("by_store_archived_created", (q) =>
          q
            .eq("userId", args.userId)
            .eq("store", "sensory")
            .eq("archived", false)
            .lte("createdAt", cutoff)
        )
        .order("asc")
        .filter((q) =>
          q.and(
            q.eq(q.field("rawContentWipedAt"), undefined),
            q.neq(q.field("rawRetentionState"), "protected")
          )
        )
        .take(Math.min(args.limit * 10, 5_000));
      for (const memory of directRows) {
        addCandidate(memory);
        if (byId.size >= args.limit) break;
      }
    }

    return Array.from(byId.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, args.limit);
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
        {
          totalMemoriesDelta: -1,
          activeMemoriesDelta: -1,
          // ILL-179 — deleting a live KB chunk drops it from the KB count too.
          knowledgeBaseMemoriesDelta: existing.knowledgeBaseId ? -1 : 0,
          activeMemoriesByStoreDelta: { [existing.store]: -1 },
          activeRecallCountDelta: -(existing.accessCount ?? 0),
          activeRecalledMemoriesDelta: (existing.accessCount ?? 0) > 0 ? -1 : 0,
        }
      );
    }

    await deleteMemoryVector(ctx, args.memoryId);
    await ctx.db.delete(args.memoryId);
    await deleteCleanupProjectionForMemory(ctx, args.memoryId);
  },
});

export const tombstoneSensoryRawContent = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    now: v.number(),
    sensoryRawTtlDaysApplied: v.number(),
    embedding: v.array(v.float64()),
    hasSummary: v.boolean(),
    expectedRawContentHash: v.string(),
    expectedEffectiveTextHash: v.string(),
    expectedRawContentExpiresAt: v.optional(v.number()),
    expectedSensoryRawTtlDaysApplied: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.store !== "sensory" || existing.archived) return null;
    if (isProtectedSensoryCapture(existing)) return null;
    if (existing.rawContentWipedAt) return null;
    const currentHasSummary = Boolean((existing.summary ?? "").trim() || (existing.recallText ?? "").trim());
    if (currentHasSummary !== args.hasSummary) {
      return { ok: false, reason: "stale_summary_state" as const };
    }
    if (currentHasSummary && args.embedding.length !== 3072) {
      // Keep the raw row due and retryable. Tombstoning here would make the
      // current summary permanently vectorless after a provider outage.
      return { ok: false, reason: "embedding_unavailable" as const };
    }
    if (
      existing.rawContentExpiresAt !== args.expectedRawContentExpiresAt ||
      existing.sensoryRawTtlDaysApplied !== args.expectedSensoryRawTtlDaysApplied
    ) {
      return { ok: false, reason: "stale_retention_policy" as const };
    }
    if (await sha256Hex(existing.content ?? "") !== args.expectedRawContentHash) {
      return { ok: false, reason: "stale_raw_content" as const };
    }
    if (await sha256Hex(getMemoryEffectiveText(existing)) !== args.expectedEffectiveTextHash) {
      return { ok: false, reason: "stale_effective_text" as const };
    }

    await ctx.db.patch(args.memoryId, {
      content: RAW_CONTENT_TOMBSTONE,
      contentTombstone: RAW_CONTENT_TOMBSTONE,
      rawContentWipedAt: args.now,
      contentWipedAt: args.now,
      rawRetentionState: args.hasSummary ? "wiped" : "wiped_without_summary",
      sensoryRawTtlDaysApplied: args.sensoryRawTtlDaysApplied,
      embeddingSource: args.hasSummary ? "summary" : "none",
      lastAccessedAt: args.now,
    });
    const updatedMemory = await ctx.db.get(args.memoryId);
    if (updatedMemory) await upsertCleanupProjectionForMemory(ctx, updatedMemory);
    if (args.embedding.length === 3072) {
      await upsertMemoryVector(ctx, {
        memoryId: args.memoryId,
        userId: existing.userId,
        knowledgeBaseId: existing.knowledgeBaseId,
        embedding: args.embedding,
      });
    } else {
      await deleteMemoryVector(ctx, args.memoryId);
    }
    return { ok: true };
  },
});

export const markProtectedSensoryRawRetention = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.store !== "sensory" || existing.archived) return null;
    if (!isProtectedSensoryCapture(existing)) return null;
    if (existing.rawRetentionState === "protected") return { ok: false };
    await ctx.db.patch(args.memoryId, {
      rawRetentionState: "protected",
      sensoryRawTtlDaysApplied: existing.sensoryRawTtlDaysApplied,
      lastAccessedAt: existing.lastAccessedAt ?? args.now,
    });
    const updated = await ctx.db.get(args.memoryId);
    if (updated) await upsertCleanupProjectionForMemory(ctx, updated);
    return { ok: true };
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

const runRetentionCleanupForUser = async (
  ctx: any,
  userId: string,
  args: { retentionDays: 7 | 14 | 30; dryRun: boolean; limit?: number },
  frontendJobId?: any,
) => {
    const now = nowMs();
    const tierInfo = await ctx.runQuery((internal as any).crystal.userProfiles.getUserTierInfo, { userId })
      .catch(() => ({ tier: "free", sensoryRawTtlDays: args.retentionDays }));
    const trigger = args.dryRun ? "backfill_dry_run" : "backfill_execute";
    const batchLimit = Math.max(10, Math.min(MAX_BATCH, Math.trunc(args.limit ?? MAX_BATCH)));
    const rawRetentionCutoffAt = now - args.retentionDays * DAY_MS;
    const runId = await ctx.runMutation((internal as any).crystal.reflectionLog.createRun, {
      userId,
      trigger,
      tier: tierInfo.tier,
      sensoryRawTtlDays: args.retentionDays,
      dryRun: args.dryRun,
      metadata: JSON.stringify({
        source: "manual_reflection_page",
        retentionDays: args.retentionDays,
        rawRetentionCutoffAt,
        limit: batchLimit,
      }),
    });

    let candidateCount = 0;
    let protectedCandidateCount = 0;
    let deferred = false;
    let wiped = 0;
    let wipedWithoutSummary = 0;
    let backfilled = 0;
    let skipped = 0;
    let errors = 0;
    let estimatedCostUsd = 0;
    let estimatedSummaryTokens = { inputTokens: 0, outputTokens: 0 };
    let costAttribution = costAttributionForOpenRouter(null);
    const memoryIds: any[] = [];
    const samples: Array<{ memoryId: any; title: string; action: string; reason?: string }> = [];
    let lastFrontendProgressPhase: string | null = null;
    let lastFrontendProgressProcessed = -1;
    const addSample = (memory: any, action: string, reason?: string) => {
      if (samples.length >= MANUAL_REFLECTION_SAMPLE_LIMIT) return;
      samples.push({
        memoryId: memory._id,
        title: memory.title,
        action,
        reason,
      });
    };

    try {
      await ctx.runMutation((internal as any).crystal.cleanupProjection.backfillCleanupProjectionForUser, {
        userId,
        limit: batchLimit,
      }).catch(() => null);
      const batch: any[] = await ctx.runQuery(internal.crystal.cleanup.getManualSensoryRawCandidatesForCleanup, {
        userId,
        now,
        sensoryRawTtlDays: args.retentionDays,
        limit: batchLimit + 1,
      });
      const protectedCandidates = batch.filter(isProtectedSensoryCapture);
      const candidates = batch.filter((memory) => !isProtectedSensoryCapture(memory)).slice(0, batchLimit);
      deferred = batch.length > batchLimit;
      candidateCount = candidates.length;
      protectedCandidateCount = protectedCandidates.length;
      skipped = protectedCandidates.length;
      const missingSummary = candidates.filter((memory) =>
        !String((memory.recallText ?? memory.summary ?? "")).trim()
      );
      estimatedCostUsd = estimateManualSummaryCostUsd(missingSummary);
      estimatedSummaryTokens = manualSummaryTokenEstimate(missingSummary);
      const openrouterCredential = missingSummary.length > 0 && !args.dryRun
        ? await ctx.runQuery((internal as any).crystal.providerSettings.resolveOpenRouterKeyForUser, {
          userId,
          includeShared: false,
        })
        : { apiKey: null, keyPrefix: null, source: null };
      costAttribution = costAttributionForOpenRouter(openrouterCredential.source);
    if (!args.dryRun) {
      for (const memory of protectedCandidates) {
        await ctx.runMutation(internal.crystal.cleanup.markProtectedSensoryRawRetention, {
          memoryId: memory._id,
          now,
        }).catch(() => null);
      }
    }
    for (const memory of protectedCandidates.slice(0, MANUAL_REFLECTION_SAMPLE_LIMIT)) {
      addSample(memory, "skipped", "protected_sensory_capture");
    }
    const patchProgress = async (phase: string, processed: number) => {
      await ctx.runMutation((internal as any).crystal.reflectionLog.updateRunProgress, {
        runId,
        summarized: args.dryRun ? 0 : backfilled,
        wiped: args.dryRun ? 0 : wiped,
        wipedWithoutSummary: args.dryRun ? 0 : wipedWithoutSummary,
        skipped,
        errors,
        estimatedCostUsd,
        costProvider: "openrouter",
        costModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
        keySource: costAttribution.keySource,
        payer: costAttribution.payer,
        estimatedInputTokens: estimatedSummaryTokens.inputTokens,
        estimatedOutputTokens: estimatedSummaryTokens.outputTokens,
        memoryIds: memoryIds.slice(0, 100),
        samples,
        metadata: JSON.stringify({
          source: "manual_reflection_page",
          retentionDays: args.retentionDays,
          rawRetentionCutoffAt,
          limit: batchLimit,
          candidateCount,
          protectedCandidateCount,
          deferred,
          dryRun: args.dryRun,
          phase,
          processed,
          progressUpdatedAt: Date.now(),
          estimatedSummaryModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
          estimatedSummaryCostUsd: estimatedCostUsd,
          estimatedSummaryInputTokens: estimatedSummaryTokens.inputTokens,
          estimatedSummaryOutputTokens: estimatedSummaryTokens.outputTokens,
          estimatedSummaryProvider: "openrouter",
          estimatedSummaryCredentialSource: openrouterCredential.source,
          backfilled,
          wouldBackfill: args.dryRun ? backfilled : undefined,
          wouldWipe: args.dryRun ? wiped : undefined,
        }),
      });
      if (frontendJobId) {
        const frontendProgressStep = Math.max(1, Math.ceil(Math.max(candidateCount, 1) / 25));
        const phaseChanged = phase !== lastFrontendProgressPhase;
        const reachedEnd = candidateCount > 0 && processed >= candidateCount;
        const advancedEnough = processed - lastFrontendProgressProcessed >= frontendProgressStep;
        if (phaseChanged || processed === 0 || reachedEnd || advancedEnough) {
          await ctx.runMutation((internal as any).crystal.frontendJobs.updateInternal, {
            jobId: frontendJobId,
            userId,
            status: "running",
            progressCurrent: processed,
            progressTotal: candidateCount || undefined,
            progressLabel: phase.replace(/_/g, " "),
          });
          lastFrontendProgressPhase = phase;
          lastFrontendProgressProcessed = processed;
        }
      }
    };

    await patchProgress("candidates_loaded", 0);
    const summaryBackfills = new Map<string, { summary: string; expectedSourceEffectiveTextHash: string }>();
    if (!args.dryRun) {
      if (missingSummary.length > 0 && !openrouterCredential.apiKey) {
        // ILL-184: no credential is an explicit, recorded failure at the choke
        // point so the alert policy can notify the user.
        await recordMissingOpenRouterKey(ctx, {
          userId,
          source: "cleanup.summarizeBatchForManualBackfill",
          endpointKind: "chat_completions",
          model: MANUAL_SUMMARY_OPENROUTER_MODEL,
        }).catch(() => {});
        const errorMessage = "Add your OpenRouter API key in Settings before running reflection summary backfill.";
        errors += 1;
        for (const memory of missingSummary.slice(0, MANUAL_REFLECTION_SAMPLE_LIMIT - samples.length)) {
          addSample(memory, "skipped", "missing_openrouter_key");
        }
        await ctx.runMutation((internal as any).crystal.reflectionLog.finishRun, {
          runId,
          status: "failed",
          summarized: 0,
          wiped: 0,
          wipedWithoutSummary: 0,
          skipped: skipped + missingSummary.length,
          errors,
          estimatedCostUsd,
          costProvider: "openrouter",
          costModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
          keySource: costAttribution.keySource,
          payer: costAttribution.payer,
          estimatedInputTokens: estimatedSummaryTokens.inputTokens,
          estimatedOutputTokens: estimatedSummaryTokens.outputTokens,
          memoryIds,
          samples,
          metadata: JSON.stringify({
            source: "manual_reflection_page",
            retentionDays: args.retentionDays,
            rawRetentionCutoffAt,
            limit: batchLimit,
            candidateCount,
            protectedCandidateCount,
            deferred,
            dryRun: args.dryRun,
            phase: "missing_openrouter_key",
            processed: 0,
            estimatedSummaryModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
            estimatedSummaryProvider: "openrouter",
            estimatedSummaryCostUsd: estimatedCostUsd,
            estimatedSummaryInputTokens: estimatedSummaryTokens.inputTokens,
            estimatedSummaryOutputTokens: estimatedSummaryTokens.outputTokens,
          }),
          errorMessage,
        });
        return {
          dryRun: args.dryRun,
          retentionDays: args.retentionDays,
          rawRetentionCutoffAt,
          candidateCount,
          wiped: 0,
          wipedWithoutSummary: 0,
          backfilled: 0,
          skipped: skipped + missingSummary.length,
          errors,
          deferred,
          estimatedCostUsd,
          estimatedSummaryModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
          error: errorMessage,
        };
      }
      await patchProgress(missingSummary.length > 0 ? "backfilling_summaries" : "processing_memories", 0);
      for (let index = 0; index < missingSummary.length; index += MANUAL_SUMMARY_BATCH_SIZE) {
        try {
          const chunk = missingSummary.slice(index, index + MANUAL_SUMMARY_BATCH_SIZE);
          const chunkSummaries = await summarizeBatchForManualBackfill(
            chunk,
            ctx,
            userId,
            openrouterCredential.apiKey,
            openrouterCredential.keyLast4 ?? null,
          );
          for (const [memoryId, generated] of chunkSummaries) {
            summaryBackfills.set(memoryId, generated);
          }
          await patchProgress("backfilling_summaries", Math.min(index + chunk.length, missingSummary.length));
        } catch (error) {
          errors += 1;
          console.log("[manual-backfill] summary batch failed", await logError(error, userId));
          await patchProgress("backfilling_summaries", Math.min(index + MANUAL_SUMMARY_BATCH_SIZE, missingSummary.length));
        }
      }
    }

    for (const [index, memory] of candidates.entries()) {
      let summaryText = String((memory.recallText ?? memory.summary ?? "")).trim();
      let hasSummary = Boolean(summaryText);
      let didBackfill = false;

      if (args.dryRun) {
        addSample(
          memory,
          hasSummary ? "would_wipe" : "would_backfill_then_wipe",
          hasSummary ? undefined : "missing_summary"
        );
        if (hasSummary) wiped += 1;
        else backfilled += 1;
        if (index < 10 || (index + 1) % 10 === 0 || index + 1 === candidateCount) {
          await patchProgress("dry_run_scanning", index + 1);
        }
        continue;
      }

      try {
        if (!hasSummary) {
          const generated = summaryBackfills.get(String(memory._id));
          summaryText = generated?.summary ?? "";
          if (summaryText && generated) {
            const summaryPatch = await ctx.runMutation(internal.crystal.reflection.patchSourceMemorySummary, {
              memoryId: memory._id,
              summary: summaryText,
              summarySource: "backfill",
              summaryModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
              summaryCostUsd: 0,
              reflectionRunId: runId,
              expectedSourceEffectiveTextHash: generated.expectedSourceEffectiveTextHash,
            });
            if (summaryPatch?.ok) {
              hasSummary = true;
              didBackfill = true;
              backfilled += 1;
            } else {
              summaryText = "";
            }
          }
        }

        if (!hasSummary) {
          skipped += 1;
          addSample(memory, "skipped", "summary_backfill_failed");
          continue;
        }

        const embeddingText = summaryText || getMemoryEffectiveText(memory);
        const expectedRawContentHash = await sha256Hex(memory.content ?? "");
        const expectedEffectiveTextHash = await sha256Hex(embeddingText);
        const embedding = await embedText(embeddingText, ctx, {
          userId: memory.userId,
          source: "cleanup.runMyRetentionCleanup",
          openRouterCredential: openrouterCredential,
        });
        const result = await ctx.runMutation(internal.crystal.cleanup.tombstoneSensoryRawContent, {
          memoryId: memory._id,
          now,
          sensoryRawTtlDaysApplied: args.retentionDays,
          embedding,
          hasSummary,
          expectedRawContentHash,
          expectedEffectiveTextHash,
          expectedRawContentExpiresAt: memory.rawContentExpiresAt,
          expectedSensoryRawTtlDaysApplied: memory.sensoryRawTtlDaysApplied,
        });
        if (result?.ok) {
          memoryIds.push(memory._id);
          wiped += 1;
          addSample(memory, didBackfill ? "backfilled_and_wiped" : "wiped");
        } else if (result?.reason === "embedding_unavailable") {
          skipped += 1;
          addSample(memory, "skipped", "embedding_unavailable");
        }
      } catch (error) {
        errors += 1;
        console.log(`[runMyRetentionCleanup] failed to process memory ${memory._id}`, await logError(error, userId));
      }

      if (index < 10 || (index + 1) % 5 === 0 || index + 1 === candidateCount) {
        await patchProgress("processing_memories", index + 1);
      }
    }

    const metadata = JSON.stringify({
      source: "manual_reflection_page",
      retentionDays: args.retentionDays,
      rawRetentionCutoffAt,
      limit: batchLimit,
      candidateCount,
      protectedCandidateCount,
      deferred,
      dryRun: args.dryRun,
      estimatedSummaryModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
      estimatedSummaryProvider: "openrouter",
      estimatedSummaryCostUsd: estimatedCostUsd,
      estimatedSummaryInputTokens: estimatedSummaryTokens.inputTokens,
      estimatedSummaryOutputTokens: estimatedSummaryTokens.outputTokens,
      backfilled,
      wouldBackfill: args.dryRun ? backfilled : undefined,
      wouldWipe: args.dryRun ? wiped : undefined,
    });
    await ctx.runMutation((internal as any).crystal.reflectionLog.finishRun, {
      runId,
      status: errors > 0 ? "failed" : "completed",
      summarized: args.dryRun ? 0 : backfilled,
      wiped: args.dryRun ? 0 : wiped,
      wipedWithoutSummary: args.dryRun ? 0 : wipedWithoutSummary,
      skipped,
      errors,
      estimatedCostUsd,
      costProvider: "openrouter",
      costModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
      keySource: costAttribution.keySource,
      payer: costAttribution.payer,
      estimatedInputTokens: estimatedSummaryTokens.inputTokens,
      estimatedOutputTokens: estimatedSummaryTokens.outputTokens,
      memoryIds: memoryIds.slice(0, 100),
      samples,
      metadata,
      errorMessage: deferred
        ? `Processed first ${batchLimit} candidates. Run again for remaining records.`
        : undefined,
    });

    return {
      dryRun: args.dryRun,
      retentionDays: args.retentionDays,
      rawRetentionCutoffAt,
      candidateCount,
      wouldWipe: args.dryRun ? wiped : undefined,
      wouldBackfill: args.dryRun ? backfilled : undefined,
      wiped: args.dryRun ? undefined : wiped,
      wipedWithoutSummary: args.dryRun ? undefined : wipedWithoutSummary,
      backfilled: args.dryRun ? undefined : backfilled,
      skipped,
      errors,
      deferred,
      estimatedCostUsd,
      estimatedSummaryModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
    };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors += 1;
      await ctx.runMutation((internal as any).crystal.reflectionLog.finishRun, {
        runId,
        status: "failed",
        summarized: args.dryRun ? 0 : backfilled,
        wiped: args.dryRun ? 0 : wiped,
        wipedWithoutSummary: args.dryRun ? 0 : wipedWithoutSummary,
        skipped,
        errors,
        estimatedCostUsd,
        costProvider: "openrouter",
        costModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
        keySource: costAttribution.keySource,
        payer: costAttribution.payer,
        estimatedInputTokens: estimatedSummaryTokens.inputTokens,
        estimatedOutputTokens: estimatedSummaryTokens.outputTokens,
        memoryIds: memoryIds.slice(0, 100),
        samples,
        metadata: JSON.stringify({
          source: "manual_reflection_page",
          retentionDays: args.retentionDays,
          rawRetentionCutoffAt,
          limit: batchLimit,
          candidateCount,
          protectedCandidateCount,
          deferred,
          dryRun: args.dryRun,
          backfilled,
          wouldBackfill: args.dryRun ? backfilled : undefined,
          wouldWipe: args.dryRun ? wiped : undefined,
          phase: "unexpected_failure",
          failedAt: Date.now(),
        }),
        errorMessage,
      });
      return {
        dryRun: args.dryRun,
        retentionDays: args.retentionDays,
        rawRetentionCutoffAt,
        candidateCount,
        wouldWipe: args.dryRun ? wiped : undefined,
        wouldBackfill: args.dryRun ? backfilled : undefined,
        wiped: args.dryRun ? undefined : wiped,
        wipedWithoutSummary: args.dryRun ? undefined : wipedWithoutSummary,
        backfilled: args.dryRun ? undefined : backfilled,
        skipped,
        errors,
        deferred: false,
        estimatedCostUsd,
        estimatedSummaryModel: MANUAL_SUMMARY_OPENROUTER_MODEL,
        error: errorMessage,
      };
    }
};

export const runMyRetentionCleanup = action({
  args: {
    retentionDays: manualRetentionDays,
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    return runRetentionCleanupForUser(ctx, stableUserId(identity.subject), args);
  },
});

export const startMyRetentionCleanup = action({
  args: {
    retentionDays: manualRetentionDays,
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    frontendJobId: v.id("crystalFrontendJobs"),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{
    frontendJobId: Id<"crystalFrontendJobs">;
    created: boolean;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    const userId = stableUserId(identity.subject);
    const kind = args.dryRun ? "reflection_dry_run" : "reflection_cleanup";
    const frontendJob = await ctx.runMutation(
      internal.crystal.frontendJobs.createInternal,
      {
        userId,
        kind,
        resourceId: "manual-retention",
        title: args.dryRun ? "Checking reflection retention" : "Running reflection cleanup",
        route: "/reflection",
        progressLabel: "Queued",
      },
    );
    if (frontendJob.created) {
      await ctx.scheduler.runAfter(
        0,
        (internal as any).crystal.cleanup.processMyRetentionCleanup,
        { userId, ...args, frontendJobId: frontendJob.jobId },
      );
    }
    return { frontendJobId: frontendJob.jobId, created: frontendJob.created };
  },
});

export const processMyRetentionCleanup: any = internalAction({
  args: {
    userId: v.string(),
    retentionDays: manualRetentionDays,
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
    frontendJobId: v.id("crystalFrontendJobs"),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation((internal as any).crystal.frontendJobs.updateInternal, {
      jobId: args.frontendJobId,
      userId: args.userId,
      status: "running",
      progressLabel: "Preparing reflection run",
    });
    try {
      const result = await runRetentionCleanupForUser(
        ctx,
        args.userId,
        {
          retentionDays: args.retentionDays,
          dryRun: args.dryRun,
          limit: args.limit,
        },
        args.frontendJobId,
      );
      const failed = Boolean(result?.error) || Number(result?.errors ?? 0) > 0;
      const progressLabel = args.dryRun
        ? `${Number(result?.candidateCount ?? 0).toLocaleString()} candidates found`
        : `${Number(result?.backfilled ?? 0).toLocaleString()} summarized, ${Number(result?.wiped ?? 0).toLocaleString()} wiped`;
      await ctx.runMutation((internal as any).crystal.frontendJobs.updateInternal, {
        jobId: args.frontendJobId,
        userId: args.userId,
        status: failed ? "failed" : "completed",
        progressLabel,
        error: result?.error,
      });
      return { status: failed ? "failed" : "completed", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation((internal as any).crystal.frontendJobs.updateInternal, {
        jobId: args.frontendJobId,
        userId: args.userId,
        status: "failed",
        progressLabel: "Reflection failed",
        error: message,
      });
      return { status: "failed", error: message };
    }
  },
});

export const runCleanup = internalAction({
  args: cleanupInput,
  handler: async (ctx, args) => {
    const now = nowMs();

    const dueWork: { userIds: string[]; deferred: boolean } = await ctx.runQuery(
      internal.crystal.cleanup.getDueCleanupUserIds,
      { now, limit: CLEANUP_DUE_USER_LIMIT },
    );
    const userIds = dueWork.userIds;

    let deletedSensory = 0;
    let wipedSensory = 0;
    let wipedWithoutSummary = 0;
    let removedAssociations = 0;
    let deletedTelemetry = 0;
    let deletedDryRunEmails = 0;
    let errors = 0;
    let anyDeferred = dueWork.deferred;

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
      const tierInfo = await ctx.runQuery((internal as any).crystal.userProfiles.getUserTierInfo, { userId })
        .catch(() => ({ tier: "free", sensoryRawTtlDays: 7 }));
      const legacyInitialization = await ctx.runMutation(
        internal.crystal.cleanup.initializeLegacySensoryRetentionDue,
        { userId, sensoryRawTtlDays: tierInfo.sensoryRawTtlDays, limit: MAX_BATCH },
      );
      if (legacyInitialization.deferred) anyDeferred = true;
      const reflectionRunId = await ctx.runMutation((internal as any).crystal.reflectionLog.createRun, {
        userId,
        trigger: "cleanup",
        tier: tierInfo.tier,
        sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
        metadata: JSON.stringify({
          source: "scheduled_cleanup",
          phase: "created",
          progressUpdatedAt: Date.now(),
          hardTimeoutBoundary: CLEANUP_HARD_TIMEOUT_NOTE,
        }),
      }).catch(() => null);
      let userWiped = 0;
      let userWipedWithoutSummary = 0;
      let userArchived = 0;
      let userSkipped = 0;
      let userErrors = 0;
      let userPhase = "created";
      let sensoryCandidateCount = 0;
      let archivalCandidateCount = 0;
      let sensoryDeferred = 0;
      let archivalDeferred = 0;
      const userMemoryIds: any[] = [];
      const userSamples: Array<{ memoryId: any; title: string; action: string; reason?: string }> = [];
      let userMadeProgress = false;

      const cleanupMetadata = (phase: string) => JSON.stringify({
        source: "scheduled_cleanup",
        phase,
        sensoryCandidateCount,
        archivalCandidateCount,
        sensoryDeferred,
        archivalDeferred,
        deferred: sensoryDeferred > 0 || archivalDeferred > 0,
        wiped: userWiped,
        wipedWithoutSummary: userWipedWithoutSummary,
        archived: userArchived,
        skipped: userSkipped,
        errors: userErrors,
        progressUpdatedAt: Date.now(),
        deferredMessage: phase === "completed" && (sensoryDeferred > 0 || archivalDeferred > 0)
          ? `Processed first cleanup batch; deferred sensory=${sensoryDeferred}, archival=${archivalDeferred}. The scheduled continuation will retry remaining records.`
          : undefined,
        hardTimeoutBoundary: CLEANUP_HARD_TIMEOUT_NOTE,
      });

      const updateCleanupRun = async (phase: string) => {
        userPhase = phase;
        if (!reflectionRunId) return;
        await ctx.runMutation((internal as any).crystal.reflectionLog.updateRunProgress, {
          runId: reflectionRunId,
          wiped: userWiped,
          wipedWithoutSummary: userWipedWithoutSummary,
          archived: userArchived,
          skipped: userSkipped,
          errors: userErrors,
          memoryIds: userMemoryIds.slice(0, 100),
          samples: userSamples,
          metadata: cleanupMetadata(phase),
        }).catch(() => {});
      };

      const finishCleanupRun = async (status: "completed" | "failed", errorMessage?: string) => {
        if (!reflectionRunId) return;
        await ctx.runMutation((internal as any).crystal.reflectionLog.finishRun, {
          runId: reflectionRunId,
          status,
          wiped: userWiped,
          wipedWithoutSummary: userWipedWithoutSummary,
          archived: userArchived,
          skipped: userSkipped,
          errors: userErrors,
          memoryIds: userMemoryIds.slice(0, 100),
          samples: userSamples,
          metadata: cleanupMetadata(status === "failed" ? `failed:${userPhase}` : "completed"),
          errorMessage: status === "failed"
            ? errorMessage ?? `Cleanup completed with ${userErrors} recoverable error${userErrors === 1 ? "" : "s"}. Check function logs for memory-level failures.`
            : undefined,
        }).catch(() => {});
      };

      let cleanupOpenRouterCredential: OpenRouterCredential | undefined;
      const getCleanupOpenRouterCredential = async () => {
        if (cleanupOpenRouterCredential !== undefined) return cleanupOpenRouterCredential;
        cleanupOpenRouterCredential = await ctx.runQuery((internal as any).crystal.providerSettings.resolveOpenRouterKeyForUser, {
          userId,
          includeShared: false,
        }) as OpenRouterCredential;
        return cleanupOpenRouterCredential;
      };

      try {
        const sensoryBatch: any[] = await ctx.runQuery(internal.crystal.cleanup.getSensoryRawCandidatesForCleanup, {
          userId,
          now,
          sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
          limit: MAX_BATCH + 1,
        });
        const sensoryMemories = sensoryBatch.slice(0, MAX_BATCH);
        sensoryCandidateCount = sensoryMemories.length;
        sensoryDeferred = Math.max(0, sensoryBatch.length - MAX_BATCH);
        await updateCleanupRun("candidates_loaded");

        for (const [index, memory] of sensoryMemories.entries()) {
          try {
            if (isProtectedSensoryCapture(memory)) {
              userSkipped += 1;
              const protectedMark = await ctx.runMutation(internal.crystal.cleanup.markProtectedSensoryRawRetention, {
                memoryId: memory._id,
                now,
              }).catch(() => null);
              if (protectedMark?.ok) userMadeProgress = true;
              if (userSamples.length < 10) {
                userSamples.push({
                  memoryId: memory._id,
                  title: memory.title,
                  action: "skipped",
                  reason: "protected_sensory_capture",
                });
              }
              continue;
            }

            const rawDueAt = memory.rawContentExpiresAt ??
              rawContentExpiresAt(memory.createdAt, tierInfo.sensoryRawTtlDays);
            const isExpiredSensory =
              memory.store === "sensory" &&
              !memory.rawContentWipedAt &&
              now >= rawDueAt;

            if (isExpiredSensory) {
              // Cleanup never calls LLMs or summarizers; it only uses existing summary/recall text.
              const effectiveText = getMemoryEffectiveText(memory);
              const hasSummary = Boolean((memory.summary ?? "").trim() || (memory.recallText ?? "").trim());
              const expectedRawContentHash = await sha256Hex(memory.content ?? "");
              const expectedEffectiveTextHash = await sha256Hex(effectiveText);
              const embedding = hasSummary ? await embedText(effectiveText, ctx, {
                userId,
                source: "cleanup.runCleanup",
                openRouterCredential: await getCleanupOpenRouterCredential(),
              }) : [];
              const result = await ctx.runMutation(internal.crystal.cleanup.tombstoneSensoryRawContent, {
                memoryId: memory._id,
                now,
                sensoryRawTtlDaysApplied: tierInfo.sensoryRawTtlDays,
                embedding,
                hasSummary,
                expectedRawContentHash,
                expectedEffectiveTextHash,
                expectedRawContentExpiresAt: memory.rawContentExpiresAt,
                expectedSensoryRawTtlDaysApplied: memory.sensoryRawTtlDaysApplied,
              });
              if (result?.ok) {
                userMadeProgress = true;
                userMemoryIds.push(memory._id);
                if (userSamples.length < 10) {
                  userSamples.push({
                    memoryId: memory._id,
                    title: memory.title,
                    action: hasSummary ? "wiped" : "wiped_without_summary",
                    reason: hasSummary ? undefined : "missing_summary",
                  });
                }
                if (hasSummary) {
                  wipedSensory += 1;
                  userWiped += 1;
                } else {
                  wipedWithoutSummary += 1;
                  userWipedWithoutSummary += 1;
                }
              } else if (result?.reason === "embedding_unavailable") {
                userSkipped += 1;
                if (userSamples.length < 10) {
                  userSamples.push({
                    memoryId: memory._id,
                    title: memory.title,
                    action: "skipped",
                    reason: "embedding_unavailable",
                  });
                }
              }
              continue;
            }
          } catch (error) {
            errors += 1;
            userErrors += 1;
            console.log(`[runCleanup] failed to process memory ${memory._id}`, await logError(error, userId));
          }
          if (index < 10 || (index + 1) % 25 === 0 || index + 1 === sensoryCandidateCount) {
            await updateCleanupRun("processing_sensory");
          }
        }
        await updateCleanupRun("sensory_processed");

        if (userMadeProgress && (sensoryDeferred > 0 || archivalDeferred > 0)) {
          anyDeferred = true;
          console.log(
            `[runCleanup] user ${await logLabel(userId)}: deferred sensory=${sensoryDeferred}, archival=${archivalDeferred} to next run`
          );
        }
        await finishCleanupRun(userErrors > 0 ? "failed" : "completed");
      } catch (error) {
        errors += 1;
        userErrors += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log("[runCleanup] failed cleanup run", await logLabel(userId), await logError(error, userId));
        await finishCleanupRun("failed", errorMessage);
      }
    }

    // If any user had memories past the per-run cap, self-schedule a continuation so
    // retention contracts converge without waiting a full day for the next cron tick.
    // Guarded by the cron itself (runs every 24h) so a broken scheduler cannot loop forever.
    if (anyDeferred) {
      await ctx.scheduler.runAfter(CONTINUATION_DELAY_MS, internal.crystal.cleanup.runCleanup, {
        strengthFloor: args.strengthFloor,
      });
    }

    return {
      deleted: deletedSensory,
      wiped: wipedSensory,
      wipedWithoutSummary,
      archived: 0,
      archivedWeakProcedurals: 0,
      removedAssociations,
      deletedTelemetry,
      deletedDryRunEmails,
      errors,
      deferred: anyDeferred,
    };
  },
});
