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
 *  - `ready=true` requires `consecutiveZeroTicks >= 2` clean full passes.
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
    let backfilled = 0;
    let lastSeenCreationTime = cursor;
    for (const row of rows) {
      const ct = (row as any)._creationTime as number;
      if (typeof ct === "number" && ct > lastSeenCreationTime) {
        lastSeenCreationTime = ct;
      }
      // M9 scalar mirrors from the parent memory (present regardless of whether
      // the inline embedding is currently populated — userId doesn't depend on it).
      const userId = (row as any).userId as string | undefined;
      const knowledgeBaseId = (row as any).knowledgeBaseId;
      // Look up the side-table row FIRST. A memory whose content was later
      // edited has its inline embedding cleared (patch.embedding = []), but its
      // side-table row (with the old embedding) persists — so we must backfill
      // the scalar on the existing row BEFORE the empty-embedding skip below,
      // or those rows never get userId (the 2026-07-09 false-green root cause).
      const existing = await ctx.db
        .query("crystalMemoryEmbeddings")
        .withIndex("by_memoryId", (q) => q.eq("memoryId", row._id))
        .first();
      if (existing) {
        if ((existing as any).userId === undefined) {
          await ctx.db.patch(existing._id, { userId, knowledgeBaseId });
          backfilled += 1;
        }
        continue;
      }
      // No side-table row yet → insert one only if there's an inline embedding
      // to copy. Empty-embedding memories with no side-table row have nothing to
      // mirror and are correctly skipped.
      const embedding = (row as any).embedding as number[] | undefined;
      if (!Array.isArray(embedding) || embedding.length === 0) continue;
      await ctx.db.insert("crystalMemoryEmbeddings", {
        memoryId: row._id,
        userId,
        knowledgeBaseId,
        embedding,
        model: "google/gemini-embedding-2-preview",
        dimensions: embedding.length,
        createdAt: Date.now(),
      });
      reconciled += 1;
    }

    return {
      reconciled,
      backfilled,
      scanned: rows.length,
      lastSeenCreationTime,
      isPageFull: rows.length >= pageSize,
    };
  },
});

// ── Coverage verification (M9 cutover gate — direct, not streak-based) ───────
//
// The clean-pass streak can be fooled if two workers (cron + a manual drive)
// share the cursor and one advances it near the tail, letting the other declare
// a short "clean" page as a full pass. Before anything irreversible (Phase C),
// verify coverage by an actual scan: every side-table row must carry the
// userId scalar (the M9 filter field) — else userId-scoped vector search after
// cutover silently misses those memories.

export const countSideTableMissingScalarsPage = internalQuery({
  args: { cursor: v.number(), pageSize: v.number() },
  handler: async (ctx, { cursor, pageSize }) => {
    const rows = await ctx.db
      .query("crystalMemoryEmbeddings")
      .withIndex("by_creation_time", (q: any) => q.gt("_creationTime", cursor))
      .order("asc")
      .take(pageSize);
    let missingUserId = 0;
    let lastCt = cursor;
    let exampleMissing: string | null = null;
    for (const r of rows) {
      const ct = (r as any)._creationTime as number;
      if (ct > lastCt) lastCt = ct;
      if ((r as any).userId === undefined) {
        missingUserId += 1;
        if (!exampleMissing) exampleMissing = String((r as any).memoryId);
      }
    }
    return {
      scanned: rows.length,
      missingUserId,
      lastCt,
      isPageFull: rows.length >= pageSize,
      exampleMissing,
    };
  },
});

export const verifySideTableCoverage = internalAction({
  args: { pageSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // Each row carries a 3072-float embedding (~24KB), so a page must stay
    // well under the 16MB single-query read limit: 400 * 24KB ≈ 9.6MB.
    const pageSize = Math.min(Math.max(args.pageSize ?? 400, 1), 600);
    let cursor = 0;
    let total = 0;
    let missing = 0;
    let example: string | null = null;
    for (let i = 0; i < 20000; i++) {
      const page: any = await ctx.runQuery(
        internal.crystal.reconcileEmbeddingDualWrite.countSideTableMissingScalarsPage,
        { cursor, pageSize },
      );
      total += page.scanned;
      missing += page.missingUserId;
      if (!example) example = page.exampleMissing;
      if (page.scanned > 0) cursor = page.lastCt;
      if (!page.isPageFull) break;
    }
    return {
      total,
      missingUserId: missing,
      coveragePct: total > 0 ? Number((((total - missing) / total) * 100).toFixed(2)) : 100,
      exampleMissingMemoryId: example,
    };
  },
});

// Targeted straggler backfill: scan the SIDE TABLE directly for rows missing
// the userId scalar and patch each from its parent (delete true orphans whose
// parent memory was deleted). Deterministic single scan — unlike the cron,
// which scans crystalMemories and re-walks the already-done front each pass.
export const patchMissingScalarsPage = internalMutation({
  args: { cursor: v.number(), pageSize: v.number() },
  handler: async (ctx, { cursor, pageSize }) => {
    const rows = await ctx.db
      .query("crystalMemoryEmbeddings")
      .withIndex("by_creation_time", (q: any) => q.gt("_creationTime", cursor))
      .order("asc")
      .take(pageSize);
    let patched = 0;
    let orphansDeleted = 0;
    let lastCt = cursor;
    for (const r of rows) {
      const ct = (r as any)._creationTime as number;
      if (ct > lastCt) lastCt = ct;
      if ((r as any).userId !== undefined) continue;
      const parent = await ctx.db.get((r as any).memoryId);
      if (!parent) {
        // Orphan: parent memory deleted. The embedding row is dead weight and
        // can never be scoped/hydrated — remove it.
        await ctx.db.delete(r._id);
        orphansDeleted += 1;
        continue;
      }
      await ctx.db.patch(r._id, {
        userId: (parent as any).userId,
        knowledgeBaseId: (parent as any).knowledgeBaseId,
      });
      patched += 1;
    }
    return { scanned: rows.length, patched, orphansDeleted, lastCt, isPageFull: rows.length >= pageSize };
  },
});

export const backfillMissingSideTableScalars = internalAction({
  args: { pageSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const pageSize = Math.min(Math.max(args.pageSize ?? 150, 1), 400);
    let cursor = 0;
    let patched = 0;
    let orphansDeleted = 0;
    let scanned = 0;
    for (let i = 0; i < 40000; i++) {
      const page: any = await ctx.runMutation(
        internal.crystal.reconcileEmbeddingDualWrite.patchMissingScalarsPage,
        { cursor, pageSize },
      );
      scanned += page.scanned;
      patched += page.patched;
      orphansDeleted += page.orphansDeleted;
      if (page.scanned > 0) cursor = page.lastCt;
      if (!page.isPageFull) break;
    }
    return { scanned, patched, orphansDeleted };
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
    let backfilledThisTick = 0;
    let scannedThisTick = 0;
    let reachedTail = false;

    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_TICK; pageIndex += 1) {
      const result: any = await ctx.runMutation(
        internal.crystal.reconcileEmbeddingDualWrite.reconcilePage,
        { cursor, pageSize: PAGE_SIZE },
      );
      reconciledThisTick += result.reconciled;
      backfilledThisTick += result.backfilled ?? 0;
      scannedThisTick += result.scanned;
      if (result.scanned > 0) {
        cursor = result.lastSeenCreationTime;
      }
      if (!result.isPageFull) {
        reachedTail = true;
        break;
      }
    }
    // A "fix" is a new copy OR a scalar backfill — the cutover gate must wait
    // for BOTH to reach zero across a full pass (every row mirrored + scoped).
    const fixesThisTick = reconciledThisTick + backfilledThisTick;

    // Pass-so-far fix count: `lastTickReconciledCount` accumulates fixes across
    // the ticks of one pass (a pass starts when the stored cursor is 0, so a
    // stored cursor > 0 means we're resuming mid-pass).
    const passFixesBefore =
      (state?.lastScannedCreationTime ?? 0) > 0
        ? (state?.lastTickReconciledCount ?? 0)
        : 0;
    const passFixesSoFar = passFixesBefore + fixesThisTick;

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
      backfilled: backfilledThisTick,
      scanned: scannedThisTick,
      cursor: nextCursor,
      reachedTail,
      consecutiveZeroTicks,
    };
  },
});

// ── Cutover-readiness API ────────────────────────────────────────────────────
//
// `getCutoverReadiness()` reports the shared operator/dashboard gate. Returns:
//   - ready: true once consecutiveZeroTicks reaches the clean-pass threshold
//   - consecutiveZeroTicks: consecutive clean FULL passes (legacy field name)
//   - lastZeroStreakHours: derived from the full-pass rest interval
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
