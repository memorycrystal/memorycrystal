import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getNonKbActiveMemories } from "./dashboardTotals";
import { MISSING_USER_OPENROUTER_KEY_REASON } from "./ltmExtraction";

/**
 * ILL-181 — operator-invoked historical backlog drain (ADR 0008, gate for
 * sub-issue 4).
 *
 * The nightly Reflection Cycle (ILL-180) distils 200 messages per user per
 * night; accounts with ~46k undistilled messages reaching back 98 days would
 * take years at that rate. This module is the explicit-drain tooling the
 * operator runs in staged, bounded invocations until the settle-eligible
 * backlog is zero. It is NOT registered in convex/crons.ts — it is
 * operator-invoked only.
 *
 * Design:
 *  - `getBacklogDepth` is the progress signal and completion gate. It seeks
 *    the `by_user_ltm_extracted_time` index on
 *    `(userId, ltmExtractedAt = undefined, timestamp <= cutoff)` and counts by
 *    paging bounded pages — never `.collect()`, never a full-table scan, and
 *    per-user bounded (one linear pass over that user's own undistilled
 *    range). The `role != "system"` predicate is applied in-stream during the
 *    page reads, exactly matching the engine's candidate semantics.
 *  - `runBacklogDrainForUser` loops the ILL-180 engine
 *    (`runDistillationForUser`) unchanged, oldest-first, until the user's
 *    settle-eligible backlog is empty or an invocation bound is hit. Each
 *    iteration writes the engine's own crystalReflectionRuns record (trigger
 *    "reflection_cycle") AND updates one campaign record (trigger
 *    "backlog_drain") plus a durable per-user cursor in crystalJobCursors, so
 *    a killed or timed-out action leaves an accurate partial record and the
 *    next invocation resumes without reprocessing.
 *
 * Resumption: processed messages are stamped `ltmExtractedAt` by the engine,
 * so the candidates index seek naturally excludes them; the durable cursor is
 * the campaign's cumulative bookkeeping (messages drained, memories created,
 * spend, iteration run ids) so the operator can see exactly where the
 * previous staged run stopped and what a bad batch's remediation scope is.
 * Memories inserted by a drain carry `extractionRunId` =
 * `ltm:<ts>:<userId>::` (buildExtractionRunId inside the engine); a bad batch
 * is bulk-archived by matching `extractionRunId` against the drain window.
 *
 * The drain never deletes a message and never mutates `expiresAt` — the
 * engine only sets `ltmExtractedAt` / `ltmExtractionSkippedReason` and
 * inserts memories.
 */

/**
 * ── OPERATOR RUNBOOK — backend memory sampling (Amendment 2026-08-06) ───────
 * Sample convex-backend-prod memory throughout each staged drain and judge the
 * next launch from the observed peak:
 *
 *     npx @railway/cli metrics -s convex-backend-prod -e production --since 15m --json
 *
 * Thresholds:
 *  - peak >= ~9,000 MB: HALVE the per-run message budget (messagesPerRun /
 *    maxMessages) for subsequent invocations before continuing.
 *  - peak >= 10,240 MB: ABORT the drain. Do not launch the next staged run
 *    until backend memory returns below the halve line.
 * Pass the observed peak to each invocation as `peakBackendMemoryMb`; the
 * runner folds it into the campaign record's metadata (requirement 4), so the
 * peak is recorded structurally rather than by hand.
 *
 * Gate output: the fail-closed wrapper suppresses getBacklogDepths payloads
 * (unclassified). To see the gate payload, run
 * `npm run convex:self-hosted -- run crystal/backlogDrain:getBacklogDepths '{}'`
 * (or with `{"exact":true}` for a true depth total). It is not in
 * SAFE_OBSERVABLE_OUTPUT_SCHEMAS because that validator requires an exact
 * key-count match of integer-only fields and the gate carries booleans /
 * arrays / strings (gatePassed, exact, capped, users, residualRisk).
 */

const DRAIN_JOB_PREFIX = "backlog_drain:";
// Mirror of EXTRACTION_SETTLE_MS in ltmExtraction.ts: messages younger than
// this are still settling and belong to the nightly cycle, not the drain.
const DRAIN_SETTLE_MS = 2 * 60 * 1000;
const DRAIN_MODEL = "openai/gpt-4o-mini";
const USER_ID_PAGE_SIZE = 200;
// crystalMessages may carry an optional 3072-dim embedding (~24 KB). Convex's
// read ceiling is 16 MB per CALL, not per page (reconcileEmbeddingDualWrite:
// "16MB single-query read limit"; kbCounterReconcile: "per-query 16MB read
// limit"; graphQuery: "16 MB/call"). The depth loop accumulates every page
// inside ONE query call, so the budget below is per call: 8 MB keeps a full
// pass comfortably inside the 16 MB hard ceiling even when the byte estimate
// undercounts multibyte content, and each paginate is additionally capped at
// 4 MB. PROBE_PAGE_SIZE=1000 would be ~24 MB per call and abort mid-count on
// any account whose backlog is embedded — exactly the class of read that
// produced the 2026-07-02 bandwidth incident pattern. Stay well under the
// ceiling; more calls, smaller each.
//
// The 8 MB budget only counts what the page RETURNS (documentsRead /
// estimatedBytesRead accumulate over page.page). Rows discarded by the
// post-index `role != "system"` filter are still read and billed against the
// 16 MB call ceiling but contribute zero to those counters, so the byte
// budget cannot backstop a user whose index range is dominated by filtered
// rows. The empty-page guard below (MAX_DEPTH_EMPTY_PAGES_PER_CALL) is that
// backstop: consecutive filtered-out pages trip `capped: true` with a
// lower-bound depth instead of letting the call reach the hard ceiling and
// throw (which would fail closed with NO gate result at all — availability,
// not data loss, but the read accounting should not lean on the ceiling).
const PROBE_PAGE_SIZE = 200;
// Per-call bounds for uncapped exact-depth probes (dry-run estimates, the
// no-credential report, and getBacklogDepths({ exact: true })). Mirrors the
// dashboardTotals maximumBytesRead pattern: when the bound is hit the probe
// returns capped:true with a lower-bound depth instead of throwing mid-call.
const MAX_DEPTH_BYTES_PER_CALL = 8_000_000; // half the 16 MB single-call ceiling
const MAX_DEPTH_PAGE_BYTES = 4_000_000; // per-paginate hard cap (mirrors dashboardTotals)
// Worst-case single crystalMessages doc: 8,000 chars at 4 bytes/char (UTF-8)
// plus a 3072-dim embedding plus fixed fields ≈ 57 KB. The document bound is
// floor(8 MB / 57 KB) so a full pass can never approach the 16 MB ceiling
// even when the byte estimate undercounts.
const MAX_DEPTH_DOC_BYTES_WORST = 512 + 8000 * 4 + 3072 * 8;
const MAX_DEPTH_DOCUMENTS_PER_CALL = Math.floor(MAX_DEPTH_BYTES_PER_CALL / MAX_DEPTH_DOC_BYTES_WORST);
// Uncapped exact probes page at 64 docs so one page (≤ 64 × ~57 KB ≈ 3.7 MB)
// stays under the per-paginate hard cap; the gate's limit:1 probes are
// unaffected.
const EXACT_PAGE_SIZE = 64;
// Consecutive empty pages before the depth probe gives up and reports a
// lower bound (capped: true, readGuardTripped: true) instead of continuing to
// scan index rows discarded by the post-index role filter. Each paginate can
// read up to maximumBytesRead (4 MB) of filtered-out rows while returning
// nothing; three consecutive empty pages are ≈ 12 MB worst case — inside the
// 16 MB call ceiling, so the probe stops BEFORE the call would throw, and the
// truncated depth is marked capped rather than presented as complete.
const MAX_DEPTH_EMPTY_PAGES_PER_CALL = 3;
// Action-side OUTER bounds for the exact-depth loop (getBacklogDepths
// exact:true, dryRun, and the no-credential report). Each getBacklogDepth
// query call stays per-call bounded (~192 docs / 8 MB estimate); the action
// resumes across calls with the returned cursor. Only THESE outer bounds make
// the final result capped — a per-call bound trip is a page boundary for the
// loop, not the end of the count. The byte ceiling is generous enough to count
// the largest audited account exactly (46,854 messages ≈ 2.7 GB at the
// worst-case ~57 KB doc estimate) while still terminating a pathological one.
const MAX_DEPTH_TOTAL_BYTES = 4_000_000_000; // ~4 GB estimated reads across calls
const MAX_DEPTH_TOTAL_WALL_CLOCK_MS = 5 * 60 * 1000;
const MESSAGE_DOC_FIXED_BYTES = 512;
// Content is capped at 8,000 chars (messages.ts MAX_CONTENT_LENGTH); UTF-8 can
// reach 4 bytes/char, so 2 bytes/char overestimates most content and still
// stays below the hard ceiling for the pathological multibyte case.
const MESSAGE_DOC_CONTENT_BYTES_PER_CHAR = 2;
const MESSAGE_EMBEDDING_BYTES_PER_ELEMENT = 8; // 3072-dim embedding ≈ 24 KB
// Pre-2026-06-02 residual (see listMessageOwnerUserIdsPage): messages inserted
// before the unconditional applyDashboardTotalsDelta call landed (commit
// 93a4d8c) whose profile row has since been removed are invisible to both
// enumeration passes. Carried on getBacklogDepths so the completion report
// names the residual instead of treating the enumerated universes as proof of
// a complete empty backlog.
const DEPTH_RESIDUAL_RISK =
  "Messages inserted before 2026-06-02 (commit 93a4d8c) predate the " +
  "unconditional applyDashboardTotalsDelta call, so an owner whose profile row " +
  "has since been removed has neither a totals row nor a profile row and is " +
  "invisible to both enumeration passes (profiles + dashboard totals). No " +
  "cheap complete enumeration exists (by_user_ltm_extracted_time cannot be " +
  "sought without a userId prefix); gatePassed is verified only against the " +
  "enumerated universes plus this documented residual.";
// Default invocation bounds. All are overridable at invocation; a value <= 0
// disables that bound. Defaults keep one staged run well inside the Convex
// action envelope and the 10 GiB memory abort criterion (Amendment 2026-08-06)
// — the operator steps through accounts smallest-first, judging each run's
// result payload before launching the next.
const DEFAULT_MESSAGES_PER_RUN = 200; // matches the engine's per-user cap
const DEFAULT_MAX_MESSAGES = 2000;
const DEFAULT_WALL_CLOCK_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SPEND_USD = 1.0;
// Baseline from ILL-180's real pilot run (40 messages -> $0.0026). Used only
// for dry-run cost estimates; real runs report the engine's measured cost.
const DEFAULT_ASSUMED_COST_PER_MESSAGE_USD = 0.000065;

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

type DrainCursor = {
  userId: string;
  status: "running" | "completed" | "no_credential";
  startedAt: number;
  updatedAt: number;
  messagesDrained: number;
  memoriesCreated: number;
  deduped: number;
  messagesDiscarded: number;
  skipped: number;
  unscoped: number;
  blockedContentSkipped: number;
  errors: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  iterations: number;
  runIds: string[];
};

// The engine's per-iteration result plus the runtime-only fields it spreads
// from the extraction result (`blockedContentSkipped`, token/cost estimates).
type DrainIterationResult = {
  candidates?: number;
  scoped?: number;
  unscoped?: number;
  inserted?: number;
  deduped?: number;
  skipped?: number;
  discardedMessages?: number;
  errors?: number;
  blockedContentSkipped?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCostUsd?: number;
  reflectionRunId?: Id<"crystalReflectionRuns">;
  reason?: string;
  error?: string;
};

type CredentialStatus = "personal" | "missing" | "mock";

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const raw = Number.isFinite(value ?? NaN) ? Math.trunc(value as number) : NaN;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function clampNonNegative(value: number | undefined, fallback: number): number {
  const raw = Number(value as number);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(raw, 0);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// Conservative per-document byte estimate used to bound a single query call
// against Convex's 16 MB/call read ceiling. Deliberately overestimates so the
// cumulative budget trips before the hard ceiling even for multibyte content.
function estimateMessageDocBytes(doc: { content?: string; embedding?: unknown }): number {
  const contentBytes = (doc.content?.length ?? 0) * MESSAGE_DOC_CONTENT_BYTES_PER_CHAR;
  const embeddingBytes = Array.isArray(doc.embedding)
    ? doc.embedding.length * MESSAGE_EMBEDDING_BYTES_PER_ELEMENT
    : 0;
  return MESSAGE_DOC_FIXED_BYTES + contentBytes + embeddingBytes;
}

function newDrainCursor(userId: string, now: number): DrainCursor {
  return {
    userId,
    status: "running",
    startedAt: now,
    updatedAt: now,
    messagesDrained: 0,
    memoriesCreated: 0,
    deduped: 0,
    messagesDiscarded: 0,
    skipped: 0,
    unscoped: 0,
    blockedContentSkipped: 0,
    errors: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedCostUsd: 0,
    iterations: 0,
    runIds: [],
  };
}

function parseDrainCursor(raw: string | null, userId: string, now: number): DrainCursor {
  if (!raw) return newDrainCursor(userId, now);
  try {
    const parsed = JSON.parse(raw) as Partial<DrainCursor>;
    const base = newDrainCursor(userId, now);
    return {
      ...base,
      ...parsed,
      status: parsed.status === "no_credential" ? "no_credential" : "running",
      runIds: Array.isArray(parsed.runIds) ? parsed.runIds.map(String) : [],
    };
  } catch {
    // A corrupt cursor restarts the cumulative bookkeeping; ltmExtractedAt
    // stamps still prevent reprocessing because the engine re-seeks only
    // undistilled messages.
    return newDrainCursor(userId, now);
  }
}

/**
 * Backlog-depth probe: count of settle-eligible, undistilled, non-system
 * messages for one user, plus the oldest such message's timestamp. Index
 * seek on `by_user_ltm_extracted_time`; bounded pages; no `.collect()`.
 *
 * Cost note: each page still hydrates full `crystalMessages` documents
 * (optional ~24 KB embedding). Exact depth over a 46k-message account would
 * be ~1.1 GB of Database I/O — far over the 16 MB single-call read ceiling —
 * so uncapped counts are bounded per call (8 MB byte budget / ~140-document
 * worst-case backstop) and return `capped: true` with a lower-bound depth
 * when the bound is hit. Re-running an exact pass after every staged batch is
 * still catastrophic; prefer `limit: 1` (existence / oldest only) for the
 * completion gate.
 *
 * `limit` (optional): stop after counting this many matching messages and
 * return `capped: true`. Gate checks should use `limit: 1` (empty iff
 * depth === 0). A limit probe is never resumed (`isDone` stays true).
 *
 * Exact totals omit `limit` and are driven from an ACTION
 * (`probeExactDepth`): each query call is per-call bounded and returns
 * `continueCursor` / `isDone` / per-call read stats so the action resumes
 * across calls and accumulates a true exact total. An action has no per-call
 * 16 MB read limit — only each individual query call does — so the dry-run
 * spend estimate and the no-credential report carry the real depth, with
 * `capped: true` only when the action's outer wall-clock / total-read bound
 * trips.
 */
export const getBacklogDepth = internalQuery({
  args: {
    userId: v.string(),
    beforeTimestamp: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cutoffAt = args.beforeTimestamp ?? Date.now() - DRAIN_SETTLE_MS;
    const cap = args.limit !== undefined && Number.isFinite(args.limit) && args.limit > 0
      ? Math.trunc(args.limit)
      : null;
    let depth = 0;
    let oldestTimestamp: number | null = null;
    let cursor: string | null = args.cursor ?? null;
    let isDone = false;
    let capped = false;
    let readGuardTripped = false;
    let consecutiveEmptyPages = 0;
    let documentsRead = 0;
    let estimatedBytesRead = 0;
    while (!isDone) {
      // Pre-fetch bound: the 16 MB ceiling is per CALL, not per page — every
      // page in this loop counts against one query invocation. Stop while
      // comfortably inside the ceiling (document bound assumes worst-case
      // ~57 KB docs; byte bound covers the byte estimate directly) and hand
      // back a resumable cursor: for the action-side exact loop this is a page
      // boundary, not the end of the count.
      if (
        documentsRead >= MAX_DEPTH_DOCUMENTS_PER_CALL ||
        estimatedBytesRead >= MAX_DEPTH_BYTES_PER_CALL
      ) {
        capped = true;
        break;
      }
      const pageBudget = cap === null
        ? EXACT_PAGE_SIZE
        : Math.min(PROBE_PAGE_SIZE, cap - depth);
      if (pageBudget <= 0) {
        capped = true;
        break;
      }
      const page = await ctx.db
        .query("crystalMessages")
        .withIndex("by_user_ltm_extracted_time", (q) =>
          q.eq("userId", args.userId).eq("ltmExtractedAt", undefined).lte("timestamp", cutoffAt)
        )
        .filter((q) => q.neq(q.field("role"), "system"))
        .order("asc")
        .paginate({
          cursor,
          numItems: pageBudget,
          maximumBytesRead: MAX_DEPTH_PAGE_BYTES,
        });
      if (oldestTimestamp === null && page.page.length > 0) {
        oldestTimestamp = page.page[0].timestamp;
      }
      if (page.page.length === 0 && !page.isDone) {
        // The page returned nothing but the index has more entries: the scan
        // is consuming rows dropped by the post-index role filter, which are
        // read and billed against the 16 MB call ceiling while contributing
        // zero to documentsRead / estimatedBytesRead (F3). Give up after a
        // small number of consecutive empty pages and report a lower bound —
        // terminal (isDone: true) so no caller resumes into the same
        // read-amplified region.
        consecutiveEmptyPages += 1;
        if (consecutiveEmptyPages >= MAX_DEPTH_EMPTY_PAGES_PER_CALL) {
          readGuardTripped = true;
          capped = true;
          isDone = true;
          break;
        }
      } else if (page.page.length > 0) {
        consecutiveEmptyPages = 0;
      }
      depth += page.page.length;
      documentsRead += page.page.length;
      estimatedBytesRead += page.page.reduce(
        (sum, doc) => sum + estimateMessageDocBytes(doc as any),
        0,
      );
      cursor = page.continueCursor;
      isDone = page.isDone;
      if (cap !== null && depth >= cap) {
        // Exact only when this page exhausted the index. Otherwise the
        // returned depth is a lower bound (capped=true). Limit probes are
        // never resumed — isDone stays true so a caller cannot loop past the
        // limit semantics.
        capped = !page.isDone;
        break;
      }
    }
    return {
      depth,
      oldestTimestamp,
      cutoffAt,
      capped,
      // Resumable pagination for the action-side exact loop: null when the
      // index is exhausted or a limit probe stopped.
      continueCursor: isDone ? null : cursor,
      isDone,
      // Set when the loop gave up on consecutive filtered-out pages (F3).
      // Terminal: the action must treat this as capped and stop, never resume.
      readGuardTripped,
      // Per-call read stats so the calling action can enforce its own outer
      // total-read ceiling across calls.
      documentsRead,
      estimatedBytesRead,
    };
  },
});

/**
 * Message-owner universe, independent of crystalUserProfiles: one paginated
 * pass over crystalDashboardTotals (ids only). Actual guarantees:
 *
 *  - Every production message-insert path in messages.ts (logMessage,
 *    logMessageInternal, logTurnInternal) calls applyDashboardTotalsDelta,
 *    which creates/updates a totals row keyed by the same userId — no profile
 *    row required — since commit 93a4d8c (2026-06-02).
 *  - adminDelete.ts deletes the totals row AND the messages in the same
 *    transaction (:304-:307), so the deletion cannot strand a totals row
 *    beside live messages.
 *  - accountMerge.ts refuses to merge any row that holds messages or memories,
 *    so it never produces the orphan this comment used to describe.
 *  - Exception: seed.ts (the ILL-179 local-fixture seeder) deliberately
 *    inserts fixture messages WITHOUT applyDashboardTotalsDelta, so a
 *    fixture-only owner has no totals row (see seed.ts:282).
 *
 * Residual (pre-2026-06-02): messages inserted before the unconditional delta
 * call landed (audited backlog reaches back to 2026-04-29) whose profile row
 * has since been removed have neither a totals row nor a profile row and are
 * invisible to BOTH enumeration passes. Convex cannot seek
 * `by_user_ltm_extracted_time` without a userId prefix, so there is no cheap
 * complete enumeration; getBacklogDepths carries this in `residualRisk` so the
 * completion report names it instead of relying on a reader finding this
 * comment.
 */
export const listMessageOwnerUserIdsPage = internalQuery({
  args: { cursor: v.optional(v.string()), numItems: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalDashboardTotals")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: Math.min(Math.max(Math.trunc(args.numItems), 1), 500),
      });
    return {
      userIds: page.page.map((p) => p.userId).filter((id): id is string => !!id),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Non-KB active memory count for a user — the number the completion report
 * compares against the 50,000 Memory Allowance (ADR 0008 / ILL-179). Reads
 * the stored aggregate; no scan of crystalMemories.
 */
export const getNonKbActiveMemoryCount = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => getNonKbActiveMemories(ctx, args.userId),
});

type DepthProbeResult = {
  depth: number;
  oldestTimestamp: number | null;
  cutoffAt: number;
  capped: boolean;
};

// Shared cross-user budget for exact-mode aggregation (F4): getBacklogDepths
// threads ONE budget object through every probeExactDepth call so an exact
// report costs at most MAX_DEPTH_TOTAL_BYTES / MAX_DEPTH_TOTAL_WALL_CLOCK_MS
// in total, not per message owner. dryRun and the no-credential report pass no
// budget and get the full per-probe allowance — those single-user expensive
// paths are deliberate.
type ExactDepthBudget = {
  estimatedBytesRead: number;
  wallClockStartedAt: number;
};

// Exact backlog-depth probe driven from an action. Loops the per-call bounded
// getBacklogDepth query (resuming via continueCursor) until the index is
// exhausted or the outer wall-clock / total-read bound trips. An action has no
// per-call 16 MB read limit — only each individual query call does — so this
// accumulates a true exact total for dry-run spend estimates and the
// no-credential report, reporting `capped: true` only when the outer bound
// trips (a per-call bound trip is just a page boundary for the loop) or the
// query's read guard trips (F3: consecutive filtered-out pages).
async function probeExactDepth(
  ctx: any,
  args: { userId: string; beforeTimestamp?: number },
  budget?: ExactDepthBudget,
): Promise<DepthProbeResult> {
  const cutoffAt = args.beforeTimestamp ?? Date.now() - DRAIN_SETTLE_MS;
  let depth = 0;
  let oldestTimestamp: number | null = null;
  let continueCursor: string | null = null;
  let isDone = false;
  let capped = false;
  let totalEstimatedBytesRead = 0;
  // Wall clock and read volume are shared across users when a budget is
  // carried (exact-mode aggregate); otherwise they bound this single probe.
  const loopStartedAt = budget?.wallClockStartedAt ?? Date.now();
  while (!isDone) {
    const bytesReadSoFar = budget ? budget.estimatedBytesRead : totalEstimatedBytesRead;
    if (
      (MAX_DEPTH_TOTAL_WALL_CLOCK_MS > 0 &&
        Date.now() - loopStartedAt >= MAX_DEPTH_TOTAL_WALL_CLOCK_MS) ||
      bytesReadSoFar >= MAX_DEPTH_TOTAL_BYTES
    ) {
      capped = true;
      break;
    }
    const page = await ctx.runQuery(
      (internal as any).crystal.backlogDrain.getBacklogDepth,
      { userId: args.userId, beforeTimestamp: cutoffAt, cursor: continueCursor ?? undefined },
    ) as DepthProbeResult & {
      continueCursor: string | null;
      isDone: boolean;
      documentsRead: number;
      estimatedBytesRead: number;
      readGuardTripped: boolean;
    };
    depth += page.depth;
    if (oldestTimestamp === null && page.oldestTimestamp !== null) {
      oldestTimestamp = page.oldestTimestamp;
    }
    totalEstimatedBytesRead += page.estimatedBytesRead;
    if (budget) budget.estimatedBytesRead += page.estimatedBytesRead;
    continueCursor = page.continueCursor;
    isDone = page.isDone;
    if (page.readGuardTripped) {
      // F3: the query gave up on consecutive filtered-out pages. The depth is
      // a lower bound and must not be presented as complete — terminal stop,
      // never resume into the same read-amplified region.
      capped = true;
      break;
    }
  }
  return { depth, oldestTimestamp, cutoffAt, capped };
}

/**
 * Aggregate backlog-depth report across every message owner — the union of
 * crystalUserProfiles and crystalDashboardTotals — per user and total. One
 * paginated pass over each universe (ids only) plus one index-seek depth probe
 * per unique user. The totals universe is the independent cross-check for
 * message owners with no profile row (legacy/merged identities): they are
 * scanned and can stop the gate exactly like profiled accounts.
 *
 * Default is the completion-gate shape: `limit: 1` per user (empty vs
 * non-empty + oldest timestamp) — O(users) tiny seeks, never a full backlog
 * scan. Pass `exact: true` only when the operator needs a total for cost
 * estimation; each exact probe loops per-call bounded query calls from the
 * action (see `probeExactDepth`) and reports `capped: true` only when the
 * action's outer wall-clock / total-read bound trips, so the aggregate
 * `total` is a true exact total in the normal case and always labeled
 * `totalLowerBound`.
 */
export const getBacklogDepths = internalAction({
  args: {
    beforeTimestamp: v.optional(v.number()),
    exact: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const cutoffAt = args.beforeTimestamp ?? Date.now() - DRAIN_SETTLE_MS;
    const exact = args.exact ?? false;
    const seenUserIds = new Set<string>();
    const users: Array<{
      userId: string;
      depth: number;
      oldestTimestamp: number | null;
      capped: boolean;
      empty: boolean;
      profiled: boolean;
    }> = [];
    let usersScanned = 0;
    let unprofiledOwnersScanned = 0;
    let usersWithBacklog = 0;
    // Aggregate cap flag: exact-mode probes are per-call bounded (see
    // getBacklogDepth); when any of them hits the bound the exact total is a
    // lower bound. Non-exact mode is 0-or-1 per user by design, so it never
    // reports capped at the aggregate level.
    let exactCapped = false;
    // F4: one budget shared across every exact probe so a report is bounded
    // in total, not per user. Created only in exact mode; dryRun and the
    // no-credential report (separate invocations) use the full per-probe
    // allowance instead.
    const exactBudget: ExactDepthBudget | undefined = exact
      ? { estimatedBytesRead: 0, wallClockStartedAt: Date.now() }
      : undefined;

    const probeUserId = async (userId: string, profiled: boolean) => {
      if (seenUserIds.has(userId)) return;
      seenUserIds.add(userId);
      usersScanned += 1;
      if (!profiled) unprofiledOwnersScanned += 1;
      const depth: DepthProbeResult = exact
        ? await probeExactDepth(ctx, { userId, beforeTimestamp: cutoffAt }, exactBudget)
        : await ctx.runQuery(
            (internal as any).crystal.backlogDrain.getBacklogDepth,
            { userId, beforeTimestamp: cutoffAt, limit: 1 },
          ) as DepthProbeResult;
      if (exact && depth.capped) exactCapped = true;
      const empty = depth.depth === 0;
      if (!empty) usersWithBacklog += 1;
      users.push({
        userId,
        depth: depth.depth,
        oldestTimestamp: depth.oldestTimestamp,
        capped: depth.capped,
        empty,
        profiled,
      });
    };

    // Pass 1: crystalUserProfiles (the original gate universe).
    let cursor: string | undefined = undefined;
    let isDone = false;
    while (!isDone) {
      const page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
        cursor,
        numItems: USER_ID_PAGE_SIZE,
      }) as { userIds: string[]; continueCursor: string; isDone: boolean };
      isDone = page.isDone;
      cursor = page.continueCursor;
      for (const userId of page.userIds) {
        await probeUserId(userId, true);
      }
    }

    // Pass 2: crystalDashboardTotals — the independent message-owner universe.
    // A userId that owns crystalMessages rows but has no profile row is still
    // scanned here, so it can stop the gate exactly like a profiled account.
    // Fail closed: if either universe enumeration throws, the whole action
    // throws and no gate result is produced.
    let totalsCursor: string | undefined = undefined;
    let totalsDone = false;
    while (!totalsDone) {
      const page = await ctx.runQuery(
        (internal as any).crystal.backlogDrain.listMessageOwnerUserIdsPage,
        { cursor: totalsCursor, numItems: USER_ID_PAGE_SIZE },
      ) as { userIds: string[]; continueCursor: string; isDone: boolean };
      totalsDone = page.isDone;
      totalsCursor = page.continueCursor;
      for (const userId of page.userIds) {
        await probeUserId(userId, false);
      }
    }

    // Smallest-first so the operator can stage accounts in the verified order
    // (698 -> 5,925 -> 46,854) without re-deriving it from the raw list.
    // Non-exact mode only distinguishes 0 vs >=1, so empty accounts sort first
    // and non-empty are unordered by true depth — enough for the gate.
    users.sort((a, b) => a.depth - b.depth);
    // Sum of per-user depths. This is the number of backlogged USERS in
    // non-exact mode (each depth is 0 or 1) and a true message total only in
    // exact mode with no capped probe — so it is always reported as the lower
    // bound it actually is, never as a message count it may not be.
    const totalLowerBound = users.reduce((sum, user) => sum + user.depth, 0);
    // Gate is passed only when every message-owning account — profiled or not
    // (profiles ∪ dashboard-totals universe) — has zero settle-eligible
    // backlog AND the enumeration was complete. `exactCapped` and any
    // per-user capped probe with depth 0 fail the gate closed (F2): a
    // truncated exact count is a lower bound, never a verified empty. Today a
    // capped exact probe cannot return depth 0 (the inner loop only exits
    // capped after reading a full page, so depth ≥ 140 whenever it resumes),
    // but the gate must not depend on that implicit invariant — one edit to
    // EXACT_PAGE_SIZE / MAX_DEPTH_DOCUMENTS_PER_CALL / the bound ordering
    // away from being false.
    const gatePassed =
      usersWithBacklog === 0 &&
      !exactCapped &&
      users.every((u) => !u.capped || u.depth > 0);
    return {
      cutoffAt,
      asOf: Date.now(),
      usersScanned,
      unprofiledOwnersScanned,
      unprofiledOwnersChecked: true,
      usersWithBacklog,
      totalLowerBound,
      exact,
      capped: exactCapped,
      scope: "profiles_and_dashboard_totals",
      gatePassed,
      users,
      // Completion-report residual (F5): the pre-2026-06-02 universe hole this
      // gate cannot enumerate cheaply; never present gatePassed as proof of a
      // complete empty backlog without this named risk.
      residualRisk: DEPTH_RESIDUAL_RISK,
    };
  },
});

/**
 * Resumable, bounded drain runner for one user. Repeatedly drives the ILL-180
 * engine (`runDistillationForUser`, consumed unchanged) until the user's
 * settle-eligible backlog is empty or an invocation bound is hit.
 *
 * Bounds (all settable at invocation; <= 0 disables the bound):
 *  - messagesPerRun: per-engine-iteration budget (1..200, default 200)
 *  - maxMessages: total messages this invocation (default 2000)
 *  - wallClockMs: wall-clock ceiling, checked between iterations (default 5m)
 *  - maxSpendUsd: estimated-spend ceiling, checked between iterations
 *    (default $1.00; soft — one engine batch may overshoot)
 *
 * dryRun reports what a real invocation would do (depth, iterations,
 * extrapolated spend) and mutates nothing — no run records, no cursor, no
 * engine calls.
 *
 * Accounts with no personal OpenRouter credential are enumerated explicitly
 * in the result (`credential: "missing"`) with their remaining depth, and a
 * campaign record is written — never silently skipped.
 */
export const runBacklogDrainForUser = internalAction({
  args: {
    userId: v.string(),
    now: v.optional(v.number()),
    messagesPerRun: v.optional(v.number()),
    maxMessages: v.optional(v.number()),
    wallClockMs: v.optional(v.number()),
    maxSpendUsd: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    assumedCostPerMessageUsd: v.optional(v.number()),
    // Amendment 2026-08-06, requirement 4: operator-observed peak backend
    // memory for the sampled window, folded into the campaign record metadata.
    peakBackendMemoryMb: v.optional(v.number()),
    mockMemories: v.optional(mockMemoryValidator),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    // Settle cutoff may be pinned via `now` for deterministic tests / audits.
    // Wall-clock bounds always measure real elapsed time from this invocation
    // so a historical `now` cannot immediately trip wallClockMs.
    const anchorNow = args.now ?? Date.now();
    const cutoffAt = anchorNow - DRAIN_SETTLE_MS;
    const wallClockStartedAt = Date.now();
    const messagesPerRun = clampInt(args.messagesPerRun, 1, 200, DEFAULT_MESSAGES_PER_RUN);
    const maxMessages = clampNonNegative(args.maxMessages, DEFAULT_MAX_MESSAGES);
    const wallClockMs = clampNonNegative(args.wallClockMs, DEFAULT_WALL_CLOCK_MS);
    const maxSpendUsd = clampNonNegative(args.maxSpendUsd, DEFAULT_MAX_SPEND_USD);
    const assumedCostPerMessageUsd = clampNonNegative(args.assumedCostPerMessageUsd, DEFAULT_ASSUMED_COST_PER_MESSAGE_USD);
    const peakBackendMemoryMb = args.peakBackendMemoryMb;

    const jobName = `${DRAIN_JOB_PREFIX}${args.userId}`;
    const credential = await ctx.runQuery(
      internal.crystal.providerSettings.resolveOpenRouterKeyForUser,
      { userId: args.userId, includeShared: false },
    ).catch(() => ({ apiKey: null, source: null })) as { apiKey: string | null; source: "personal" | null };
    const credentialStatus: CredentialStatus = args.mockMemories
      ? "mock"
      : credential.apiKey
        ? "personal"
        : "missing";
    const hasCredential = credentialStatus !== "missing";
    const keySource = credentialStatus === "personal" ? "user_byok" : "unknown";
    const payer = credentialStatus === "personal" ? "user" : "unknown";

    const tierInfo = await ctx.runQuery(internal.crystal.userProfiles.getUserTierInfo, { userId: args.userId })
      .catch(() => ({ tier: "unknown", sensoryRawTtlDays: 7 })) as { tier: string; sensoryRawTtlDays: number };

    const nonKbActiveMemories = await ctx.runQuery(
      (internal as any).crystal.backlogDrain.getNonKbActiveMemoryCount,
      { userId: args.userId },
    ).catch(() => 0) as number;

    // ── dryRun: read-only plan, mutates nothing ───────────────────────────────
    // Exact depth once: required for the pre-run spend estimate the operator
    // must approve. This is the expensive path by design; real runs never
    // re-scan the full remaining backlog after every batch. The probe loops
    // per-call bounded query calls from the action (probeExactDepth), so the
    // estimate carries the REAL depth (46,854 messages → ~$3.05), with
    // capped:true only when the outer wall-clock / total-read bound trips.
    // It runs inside the try block so an unexpected probe failure still
    // produces a structured error result with backlogDepth: null rather than
    // a raw action rejection.
    let runId: Id<"crystalReflectionRuns"> | undefined;

    // Progress fields live outside the try body so an unexpected throw cannot
    // report a false-zero backlog or wipe observed counters in the return.
    let messagesProcessed = 0;
    let memoriesCreated = 0;
    let deduped = 0;
    let messagesDiscarded = 0;
    let skipped = 0;
    let unscoped = 0;
    let blockedContentSkipped = 0;
    let errors = 0;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;
    const iterationRunIds: string[] = [];
    let iterations = 0;
    let drained = false;
    let stoppedBy: "drained" | "messages" | "wall_clock" | "spend" | "no_credential" | "error" = "drained";
    let cumulative: DrainCursor = newDrainCursor(args.userId, wallClockStartedAt);

    try {
      if (dryRun) {
        const depth = await probeExactDepth(ctx, { userId: args.userId, beforeTimestamp: cutoffAt });
        const estimatedIterations = Math.ceil(depth.depth / messagesPerRun);
        return {
          userId: args.userId,
          dryRun: true,
          drained: false,
          credential: credentialStatus,
          cutoffAt,
          backlogDepth: depth.depth,
          backlogDepthCapped: depth.capped,
          oldestBacklogTimestamp: depth.oldestTimestamp,
          wouldProcess: depth.depth,
          wouldProcessCapped: depth.capped,
          estimatedIterations,
          estimatedSpendUsd: round4(depth.depth * assumedCostPerMessageUsd),
          bounds: { messagesPerRun, maxMessages, wallClockMs, maxSpendUsd, assumedCostPerMessageUsd },
          nonKbActiveMemories,
          peakBackendMemoryMb,
          elapsedMs: 0,
          iterations: 0,
          stoppedBy: "dry_run",
        };
      }

      // ── real run: one campaign record, updated as it goes ───────────────────
      const priorCursorRaw = await ctx.runQuery(internal.crystal.jobCursors.getJobCursor, { jobName });
      const prior = parseDrainCursor(priorCursorRaw, args.userId, wallClockStartedAt);
      cumulative = {
        ...newDrainCursor(args.userId, wallClockStartedAt),
        ...prior,
        startedAt: prior.startedAt,
        status: "running",
      };

      runId = await ctx.runMutation(internal.crystal.reflectionLog.createRun, {
        userId: args.userId,
        trigger: "backlog_drain",
        tier: tierInfo.tier,
        sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
        dryRun: false,
        costProvider: "openrouter",
        costModel: DRAIN_MODEL,
        keySource,
        payer,
        metadata: JSON.stringify({
          source: "backlog_drain",
          cutoffAt,
          messagesPerRun,
          maxMessages,
          wallClockMs,
          maxSpendUsd,
          peakBackendMemoryMb,
          progressUpdatedAt: wallClockStartedAt,
          resumedFrom: priorCursorRaw ? { messagesDrained: prior.messagesDrained, iterations: prior.iterations } : undefined,
        }),
      }) as Id<"crystalReflectionRuns">;

      // Closures capture the narrowed value; the outer `runId` stays
      // `Id | undefined` for the pre-campaign failure path.
      const currentRunId = runId;
      const writeCursor = async (next: DrainCursor) => {
        await ctx.runMutation(internal.crystal.jobCursors.setJobCursor, {
          jobName,
          cursor: JSON.stringify(next),
        }).catch(() => {});
      };

      const patchProgress = async (progress: Record<string, unknown>, metadata: Record<string, unknown>) => {
        await ctx.runMutation(internal.crystal.reflectionLog.updateRunProgress, {
          runId: currentRunId,
          costProvider: "openrouter",
          costModel: DRAIN_MODEL,
          keySource,
          payer,
          metadata: JSON.stringify({
            source: "backlog_drain",
            cutoffAt,
            messagesPerRun,
            maxMessages,
            wallClockMs,
            maxSpendUsd,
            peakBackendMemoryMb,
            progressUpdatedAt: Date.now(),
            ...metadata,
          }),
          ...progress,
        }).catch(() => {});
      };

      // ── no personal credential: enumerate, never silently skip ──────────────
      if (!hasCredential) {
        // Exact remaining depth once so the completion report can name the
        // account with a real backlog size (Req 6 / AC5).
        const depth = await probeExactDepth(ctx, { userId: args.userId, beforeTimestamp: cutoffAt });
        await writeCursor({
          ...newDrainCursor(args.userId, wallClockStartedAt),
          status: "no_credential",
          updatedAt: Date.now(),
        });
        await ctx.runMutation(internal.crystal.reflectionLog.finishRun, {
          runId,
          status: "completed",
          skipped: 1,
          errors: 0,
          estimatedCostUsd: 0,
          costProvider: "openrouter",
          costModel: DRAIN_MODEL,
          keySource,
          payer,
          errorMessage: MISSING_USER_OPENROUTER_KEY_REASON,
          metadata: JSON.stringify({
            source: "backlog_drain",
            cutoffAt,
            reason: MISSING_USER_OPENROUTER_KEY_REASON,
            backlogDepth: depth.depth,
            backlogDepthCapped: depth.capped,
            oldestBacklogTimestamp: depth.oldestTimestamp,
            peakBackendMemoryMb,
            progressUpdatedAt: Date.now(),
          }),
        }).catch(() => {});
        return {
          userId: args.userId,
          dryRun: false,
          drained: false,
          credential: "missing" as const,
          cutoffAt,
          backlogDepth: depth.depth,
          backlogDepthCapped: depth.capped,
          oldestBacklogTimestamp: depth.oldestTimestamp,
          messagesProcessed: 0,
          memoriesCreated: 0,
          deduped: 0,
          messagesDiscarded: 0,
          skipped: 1,
          unscoped: 0,
          blockedContentSkipped: 0,
          errors: 0,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCostUsd: 0,
          elapsedMs: Date.now() - wallClockStartedAt,
          iterations: 0,
          stoppedBy: "no_credential" as const,
          runId,
          iterationRunIds: [],
          nonKbActiveMemories,
          peakBackendMemoryMb,
          cumulative: { ...newDrainCursor(args.userId, wallClockStartedAt) },
        };
      }

      // ── drain loop ──────────────────────────────────────────────────────────
      while (true) {
        const elapsedMs = Date.now() - wallClockStartedAt;
        if (wallClockMs > 0 && elapsedMs >= wallClockMs) {
          stoppedBy = "wall_clock";
          break;
        }
        if (maxMessages > 0 && messagesProcessed >= maxMessages) {
          stoppedBy = "messages";
          break;
        }
        if (maxSpendUsd > 0 && estimatedCostUsd >= maxSpendUsd) {
          stoppedBy = "spend";
          break;
        }

        // Never overshoot the message cap: shrink the last engine batch.
        const iterationBudget = maxMessages > 0
          ? Math.min(messagesPerRun, maxMessages - messagesProcessed)
          : messagesPerRun;

        const iteration = await ctx.runAction(
          internal.crystal.reflectionCycle.runDistillationForUser,
          {
            userId: args.userId,
            now: cutoffAt,
            messagesPerUser: iterationBudget,
            dryRun: false,
            ...(args.mockMemories ? { mockMemories: args.mockMemories } : {}),
          },
        ) as DrainIterationResult;

        if (iteration.reason === MISSING_USER_OPENROUTER_KEY_REASON) {
          stoppedBy = "no_credential";
          break;
        }

        // The engine converts a thrown extraction failure into a result with
        // `error` and `candidates: 0`; that is NOT an empty backlog. Stop and
        // report the failure so the operator can retry instead of declaring
        // the account drained.
        if (iteration.error) {
          errors += 1;
          stoppedBy = "error";
          break;
        }

        // An unrecognised iteration result (no numeric `candidates` at all)
        // must default to "unknown", never "empty": on a module whose purpose
        // is a deletion interlock, `?? 0` would mark the account drained on a
        // shape the engine never produced (ILL-181 audit F4).
        if (typeof iteration.candidates !== "number") {
          errors += 1;
          stoppedBy = "error";
          break;
        }
        const iterationCandidates = iteration.candidates;
        messagesProcessed += iterationCandidates;
        memoriesCreated += iteration.inserted ?? 0;
        deduped += iteration.deduped ?? 0;
        messagesDiscarded += iteration.discardedMessages ?? 0;
        skipped += iteration.skipped ?? 0;
        unscoped += iteration.unscoped ?? 0;
        blockedContentSkipped += iteration.blockedContentSkipped ?? 0;
        errors += iteration.errors ?? 0;
        estimatedInputTokens += iteration.estimatedInputTokens ?? 0;
        estimatedOutputTokens += iteration.estimatedOutputTokens ?? 0;
        estimatedCostUsd = round4(estimatedCostUsd + (iteration.estimatedCostUsd ?? 0));
        iterations += 1;
        // The engine opens a run record even for a zero-candidate probe
        // iteration; only record run ids that actually processed messages so
        // the campaign's runId list stays a precise remediation scope.
        if (iterationCandidates > 0 && iteration.reflectionRunId) {
          const iterationRunId = String(iteration.reflectionRunId);
          iterationRunIds.push(iterationRunId);
          if (!cumulative.runIds.includes(iterationRunId)) cumulative.runIds.push(iterationRunId);
        }

        cumulative = {
          ...cumulative,
          messagesDrained: cumulative.messagesDrained + iterationCandidates,
          memoriesCreated: cumulative.memoriesCreated + (iteration.inserted ?? 0),
          deduped: cumulative.deduped + (iteration.deduped ?? 0),
          messagesDiscarded: cumulative.messagesDiscarded + (iteration.discardedMessages ?? 0),
          skipped: cumulative.skipped + (iteration.skipped ?? 0),
          unscoped: cumulative.unscoped + (iteration.unscoped ?? 0),
          blockedContentSkipped: cumulative.blockedContentSkipped + (iteration.blockedContentSkipped ?? 0),
          errors: cumulative.errors + (iteration.errors ?? 0),
          estimatedInputTokens: cumulative.estimatedInputTokens + (iteration.estimatedInputTokens ?? 0),
          estimatedOutputTokens: cumulative.estimatedOutputTokens + (iteration.estimatedOutputTokens ?? 0),
          estimatedCostUsd: round4(cumulative.estimatedCostUsd + (iteration.estimatedCostUsd ?? 0)),
          iterations: cumulative.iterations + 1,
          updatedAt: Date.now(),
        };

        // Progress as it goes: durable cursor + campaign record, every
        // iteration, so a killed action leaves an accurate partial record.
        await writeCursor(cumulative);
        await patchProgress(
          {
            messagesProcessed,
            memoriesCreated,
            deduped,
            messagesDiscarded,
            skipped,
            errors,
            estimatedInputTokens,
            estimatedOutputTokens,
            estimatedCostUsd,
          },
          {
            iteration: iterations,
            drained: false,
            stoppedBy: "running",
            cumulative: {
              messagesDrained: cumulative.messagesDrained,
              memoriesCreated: cumulative.memoriesCreated,
              estimatedCostUsd: cumulative.estimatedCostUsd,
              skipped: cumulative.skipped,
              unscoped: cumulative.unscoped,
              messagesDiscarded: cumulative.messagesDiscarded,
              blockedContentSkipped: cumulative.blockedContentSkipped,
            },
            iterationRunIds,
          },
        );

        if (iterationCandidates === 0) {
          drained = true;
          stoppedBy = "drained";
          break;
        }
      }

      // Depth after a real run:
      //  - drained via zero-candidate probe: depth is 0 with no re-scan (the
      //    engine already sought the same index/cutoff; re-reading ~46k docs
      //    would burn ~1 GB of Database I/O for a known-empty result).
      //  - stopped early (bounds / error / missing key mid-loop): existence
      //    probe only (limit: 1). depth is 0 or a lower bound of 1 with
      //    capped=true; never a full remaining-backlog scan per staged batch.
      // Exact remaining counts are available on demand via getBacklogDepth
      // (uncapped) or dryRun.
      let finalDepth: {
        depth: number;
        oldestTimestamp: number | null;
        cutoffAt: number;
        capped: boolean;
      };
      if (drained) {
        finalDepth = { depth: 0, oldestTimestamp: null, cutoffAt, capped: false };
      } else {
        finalDepth = await ctx.runQuery(
          (internal as any).crystal.backlogDrain.getBacklogDepth,
          { userId: args.userId, beforeTimestamp: cutoffAt, limit: 1 },
        ) as { depth: number; oldestTimestamp: number | null; cutoffAt: number; capped: boolean };
      }

      cumulative = {
        ...cumulative,
        status: drained ? "completed" : "running",
        updatedAt: Date.now(),
      };
      await writeCursor(cumulative);

      await ctx.runMutation(internal.crystal.reflectionLog.finishRun, {
        runId,
        status: errors > 0 || stoppedBy === "error" ? "failed" : "completed",
        messagesProcessed,
        memoriesCreated,
        deduped,
        messagesDiscarded,
        skipped,
        errors,
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedCostUsd,
        costProvider: "openrouter",
        costModel: DRAIN_MODEL,
        keySource,
        payer,
        errorMessage: stoppedBy === "no_credential" ? MISSING_USER_OPENROUTER_KEY_REASON : undefined,
        metadata: JSON.stringify({
          source: "backlog_drain",
          cutoffAt,
          messagesPerRun,
          maxMessages,
          wallClockMs,
          maxSpendUsd,
          peakBackendMemoryMb,
          drained,
          stoppedBy,
          iterations,
          iterationRunIds,
          backlogDepthAfter: finalDepth.depth,
          backlogDepthCapped: finalDepth.capped,
          oldestBacklogTimestampAfter: finalDepth.oldestTimestamp,
          cumulative: {
            messagesDrained: cumulative.messagesDrained,
            memoriesCreated: cumulative.memoriesCreated,
            estimatedCostUsd: cumulative.estimatedCostUsd,
            skipped: cumulative.skipped,
            unscoped: cumulative.unscoped,
            messagesDiscarded: cumulative.messagesDiscarded,
            blockedContentSkipped: cumulative.blockedContentSkipped,
          },
          progressUpdatedAt: Date.now(),
        }),
      }).catch(() => {});

      return {
        userId: args.userId,
        dryRun: false,
        drained,
        credential: credentialStatus,
        cutoffAt,
        backlogDepth: finalDepth.depth,
        backlogDepthCapped: finalDepth.capped,
        oldestBacklogTimestamp: finalDepth.oldestTimestamp,
        messagesProcessed,
        memoriesCreated,
        deduped,
        messagesDiscarded,
        skipped,
        unscoped,
        blockedContentSkipped,
        errors,
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedCostUsd,
        elapsedMs: Date.now() - wallClockStartedAt,
        iterations,
        stoppedBy,
        runId,
        iterationRunIds,
        nonKbActiveMemories,
        peakBackendMemoryMb,
        cumulative: {
          messagesDrained: cumulative.messagesDrained,
          memoriesCreated: cumulative.memoriesCreated,
          deduped: cumulative.deduped,
          messagesDiscarded: cumulative.messagesDiscarded,
          skipped: cumulative.skipped,
          unscoped: cumulative.unscoped,
          blockedContentSkipped: cumulative.blockedContentSkipped,
          errors: cumulative.errors,
          estimatedInputTokens: cumulative.estimatedInputTokens,
          estimatedOutputTokens: cumulative.estimatedOutputTokens,
          estimatedCostUsd: cumulative.estimatedCostUsd,
          iterations: cumulative.iterations,
          runIds: cumulative.runIds,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Never invent backlogDepth: 0 on an unexpected failure — a false zero
      // here is the gate signal that unblocks ILL-182 message deletion.
      let failureDepth: {
        depth: number | null;
        oldestTimestamp: number | null;
        capped: boolean;
      } = { depth: null, oldestTimestamp: null, capped: false };
      try {
        const probe = await ctx.runQuery(
          (internal as any).crystal.backlogDrain.getBacklogDepth,
          { userId: args.userId, beforeTimestamp: cutoffAt, limit: 1 },
        ) as { depth: number; oldestTimestamp: number | null; capped: boolean };
        failureDepth = {
          depth: probe.depth,
          oldestTimestamp: probe.oldestTimestamp,
          capped: probe.capped,
        };
      } catch {
        // Probe itself failed; leave depth null so the operator cannot
        // mistake this for a verified empty backlog.
      }

      if (runId) {
        await ctx.runMutation(internal.crystal.reflectionLog.finishRun, {
          runId,
          status: "failed",
          messagesProcessed,
          memoriesCreated,
          deduped,
          messagesDiscarded,
          skipped,
          errors: Math.max(errors, 1),
          estimatedInputTokens,
          estimatedOutputTokens,
          estimatedCostUsd,
          errorMessage: errorMessage.slice(0, 500),
          costProvider: "openrouter",
          costModel: DRAIN_MODEL,
          keySource,
          payer,
          metadata: JSON.stringify({
            source: "backlog_drain",
            cutoffAt,
            reason: errorMessage.slice(0, 500),
            backlogDepthAfter: failureDepth.depth,
            backlogDepthCapped: failureDepth.capped,
            oldestBacklogTimestampAfter: failureDepth.oldestTimestamp,
            peakBackendMemoryMb,
            progressUpdatedAt: Date.now(),
          }),
        }).catch(() => {});
      }
      return {
        userId: args.userId,
        dryRun: false,
        drained: false,
        credential: credentialStatus,
        cutoffAt,
        // null = unknown; never report 0 unless the existence probe confirmed empty.
        backlogDepth: failureDepth.depth,
        backlogDepthCapped: failureDepth.capped,
        oldestBacklogTimestamp: failureDepth.oldestTimestamp,
        messagesProcessed,
        memoriesCreated,
        deduped,
        messagesDiscarded,
        skipped,
        unscoped,
        blockedContentSkipped,
        errors: Math.max(errors, 1),
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedCostUsd,
        elapsedMs: Date.now() - wallClockStartedAt,
        iterations,
        stoppedBy: "error" as const,
        runId,
        iterationRunIds,
        nonKbActiveMemories,
        peakBackendMemoryMb,
        cumulative: {
          messagesDrained: cumulative.messagesDrained,
          memoriesCreated: cumulative.memoriesCreated,
          deduped: cumulative.deduped,
          messagesDiscarded: cumulative.messagesDiscarded,
          skipped: cumulative.skipped,
          unscoped: cumulative.unscoped,
          blockedContentSkipped: cumulative.blockedContentSkipped,
          errors: cumulative.errors,
          estimatedInputTokens: cumulative.estimatedInputTokens,
          estimatedOutputTokens: cumulative.estimatedOutputTokens,
          estimatedCostUsd: cumulative.estimatedCostUsd,
          iterations: cumulative.iterations,
          runIds: cumulative.runIds,
        },
        error: errorMessage,
      };
    }
  },
});
