import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  applyDashboardTotalsDelta,
  buildMemoryTransitionDelta,
} from "./dashboardTotals";
import { stableUserId } from "./auth";
import { getMemoryEffectiveText, RAW_CONTENT_TOMBSTONE } from "./memoryText";
import { rawContentExpiresAt } from "./retention";
import { isProtectedSensoryCapture } from "./sensoryPolicy";

export { isProtectedSensoryCapture } from "./sensoryPolicy";

const nowMs = () => Date.now();
const MAX_BATCH = 500;
const MANUAL_REFLECTION_SAMPLE_LIMIT = 100;
const MANUAL_SUMMARY_BATCH_SIZE = 10;
const MANUAL_SUMMARY_MODEL = "gpt-4o-mini";
const MANUAL_SUMMARY_INPUT_USD_PER_1M = 0.15;
const MANUAL_SUMMARY_OUTPUT_USD_PER_1M = 0.60;
const MANUAL_SUMMARY_OUTPUT_TOKENS_PER_MEMORY = 45;
const OPENAI_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const PROCEDURAL_REINFORCEMENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PROCEDURAL_OBSERVATIONS_TO_KEEP_ACTIVE = 3;
const CONTINUATION_DELAY_MS = 5_000;
const GEMINI_EMBEDDING_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2-preview";

const cleanupInput = v.object({
  sensoryTtlHours: v.optional(v.number()),
  strengthFloor: v.optional(v.float64()),
});

const manualRetentionDays = v.union(v.literal(7), v.literal(14), v.literal(30));

function estimateManualSummaryCostUsd(memories: Array<{ content?: string | null }>) {
  const inputTokens = memories.reduce((total, memory) => {
    const contentChars = (memory.content ?? "").trim().slice(0, 1800).length;
    return total + Math.ceil(contentChars / 4) + 80;
  }, 0);
  const outputTokens = memories.length * MANUAL_SUMMARY_OUTPUT_TOKENS_PER_MEMORY;
  return (inputTokens / 1_000_000) * MANUAL_SUMMARY_INPUT_USD_PER_1M
    + (outputTokens / 1_000_000) * MANUAL_SUMMARY_OUTPUT_USD_PER_1M;
}

async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !text.trim()) return [];
  const model = process.env.GEMINI_EMBEDDING_MODEL || GEMINI_EMBEDDING_MODEL;
  const response = await fetch(
    `${GEMINI_EMBEDDING_ENDPOINT}/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    }
  );
  const payload = await response.json().catch(() => null);
  const vector = payload?.embedding?.values;
  if (!response.ok || !Array.isArray(vector)) {
    console.log(`[cleanup.embedText] Gemini embedding failed: status=${response.status}`);
    return [];
  }
  return vector as number[];
}

async function summarizeBatchForManualBackfill(
  memories: Array<{ _id: string; title?: string; content?: string | null }>
): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  const apiKey = process.env.OPENAI_API_KEY;
  const inputs = memories
    .map((memory) => ({
      id: String(memory._id),
      title: memory.title ?? "Untitled",
      content: (memory.content ?? "").trim().slice(0, 1800),
    }))
    .filter((item) => item.content && item.content !== RAW_CONTENT_TOMBSTONE)
    .map((item, index) => ({ ...item, index }));
  if (!apiKey || inputs.length === 0) return summaries;

  const response = await fetch(OPENAI_COMPLETIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MANUAL_SUMMARY_MODEL,
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
    }),
  });

  if (!response.ok) {
    console.log(`[manual-backfill] OpenAI summary failed: status=${response.status}`);
    return summaries;
  }
  const payload = await response.json().catch(() => null);
  const rawContent = String(payload?.choices?.[0]?.message?.content ?? "").trim();
  const cleaned = rawContent
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as { summaries?: Array<{ index?: number; summary?: string }> };
  for (const item of parsed.summaries ?? []) {
    const input = inputs[Number(item.index)];
    const summary = String(item.summary ?? "").trim();
    if (input && summary) summaries.set(input.id, summary);
  }
  return summaries;
}

export const getMemoriesForCleanup = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    // Non-sensory archival candidates are kept separate from raw sensory retention so
    // healthy old memories cannot block due sensory wipes.
    return ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("asc")
      .filter((q) =>
        q.and(
          q.eq(q.field("archived"), false),
          q.neq(q.field("store"), "sensory")
        )
      )
      .take(args.limit);
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
      if (dueByIndex.length >= args.limit) break;
    }

    const seen = new Set<string>();
    const due = dueByIndex.filter((row) => {
      const id = String(row._id);
      if (seen.has(id) || row.rawContentWipedAt) return false;
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
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("asc")
      .filter((q) =>
        q.and(
          q.eq(q.field("archived"), false),
          q.eq(q.field("store"), "sensory"),
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
      .slice(0, args.limit);
  },
});

export const getManualSensoryRawCandidatesForCleanup = internalQuery({
  args: { userId: v.string(), now: v.number(), sensoryRawTtlDays: manualRetentionDays, limit: v.number() },
  handler: async (ctx, args) => {
    const cutoff = args.now - args.sensoryRawTtlDays * 24 * 60 * 60 * 1000;
    return ctx.db
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

export const tombstoneSensoryRawContent = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    now: v.number(),
    sensoryRawTtlDaysApplied: v.number(),
    embedding: v.array(v.float64()),
    hasSummary: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.store !== "sensory" || existing.archived) return null;
    if (isProtectedSensoryCapture(existing)) return null;
    if (existing.rawContentWipedAt) return null;

    await ctx.db.patch(args.memoryId, {
      content: RAW_CONTENT_TOMBSTONE,
      contentTombstone: RAW_CONTENT_TOMBSTONE,
      rawContentWipedAt: args.now,
      contentWipedAt: args.now,
      rawRetentionState: args.hasSummary ? "wiped" : "wiped_without_summary",
      sensoryRawTtlDaysApplied: args.sensoryRawTtlDaysApplied,
      embedding: args.embedding,
      embeddingSource: args.hasSummary ? "summary" : "none",
      lastAccessedAt: args.now,
    });
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

export const runMyRetentionCleanup = action({
  args: {
    retentionDays: manualRetentionDays,
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const now = nowMs();
    const userId = stableUserId(identity.subject);
    const tierInfo = await ctx.runQuery((internal as any).crystal.userProfiles.getUserTierInfo, { userId })
      .catch(() => ({ tier: "free", sensoryRawTtlDays: args.retentionDays }));
    const trigger = args.dryRun ? "backfill_dry_run" : "backfill_execute";
    const batchLimit = Math.max(10, Math.min(MAX_BATCH, Math.trunc(args.limit ?? MAX_BATCH)));
    const runId = await ctx.runMutation((internal as any).crystal.reflectionLog.createRun, {
      userId,
      trigger,
      tier: tierInfo.tier,
      sensoryRawTtlDays: args.retentionDays,
      dryRun: args.dryRun,
      metadata: JSON.stringify({ source: "manual_reflection_page", retentionDays: args.retentionDays, limit: batchLimit }),
    });

    const batch: any[] = await ctx.runQuery(internal.crystal.cleanup.getManualSensoryRawCandidatesForCleanup, {
      userId,
      now,
      sensoryRawTtlDays: args.retentionDays,
      limit: batchLimit + 1,
    });
    const protectedCandidates = batch.filter(isProtectedSensoryCapture);
    const candidates = batch.filter((memory) => !isProtectedSensoryCapture(memory)).slice(0, batchLimit);
    const deferred = batch.length > batchLimit;
    const candidateCount = candidates.length;
    let wiped = 0;
    let wipedWithoutSummary = 0;
    let backfilled = 0;
    let skipped = protectedCandidates.length;
    let errors = 0;
    const missingSummary = candidates.filter((memory) =>
      !String((memory.recallText ?? memory.summary ?? "")).trim()
    );
    const estimatedCostUsd = estimateManualSummaryCostUsd(missingSummary);
    const memoryIds: any[] = [];
    const samples: Array<{ memoryId: any; title: string; action: string; reason?: string }> = [];
    const addSample = (memory: any, action: string, reason?: string) => {
      if (samples.length >= MANUAL_REFLECTION_SAMPLE_LIMIT) return;
      samples.push({
        memoryId: memory._id,
        title: memory.title,
        action,
        reason,
      });
    };
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
        memoryIds: memoryIds.slice(0, 100),
        samples,
        metadata: JSON.stringify({
          source: "manual_reflection_page",
          retentionDays: args.retentionDays,
          limit: batchLimit,
          candidateCount,
          protectedCandidateCount: protectedCandidates.length,
          deferred,
          dryRun: args.dryRun,
          phase,
          processed,
          progressUpdatedAt: Date.now(),
          estimatedSummaryModel: MANUAL_SUMMARY_MODEL,
          estimatedSummaryCostUsd: estimatedCostUsd,
          backfilled,
          wouldBackfill: args.dryRun ? backfilled : undefined,
          wouldWipe: args.dryRun ? wiped : undefined,
        }),
      });
    };

    for (const memory of protectedCandidates.slice(0, MANUAL_REFLECTION_SAMPLE_LIMIT)) {
      addSample(memory, "skipped", "protected_sensory_capture");
    }

    await patchProgress("candidates_loaded", 0);
    const summaryBackfills = new Map<string, string>();
    if (!args.dryRun) {
      await patchProgress(missingSummary.length > 0 ? "backfilling_summaries" : "processing_memories", 0);
      for (let index = 0; index < missingSummary.length; index += MANUAL_SUMMARY_BATCH_SIZE) {
        try {
          const chunk = missingSummary.slice(index, index + MANUAL_SUMMARY_BATCH_SIZE);
          const chunkSummaries = await summarizeBatchForManualBackfill(chunk);
          for (const [memoryId, summary] of chunkSummaries) {
            summaryBackfills.set(memoryId, summary);
          }
          await patchProgress("backfilling_summaries", Math.min(index + chunk.length, missingSummary.length));
        } catch (error) {
          errors += 1;
          console.log("[manual-backfill] summary batch failed", error);
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
          summaryText = summaryBackfills.get(String(memory._id)) ?? "";
          if (summaryText) {
            await ctx.runMutation(internal.crystal.reflection.patchSourceMemorySummary, {
              memoryId: memory._id,
              summary: summaryText,
              summarySource: "backfill",
              summaryModel: MANUAL_SUMMARY_MODEL,
              summaryCostUsd: 0,
              reflectionRunId: runId,
            });
            hasSummary = true;
            didBackfill = true;
            backfilled += 1;
          }
        }

        if (!hasSummary) {
          skipped += 1;
          addSample(memory, "skipped", "summary_backfill_failed");
          continue;
        }

        const embedding = await embedText(summaryText || getMemoryEffectiveText(memory));
        const result = await ctx.runMutation(internal.crystal.cleanup.tombstoneSensoryRawContent, {
          memoryId: memory._id,
          now,
          sensoryRawTtlDaysApplied: args.retentionDays,
          embedding,
          hasSummary,
        });
        if (result) {
          memoryIds.push(memory._id);
          wiped += 1;
          addSample(memory, didBackfill ? "backfilled_and_wiped" : "wiped");
        }
      } catch (error) {
        errors += 1;
        console.log(`[runMyRetentionCleanup] failed to process memory ${memory._id}`, error);
      }

      if (index < 10 || (index + 1) % 5 === 0 || index + 1 === candidateCount) {
        await patchProgress("processing_memories", index + 1);
      }
    }

    const metadata = JSON.stringify({
      source: "manual_reflection_page",
      retentionDays: args.retentionDays,
      limit: batchLimit,
      candidateCount,
      protectedCandidateCount: protectedCandidates.length,
      deferred,
      dryRun: args.dryRun,
      estimatedSummaryModel: MANUAL_SUMMARY_MODEL,
      estimatedSummaryCostUsd: estimatedCostUsd,
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
      estimatedSummaryModel: MANUAL_SUMMARY_MODEL,
    };
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
    const strengthFloor = Math.max(args.strengthFloor ?? 0.1, 0);

    const userIds: string[] = await ctx.runQuery(internal.crystal.userProfiles.listAllUserIds, {});

    let deletedSensory = 0;
    let wipedSensory = 0;
    let wipedWithoutSummary = 0;
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
      const tierInfo = await ctx.runQuery((internal as any).crystal.userProfiles.getUserTierInfo, { userId })
        .catch(() => ({ tier: "free", sensoryRawTtlDays: 7 }));
      const reflectionRunId = await ctx.runMutation((internal as any).crystal.reflectionLog.createRun, {
        userId,
        trigger: "cleanup",
        tier: tierInfo.tier,
        sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
      }).catch(() => null);
      let userWiped = 0;
      let userWipedWithoutSummary = 0;
      let userArchived = 0;
      let userSkipped = 0;
      let userErrors = 0;
      const userMemoryIds: any[] = [];
      const userSamples: Array<{ memoryId: any; title: string; action: string; reason?: string }> = [];
      const sensoryBatch: any[] = await ctx.runQuery(internal.crystal.cleanup.getSensoryRawCandidatesForCleanup, {
        userId,
        now,
        sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
        limit: MAX_BATCH + 1,
      });
      const archivalBatch: any[] = await ctx.runQuery(internal.crystal.cleanup.getMemoriesForCleanup, {
        userId,
        limit: MAX_BATCH + 1,
      });

      const sensoryMemories = sensoryBatch.slice(0, MAX_BATCH);
      const archivalMemories = archivalBatch.slice(0, MAX_BATCH);
      const sensoryDeferred = Math.max(0, sensoryBatch.length - MAX_BATCH);
      const archivalDeferred = Math.max(0, archivalBatch.length - MAX_BATCH);
      let userMadeProgress = false;

      for (const memory of sensoryMemories) {
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
            const embedding = hasSummary ? await embedText(effectiveText) : [];
            const result = await ctx.runMutation(internal.crystal.cleanup.tombstoneSensoryRawContent, {
              memoryId: memory._id,
              now,
              sensoryRawTtlDaysApplied: tierInfo.sensoryRawTtlDays,
              embedding,
              hasSummary,
            });
            if (result) {
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
            }
            continue;
          }
        } catch (error) {
          errors += 1;
          userErrors += 1;
          console.log(`[runCleanup] failed to process memory ${memory._id}`, error);
        }
      }

      for (const memory of archivalMemories) {
        try {
          if (memory.knowledgeBaseId) {
            continue;
          }

          const isWeakMemory = memory.strength < strengthFloor;
          const shouldArchiveWeakProcedural = getWeakProceduralArchiveEligibility(memory, now);

          if (isWeakMemory) {
            await ctx.runMutation(internal.crystal.cleanup.archiveWeakMemory, { memoryId: memory._id, archivedAt: now });
            archivedByStrength += 1;
            userArchived += 1;
            userMadeProgress = true;
            continue;
          }

          if (shouldArchiveWeakProcedural) {
            await ctx.runMutation(internal.crystal.cleanup.archiveWeakMemory, { memoryId: memory._id, archivedAt: now });
            archivedWeakProcedurals += 1;
            userArchived += 1;
            userMadeProgress = true;
          }
        } catch (error) {
          errors += 1;
          userErrors += 1;
          console.log(`[runCleanup] failed to process memory ${memory._id}`, error);
        }
      }
      if (userMadeProgress && (sensoryDeferred > 0 || archivalDeferred > 0)) {
        anyDeferred = true;
        console.log(
          `[runCleanup] user ${userId}: deferred sensory=${sensoryDeferred}, archival=${archivalDeferred} to next run`
        );
      }
      if (reflectionRunId) {
        await ctx.runMutation((internal as any).crystal.reflectionLog.finishRun, {
          runId: reflectionRunId,
          status: userErrors > 0 ? "failed" : "completed",
          wiped: userWiped,
          wipedWithoutSummary: userWipedWithoutSummary,
          archived: userArchived,
          skipped: userSkipped,
          errors: userErrors,
          memoryIds: userMemoryIds.slice(0, 100),
          samples: userSamples,
        }).catch(() => {});
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
