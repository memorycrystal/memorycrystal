import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  archiveMemoryAndSyncCleanupProjection,
  patchMemoryAndSyncCleanupProjection,
  upsertCleanupProjectionForMemory,
} from "./cleanupProjection";
import { applyDashboardTotalsDelta, buildMemoryTransitionDelta, nonKbActiveFromTotals } from "./publicDashboardTotals";
import { scheduleMemoryEmbedding } from "./embedRetry";

const DAY_MS = 86_400_000;
export const STALE_AGE_MS = 90 * DAY_MS;
export const STALE_ARCHIVE_KEPT_CATEGORIES: ReadonlySet<Doc<"crystalMemories">["category"]> = new Set(["rule", "decision", "person"] as const);
// Earlier unmarked rows may predate immutable extraction provenance.
export const EXTRACTION_ORIGIN_SHIP_DATE = Date.UTC(2026, 9, 13);
export const STALE_PAGE_SIZE = 50;
export const MAX_ROWS_PER_ACCOUNT = 5_000;
export const MAX_DRY_RUN_ROWS_PER_ACCOUNT = 60_000;
export const MAX_ARCHIVES_PER_ACCOUNT = 1_000;
export const MAX_ARCHIVES_PER_RUN = 10_000;
export const STALE_RUN_BUDGET_MS = 8 * 60_000;
const ARCHIVE_REASON = "stale_unrecalled_90d" as const;
const modeValidator = v.union(v.literal("dry_run"), v.literal("on"));

function provenance(memory: Doc<"crystalMemories">): "origin" | "legacy" | "legacy_sources" | null {
  if (memory.origin === "extraction") return "origin";
  if (
    memory.origin === undefined && memory.createdAt < EXTRACTION_ORIGIN_SHIP_DATE &&
    memory.source === "conversation"
  ) {
    if (memory.extractionRunId !== undefined) return "legacy";
    if ((memory.sourceMessageIds?.length ?? 0) > 0) return "legacy_sources";
  }
  return null;
}

function eligibleProvenance(memory: Doc<"crystalMemories">, now: number) {
  const cutoff = now - STALE_AGE_MS;
  if (
    memory.archived || memory.knowledgeBaseId || memory.store === "sensory" ||
    STALE_ARCHIVE_KEPT_CATEGORIES.has(memory.category) ||
    !(memory.createdAt <= cutoff) || !(memory.lastAccessedAt <= cutoff) ||
    (memory.lastRecalledAt !== undefined && !(memory.lastRecalledAt <= cutoff)) ||
    memory.coreTier === true || memory.tags.some((tag) => tag.toLowerCase() === "core") ||
    !(memory.strength < 0.85)
  ) return null;
  return provenance(memory);
}

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

export const startStaleArchiveRun = internalMutation({
  args: { mode: modeValidator },
  handler: async (ctx, { mode }) => {
    const previous = mode === "on" ? await ctx.db.query("crystalStaleArchiveRuns")
      .withIndex("by_mode", (q) => q.eq("mode", "on")).order("desc").first() : null;
    return ctx.db.insert("crystalStaleArchiveRuns", {
      mode, startedAt: Date.now(), accountsScanned: 0, rowsRead: 0,
      eligible: 0, archived: 0, capReached: false, budgetReached: false, failed: false,
      nextProfileCursor: previous?.nextProfileCursor ?? null,
    });
  },
});

export const getStaleArchiveProfileCursor = internalQuery({
  args: { runId: v.id("crystalStaleArchiveRuns") },
  handler: async (ctx, { runId }) => (await ctx.db.get(runId))?.nextProfileCursor ?? null,
});

export const advanceStaleArchiveProfileCursor = internalMutation({
  args: { runId: v.id("crystalStaleArchiveRuns"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { runId, cursor }) => ctx.db.patch(runId, { nextProfileCursor: cursor }),
});

export const listStaleArchiveAccounts = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    // One profile per page lets a budget stop rotate past the processed account.
    const page = await ctx.db.query("crystalUserProfiles").paginate({ cursor, numItems: 1 });
    return { userIds: page.page.map((row) => row.userId), cursor: page.continueCursor, isDone: page.isDone };
  },
});

export const processStaleArchivePage = internalMutation({
  args: {
    runId: v.id("crystalStaleArchiveRuns"),
    userId: v.string(),
    cursor: v.union(v.string(), v.null()),
    scanCutoff: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.finishedAt !== undefined) throw new Error("Stale archive run is not active");
    const now = Date.now();
    const dryRun = run.mode === "dry_run";
    const previous = await ctx.db.query("crystalStaleArchiveRunAccounts")
      .withIndex("by_run_user", (q) => q.eq("runId", args.runId).eq("userId", args.userId)).unique();
    const totals = previous ? null : await ctx.db.query("crystalDashboardTotals")
      .withIndex("by_user", (q) => q.eq("userId", args.userId)).unique();
    const account = previous ?? {
      runId: args.runId, userId: args.userId, rowsRead: 0, eligible: 0, archived: 0,
      dashboardNonKbActiveCount: totals ? nonKbActiveFromTotals(totals) : null,
      byStore: {}, byCategory: {}, byAge: {}, byProvenance: {}, strengthHistogram: {}, partial: true,
    };
    const rowsLimit = dryRun ? MAX_DRY_RUN_ROWS_PER_ACCOUNT : MAX_ROWS_PER_ACCOUNT;
    const budgetReached = now - run.startedAt >= STALE_RUN_BUDGET_MS;
    const runCapReached = !dryRun && run.archived >= MAX_ARCHIVES_PER_RUN;
    if (budgetReached || runCapReached) {
      await ctx.db.patch(run._id, {
        budgetReached: run.budgetReached || budgetReached,
        capReached: run.capReached || runCapReached,
      });
      return { processed: false, cursor: args.cursor, isDone: false, accountStopped: true, runStopped: true };
    }
    const numItems = Math.min(
      STALE_PAGE_SIZE, rowsLimit - account.rowsRead,
      dryRun ? STALE_PAGE_SIZE : MAX_ARCHIVES_PER_ACCOUNT - account.archived,
      dryRun ? STALE_PAGE_SIZE : MAX_ARCHIVES_PER_RUN - run.archived,
    );
    if (numItems <= 0) {
      return { processed: false, cursor: args.cursor, isDone: false, accountStopped: true, runStopped: false };
    }
    // Dry runs neither read nor write the persisted cursor. A live pass keeps
    // the exact indexed range fixed until paginate reports completion.
    const state = dryRun ? null : await ctx.db.query("crystalStaleArchiveCursors")
      .withIndex("by_user", (q) => q.eq("userId", args.userId)).unique();
    const scanCutoff = dryRun ? args.scanCutoff
      : state?.cursor ? state.scanCutoff : now - STALE_AGE_MS;
    const cursor = dryRun ? args.cursor : state?.cursor ?? null;
    const page = await ctx.db.query("crystalMemoryCleanupIndex")
      .withIndex("by_user_archived_created", (q) => q.eq("userId", args.userId)
        .eq("archived", false).lte("createdAt", scanCutoff))
      .paginate({ cursor, numItems });
    let eligible = 0;
    let archived = 0;
    const cutoff = now - STALE_AGE_MS;
    for (const row of page.page) {
      if (row.knowledgeBaseId || row.store === "sensory" || !(row.createdAt <= cutoff) || !(row.lastAccessedAt <= cutoff)) continue;
      increment(account.strengthHistogram, row.strength < 0.6 ? "<0.6"
        : row.strength < 0.7 ? "0.6-0.7" : row.strength < 0.85 ? "0.7-0.85" : ">=0.85");
      if (STALE_ARCHIVE_KEPT_CATEGORIES.has(row.category)) continue;
      if (!(row.strength < 0.85)) continue;
      const memory = await ctx.db.get(row.memoryId);
      if (!memory || memory.userId !== args.userId) continue;
      const kind = eligibleProvenance(memory, now);
      if (!kind) {
        if (!dryRun && (memory.lastAccessedAt > cutoff || (memory.lastRecalledAt ?? 0) > cutoff)) {
          await upsertCleanupProjectionForMemory(ctx, {
            ...memory, lastAccessedAt: Math.max(memory.lastAccessedAt, memory.lastRecalledAt ?? 0),
          }, now);
        }
        continue;
      }
      eligible++;
      increment(account.byStore, memory.store);
      increment(account.byCategory, memory.category);
      increment(account.byProvenance, kind);
      const age = now - memory.createdAt;
      increment(account.byAge, age <= 180 * DAY_MS ? "90-180" : age <= 365 * DAY_MS ? "180-365" : ">365");
      if (dryRun) continue;
      await archiveMemoryAndSyncCleanupProjection(ctx, memory, now, { archiveReason: ARCHIVE_REASON });
      await applyDashboardTotalsDelta(ctx, memory.userId, buildMemoryTransitionDelta({
        oldArchived: false, oldStore: memory.store, oldAccessCount: memory.accessCount,
        oldKnowledgeBaseId: memory.knowledgeBaseId,
        newArchived: true, newStore: memory.store, newAccessCount: memory.accessCount,
      }));
      archived++;
    }
    const nextCursor = page.isDone ? null : page.continueCursor;
    if (!dryRun) {
      const nextState = { userId: args.userId, cursor: nextCursor, scanCutoff };
      if (state) await ctx.db.patch(state._id, nextState);
      else await ctx.db.insert("crystalStaleArchiveCursors", nextState);
    }
    const rowsRead = account.rowsRead + page.page.length;
    const accountCap = rowsRead >= rowsLimit || (!dryRun && account.archived + archived >= MAX_ARCHIVES_PER_ACCOUNT);
    const runCap = !dryRun && run.archived + archived >= MAX_ARCHIVES_PER_RUN;
    const capReached = !page.isDone && (accountCap || runCap);
    const accountPatch = {
      rowsRead, eligible: account.eligible + eligible, archived: account.archived + archived,
      dashboardNonKbActiveCount: account.dashboardNonKbActiveCount,
      byStore: account.byStore, byCategory: account.byCategory, byAge: account.byAge,
      byProvenance: account.byProvenance, strengthHistogram: account.strengthHistogram,
      partial: !page.isDone,
    };
    if (previous) await ctx.db.patch(previous._id, accountPatch);
    else await ctx.db.insert("crystalStaleArchiveRunAccounts", { runId: args.runId, userId: args.userId, ...accountPatch });
    await ctx.db.patch(run._id, {
      rowsRead: run.rowsRead + page.page.length, eligible: run.eligible + eligible,
      archived: run.archived + archived, accountsScanned: run.accountsScanned + (previous ? 0 : 1),
      capReached: run.capReached || capReached || runCap,
    });
    return { processed: true, cursor: nextCursor, isDone: page.isDone, accountStopped: accountCap, runStopped: runCap };
  },
});

export const recordStaleArchiveAccountFailure = internalMutation({
  args: { runId: v.id("crystalStaleArchiveRuns"), userId: v.string() },
  handler: async (ctx, { runId, userId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Stale archive run not found");
    const account = await ctx.db.query("crystalStaleArchiveRunAccounts")
      .withIndex("by_run_user", (q) => q.eq("runId", runId).eq("userId", userId)).unique();
    // Exception messages can contain memory data; persist only a fixed code.
    const failure = { error: "account_page_failed", partial: true };
    if (account) await ctx.db.patch(account._id, failure);
    else {
      const totals = await ctx.db.query("crystalDashboardTotals")
        .withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.insert("crystalStaleArchiveRunAccounts", {
        runId, userId, rowsRead: 0, eligible: 0, archived: 0,
        dashboardNonKbActiveCount: totals ? nonKbActiveFromTotals(totals) : null,
        byStore: {}, byCategory: {}, byAge: {}, byProvenance: {}, strengthHistogram: {},
        ...failure,
      });
    }
    await ctx.db.patch(runId, { failed: true, accountsScanned: run.accountsScanned + (account ? 0 : 1) });
  },
});

export const finishStaleArchiveRun = internalMutation({
  args: { runId: v.id("crystalStaleArchiveRuns"), budgetReached: v.boolean(), failed: v.boolean() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Stale archive run not found");
    await ctx.db.patch(run._id, {
      finishedAt: Date.now(), budgetReached: run.budgetReached || args.budgetReached, failed: run.failed || args.failed,
    });
  },
});

export const runStaleMemoryArchive = internalAction({
  args: {},
  handler: async (ctx): Promise<Id<"crystalStaleArchiveRuns"> | null> => {
    const mode = process.env.CRYSTAL_STALE_ARCHIVE;
    if (mode !== "dry_run" && mode !== "on") return null;
    const startedAt = Date.now();
    const runId = await ctx.runMutation(internal.crystal.staleArchive.startStaleArchiveRun, { mode });
    let budgetReached = false;
    let failed = true;
    try {
      let profileCursor: string | null = await ctx.runQuery(internal.crystal.staleArchive.getStaleArchiveProfileCursor, { runId });
      let canWrap = profileCursor !== null;
      let firstUserId: string | undefined;
      let stopped = false;
      do {
        if (Date.now() - startedAt >= STALE_RUN_BUDGET_MS) { budgetReached = true; break; }
        const profiles: { userIds: string[]; cursor: string; isDone: boolean } =
          await ctx.runQuery(internal.crystal.staleArchive.listStaleArchiveAccounts, { cursor: profileCursor });
        if (mode === "on" && profiles.isDone && profiles.userIds.length === 0) {
          await ctx.runMutation(internal.crystal.staleArchive.advanceStaleArchiveProfileCursor, { runId, cursor: null });
        }
        for (const userId of profiles.userIds) {
          if (userId === firstUserId) { stopped = true; break; }
          firstUserId ??= userId;
          let cursor: string | null = null;
          let processed = false;
          do {
            if (Date.now() - startedAt >= STALE_RUN_BUDGET_MS) {
              budgetReached = true; stopped = true; break;
            }
            let page: { processed: boolean; cursor: string | null; isDone: boolean; accountStopped: boolean; runStopped: boolean };
            try {
              page = await ctx.runMutation(internal.crystal.staleArchive.processStaleArchivePage, {
                runId, userId, cursor, scanCutoff: startedAt - STALE_AGE_MS,
              });
            } catch {
              await ctx.runMutation(internal.crystal.staleArchive.recordStaleArchiveAccountFailure, { runId, userId });
              break;
            }
            processed ||= page.processed;
            cursor = page.cursor;
            if (page.runStopped) { stopped = true; break; }
            if (page.isDone || page.accountStopped) break;
          } while (true);
          if (mode === "on" && processed) await ctx.runMutation(internal.crystal.staleArchive.advanceStaleArchiveProfileCursor, {
            runId, cursor: profiles.isDone ? null : profiles.cursor,
          });
          if (stopped) break;
        }
        profileCursor = profiles.cursor;
        if (profiles.isDone) {
          if (!canWrap) break;
          canWrap = false;
          profileCursor = null;
        }
      } while (!stopped);
      failed = false;
      return runId;
    } finally {
      await ctx.runMutation(internal.crystal.staleArchive.finishStaleArchiveRun, { runId, budgetReached, failed });
    }
  },
});

export const restoreStaleArchivedMemoriesBatch = internalMutation({
  args: { userId: v.string(), memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, { userId, memoryIds }) => {
    if (memoryIds.length > 100) throw new Error("At most 100 memory ids may be restored");
    const restored: Id<"crystalMemories">[] = [];
    const refused: Id<"crystalMemories">[] = [];
    const now = Date.now();
    for (const memoryId of new Set(memoryIds)) {
      const memory = await ctx.db.get(memoryId);
      if (!memory || memory.userId !== userId || !memory.archived || memory.archiveReason !== ARCHIVE_REASON) {
        refused.push(memoryId);
        continue;
      }
      const accessCount = Math.max(memory.accessCount, 1);
      await patchMemoryAndSyncCleanupProjection(ctx, memory, {
        archived: false, archivedAt: undefined, lastAccessedAt: now, accessCount,
      }, now);
      await applyDashboardTotalsDelta(ctx, userId, buildMemoryTransitionDelta({
        oldArchived: true, oldStore: memory.store, oldAccessCount: memory.accessCount,
        oldKnowledgeBaseId: memory.knowledgeBaseId,
        newArchived: false, newStore: memory.store, newAccessCount: accessCount,
      }));
      await scheduleMemoryEmbedding(ctx, memoryId);
      restored.push(memoryId);
    }
    return { restored, refused };
  },
});

export const restoreStaleArchivedMemories = internalAction({
  args: { userId: v.string(), memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, args): Promise<{ restored: Id<"crystalMemories">[]; refused: Id<"crystalMemories">[] }> => {
    if (args.memoryIds.length > 100) throw new Error("At most 100 memory ids may be restored");
    return ctx.runMutation(internal.crystal.staleArchive.restoreStaleArchivedMemoriesBatch, args);
  },
});
