// Hard-delete of spent archived sensory memories after their applied raw
// retention deadline. Durable LTM remains soft-deleted unless an operator
// explicitly targets one user through the internal maintenance surface.
//
// Policy:
//   - recurring maintenance only purges sensory rows whose materialized,
//     tier-derived rawContentExpiresAt is due.
//   - protected sensory and KB content are never purge candidates.
//   - non-sensory is durable by default and is only reachable from an explicit
//     single-user operator run. Supersession predecessors remain preserved.
//
// Efficiency: due selection reads the narrow `crystalMemoryCleanupIndex`
// projection and hydrates a main document only inside the deleting mutation.
// Cascade covers every single-FK child including the authoritative embedding
// sidecar. Array-valued references are tolerated — read paths null-filter.

import { v } from "convex/values";
import { internalQuery, internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { applyDashboardTotalsDelta, buildMemoryDeleteDelta } from "./publicDashboardTotals";
import { deleteCleanupProjectionForMemory } from "./cleanupProjection";
import { deleteMemoryVector } from "./memoryVectors";
import { isProtectedSensoryCapture } from "./sensoryPolicy";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_USERS_PER_TICK = 25;
const MAX_USERS_PER_TICK = 200;
const MAX_DUE_ROWS_PER_STATE = 500;
const PURGES_PER_USER_TICK = 100;

const clampInt = (value: number | undefined, min: number, max: number, fallback: number) => {
  const raw = Number.isFinite(value ?? NaN) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(raw, min), max);
};

const SENSORY_RETENTION_DAYS = 7;
const NON_SENSORY_RETENTION_DAYS = 30;
const PURGE_STORES = ["sensory", "episodic", "semantic", "procedural", "prospective"] as const;
const PURGEABLE_SENSORY_STATES = ["raw", "summarized", "wiped", "wiped_without_summary", undefined] as const;

const retentionDaysForStore = (store: string): number =>
  store === "sensory" ? SENSORY_RETENTION_DAYS : NON_SENSORY_RETENTION_DAYS;

// Eligibility on the MAIN doc, re-verified in the same transaction as deletion.
// Sensory rows without a materialized retention deadline fail closed: guessing
// a legacy tenant's tier could delete paid-retention content too early.
const isPurgeable = (m: any, now: number, allowDurableStores: boolean): boolean => {
  if (!m || m.archived !== true) return false;
  if (m.knowledgeBaseId) return false;
  if (m.store === "sensory") {
    if (m.rawRetentionState === "protected" || isProtectedSensoryCapture(m)) return false;
    return typeof m.rawContentExpiresAt === "number" && m.rawContentExpiresAt <= now;
  }
  if (!allowDurableStores || m.supersededByMemoryId) return false;
  return m.createdAt < now - NON_SENSORY_RETENTION_DAYS * DAY_MS;
};

// ── cascade ──────────────────────────────────────────────────────────────────
// Five KB chunks can be processed in one mutation, so cap each retained child
// index at 50 rows, comfortably below Convex's transaction read limit.
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
  // Every retained child relation is deleted in bounded pages. The caller
  // repeats until this returns true.
  let hasMoreChildren = false;
  const childIndexes = [
    ["crystalMemoryTriggers", "by_memory", "memoryId"],
  ] as const;
  // Side-vector uniqueness is an application invariant. The shared helper
  // deletes the valid row and fails closed on duplicates before parent delete.
  await deleteMemoryVector(ctx, memoryId);
  for (const [table, index, field] of childIndexes) {
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

// ── recurring due-tenant selection (no profile walk, no rotation cursor) ─────
// Normal sensory writes materialize the tier-derived rawContentExpiresAt. The
// global projection index lets an idle cron prove there is no work with bounded
// seeks, regardless of how many user profiles exist.
export const getDueArchivedSensoryUserIds = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, { now, limit }) => {
    const maxUsers = clampInt(limit, 1, MAX_USERS_PER_TICK, DEFAULT_USERS_PER_TICK);
    const scanLimit = Math.min(
      Math.max(maxUsers * 4, maxUsers + 1),
      MAX_DUE_ROWS_PER_STATE,
    );
    const dueRows: any[] = [];
    for (const state of PURGEABLE_SENSORY_STATES) {
      dueRows.push(...await ctx.db
        .query("crystalMemoryCleanupIndex")
        .withIndex("by_archived_sensory_purge_due", (q) =>
          q.eq("store", "sensory")
            .eq("archived", true)
            .eq("knowledgeBaseId", undefined)
            .eq("protectedSensoryCandidate", false)
            .eq("rawRetentionState", state)
            .gt("rawContentExpiresAt", 0)
            .lte("rawContentExpiresAt", now)
        )
        .take(scanLimit));
    }
    return Array.from(new Set(dueRows.map((row) => row.userId as string)))
      .slice(0, maxUsers);
  },
});

export const getArchivedSensoryPurgeCandidates = internalQuery({
  args: { userId: v.string(), now: v.number(), limit: v.number() },
  handler: async (ctx, { userId, now, limit }) => {
    const max = clampInt(limit, 1, 500, 500);
    const candidates: any[] = [];
    for (const state of PURGEABLE_SENSORY_STATES) {
      candidates.push(...await ctx.db
        .query("crystalMemoryCleanupIndex")
        .withIndex("by_user_archived_sensory_purge_due", (q) =>
          q.eq("userId", userId)
            .eq("store", "sensory")
            .eq("archived", true)
            .eq("knowledgeBaseId", undefined)
            .eq("protectedSensoryCandidate", false)
            .eq("rawRetentionState", state)
            .gt("rawContentExpiresAt", 0)
            .lte("rawContentExpiresAt", now)
        )
        .take(max));
    }
    return Array.from(new Map(candidates
      .sort((a, b) => (a.rawContentExpiresAt ?? 0) - (b.rawContentExpiresAt ?? 0))
      .map((row) => [String(row.memoryId), row.memoryId] as const))
      .values())
      .slice(0, max);
  },
});

// ── cascade-delete a batch (re-verifies on the main doc, incl. supersession) ──
export const purgeArchivedBatch = internalMutation({
  args: {
    memoryIds: v.array(v.id("crystalMemories")),
    now: v.number(),
    allowDurableStores: v.optional(v.boolean()),
  },
  handler: async (ctx, { memoryIds, now, allowDurableStores }) => {
    let purged = 0, skipped = 0, pending = 0;
    for (const id of memoryIds) {
      const m = await ctx.db.get(id);
      if (!isPurgeable(m, now, allowDurableStores === true)) { skipped++; continue; }
      if (await cascadeDeleteMemory(ctx, m)) purged++;
      else pending++;
    }
    return { purged, skipped, pending };
  },
});

// ── per-user orchestrator (one scheduled action per user via the cron) ────────
export const runArchivedPurgeForUser = internalAction({
  args: {
    userId: v.string(),
    dryRun: v.boolean(),
    allowDurableStores: v.optional(v.boolean()),
  },
  handler: async (ctx, { userId, dryRun, allowDurableStores }) => {
    const now = Date.now();
    let eligible = 0, purged = 0, scannedTotal = 0;
    const byStore: Record<string, number> = {};

    // Sensory uses the exact materialized tier deadline. One fixed batch keeps
    // the recurring tenant job cheap even when an account has a large backlog;
    // due rows remain indexed for the next tick.
    const sensoryCandidateIds = await ctx.runQuery(
      internal.crystal.archivedPurge.getArchivedSensoryPurgeCandidates,
      { userId, now, limit: PURGES_PER_USER_TICK },
    ) as Id<"crystalMemories">[];
    scannedTotal += sensoryCandidateIds.length;
    eligible += sensoryCandidateIds.length;
    byStore.sensory = sensoryCandidateIds.length;
    if (!dryRun) {
      for (const memoryId of sensoryCandidateIds) {
        let cascadeDone = false;
        for (let cascadePage = 0; cascadePage < 100 && !cascadeDone; cascadePage++) {
          const result: any = await ctx.runMutation(
            internal.crystal.archivedPurge.purgeArchivedBatch,
            { memoryIds: [memoryId], now, allowDurableStores: false },
          );
          purged += result.purged;
          cascadeDone = result.pending === 0;
        }
      }
    }

    // Preserve the explicit single-user maintenance capability, but keep it
    // unreachable from recurring fan-out. Durable rows are still revalidated
    // inside purgeArchivedBatch immediately before deletion.
    const stores = allowDurableStores === true ? PURGE_STORES.slice(1) : [];
    for (const store of stores) {
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
                allowDurableStores: true,
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

// ── daily cron: fan out only to indexed due tenants ──────────────────────────
export const purgeArchivedAllUsers = internalAction({
  args: {
    userId: v.optional(v.string()),
    usersLimit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    allowDurableStores: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ scheduledUsers: number; dryRun: boolean }> => {
    const usersLimit = clampInt(args.usersLimit, 1, MAX_USERS_PER_TICK, DEFAULT_USERS_PER_TICK);
    const dryRun = args.dryRun ?? false;

    const userIds = args.userId
      ? [args.userId]
      : await ctx.runQuery(internal.crystal.archivedPurge.getDueArchivedSensoryUserIds, {
          now: Date.now(),
          limit: usersLimit,
        }) as string[];

    for (const userId of userIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.archivedPurge.runArchivedPurgeForUser,
        {
          userId,
          dryRun,
          allowDurableStores: Boolean(args.userId) && args.allowDurableStores === true,
        },
      );
    }

    return { scheduledUsers: userIds.length, dryRun };
  },
});
