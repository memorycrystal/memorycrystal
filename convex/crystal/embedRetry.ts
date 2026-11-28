/**
 * Bounded embedding retries. Each attempt queues the next one before doing
 * any work and cancels that job when the outcome is definitive, so an
 * interrupted invocation cannot end the chain. The bound is per chain.
 */
import { ConvexError, v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { metric } from "./metrics";

/**
 * Attempt 0 plus four retries: 10 minutes, 1 hour, 6 hours, 24 hours.
 * The bound is per chain. A second chain for the same memory may also call
 * the provider; the text-hash guard rejects a stale write.
 */
export const EMBED_RETRY_DELAYS_MS = [
  10 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;

const RETRYABLE_PROVIDER_STATUSES = new Set([408, 425, 429]);

type Outcome =
  | "embedded"
  | "no_vector_after_retry"
  | "skipped_no_key"
  | "terminal_provider"
  | "retry_kept"
  | "successor_schedule_failed"
  | "gave_up"
  | "settled"
  | "schedule_failed"
  | "cancel_failed";

type SchedulerCtx = {
  scheduler: {
    runAfter: (delayMs: number, reference: any, args?: any) => Promise<any>;
  };
};

export async function scheduleMemoryEmbedding(
  ctx: SchedulerCtx,
  memoryId: Id<"crystalMemories">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.crystal.embedRetry.ensureEmbedded, {
    memoryId,
    attempt: 0,
  });
}

export const embeddingOwner = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, { memoryId }) => {
    const row = await ctx.db.get(memoryId);
    if (!row) return null;
    return { userId: row.userId };
  },
});

function errorCode(error: unknown): string | undefined {
  const candidates: unknown[] = [];
  if (error instanceof ConvexError) candidates.push(error.data);
  if (error && typeof error === "object" && "data" in error) {
    candidates.push((error as { data?: unknown }).data);
  }
  for (const candidate of candidates) {
    let data = candidate;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { data = null; }
    }
    if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
      return (data as { code: string }).code;
    }
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("missing_openrouter_key")) return "missing_openrouter_key";
  if (message.includes("embedding_cap_exceeded")) return "embedding_cap_exceeded";
  return undefined;
}

function retryableProviderStatus(status: unknown): boolean {
  // Terminal means only a 4xx status other than 408, 425 and 429.
  // Every other status or absence of one is retryable (the bound limits spend).
  if (typeof status !== "number" || !Number.isInteger(status)) return true;
  if (status >= 400 && status < 500) {
    return RETRYABLE_PROVIDER_STATUSES.has(status);
  }
  return true;
}

const DONE_REASONS = new Set<string>([
  "archived",
  "missing",
  "empty_effective_text",
  "stale_effective_text",
]);

function classifyEmbedResult(result: any): "done" | "terminal" | "retryable" {
  // null/undefined: the memory is gone or blank (settled).
  if (result == null) return "done";
  // Explicit success or near-duplicate merge.
  if (result.embedded === true || result.nearDupMergedInto) return "done";
  // Known done reasons from embedMemory (explicit settled shapes from the current path).
  if (result.embedded === false && DONE_REASONS.has(result.reason)) return "done";
  // Known non-provider reasons that are retryable.
  if (result.reason === "embedding_cap_exceeded" || result.reason === "missing_vector") return "retryable";
  // Provider errors: delegate to the status classifier.
  if (result.reason === "provider_error") {
    return retryableProviderStatus(result.status) ? "retryable" : "terminal";
  }
  // Anything not recognised is retryable: {embedded:false} with no/unknown reason,
  // {}, non-objects, etc. The bound limits spend.
  return "retryable";
}

function logOutcome(outcome: Outcome): void {
  if (outcome === "settled") return;
  metric("ensureEmbedded", { outcome });
}

export const ensureEmbedded = internalAction({
  args: {
    memoryId: v.id("crystalMemories"),
    attempt: v.number(),
  },
  handler: async (ctx, { memoryId, attempt }): Promise<{ outcome: Outcome }> => {
    let successorId: Id<"_scheduled_functions"> | null = null;
    let successorScheduleFailed = false;
    if (Number.isInteger(attempt) && attempt >= 0 && attempt < EMBED_RETRY_DELAYS_MS.length) {
      try {
        successorId = await ctx.scheduler.runAfter(
          EMBED_RETRY_DELAYS_MS[attempt],
          internal.crystal.embedRetry.ensureEmbedded,
          { memoryId, attempt: attempt + 1 },
        );
      } catch {
        successorScheduleFailed = true;
        logOutcome("schedule_failed");
        // Continue without a successor; the work still runs.
      }
    }
    const cancelSuccessor = async () => {
      if (successorId !== null) {
        try {
          await ctx.scheduler.cancel(successorId);
        } catch {
          logOutcome("cancel_failed");
        }
        successorId = null;
      }
    };

    // Attempt 0 is today's first job, including its missing-key record, and it
    // is the shared near-duplicate finalizer. Creators may already have stored
    // a vector; embedMemory must still run so it can reuse that vector and
    // merge. Later attempts stop once the row is no longer vectorless, and
    // before any provider call when the key is gone.
    if (attempt >= 1) {
      const classification = await ctx.runQuery(internal.crystal.vectorlessSweep.recheck, { memoryId });
      if (classification !== "vectorless") {
        await cancelSuccessor();
        return { outcome: "settled" };
      }
      const owner = await ctx.runQuery(internal.crystal.embedRetry.embeddingOwner, { memoryId });
      if (!owner) {
        await cancelSuccessor();
        return { outcome: "settled" };
      }
      const hasKey = await ctx.runQuery(internal.crystal.vectorlessSweep.hasPersonalKey, {
        userId: owner.userId,
      });
      if (!hasKey) {
        await cancelSuccessor();
        logOutcome("skipped_no_key");
        return { outcome: "skipped_no_key" };
      }
    }

    let result: any;
    try {
      result = await ctx.runAction(internal.crystal.mcp.embedMemory, {
        memoryId,
        reportOutcome: true,
        quietMissingKey: attempt >= 1,
      });
    } catch (error) {
      if (errorCode(error) === "missing_openrouter_key") {
        await cancelSuccessor();
        logOutcome("skipped_no_key");
        return { outcome: "skipped_no_key" };
      }
      const outcome: Outcome = successorId !== null
        ? "retry_kept"
        : successorScheduleFailed ? "successor_schedule_failed" : "gave_up";
      logOutcome(outcome);
      return { outcome };
    }

    const decision = classifyEmbedResult(result);
    if (decision === "done") {
      await cancelSuccessor();
      if (result?.embedded === true || result?.nearDupMergedInto) {
        logOutcome("embedded");
        return { outcome: "embedded" };
      }
      return { outcome: "settled" };
    }
    if (decision === "terminal") {
      await cancelSuccessor();
      logOutcome("terminal_provider");
      return { outcome: "terminal_provider" };
    }
    if (successorId !== null) {
      logOutcome("retry_kept");
      return { outcome: "retry_kept" };
    }
    if (successorScheduleFailed) {
      logOutcome("successor_schedule_failed");
      return { outcome: "successor_schedule_failed" };
    }
    const outcome: Outcome = result?.reason === "missing_vector" || result?.reason === "provider_error"
      ? "no_vector_after_retry"
      : "gave_up";
    logOutcome(outcome);
    return { outcome };
  },
});
