/**
 * M8 — Cursor-based reconcile cron for the embedding dual-write window.
 *
 * Plan reference: `.omc/plans/memorycrystal-cost-reduction.md` §M8 + §4
 * scenario D (dual-write inconsistency pre-mortem) + §9 gate #10.
 *
 * Behaviour:
 *  - Schedule: every 30 minutes during the dual-write window.
 *  - Cursor: persist `lastScannedCreationTime` in `crystalReconcileState`.
 *  - Page size: 100 rows of `crystalMemories` ordered by `_creationTime` ASC.
 *  - Per row: if the inline `embedding` is non-empty AND no
 *    `crystalMemoryEmbeddings` row exists for `memoryId`, copy the inline
 *    embedding to the extracted table.
 *  - Backoff: zero-row tick increments `consecutiveZeroTicks` and sets
 *    `nextRunAt = now + 60min` so the next 30-min tick is skipped.
 *  - Cutover-readiness: 48 consecutive zero ticks (24h at 30-min cadence)
 *    signal it's safe to flip `EMBEDDING_TABLE_AS_PRIMARY=true`.
 *  - Telemetry: M0 `recordCall` is invoked with `name="reconcileEmbeddingDualWrite"`.
 *
 * Cutover-readiness API surface:
 *  - `getCutoverReadiness()` query returns
 *    `{ ready: boolean, lastZeroStreakHours: number, consecutiveZeroTicks: number }`.
 *  - `ready=true` requires `consecutiveZeroTicks >= 48` (24h).
 *  - The flag flip itself remains an operator action (not automated).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { getActorForQuery } from "./adminSupport";
import { requireRole } from "./permissions";

const CRON_NAME = "reconcileEmbeddingDualWrite";
const PAGE_SIZE = 100;
const TICK_INTERVAL_MS = 30 * 60 * 1000;
const BACKOFF_DELAY_MS = 60 * 60 * 1000; // skip-next-tick window
const CUTOVER_TICKS_REQUIRED = 48; // 24h at 30-min cadence

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

    const cursor: number = state?.lastScannedCreationTime ?? 0;
    const result: any = await ctx.runMutation(
      internal.crystal.reconcileEmbeddingDualWrite.reconcilePage,
      { cursor, pageSize: PAGE_SIZE },
    );

    // Decide the next cursor + backoff.
    const nextCursor =
      result.scanned > 0 ? result.lastSeenCreationTime : cursor;

    let consecutiveZeroTicks: number = state?.consecutiveZeroTicks ?? 0;
    let nextRunAt: number | undefined;

    if (result.reconciled === 0) {
      consecutiveZeroTicks += 1;
      // Backoff: skip the NEXT 30-min tick by setting nextRunAt 60min ahead.
      // (One tick happens at 30min anyway; nextRunAt > that tick boundary
      // forces a skip.)
      nextRunAt = now + BACKOFF_DELAY_MS;
      // If the page wasn't full and reconciled zero, the cursor has caught up
      // to the table tail. Reset the cursor to 0 so the next active tick
      // re-scans from the start (handles late dual-write writes that landed
      // earlier in time).
      if (!result.isPageFull) {
        await ctx.runMutation(
          internal.crystal.reconcileEmbeddingDualWrite.upsertReconcileState,
          {
            lastScannedCreationTime: 0,
            lastTickReconciledCount: 0,
            consecutiveZeroTicks,
            nextRunAt,
          },
        );
        return { skipped: false, reconciled: 0, cursorReset: true };
      }
    } else {
      consecutiveZeroTicks = 0;
    }

    await ctx.runMutation(
      internal.crystal.reconcileEmbeddingDualWrite.upsertReconcileState,
      {
        lastScannedCreationTime: nextCursor,
        lastTickReconciledCount: result.reconciled,
        consecutiveZeroTicks,
        nextRunAt,
      },
    );

    return {
      skipped: false,
      reconciled: result.reconciled,
      scanned: result.scanned,
      cursor: nextCursor,
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
  const lastZeroStreakHours = (consecutiveZeroTicks * TICK_INTERVAL_MS) / (60 * 60 * 1000);
  return {
    ready: consecutiveZeroTicks >= CUTOVER_TICKS_REQUIRED,
    consecutiveZeroTicks,
    lastZeroStreakHours,
    ticksRequired: CUTOVER_TICKS_REQUIRED,
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
