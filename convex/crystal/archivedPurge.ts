// Hard-delete of spent archived memories so they stop bloating the recall vector
// scan. Archival is one-way (decay, supersession, forget, salience, KB, sensory
// TTL) but nothing ever deleted archived rows, so they piled up keeping a
// 3072-dim embedding in the recall index forever.
//
// Policy (age measured by createdAt — always present, unlike archivedAt, and the
// retention basis for ephemeral stores anyway):
//   - sensory: ephemeral by design, purge when created >7d ago.
//   - non-sensory: purge when created >30d ago, BUT keep supersession
//     predecessors (supersededByMemoryId set) so "why did we change X" survives.
//   - never touch protected sensory (rawRetentionState === "protected").
//
// Efficiency: the candidate scan reads `crystalMemoryCleanupIndex` — an
// embedding-free projection of every memory — so it stays cheap no matter how
// many archived rows exist (the main-table rows each carry a ~24KB embedding;
// the projection rows don't). The main doc is read only to cascade-delete an
// eligible row. Cascade covers every single-FK child incl. the M8 embedding
// sidecar (the reconcile cron iterates memories and will NOT clean an orphaned
// sidecar row). Array-valued references are tolerated — read paths null-filter.

import { v } from "convex/values";
import { internalQuery, internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { applyDashboardTotalsDelta, buildMemoryDeleteDelta } from "./dashboardTotals";
import { deleteCleanupProjectionForMemory } from "./cleanupProjection";

const DAY_MS = 24 * 60 * 60 * 1000;

// Persistent rotation cursor (crystalJobCursors): each daily tick fans out over
// ONE page of user profiles instead of collecting the whole table. Safe here
// because eligibility is purely elapsed-time from createdAt (rows only become
// MORE purgeable over time) and deletion is idempotent + re-verified at delete
// time — visiting a user less often just means spent rows linger a bit longer.
const JOB_NAME = "archived-purge";
const DEFAULT_USERS_PER_TICK = 25;
const MAX_USERS_PER_TICK = 200;

const clampInt = (value: number | undefined, min: number, max: number, fallback: number) => {
  const raw = Number.isFinite(value ?? NaN) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(raw, min), max);
};

const SENSORY_RETENTION_DAYS = 7;
const NON_SENSORY_RETENTION_DAYS = 30;
const PURGE_STORES = ["sensory", "episodic", "semantic", "procedural", "prospective"] as const;

const retentionDaysForStore = (store: string): number =>
  store === "sensory" ? SENSORY_RETENTION_DAYS : NON_SENSORY_RETENTION_DAYS;

// Eligibility on the MAIN doc (re-verified before deletion). createdAt is always
// set at insert, so there is no immortal-row gap.
const isPurgeable = (m: any, now: number): boolean => {
  if (!m || m.archived !== true) return false;
  if (m.rawRetentionState === "protected") return false;
  // Preserve supersession provenance — only non-sensory carries real history.
  if (m.store !== "sensory" && m.supersededByMemoryId) return false;
  const cutoff = now - retentionDaysForStore(m.store) * DAY_MS;
  return m.createdAt < cutoff;
};

// ── cascade ──────────────────────────────────────────────────────────────────
// Five KB chunks can be processed in one mutation, so cap each of the eight
// child indexes at 50 rows: 5 * 8 * 50 = 2,000 child reads/writes before the
// small parent/projection overhead, comfortably below Convex's 4,096-read cap.
const CASCADE_CHILD_PAGE_SIZE = 50;

async function deleteByMemoryIndexPage(
  ctx: any,
  table: string,
  index: string,
  field: string,
  memoryId: Id<"crystalMemories">,
): Promise<boolean> {
  const rows = await ctx.db
    .query(table)
    .withIndex(index, (q: any) => q.eq(field, memoryId))
    .take(CASCADE_CHILD_PAGE_SIZE);
  for (const row of rows) await ctx.db.delete(row._id);
  // An exact full page gets one confirmation pass before the parent memory is
  // deleted. This keeps child cleanup resumable without relying on row counts.
  return rows.length === CASCADE_CHILD_PAGE_SIZE;
}

export async function cascadeDeleteMemory(
  ctx: any,
  memory: any,
  options: { applyDashboardTotals?: boolean } = {},
): Promise<boolean> {
  const memoryId = memory._id as Id<"crystalMemories">;
  // Every child relation is deleted in bounded pages. A frequently recalled
  // memory can have thousands of organicActivityLog rows; collecting them all
  // made KB deletion and the archived-memory purge exceed Convex's 4096-read
  // transaction limit. The caller repeats until this returns true.
  let hasMoreChildren = false;
  const childIndexes = [
    ["crystalMemoryEmbeddings", "by_memoryId", "memoryId"],
    ["crystalMemoryTriggers", "by_memory", "memoryId"],
    ["crystalMemoryNodeLinks", "by_memory", "memoryId"],
    ["crystalEnrichmentBacklog", "by_memory", "memoryId"],
    ["organicActivityLog", "by_memory", "memoryId"],
    ["organicEnsembleMemberships", "by_memory", "memoryId"],
    ["crystalAssociations", "by_from", "fromMemoryId"],
    ["crystalAssociations", "by_to", "toMemoryId"],
  ] as const;
  for (const [table, index, field] of childIndexes) {
    // M8 embedding sidecar is included first — it MUST go because the reconcile
    // cron iterates memories and cannot clean an orphaned sidecar.
    hasMoreChildren = await deleteByMemoryIndexPage(ctx, table, index, field, memoryId) || hasMoreChildren;
  }
  if (hasMoreChildren) return false;
  await deleteCleanupProjectionForMemory(ctx, memoryId);

  await ctx.db.delete(memoryId);
  if (options.applyDashboardTotals !== false) {
    await applyDashboardTotalsDelta(
      ctx,
      memory.userId,
      buildMemoryDeleteDelta({
        archived: memory.archived === true,
        store: memory.store,
        graphEnriched: memory.graphEnriched === true,
        enrichmentSkippedReason: memory.enrichmentSkippedReason,
        accessCount: memory.accessCount,
        strength: memory.strength,
        knowledgeBaseId: memory.knowledgeBaseId,
      }),
    );
  }
  return true;
}

// ── candidate scan (embedding-free projection, one store, early-terminating) ──
export const scanArchivedProjectionPage = internalQuery({
  args: {
    userId: v.string(),
    store: v.string(),
    cursor: v.union(v.string(), v.null()),
    batch: v.number(),
    now: v.number(),
  },
  handler: async (ctx, { userId, store, cursor, batch, now }) => {
    const cutoff = now - retentionDaysForStore(store) * DAY_MS;
    const res = await ctx.db
      .query("crystalMemoryCleanupIndex")
      .withIndex("by_user_archived_store_created", (q) =>
        q.eq("userId", userId).eq("archived", true).eq("store", store as any),
      )
      .paginate({ cursor, numItems: batch });

    const candidateIds: Id<"crystalMemories">[] = [];
    let reachedNewRows = false;
    for (const row of res.page) {
      // Ordered by createdAt asc; once createdAt crosses the cutoff nothing later
      // in this store can qualify — stop. (createdAt is the retention basis.)
      if (row.createdAt >= cutoff) {
        reachedNewRows = true;
        break;
      }
      if (row.rawRetentionState === "protected") continue;
      candidateIds.push(row.memoryId);
    }
    return {
      candidateIds,
      scanned: res.page.length,
      isDone: res.isDone || reachedNewRows,
      cursor: res.continueCursor,
    };
  },
});

// ── cascade-delete a batch (re-verifies on the main doc, incl. supersession) ──
export const purgeArchivedBatch = internalMutation({
  args: { memoryIds: v.array(v.id("crystalMemories")), now: v.number() },
  handler: async (ctx, { memoryIds, now }) => {
    let purged = 0, skipped = 0, pending = 0;
    for (const id of memoryIds) {
      const m = await ctx.db.get(id);
      if (!isPurgeable(m, now)) { skipped++; continue; }
      if (await cascadeDeleteMemory(ctx, m)) purged++;
      else pending++;
    }
    return { purged, skipped, pending };
  },
});

// ── per-user orchestrator (one scheduled action per user via the cron) ────────
export const runArchivedPurgeForUser = internalAction({
  args: { userId: v.string(), dryRun: v.boolean() },
  handler: async (ctx, { userId, dryRun }) => {
    const now = Date.now();
    let eligible = 0, purged = 0, scannedTotal = 0;
    const byStore: Record<string, number> = {};

    for (const store of PURGE_STORES) {
      let cursor: string | null = null;
      let done = false;
      let pages = 0;
      while (!done && pages < 400) {
        const page: any = await ctx.runQuery(internal.crystal.archivedPurge.scanArchivedProjectionPage, {
          userId, store, cursor, batch: 500, now,
        });
        scannedTotal += page.scanned;
        eligible += page.candidateIds.length;
        byStore[store] = (byStore[store] ?? 0) + page.candidateIds.length;
        if (!dryRun && page.candidateIds.length > 0) {
          for (const memoryId of page.candidateIds) {
            let cascadeDone = false;
            for (let cascadePage = 0; cascadePage < 100 && !cascadeDone; cascadePage++) {
              const r: any = await ctx.runMutation(internal.crystal.archivedPurge.purgeArchivedBatch, {
                memoryIds: [memoryId],
                now,
              });
              purged += r.purged;
              cascadeDone = r.pending === 0;
            }
          }
        }
        cursor = page.cursor;
        done = page.isDone;
        pages++;
      }
    }
    return { userId, dryRun, scannedTotal, eligible, purged, byStore };
  },
});

// ── daily cron: fan out one action per user (bounds per-user work) ────────────
// Cursor rotation: each tick schedules purges for ONE page of users (resuming
// from the persisted crystalJobCursors cursor) instead of collecting the whole
// profiles table. At end-of-table the cursor resets and the rotation restarts.
// Explicit single-user runs and dry runs never advance the shared cursor.
export const purgeArchivedAllUsers = internalAction({
  args: {
    userId: v.optional(v.string()),
    usersLimit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ scheduledUsers: number; dryRun: boolean }> => {
    const usersLimit = clampInt(args.usersLimit, 1, MAX_USERS_PER_TICK, DEFAULT_USERS_PER_TICK);
    const dryRun = args.dryRun ?? false;

    let userIds: string[];
    let nextCursor: string | undefined;
    if (args.userId) {
      userIds = [args.userId];
    } else {
      const cursor = (await ctx.runQuery(internal.crystal.jobCursors.getJobCursor, {
        jobName: JOB_NAME,
      })) as string | null;
      let page: { userIds: string[]; continueCursor: string; isDone: boolean };
      try {
        page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          cursor: cursor ?? undefined,
          numItems: usersLimit,
        });
      } catch {
        // Stale/invalidated pagination cursor (table churn between ticks):
        // restart the rotation from the beginning rather than failing the tick.
        page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          numItems: usersLimit,
        });
      }
      userIds = page.userIds;
      nextCursor = page.isDone ? undefined : page.continueCursor;
    }

    for (const userId of userIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.archivedPurge.runArchivedPurgeForUser,
        { userId, dryRun },
      );
    }

    // Advance (or reset) the rotation only for real cron sweeps: explicit
    // single-user runs and dry runs must not move the shared cursor.
    if (!args.userId && !args.dryRun) {
      await ctx.runMutation(internal.crystal.jobCursors.setJobCursor, {
        jobName: JOB_NAME,
        cursor: nextCursor,
      });
    }

    return { scheduledUsers: userIds.length, dryRun };
  },
});
