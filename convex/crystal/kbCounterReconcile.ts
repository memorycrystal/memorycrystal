import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { metric } from "./metrics";
import type { Doc, Id } from "../_generated/dataModel";

const reconcileAllSelfRef = makeFunctionReference<"action">(
  "crystal/kbCounterReconcile:reconcileAllKnowledgeBases"
);

// One-shot reconciliation for KB memoryCount/totalChars drift.
//
// Why this exists: prior to the 2026-04-16 fix in archiveKnowledgeBaseMemoryInternal,
// every per-memory archive (including via deleteKnowledgeBase) leaked from the
// parent KB's memoryCount and totalChars without decrementing them. Result:
// stored counters drift above the true count of active chunks over time.
//
// Design:
//   - inspectKnowledgeBase: pure read; computes true counts from the
//     by_knowledge_base index and returns drift deltas.
//   - reconcileKnowledgeBaseInternal: mutation; patches the KB row to match.
//   - reconcileAllKnowledgeBases: paginated action; applyMode "dry-run" reports
//     drift only, "apply" patches divergent rows.
//
// TOCTOU window: the count phase (`computeKnowledgeBaseTotalsViaActions`) and
// the patch phase (`reconcileKnowledgeBaseInternal`) run in separate Convex
// transactions. A concurrent chunk insert or archive between the two phases
// would be missed — the patch commits stale values and the increment/decrement
// is effectively erased. Mitigation: (1) the mutation re-checks current stored
// counts and no-ops when already correct, (2) this tool is intended for
// operational repair — run it during low-write windows (e.g. during
// maintenance) rather than at peak traffic, and (3) for large corpora, pause
// ingestion before running with `applyMode: "apply"`.

type DriftReport = {
  knowledgeBaseId: Id<"knowledgeBases">;
  userId: string;
  name: string;
  storedMemoryCount: number;
  trueMemoryCount: number;
  storedTotalChars: number;
  trueTotalChars: number;
  memoryCountDelta: number;
  totalCharsDelta: number;
};

export const getKnowledgeBaseMetaInternal = internalQuery({
  args: { knowledgeBaseId: v.id("knowledgeBases") },
  handler: async (ctx, args) => {
    const kb = await ctx.db.get(args.knowledgeBaseId);
    if (!kb) return null;
    return {
      knowledgeBaseId: kb._id,
      userId: kb.userId,
      name: kb.name,
      storedMemoryCount: kb.memoryCount ?? 0,
      storedTotalChars: kb.totalChars ?? 0,
    };
  },
});

// Paginated chunk-count helper. Each invocation reads one page (default 200
// memories) bounded well below the per-query 16MB read limit. The caller (an
// action) loops until isDone, accumulating count + char sum across pages.
// The index scopes us to (knowledgeBaseId, archived=false) so we only pay for
// active chunks.
export const countKnowledgeBaseChunksPage = internalQuery({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    // userId is required so we can use the full composite index predicate
    // (knowledgeBaseId, userId, archived) instead of scan-and-filter. Without
    // it, the query fell back to scanning archived rows before filtering.
    userId: v.string(),
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = args.pageSize ?? 200;
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q: any) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId).eq("archived", false)
      )
      .paginate({ cursor: args.cursor ?? null, numItems });

    let pageCount = 0;
    let pageChars = 0;
    for (const memory of page.page) {
      pageCount += 1;
      pageChars += memory.content?.length ?? 0;
    }

    return {
      pageCount,
      pageChars,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

const computeKnowledgeBaseTotalsViaActions = async (
  ctx: { runQuery: Function },
  knowledgeBaseId: Id<"knowledgeBases">,
  userId: string,
  pageSize: number
): Promise<{ trueMemoryCount: number; trueTotalChars: number }> => {
  let trueMemoryCount = 0;
  let trueTotalChars = 0;
  let cursor: string | undefined = undefined;

  // Hard upper bound on iterations to defend against an unexpected non-
  // terminating cursor. 1M chunks at pageSize 200 = 5000 iterations, far
  // beyond any realistic KB.
  for (let i = 0; i < 5000; i += 1) {
    const result: { pageCount: number; pageChars: number; isDone: boolean; continueCursor: string } =
      await ctx.runQuery(
        internal.crystal.kbCounterReconcile.countKnowledgeBaseChunksPage,
        { knowledgeBaseId, userId, cursor, pageSize }
      );
    trueMemoryCount += result.pageCount;
    trueTotalChars += result.pageChars;
    if (result.isDone) break;
    cursor = result.continueCursor;
  }

  return { trueMemoryCount, trueTotalChars };
};

export const reconcileKnowledgeBaseInternal = internalMutation({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    trueMemoryCount: v.number(),
    trueTotalChars: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const kb = await ctx.db.get(args.knowledgeBaseId);
    if (!kb) return { patched: false };

    const storedMemoryCount = kb.memoryCount ?? 0;
    const storedTotalChars = kb.totalChars ?? 0;

    if (storedMemoryCount === args.trueMemoryCount && storedTotalChars === args.trueTotalChars) {
      return { patched: false };
    }

    await ctx.db.patch(args.knowledgeBaseId, {
      memoryCount: args.trueMemoryCount,
      totalChars: args.trueTotalChars,
      updatedAt: args.updatedAt,
    });

    return {
      patched: true,
      memoryCountDelta: storedMemoryCount - args.trueMemoryCount,
      totalCharsDelta: storedTotalChars - args.trueTotalChars,
    };
  },
});

export const listKnowledgeBaseIdsPage = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;
    const page = await ctx.db
      .query("knowledgeBases")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    return {
      ids: page.page.map((kb: Doc<"knowledgeBases">) => kb._id),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const reconcileAllKnowledgeBases: any = internalAction({
  args: {
    applyMode: v.union(v.literal("dry-run"), v.literal("apply")),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    accumulator: v.optional(
      v.object({
        kbsScanned: v.number(),
        kbsDrifted: v.number(),
        kbsPatched: v.number(),
        memoryCountDeltaSum: v.number(),
        totalCharsDeltaSum: v.number(),
        worstOffenders: v.array(
          v.object({
            knowledgeBaseId: v.string(),
            name: v.string(),
            memoryCountDelta: v.number(),
            totalCharsDelta: v.number(),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args): Promise<{
    isDone: boolean;
    kbsScanned: number;
    kbsDrifted: number;
    kbsPatched: number;
    memoryCountDeltaSum: number;
    totalCharsDeltaSum: number;
    worstOffenders: Array<{
      knowledgeBaseId: string;
      name: string;
      memoryCountDelta: number;
      totalCharsDelta: number;
    }>;
  }> => {
    const batchSize = args.batchSize ?? 50;
    const acc = args.accumulator ?? {
      kbsScanned: 0,
      kbsDrifted: 0,
      kbsPatched: 0,
      memoryCountDeltaSum: 0,
      totalCharsDeltaSum: 0,
      worstOffenders: [] as Array<{
        knowledgeBaseId: string;
        name: string;
        memoryCountDelta: number;
        totalCharsDelta: number;
      }>,
    };

    const page = await ctx.runQuery(
      internal.crystal.kbCounterReconcile.listKnowledgeBaseIdsPage,
      { cursor: args.cursor, batchSize }
    );

    const now = Date.now();

    for (const knowledgeBaseId of page.ids) {
      const meta = await ctx.runQuery(
        internal.crystal.kbCounterReconcile.getKnowledgeBaseMetaInternal,
        { knowledgeBaseId }
      );
      if (!meta) continue;

      const { trueMemoryCount, trueTotalChars } = await computeKnowledgeBaseTotalsViaActions(
        ctx,
        knowledgeBaseId,
        meta.userId,
        200
      );

      acc.kbsScanned += 1;

      const memoryCountDelta = meta.storedMemoryCount - trueMemoryCount;
      const totalCharsDelta = meta.storedTotalChars - trueTotalChars;
      const drifted = memoryCountDelta !== 0 || totalCharsDelta !== 0;
      if (!drifted) continue;

      acc.kbsDrifted += 1;
      acc.memoryCountDeltaSum += memoryCountDelta;
      acc.totalCharsDeltaSum += totalCharsDelta;

      // Keep top 20 worst offenders by absolute memoryCountDelta.
      acc.worstOffenders.push({
        knowledgeBaseId: String(meta.knowledgeBaseId),
        name: meta.name,
        memoryCountDelta,
        totalCharsDelta,
      });
      acc.worstOffenders.sort(
        (a, b) => Math.abs(b.memoryCountDelta) - Math.abs(a.memoryCountDelta)
      );
      if (acc.worstOffenders.length > 20) {
        acc.worstOffenders.length = 20;
      }

      if (args.applyMode === "apply") {
        const result = await ctx.runMutation(
          internal.crystal.kbCounterReconcile.reconcileKnowledgeBaseInternal,
          {
            knowledgeBaseId,
            trueMemoryCount,
            trueTotalChars,
            updatedAt: now,
          }
        );
        if (result.patched) {
          acc.kbsPatched += 1;
        }
      }
    }

    metric("mc.metric.kb-reconcile-progress", {
      applyMode: args.applyMode,
      kbsScanned: acc.kbsScanned,
      kbsDrifted: acc.kbsDrifted,
      kbsPatched: acc.kbsPatched,
      isDone: page.isDone ? 1 : 0,
    });

    if (!page.isDone) {
      // Recurse synchronously so a single `convex run` call returns the full
      // report. For large corpora, switch this to scheduler.runAfter() and
      // accumulate via a state row. The self-ref bypass mirrors the pattern
      // used by kbPeerScopeBackfill.
      return ctx.runAction(reconcileAllSelfRef, {
        applyMode: args.applyMode,
        cursor: page.continueCursor,
        batchSize,
        accumulator: acc,
      });
    }

    return {
      isDone: true,
      kbsScanned: acc.kbsScanned,
      kbsDrifted: acc.kbsDrifted,
      kbsPatched: acc.kbsPatched,
      memoryCountDeltaSum: acc.memoryCountDeltaSum,
      totalCharsDeltaSum: acc.totalCharsDeltaSum,
      worstOffenders: acc.worstOffenders,
    };
  },
});
