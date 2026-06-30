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
import { applyDashboardTotalsDelta } from "./dashboardTotals";
import { deleteCleanupProjectionForMemory } from "./cleanupProjection";

const DAY_MS = 24 * 60 * 60 * 1000;

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
async function deleteByMemoryIndex(
  ctx: any,
  table: string,
  index: string,
  field: string,
  memoryId: Id<"crystalMemories">,
): Promise<void> {
  const rows = await ctx.db
    .query(table)
    .withIndex(index, (q: any) => q.eq(field, memoryId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

export async function cascadeDeleteMemory(ctx: any, memory: any): Promise<void> {
  const memoryId = memory._id as Id<"crystalMemories">;
  // M8 embedding sidecar — MUST go, the reconcile cron won't clean orphans.
  await deleteByMemoryIndex(ctx, "crystalMemoryEmbeddings", "by_memoryId", "memoryId", memoryId);
  await deleteByMemoryIndex(ctx, "crystalMemoryTriggers", "by_memory", "memoryId", memoryId);
  await deleteByMemoryIndex(ctx, "crystalMemoryNodeLinks", "by_memory", "memoryId", memoryId);
  await deleteByMemoryIndex(ctx, "crystalEnrichmentBacklog", "by_memory", "memoryId", memoryId);
  await deleteByMemoryIndex(ctx, "organicActivityLog", "by_memory", "memoryId", memoryId);
  await deleteByMemoryIndex(ctx, "organicEnsembleMemberships", "by_memory", "memoryId", memoryId);
  await deleteByMemoryIndex(ctx, "crystalAssociations", "by_from", "fromMemoryId", memoryId);
  await deleteByMemoryIndex(ctx, "crystalAssociations", "by_to", "toMemoryId", memoryId);
  await deleteCleanupProjectionForMemory(ctx, memoryId);

  await ctx.db.delete(memoryId);
  await applyDashboardTotalsDelta(ctx, memory.userId, {
    totalMemoriesDelta: -1,
    archivedMemoriesDelta: -1,
  });
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
    let purged = 0, skipped = 0;
    for (const id of memoryIds) {
      const m = await ctx.db.get(id);
      if (!isPurgeable(m, now)) { skipped++; continue; }
      await cascadeDeleteMemory(ctx, m);
      purged++;
    }
    return { purged, skipped };
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
          for (let i = 0; i < page.candidateIds.length; i += 50) {
            const r: any = await ctx.runMutation(internal.crystal.archivedPurge.purgeArchivedBatch, {
              memoryIds: page.candidateIds.slice(i, i + 50),
              now,
            });
            purged += r.purged;
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
export const purgeArchivedAllUsers = internalAction({
  args: {},
  handler: async (ctx) => {
    const userIds: string[] = await ctx.runQuery(
      internal.crystal.userProfiles.listAllUserIds,
      {},
    );
    for (const userId of userIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.archivedPurge.runArchivedPurgeForUser,
        { userId, dryRun: false },
      );
    }
    return { scheduledUsers: userIds.length };
  },
});
