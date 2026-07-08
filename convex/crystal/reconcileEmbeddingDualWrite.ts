/**
 * M8 — Cursor-based reconcile cron for the embedding dual-write window.
 *
 * Plan reference: `.omc/plans/memorycrystal-cost-reduction.md` §M8 + §4
 * scenario D (dual-write inconsistency pre-mortem) + §9 gate #10.
 *
 * Behaviour (2026-07-07 rework — the original one-page-per-tick loop backed
 * off 60 min on any zero-RECONCILED tick, even mid-scan, so the crawl ran at
 * ~100 rows/hour and never reached the table tail):
 *  - Schedule: every 5 minutes; each active tick drains up to
 *    MAX_PAGES_PER_TICK pages (PAGE_SIZE rows each) ordered by
 *    `_creationTime` ASC from the persisted cursor.
 *  - Per row: if the inline `embedding` is non-empty AND no
 *    `crystalMemoryEmbeddings` row exists for `memoryId`, copy the inline
 *    embedding to the extracted table.
 *  - Mid-scan ticks never back off. When a pass reaches the tail, the cursor
 *    resets to 0 and the cron rests PASS_REST_MS (6h) before the next full
 *    pass — each pass reads the whole table, so passes must be rare.
 *  - Cutover-readiness: CUTOVER_CLEAN_PASSES_REQUIRED (2) consecutive
 *    complete passes with zero fixes. `consecutiveZeroTicks` (field name kept
 *    for schema compat) counts clean passes; `lastTickReconciledCount`
 *    accumulates fixes across the ticks of the current pass.
 *  - Once ready, verify passes run weekly (READY_REST_MS).
 *  - Telemetry: M0 `recordCall` is invoked with `name="reconcileEmbeddingDualWrite"`.
 *
 * Cutover-readiness API surface:
 *  - `getCutoverReadiness()` query returns
 *    `{ ready: boolean, lastZeroStreakHours: number, consecutiveZeroTicks: number }`.
 *  - `ready=true` requires `consecutiveZeroTicks >= 2` clean passes.
 *  - The flag flip itself remains an operator action (not automated).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { getActorForQuery } from "./adminSupport";
import { requireRole } from "./permissions";

const CRON_NAME = "reconcileEmbeddingDualWrite";
const PAGE_SIZE = 100;
// Multiple pages per tick so the initial catch-up crawl finishes in weeks,
// not months. At the active 5-minute cadence, 20 pages * 100 rows * ~35 KB/doc
// is about 70 MB read per active tick, or roughly 20 GB/day while the cursor is
// still crawling. That temporary read cost is intentional and bounded: active
// ticks stop after the cursor reaches the tail, then full passes rest for 6h
// and later weekly once the clean-pass cutover gate is green.
const MAX_PAGES_PER_TICK = 20;
// After a completed pass, rest before starting the next full scan: each pass
// reads the whole crystalMemories table (~$8 of bandwidth at current size),
// so passes must be rare. Once ready, sleep a week between verify passes.
const PASS_REST_MS = 6 * 60 * 60 * 1000;
const READY_REST_MS = 7 * 24 * 60 * 60 * 1000;
// Cutover gate: N consecutive COMPLETE passes (cursor 0 → table tail) that
// reconciled zero rows. A clean full pass verifies every row has its
// side-table copy — far stronger evidence than the old "48 quiet half-hour
// ticks" gate, which could sit mid-scan and never actually verify the tail.
// `consecutiveZeroTicks` (state field name kept for schema compat) now counts
// clean passes.
const CUTOVER_CLEAN_PASSES_REQUIRED = 2;

// ── State helpers ────────────────────────────────────────────────────────────

export const getReconcileState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("crystalReconcileState")
      .withIndex("by_cronName", (q) => q.eq("cronName", CRON_NAME))
      .first();
    return row;
  },
});

export const upsertReconcileState = internalMutation({
  args: {
    lastScannedCreationTime: v.number(),
    lastTickReconciledCount: v.number(),
    consecutiveZeroTicks: v.number(),
    nextRunAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("crystalReconcileState")
      .withIndex("by_cronName", (q) => q.eq("cronName", CRON_NAME))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastScannedCreationTime: args.lastScannedCreationTime,
        lastTickReconciledCount: args.lastTickReconciledCount,
        consecutiveZeroTicks: args.consecutiveZeroTicks,
        nextRunAt: args.nextRunAt,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("crystalReconcileState", {
      cronName: CRON_NAME,
      lastScannedCreationTime: args.lastScannedCreationTime,
      lastTickReconciledCount: args.lastTickReconciledCount,
      consecutiveZeroTicks: args.consecutiveZeroTicks,
      nextRunAt: args.nextRunAt,
      updatedAt: now,
    });
  },
});

// ── Reconcile core ──────────────────────────────────────────────────────────

export const reconcilePage = internalMutation({
  args: {
    cursor: v.number(),
    pageSize: v.number(),
  },
  handler: async (ctx, { cursor, pageSize }) => {
    // Scan crystalMemories ordered by _creationTime ASC starting after the
    // cursor. We use the by_creation_time implicit index via order().
    const rows = await ctx.db
      .query("crystalMemories")
      .withIndex("by_creation_time", (q: any) => q.gt("_creationTime", cursor))
      .order("asc")
      .take(pageSize);

    let reconciled = 0;
    let lastSeenCreationTime = cursor;
    for (const row of rows) {
      const ct = (row as any)._creationTime as number;
      if (typeof ct === "number" && ct > lastSeenCreationTime) {
        lastSeenCreationTime = ct;
      }
      const embedding = (row as any).embedding as number[] | undefined;
      if (!Array.isArray(embedding) || embedding.length === 0) continue;
      // Check if extracted-table row already exists for this memory.
      const existing = await ctx.db
        .query("crystalMemoryEmbeddings")
        .withIndex("by_memoryId", (q) => q.eq("memoryId", row._id))
        .first();
      if (existing) continue;
      await ctx.db.insert("crystalMemoryEmbeddings", {
        memoryId: row._id,
        embedding,
        model: "google/gemini-embedding-2-preview",
        dimensions: embedding.length,
        createdAt: Date.now(),
      });
      reconciled += 1;
    }

    return {
      reconciled,
      scanned: rows.length,
      lastSeenCreationTime,
      isPageFull: rows.length >= pageSize,
    };
  },
});

// ── Cron tick ────────────────────────────────────────────────────────────────

export const runReconcileTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Explicit `any` typing breaks a TS self-reference cycle: this file imports
    // `internal` from `_generated/api`, which now (post-codegen) types this
    // module's exports — including this very handler. Inferring through the
    // cycle isn't possible. The runtime cast was already `(internal as any)`;
    // the explicit `: any` here is what actually breaks the inference loop.
    const state: any = await ctx.runQuery(
      internal.crystal.reconcileEmbeddingDualWrite.getReconcileState,
      {},
    );

    // Backoff: if a previous zero-row tick set `nextRunAt` in the future, skip.
    if (state && typeof state.nextRunAt === "number" && state.nextRunAt > now) {
      // Skip — still in backoff window.
      return { skipped: true, reason: "backoff_window", reconciled: 0 };
    }

    // M0 — invocation count for cost-reduction baseline.
    ctx
      .runMutation(
        internal.crystal.observability.functionCallMetrics.recordCall,
        { name: CRON_NAME },
      )
      .catch(() => null);

    // Drain up to MAX_PAGES_PER_TICK pages per tick. The previous
    // one-page-per-tick loop also backed off 60 min whenever a tick
    // *reconciled* zero rows — even mid-scan on a full page of
    // already-copied rows — so the catch-up crawl ran at ~100 rows/hour
    // and the cursor sat weeks behind the table tail (2026-07-07 audit).
    // Backoff and the zero-tick cutover streak now key on reaching the
    // TAIL, not on a quiet page.
    let cursor: number = state?.lastScannedCreationTime ?? 0;
    let reconciledThisTick = 0;
    let scannedThisTick = 0;
    let reachedTail = false;

    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_TICK; pageIndex += 1) {
      const result: any = await ctx.runMutation(
        internal.crystal.reconcileEmbeddingDualWrite.reconcilePage,
        { cursor, pageSize: PAGE_SIZE },
      );
      reconciledThisTick += result.reconciled;
      scannedThisTick += result.scanned;
      if (result.scanned > 0) {
        cursor = result.lastSeenCreationTime;
      }
      if (!result.isPageFull) {
        reachedTail = true;
        break;
      }
    }

    // Pass-so-far fix count: `lastTickReconciledCount` accumulates fixes across
    // the ticks of one pass (a pass starts when the stored cursor is 0, so a
    // stored cursor > 0 means we're resuming mid-pass).
    const passFixesBefore =
      (state?.lastScannedCreationTime ?? 0) > 0
        ? (state?.lastTickReconciledCount ?? 0)
        : 0;
    const passFixesSoFar = passFixesBefore + reconciledThisTick;

    let consecutiveZeroTicks: number = state?.consecutiveZeroTicks ?? 0;
    let nextRunAt: number | undefined;
    let nextCursor = cursor;

    if (reachedTail) {
      // Full pass complete — clean only if the WHOLE pass reconciled nothing.
      consecutiveZeroTicks = passFixesSoFar === 0 ? consecutiveZeroTicks + 1 : 0;
      // Rest between passes; once the gate is green, verify weekly only.
      nextRunAt =
        now +
        (consecutiveZeroTicks >= CUTOVER_CLEAN_PASSES_REQUIRED
          ? READY_REST_MS
          : PASS_REST_MS);
      nextCursor = 0;
    }
    // Mid-scan (tail not reached): never back off and never touch the clean-pass
    // streak — the next tick continues the crawl from the cursor.

    await ctx.runMutation(
      internal.crystal.reconcileEmbeddingDualWrite.upsertReconcileState,
      {
        lastScannedCreationTime: nextCursor,
        lastTickReconciledCount: passFixesSoFar,
        consecutiveZeroTicks,
        nextRunAt,
      },
    );

    return {
      skipped: false,
      reconciled: reconciledThisTick,
      scanned: scannedThisTick,
      cursor: nextCursor,
      reachedTail,
      consecutiveZeroTicks,
    };
  },
});

// ── Cutover-readiness API ────────────────────────────────────────────────────
//
// `getCutoverReadiness()` is a public query so operators (or a dashboard
// widget) can poll readiness without granting full state read. Returns:
//   - ready: true once consecutiveZeroTicks >= 48 (24h)
//   - consecutiveZeroTicks: raw streak count
//   - lastZeroStreakHours: derived hour count assuming 30-min tick cadence
//
// DO NOT auto-flip the cutover flag; this query only reports readiness.

// Shared helper: extract readiness logic so both the internalQuery and the
// public admin wrapper call the same code without duplication.
async function computeCutoverReadiness(ctx: any) {
  const row = await ctx.db
    .query("crystalReconcileState")
    .withIndex("by_cronName", (q: any) => q.eq("cronName", CRON_NAME))
    .first();
  const consecutiveZeroTicks = row?.consecutiveZeroTicks ?? 0;
  // consecutiveZeroTicks counts consecutive CLEAN FULL PASSES (cursor 0 → tail
  // with zero fixes); passes rest PASS_REST_MS apart, so streak-hours derive
  // from the pass rest interval.
  const lastZeroStreakHours = (consecutiveZeroTicks * PASS_REST_MS) / (60 * 60 * 1000);
  return {
    ready: consecutiveZeroTicks >= CUTOVER_CLEAN_PASSES_REQUIRED,
    consecutiveZeroTicks,
    lastZeroStreakHours,
    ticksRequired: CUTOVER_CLEAN_PASSES_REQUIRED,
    lastTickReconciledCount: row?.lastTickReconciledCount ?? 0,
    lastScannedCreationTime: row?.lastScannedCreationTime ?? 0,
    nextRunAt: row?.nextRunAt,
  };
}

export const getCutoverReadiness = internalQuery({
  args: {},
  handler: async (ctx) => {
    return computeCutoverReadiness(ctx);
  },
});

/**
 * getCutoverReadinessPublic — admin-gated public query exposing the same readiness
 * data as getCutoverReadiness. Used by the admin settings panel and adminSetFeatureFlag
 * cutover gate (US-006).
 */
export const getCutoverReadinessPublic = query({
  args: {},
  handler: async (ctx) => {
    const { actorProfile } = await getActorForQuery(ctx);
    requireRole(actorProfile?.roles, "admin");
    return computeCutoverReadiness(ctx);
  },
});
