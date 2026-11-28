/**
 * ILL-1177: the Memory health self-probe. Accuracy without a private answer
 * key: each sampled memory becomes one query built from words in its own
 * title, run through the shared recall engine (the same ranking path as
 * recallMemories) with recordAccess false, and scored by the rank of that
 * memory in the top 5. A few nonsense queries check that recall can return
 * nothing.
 *
 * Bounds: at most POSITIVE_PROBES + NEGATIVE_PROBE_QUERIES.length probes per
 * run, and the searching parts of a run (these probes and the sample step's
 * near-duplicate searches) run in at most SEARCH_RUNS_PER_DAY searching runs
 * per account per UTC day the run STARTED; a run that crosses midnight is
 * counted against its start day. Slots are reserved atomically in
 * crystalMemoryHealthSearchSlots before any search, and nothing searches while
 * the cost breaker is past "ok" for the surfaces it uses. The embedding calls are debited to the breaker up front; each recall
 * debits itself through the engine's own budget port. The probe never calls a
 * rerank model.
 *
 * Only memory ids, ranks and result counts are stored. Query text lives in
 * this action's memory and is never written or logged.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { embedTextWithUserOpenRouterDetailed } from "./embeddings";
import { logError } from "./crypto";
import { buildRecallMemoriesPorts } from "./recall";
import { normalizeActionRecallArgs } from "./recallEngine/normalize";
import { runRecallEngine } from "./recallEngine/run";
import type { MemoryHealthMetrics, MemoryHealthWork } from "./memoryHealthModel";

/** Searching runs (vector searches, probe recalls) per account per UTC day the run started. */
export const SEARCH_RUNS_PER_DAY = 2;
export const PROBE_TOP_K = 5;
export const POSITIVE_PROBES = 12;
export const PROBE_QUERY_MAX_WORDS = 6;
const PROBE_QUERY_MIN_WORDS = 3;
const PROBE_EMBED_SOURCE = "memory_health_probe";
/** Probe items (positive or nonsense) per scheduled action. */
export const PROBE_BATCH = 4;
/** One embedding or one recall may take at most this long. */
export const PROBE_CALL_TIMEOUT_MS = 30_000;
/** A batch starts no new item after this long, far inside Convex's 10-minute action limit. */
export const PROBE_BATCH_DEADLINE_MS = 120_000;

/** Rejects when `work` has not settled within `ms`. */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Made-up words: no tenant's memories should match them. */
export const NEGATIVE_PROBE_QUERIES = [
  "quorvex plimbate zantheric volundry",
  "glarnish obbertude fenwhistle craddock spleen",
  "vexillomancy trundlebeck oomph moonquake",
] as const;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "how", "in", "into", "is", "it",
  "its", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "what", "when", "which", "who",
  "why", "will", "with", "about", "after", "before", "should", "would", "could", "can", "not", "but", "our", "your",
  "lesson", "decision", "reflection", "summary", "open", "loop", "note", "memory", "update",
]);

/**
 * Query for a positive probe: the title's content words, lowercased, minus
 * stopwords and the digest prefixes, first PROBE_QUERY_MAX_WORDS kept in order.
 * Null when fewer than three content words remain (an untitled or one-word
 * memory is not a fair probe).
 */
export function probeQueryFromTitle(title: string | undefined | null): string | null {
  if (typeof title !== "string") return null;
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw) || seen.has(raw)) continue;
    seen.add(raw);
    words.push(raw);
    if (words.length === PROBE_QUERY_MAX_WORDS) break;
  }
  return words.length >= PROBE_QUERY_MIN_WORDS ? words.join(" ") : null;
}

/** 1-based rank of `memoryId` among the first PROBE_TOP_K results, or null. */
export function rankOf(memories: unknown, memoryId: string): number | null {
  if (!Array.isArray(memories)) return null;
  const ids: string[] = [];
  for (const memory of memories) {
    const id = String((memory as any)?._id ?? (memory as any)?.memoryId ?? "");
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length === PROBE_TOP_K) break;
  }
  const index = ids.indexOf(memoryId);
  return index === -1 ? null : index + 1;
}

/**
 * Atomically reserves one of the account's SEARCH_RUNS_PER_DAY searching slots
 * for `dayKey`, the UTC day the run STARTED (the snapshot's dayKey), not the
 * day of the call: a run that crosses midnight is counted against its start
 * day. Guarantee: at most SEARCH_RUNS_PER_DAY searching runs per account per
 * UTC day the run started. A snapshot that already holds a slot (a retried
 * step, a later probe batch, or its probe after its near-duplicate searches)
 * reuses it. A slot is never released: a failed attempt still counts.
 */
export const reserveSearchSlot = internalMutation({
  args: { userId: v.string(), dayKey: v.string(), snapshotId: v.id("crystalMemoryHealthSnapshots") },
  handler: async (ctx, { userId, dayKey, snapshotId }) => {
    const row = await ctx.db
      .query("crystalMemoryHealthSearchSlots")
      .withIndex("by_user_day", (q) => q.eq("userId", userId).eq("dayKey", dayKey))
      .first();
    if (row?.snapshotIds.includes(snapshotId)) return { reserved: true, used: row.snapshotIds.length };
    const used = row?.snapshotIds.length ?? 0;
    if (used >= SEARCH_RUNS_PER_DAY) return { reserved: false, used };
    if (row) await ctx.db.patch(row._id, { snapshotIds: [...row.snapshotIds, snapshotId], updatedAt: Date.now() });
    else await ctx.db.insert("crystalMemoryHealthSearchSlots", { userId, dayKey, snapshotIds: [snapshotId], updatedAt: Date.now() });
    return { reserved: true, used: used + 1 };
  },
});

const SLOT_PRUNE_BATCH = 200;

/** Deletes slot rows for days before `beforeDayKey`, one bounded batch per call, rescheduling until done. */
export const pruneSearchSlots = internalMutation({
  args: { beforeDayKey: v.string() },
  handler: async (ctx, { beforeDayKey }) => {
    const rows = await ctx.db
      .query("crystalMemoryHealthSearchSlots")
      .withIndex("by_day", (q) => q.lt("dayKey", beforeDayKey))
      .take(SLOT_PRUNE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === SLOT_PRUNE_BATCH) await ctx.scheduler.runAfter(0, internal.crystal.memoryHealthProbe.pruneSearchSlots, { beforeDayKey });
    return { deleted: rows.length };
  },
});

type BreakerSurface = "recall" | "embedding" | "cleanup";
type GateInput = { snapshotId: Id<"crystalMemoryHealthSnapshots">; userId: string; dayKey: string };

/**
 * Why this run may not search now, or null when it may. Read-only breaker
 * check first, then the atomic daily slot reservation, both before any
 * search or embedding call.
 */
export async function searchSkipReason(ctx: ActionCtx, input: GateInput, work: MemoryHealthWork, surfaces: BreakerSurface[]): Promise<string | null> {
  const ledger = await ctx.runQuery(internal.crystal.costBreaker.readTodayLedgerStatus, { userId: input.userId });
  if (surfaces.some((surface) => ledger.user[surface] !== "ok" || ledger.global[surface] !== "ok")) return "cost breaker is not ok";
  const slot = await ctx.runMutation(internal.crystal.memoryHealthProbe.reserveSearchSlot, {
    userId: input.userId,
    dayKey: input.dayKey,
    snapshotId: input.snapshotId,
  });
  work.docsRead += 1;
  if (!slot.reserved) return `daily limit of ${SEARCH_RUNS_PER_DAY} searching runs reached`;
  return null;
}

/** Owner-checked probe input for one sampled memory. The query never leaves the action. */
export const readProbeTarget = internalQuery({
  args: { userId: v.string(), memoryId: v.id("crystalMemories") },
  handler: async (ctx, { userId, memoryId }) => {
    const memory = await ctx.db.get(memoryId);
    if (!memory || memory.userId !== userId || memory.archived || memory.knowledgeBaseId) return null;
    const query = probeQueryFromTitle(memory.title);
    if (!query) return null;
    return { query, ...(memory.channel !== undefined ? { channel: memory.channel } : {}) };
  },
});

type ProbeSection = NonNullable<MemoryHealthMetrics["probe"]>;
type ProbeInput = {
  snapshotId: Id<"crystalMemoryHealthSnapshots">;
  userId: string;
  dayKey: string;
  probeTargets: Id<"crystalMemories">[];
  probeCursor: number;
  probe: ProbeSection | null;
};
type ProbeBatch = { section: ProbeSection; nextCursor: number | null };

function skipped(reason: string, work?: { embeddingCalls: number; recallRuns: number }): ProbeSection {
  return { positives: [], negatives: [], skippedReason: reason, embeddingCalls: work?.embeddingCalls ?? 0, recallRuns: work?.recallRuns ?? 0 };
}

async function recallTop(ctx: ActionCtx, userId: string, query: string, channel: string | undefined, work: MemoryHealthWork) {
  try {
    return await recallTopUnsafe(ctx, userId, query, channel, work);
  } catch (error) {
    // The query is derived from a memory title: redact it from the log, and rethrow
    // without the original message so the step's own failure log cannot carry it.
    console.error("[memoryHealth] probe recall failed:", await logError(error, userId, [query]));
    throw new Error("memory health probe recall failed");
  }
}

async function recallTopUnsafe(ctx: ActionCtx, userId: string, query: string, channel: string | undefined, work: MemoryHealthWork) {
  const embedded = await withTimeout(
    // Uncached on purpose: embedText/embedTextDetailed keep a module-level cache keyed by the input text,
    // and a probe query is derived from a memory title.
    embedTextWithUserOpenRouterDetailed(ctx, query, { userId, source: PROBE_EMBED_SOURCE }, { quietMissingKey: true }),
    PROBE_CALL_TIMEOUT_MS,
    "probe embedding",
  );
  work.embeddingCalls += 1;
  if (!embedded.ok) return null;
  const outcome = await withTimeout(
    runRecallEngine(
      normalizeActionRecallArgs({
        embedding: embedded.embedding,
        query,
        limit: PROBE_TOP_K,
        recordAccess: false,
        ...(channel !== undefined ? { channel } : {}),
      }),
      buildRecallMemoriesPorts(ctx, userId),
    ),
    PROBE_CALL_TIMEOUT_MS,
    "probe recall",
  );
  work.recallRuns += 1;
  return outcome.body.memories;
}

/**
 * One batch of the probe step: at most PROBE_BATCH items, and no new item
 * after PROBE_BATCH_DEADLINE_MS. Items are the probe targets, then the
 * nonsense queries; the cursor indexes that list and is stored on the
 * snapshot between batches, so a retried batch resumes where the last
 * successful one stopped. The gate and the embedding debit run once, before
 * the first item.
 */
export async function runProbeStep(ctx: ActionCtx, input: ProbeInput, work: MemoryHealthWork): Promise<ProbeBatch> {
  const done = (section: ProbeSection): ProbeBatch => ({ section, nextCursor: null });
  const items = input.probeTargets.length + NEGATIVE_PROBE_QUERIES.length;
  let section: ProbeSection;
  if (input.probeCursor === 0) {
    const reason = await searchSkipReason(ctx, input, work, ["recall", "embedding"]);
    if (reason) return done(skipped(reason));
    if (!input.probeTargets.length) return done(skipped("no sampled memory has a usable title"));
    const debit = await ctx.runMutation(internal.crystal.costBreaker.debitUserAndGlobal, {
      userId: input.userId,
      surface: "embedding",
      estimatedEmbeddingCalls: items,
      reason: "memoryHealth.probe",
    });
    if (debit.user.emergency || debit.global.emergency) return done(skipped("cost breaker is not ok"));
    section = { positives: [], negatives: [], embeddingCalls: 0, recallRuns: 0 };
  } else {
    section = input.probe ?? { positives: [], negatives: [], embeddingCalls: 0, recallRuns: 0 };
  }

  const started = Date.now();
  let cursor = input.probeCursor;
  const end = Math.min(items, cursor + PROBE_BATCH);
  const tally = () => ({
    ...section,
    embeddingCalls: section.embeddingCalls + work.embeddingCalls,
    recallRuns: section.recallRuns + work.recallRuns,
  });
  while (cursor < end && Date.now() - started < PROBE_BATCH_DEADLINE_MS) {
    if (cursor < input.probeTargets.length) {
      const memoryId = input.probeTargets[cursor];
      const target = await ctx.runQuery(internal.crystal.memoryHealthProbe.readProbeTarget, { userId: input.userId, memoryId });
      work.docsRead += 1;
      if (target) {
        const memories = await recallTop(ctx, input.userId, target.query, target.channel, work);
        if (memories === null) return done({ ...tally(), skippedReason: "embedding unavailable" });
        section.positives.push({ memoryId: String(memoryId), rank: rankOf(memories, String(memoryId)) });
      }
    } else {
      const query = NEGATIVE_PROBE_QUERIES[cursor - input.probeTargets.length];
      const memories = await recallTop(ctx, input.userId, query, undefined, work);
      if (memories === null) return done({ ...tally(), skippedReason: "embedding unavailable" });
      section.negatives.push({ returned: Array.isArray(memories) ? memories.length : 0 });
    }
    cursor += 1;
  }
  return { section: tally(), nextCursor: cursor < items ? cursor : null };
}
