/** Operator-only direct gates for the v0.9.0 vector cutover. */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { inlineMemoryVectorsRetired, assertMemoryVector, MEMORY_VECTOR_DIMENSIONS, MEMORY_VECTOR_MODEL } from "./memoryVectors";
import {
  classifyParityQuery,
  dedupeIds,
  emptyCounts,
  exactCosine,
  PARITY_DROP_REASONS,
  PARITY_MAX_LIMIT,
  PARITY_OVERFETCH,
  parityVerdict,
  type ParityClass,
  type ParityDropReason,
  type ParityGapReason,
  type ParityQueryResult,
} from "./memoryVectorParity";

const KEEP_WARM_SCOPE = "__memory_crystal_vector_keep_warm__";
const KEEP_WARM_VECTOR = Array(MEMORY_VECTOR_DIMENSIONS).fill(0);

/**
 * Touch the LTM vector index recall reads, without returning matching
 * documents. Only the active read-mode index is warmed: warming the other one
 * filled the searchlight caches with segments recall never reads and pushed
 * out the ones it does (ILL-441).
 */
export const keepMemoryVectorIndexesWarm = internalAction({
  args: {},
  handler: async (ctx) => {
    const side = process.env.CRYSTAL_MEMORY_VECTOR_READ_MODE === "side";
    await ctx.vectorSearch((side ? "crystalMemoryEmbeddings" : "crystalMemories") as any, "by_embedding" as any, {
      vector: KEEP_WARM_VECTOR,
      limit: 1,
      filter: (q: any) => q.eq("userId", KEEP_WARM_SCOPE),
    });
    return { inlineRows: 0, sideRows: 0 };
  },
});

export function orderedVectorIdsMatch(oldIds: string[], sideIds: string[]): boolean {
  return oldIds.length === sideIds.length && oldIds.every((id, index) => id === sideIds[index]);
}

export function vectorsExactlyMatch(oldVector: number[], sideVector: number[]): boolean {
  return oldVector.length === sideVector.length && oldVector.every((value, index) => value === sideVector[index]);
}

export function sideMetadataMatchesMemory(
  memory: { userId: string; knowledgeBaseId?: unknown },
  side: { userId?: string; knowledgeBaseId?: unknown; conversationUserId?: string; model: string; dimensions: number },
): boolean {
  return side.userId === memory.userId &&
    (side.knowledgeBaseId ?? null) === (memory.knowledgeBaseId ?? null) &&
    (process.env.CRYSTAL_SCOPED_VECTORS_READY !== "1" || side.conversationUserId === (memory.knowledgeBaseId ? undefined : memory.userId)) &&
    side.model === MEMORY_VECTOR_MODEL &&
    side.dimensions === MEMORY_VECTOR_DIMENSIONS;
}

type SideRepairCounts = {
  scanned: number;
  archived: number;
  orphans: number;
  emptySentinels: number;
  activePreserved: number;
  duplicatesNormalized: number;
  blockers: number;
  deleted: number;
};

export const scanStaleSideRowsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), pageSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("crystalMemoryEmbeddings").paginate({
      cursor: args.cursor,
      numItems: Math.min(Math.max(args.pageSize ?? 25, 1), 25),
    });
    return {
      scanned: page.page.length,
      sideIds: page.page.map((side) => side._id),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Final-schema repair: preserve one valid active row; never guess divergence. */
export const repairSideRowsPage = internalMutation({
  args: {
    sideIds: v.array(v.id("crystalMemoryEmbeddings")),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const seen = new Set<string>();
    const counts = {
      archived: 0, orphans: 0, emptySentinels: 0, activePreserved: 0,
      duplicatesNormalized: 0, blockers: 0, deleted: 0,
    };
    const blockerSamples: string[] = [];
    const noteBlocker = (memoryId: unknown, reason: string) => {
      counts.blockers += 1;
      if (blockerSamples.length < 20) blockerSamples.push(`${String(memoryId)}:${reason}`);
    };
    const removeRows = async (rows: any[]) => {
      if (args.dryRun) return;
      for (const row of rows) {
        await ctx.db.delete(row._id);
        counts.deleted += 1;
      }
    };
    for (const sideId of args.sideIds.slice(0, 25)) {
      const side = await ctx.db.get(sideId);
      if (!side) continue;
      const memoryKey = String(side.memoryId);
      if (seen.has(memoryKey)) continue;
      seen.add(memoryKey);
      const group = await ctx.db.query("crystalMemoryEmbeddings")
        .withIndex("by_memoryId", (q) => q.eq("memoryId", side.memoryId)).take(26);
      if (group.length > 25) {
        noteBlocker(side.memoryId, "more_than_25_duplicates");
        continue;
      }
      const memory = await ctx.db.get(side.memoryId);
      if (!memory) {
        counts.orphans += group.length;
        await removeRows(group);
        continue;
      }
      if (memory.archived) {
        counts.archived += group.length;
        await removeRows(group);
        continue;
      }
      if (memory.embeddingSource === "none") {
        counts.emptySentinels += group.length;
        await removeRows(group);
        continue;
      }
      const allValid = group.every((row) => {
        try { assertMemoryVector(row.embedding); } catch { return false; }
        return sideMetadataMatchesMemory(memory, row);
      });
      if (!allValid) {
        noteBlocker(memory._id, "invalid_or_misscoped_side_row");
        continue;
      }
      const authoritative = group[0]?.embedding;
      if (!authoritative || !group.every((row) => vectorsExactlyMatch(authoritative, row.embedding))) {
        noteBlocker(memory._id, "divergent_side_payload");
        continue;
      }
      counts.activePreserved += 1;
      const redundant = group.slice(1);
      counts.duplicatesNormalized += redundant.length;
      await removeRows(redundant);
    }
    return { ...counts, blockerSamples };
  },
});

/** Bounded repair retained after cutover for stale-row operational recovery. */
export const repairStaleSideRows = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    maxPages: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let cursor: string | null = args.cursor ?? null;
    const totals: SideRepairCounts = {
      scanned: 0, archived: 0, orphans: 0, emptySentinels: 0,
      activePreserved: 0, duplicatesNormalized: 0, blockers: 0, deleted: 0,
    };
    const blockerSamples: string[] = [];
    const blockedMemoryIds = new Set<string>();
    const dryRun = args.dryRun ?? true;
    const maxPages = Math.min(Math.max(args.maxPages ?? 1_000, 1), 100_000);
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page: any = await ctx.runQuery(
        (internal as any).crystal.memoryVectorAudit.scanStaleSideRowsPage,
        { cursor, pageSize: args.pageSize },
      );
      totals.scanned += page.scanned;
      if (page.sideIds.length > 0) {
        const applied: any = await ctx.runMutation(
          (internal as any).crystal.memoryVectorAudit.repairSideRowsPage,
          { sideIds: page.sideIds, dryRun },
        );
        for (const key of ["archived", "orphans", "emptySentinels", "activePreserved", "duplicatesNormalized", "deleted"] as const) {
          totals[key] += applied[key];
        }
        for (const sample of applied.blockerSamples) {
          const memoryId = sample.split(":", 1)[0];
          blockedMemoryIds.add(memoryId);
          if (blockerSamples.length < 20 && !blockerSamples.includes(sample)) blockerSamples.push(sample);
        }
        totals.blockers = blockedMemoryIds.size;
      }
      if (page.isDone) return {
        ...totals, blockerSamples, ok: totals.blockers === 0,
        dryRun, isDone: true, continueCursor: page.continueCursor,
      };
      // Cursors are index positions that survive deletes, so one pass suffices.
      const nextCursor = page.continueCursor;
      if (nextCursor !== null && nextCursor === cursor) {
        throw new Error("stale side-row repair pagination did not advance");
      }
      cursor = nextCursor;
    }
    return { ...totals, blockerSamples, ok: false, dryRun, isDone: false, continueCursor: cursor };
  },
});

export const auditSidePage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), pageSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("crystalMemoryEmbeddings").paginate({
      cursor: args.cursor,
      numItems: Math.min(Math.max(args.pageSize ?? 25, 1), 25),
    });
    const counts = { rows: 0, duplicates: 0, orphans: 0, archivedRows: 0, missingOwner: 0, ownerMismatch: 0, kbMismatch: 0, modelMismatch: 0, dimensionMismatch: 0 };
    for (const side of page.page) {
      counts.rows += 1;
      const siblings = await ctx.db.query("crystalMemoryEmbeddings")
        .withIndex("by_memoryId", (q) => q.eq("memoryId", side.memoryId)).take(2);
      if (siblings.length > 1) counts.duplicates += 1;
      const memory = await ctx.db.get(side.memoryId);
      if (!memory) { counts.orphans += 1; continue; }
      if (memory.archived) counts.archivedRows += 1;
      if (!side.userId) counts.missingOwner += 1;
      else if (side.userId !== memory.userId) counts.ownerMismatch += 1;
      if ((side.knowledgeBaseId ?? null) !== (memory.knowledgeBaseId ?? null)) counts.kbMismatch += 1;
      if (side.model !== MEMORY_VECTOR_MODEL) counts.modelMismatch += 1;
      if (side.dimensions !== MEMORY_VECTOR_DIMENSIONS || side.embedding.length !== MEMORY_VECTOR_DIMENSIONS || side.embedding.some((n) => !Number.isFinite(n))) counts.dimensionMismatch += 1;
    }
    return { ...counts, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const auditSideTable = internalAction({
  args: { pageSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let cursor: string | null = null;
    const totals: any = { rows: 0, duplicates: 0, orphans: 0, archivedRows: 0, missingOwner: 0, ownerMismatch: 0, kbMismatch: 0, modelMismatch: 0, dimensionMismatch: 0 };
    for (let pageNumber = 0; pageNumber < 100_000; pageNumber += 1) {
      const page: any = await ctx.runQuery(internal.crystal.memoryVectorAudit.auditSidePage, { cursor, pageSize: args.pageSize });
      for (const key of Object.keys(totals)) totals[key] += page[key];
      if (page.isDone) return { ...totals, ok: Object.entries(totals).every(([key, value]) => key === "rows" || value === 0) };
      if (!page.continueCursor || page.continueCursor === cursor) {
        throw new Error("vector audit pagination did not advance");
      }
      cursor = page.continueCursor;
    }
    throw new Error("vector audit exceeded page safety bound");
  },
});

// At most three 1-MiB memory documents plus nine 1-MiB side reads:
// 12 MiB worst case per transaction, leaving 4 MiB below Convex's read limit.
export const PARITY_HYDRATION_BATCH_SIZE = 3;
export const PARITY_HYDRATION_MAX_READ_BYTES = 12 * 1024 * 1024;
export const PARITY_HYDRATION_MAX_IN_FLIGHT = 8;
const PARITY_SAMPLE_PAGE_SIZE = PARITY_HYDRATION_BATCH_SIZE;
const PARITY_SAMPLE_MAX_PAGES_PER_DIRECTION = Math.ceil(2500 / PARITY_SAMPLE_PAGE_SIZE);

/** Internal bounded source qualification; vectors and IDs never leave the audit action. */
export const sampleParityPage = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    direction: v.union(v.literal("asc"), v.literal("desc")),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemoryEmbeddings")
      .order(args.direction)
      .paginate({ cursor: args.cursor, numItems: PARITY_SAMPLE_PAGE_SIZE });
    const queries: Array<{ memoryId: string; userId: string; vector: number[] }> = [];
    for (const side of page.page) {
      const memory = await ctx.db.get(side.memoryId);
      if (!memory || memory.archived || memory.embeddingSource === "none") continue;
      if (side.userId !== memory.userId || side.model !== MEMORY_VECTOR_MODEL || side.dimensions !== MEMORY_VECTOR_DIMENSIONS) continue;
      try {
        assertMemoryVector(side.embedding);
      } catch {
        continue;
      }
      const group = await ctx.db
        .query("crystalMemoryEmbeddings")
        .withIndex("by_memoryId", (q) => q.eq("memoryId", side.memoryId))
        .take(2);
      if (group.length !== 1 || group[0]._id !== side._id) continue;
      queries.push({ memoryId: String(memory._id), userId: memory.userId, vector: side.embedding });
    }
    return { queries, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

type ParityDropCounts = Record<ParityDropReason, number>;
type ParityShortCounts = { hydration: number; index: number };
type ParityQuery = { userId: string; vector: number[]; limit?: number; selfMemoryId?: string };

/**
 * Action-driven hydration batch (A5), bounded even for malformed 1-MiB side
 * documents: per raw hit, one memory, one raw side row and two side rows from
 * the duplicate check. Three hits cost at most 12,582,912 bytes (12 MiB).
 * No pagination here. Return per-memory validation gaps so the action can
 * deduplicate and select the final union after global hydration/truncation.
 */
export const resolveParityHits = internalQuery({
  args: {
    userId: v.string(),
    limit: v.number(),
    queryVector: v.array(v.float64()),
    inlineMemoryIds: v.array(v.id("crystalMemories")),
    sideIds: v.array(v.id("crystalMemoryEmbeddings")),
  },
  handler: async (ctx, args) => {
    if (args.inlineMemoryIds.length + args.sideIds.length > PARITY_HYDRATION_BATCH_SIZE) {
      throw new Error("parity hydration exceeds the raw hit bound");
    }
    assertMemoryVector(args.queryVector);
    const memories = new Map<string, any>();
    const loadMemory = async (memoryId: any) => {
      const key = String(memoryId);
      if (!memories.has(key)) memories.set(key, await ctx.db.get(memoryId));
      return memories.get(key);
    };
    const dropped: { inline: ParityDropCounts; side: ParityDropCounts } = {
      inline: emptyCounts(PARITY_DROP_REASONS),
      side: emptyCounts(PARITY_DROP_REASONS),
    };
    const inlineHydrated: string[] = [];
    for (const memoryId of args.inlineMemoryIds) {
      const memory = await loadMemory(memoryId);
      if (!memory) dropped.inline.missing_memory += 1;
      else if (memory.archived) dropped.inline.archived += 1;
      else if (memory.userId !== args.userId) dropped.inline.owner += 1;
      else inlineHydrated.push(String(memory._id));
    }
    const sideHydrated: string[] = [];
    for (const sideId of args.sideIds) {
      const side = await ctx.db.get(sideId);
      if (!side) { dropped.side.missing_side += 1; continue; }
      const memory = await loadMemory(side.memoryId);
      if (!memory) dropped.side.missing_memory += 1;
      else if (memory.archived) dropped.side.archived += 1;
      // Side metadata is never the authority: the memory row's owner decides.
      else if (side.userId !== args.userId || memory.userId !== args.userId) dropped.side.owner += 1;
      else sideHydrated.push(String(memory._id));
    }
    const inlineIds = dedupeIds(inlineHydrated);
    const sideIds = dedupeIds(sideHydrated);

    const scores: Array<{ memoryId: string; score: number }> = [];
    const gaps: Array<{ memoryId: string; reason: ParityGapReason }> = [];
    for (const key of dedupeIds([...inlineIds, ...sideIds])) {
      const gap = (reason: ParityGapReason) => gaps.push({ memoryId: key, reason });
      const memoryId = key as Id<"crystalMemories">;
      const rows = await ctx.db.query("crystalMemoryEmbeddings")
        .withIndex("by_memoryId", (q) => q.eq("memoryId", memoryId)).take(2);
      if (rows.length === 0) { gap("missing_side"); continue; }
      if (rows.length > 1) { gap("duplicate_side"); continue; }
      const side = rows[0];
      const memory = await loadMemory(memoryId);
      if (!memory) { gap("missing_memory"); continue; }
      if (memory.archived) { gap("archived_memory"); continue; }
      if (memory.userId !== args.userId) { gap("owner"); continue; }
      let validSide = sideMetadataMatchesMemory(memory, side);
      try { assertMemoryVector(side.embedding); } catch { validSide = false; }
      if (!validSide) { gap("invalid_side"); continue; }
      if (!(inlineMemoryVectorsRetired() && memory.embedding === undefined)) {
        if (!Array.isArray(memory.embedding)) { gap("missing_inline"); continue; }
        if (!vectorsExactlyMatch(memory.embedding, side.embedding)) { gap("vector_drift"); continue; }
      }
      scores.push({ memoryId: key, score: exactCosine(args.queryVector, side.embedding) });
    }
    return { inlineIds, sideIds, dropped, scores, gaps };
  },
});

type ParityComparison = {
  code: "ok" | "inline_search_failed" | "side_search_failed";
  checked: number;
  results: ParityQueryResult[];
  legacyMismatches: Array<{ index: number; oldIds: string[]; sideIds: string[]; class: ParityClass }>;
  hydrationDropped: { inline: ParityDropCounts; side: ParityDropCounts };
  inlineShort: ParityShortCounts;
  sideShort: ParityShortCounts;
  error?: string;
};

async function compareTopK(ctx: any, queries: ParityQuery[]): Promise<ParityComparison> {
  const results: ParityQueryResult[] = [];
  const legacyMismatches: ParityComparison["legacyMismatches"] = [];
  const hydrationDropped = { inline: emptyCounts(PARITY_DROP_REASONS), side: emptyCounts(PARITY_DROP_REASONS) };
  const inlineShort: ParityShortCounts = { hydration: 0, index: 0 };
  const sideShort: ParityShortCounts = { hydration: 0, index: 0 };
  const partial = (code: ParityComparison["code"], checked: number, error?: string): ParityComparison => ({
    code, checked, results, legacyMismatches, hydrationDropped, inlineShort, sideShort, error,
  });
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    if (!query.userId.trim()) throw new Error(`parity query ${index} requires a userId`);
    assertMemoryVector(query.vector);
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 10), 1), PARITY_MAX_LIMIT);
    const rawLimit = limit + PARITY_OVERFETCH;
    // Always compare the physical inline index with the physical side index,
    // independently of the environment-selected normal recall path. Convex
    // vector filters support one equality, not chained .eq calls.
    const [inlineSearch, sideSearch] = await Promise.allSettled([
      Promise.resolve().then(() => ctx.vectorSearch("crystalMemories" as any, "by_embedding" as any, {
        vector: query.vector, limit: rawLimit, filter: (q: any) => q.eq("userId", query.userId),
      })),
      Promise.resolve().then(() => ctx.vectorSearch("crystalMemoryEmbeddings" as any, "by_embedding" as any, {
        vector: query.vector, limit: rawLimit, filter: (q: any) => q.eq("userId", query.userId),
      })),
    ]);
    if (inlineSearch.status === "rejected") {
      // A transient failure or an invalid filter is not evidence that the
      // index was removed. All failures still keep the cutover gate closed.
      return partial("inline_search_failed", index, String(inlineSearch.reason));
    }
    if (sideSearch.status === "rejected") {
      return partial("side_search_failed", index, String(sideSearch.reason));
    }
    const inlineRaw: any[] = inlineSearch.value;
    const sideRaw: any[] = sideSearch.value;
    const resolved = {
      inlineIds: [] as string[], sideIds: [] as string[],
      scores: [] as Array<{ memoryId: string; score: number }>,
      gaps: [] as Array<{ memoryId: string; reason: ParityGapReason }>,
      dropped: { inline: emptyCounts(PARITY_DROP_REASONS), side: emptyCounts(PARITY_DROP_REASONS) },
    };
    // Preserve each index's order across batches; truncate only after every
    // raw hit has been hydrated and every drop accounted for.
    const raw = [
      ...inlineRaw.slice(0, rawLimit).map((hit: any) => ({ inline: true, id: hit._id })),
      ...sideRaw.slice(0, rawLimit).map((hit: any) => ({ inline: false, id: hit._id })),
    ];
    const batches: any[][] = [];
    for (let offset = 0; offset < raw.length; offset += PARITY_HYDRATION_BATCH_SIZE) {
      batches.push(raw.slice(offset, offset + PARITY_HYDRATION_BATCH_SIZE));
    }
    for (let offset = 0; offset < batches.length; offset += PARITY_HYDRATION_MAX_IN_FLIGHT) {
      const pages = await Promise.all(batches.slice(offset, offset + PARITY_HYDRATION_MAX_IN_FLIGHT).map((batch) =>
        ctx.runQuery(internal.crystal.memoryVectorAudit.resolveParityHits, {
          userId: query.userId, limit, queryVector: query.vector,
          inlineMemoryIds: batch.filter((hit) => hit.inline).map((hit) => hit.id),
          sideIds: batch.filter((hit) => !hit.inline).map((hit) => hit.id),
        })
      ));
      // Promise.all retains input order, so each index, gap, and score list
      // has the same aggregation order as the bounded serial implementation.
      for (const page of pages) {
        resolved.inlineIds.push(...page.inlineIds);
        resolved.sideIds.push(...page.sideIds);
        resolved.scores.push(...page.scores);
        resolved.gaps.push(...page.gaps);
        for (const side of ["inline", "side"] as const) {
          for (const reason of PARITY_DROP_REASONS) resolved.dropped[side][reason] += page.dropped[side][reason];
        }
      }
    }
    resolved.inlineIds = dedupeIds(resolved.inlineIds).slice(0, limit);
    resolved.sideIds = dedupeIds(resolved.sideIds).slice(0, limit);
    const union = new Set([...resolved.inlineIds, ...resolved.sideIds]);
    const uniqueGaps = new Map(resolved.gaps.filter((gap) => union.has(gap.memoryId))
      .map((gap) => [`${gap.memoryId}:${gap.reason}`, gap.reason]));
    const gapReasons: ParityGapReason[] = [...uniqueGaps.values()];
    for (const sideName of ["inline", "side"] as const) {
      for (const reason of PARITY_DROP_REASONS) {
        const count = resolved.dropped[sideName][reason];
        hydrationDropped[sideName][reason] += count;
        if (reason !== "archived") for (let n = 0; n < count; n += 1) gapReasons.push(reason);
      }
    }
    if (resolved.inlineIds.length < limit) inlineShort[inlineRaw.length < limit ? "index" : "hydration"] += 1;
    if (resolved.sideIds.length < limit) sideShort[sideRaw.length < limit ? "index" : "hydration"] += 1;
    const result = classifyParityQuery({
      limit,
      inlineIds: resolved.inlineIds,
      sideIds: resolved.sideIds,
      scores: Object.fromEntries(resolved.scores.map((entry: { memoryId: string; score: number }) => [entry.memoryId, entry.score])),
      selfMemoryId: query.selfMemoryId,
      gapReasons,
    });
    results.push(result);
    if (!result.legacyMatched && legacyMismatches.length < 20) {
      legacyMismatches.push({ index, oldIds: resolved.inlineIds, sideIds: resolved.sideIds, class: result.class });
    }
  }
  return partial("ok", queries.length);
}

/** Fields carried from the old strict ordered-equality gate; they never decide. */
const PARITY_INFORMATIONAL_FIELDS = ["legacyMatched", "mismatchCount", "mismatches"] as const;

function parityReport(comparison: ParityComparison) {
  const verdict = parityVerdict(comparison.results);
  return {
    ...verdict,
    hydrationDropped: comparison.hydrationDropped,
    inlineShort: comparison.inlineShort,
    sideShort: comparison.sideShort,
    // Sampled tripwire only: auditSideTable, the active-count equality check
    // and auditInlineEmbeddingsRemoved remain the ILL-238 coverage gates.
    coverageScope: "sampled_tripwire" as const,
    informational: [...PARITY_INFORMATIONAL_FIELDS],
  };
}

export const verifyTopKParity = internalAction({
  args: {
    queries: v.array(v.object({ userId: v.string(), vector: v.array(v.float64()), limit: v.optional(v.number()) })),
  },
  handler: async (ctx: any, args) => {
    if (inlineMemoryVectorsRetired()) return { ok: false, retired: true, code: "inline_vectors_retired", checked: 0 };
    if (args.queries.length < 100) throw new Error("parity gate requires at least 100 representative queries");
    const comparison = await compareTopK(ctx, args.queries);
    if (comparison.code !== "ok") {
      return { ok: false, code: comparison.code, checked: comparison.checked, error: comparison.error };
    }
    return {
      ...parityReport(comparison),
      mismatchCount: comparison.checked - comparison.results.filter((result) => result.legacyMatched).length,
      mismatches: comparison.legacyMismatches,
    };
  },
});

export const verifyTopKParitySample = internalAction({
  args: {
    queries: v.optional(v.number()),
    perOwnerMax: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx: any, args) => {
    if (inlineMemoryVectorsRetired()) return { ok: false, retired: true, code: "inline_vectors_retired", checked: 0 };
    const requested = args.queries ?? 120;
    const perOwnerMax = args.perOwnerMax ?? 10;
    const limit = args.limit ?? 10;
    if (!Number.isInteger(requested) || requested < 100 || requested > 500)
      throw new Error("queries must be an integer in 100..500");
    if (!Number.isInteger(perOwnerMax) || perOwnerMax < 1 || perOwnerMax > 50)
      throw new Error("perOwnerMax must be an integer in 1..50");
    if (!Number.isInteger(limit) || limit < 1 || limit > PARITY_MAX_LIMIT)
      throw new Error(`limit must be an integer in 1..${PARITY_MAX_LIMIT}`);

    const cursors: Record<"asc" | "desc", string | null> = { asc: null, desc: null };
    const done: Record<"asc" | "desc", boolean> = { asc: false, desc: false };
    const capped: Record<"asc" | "desc", boolean> = { asc: false, desc: false };
    const pages: Record<"asc" | "desc", number> = { asc: 0, desc: 0 };
    const owners = new Map<string, number>();
    const seen = new Set<string>();
    const selected: Array<{ userId: string; vector: number[]; limit: number; selfMemoryId: string }> = [];
    const addPage = (direction: "asc" | "desc", page: any) => {
      pages[direction] += 1;
      for (const item of page.queries) {
        if (selected.length >= requested) break;
        if (seen.has(item.memoryId)) continue;
        seen.add(item.memoryId);
        const count = owners.get(item.userId) ?? 0;
        if (count >= perOwnerMax) continue;
        owners.set(item.userId, count + 1);
        selected.push({ userId: item.userId, vector: item.vector, limit, selfMemoryId: item.memoryId });
      }
      cursors[direction] = page.continueCursor;
      capped[direction] = !page.isDone && pages[direction] >= PARITY_SAMPLE_MAX_PAGES_PER_DIRECTION;
      done[direction] = page.isDone || capped[direction];
    };
    const empty = (code: string) => ({
      ok: false, code, sampled: selected.length, owners: owners.size,
      checked: 0, legacyMatched: 0, mismatchCount: 0, mismatches: [], informational: [...PARITY_INFORMATIONAL_FIELDS],
    });

    try {
      // Alternate bounded pages so both ends contribute before either end can
      // dominate the sample. At most 100 * 25 rows are visited per direction.
      while (selected.length < requested && (!done.asc || !done.desc)) {
        for (const direction of ["asc", "desc"] as const) {
          if (selected.length >= requested) break;
          if (done[direction]) continue;
          const page = await ctx.runQuery(internal.crystal.memoryVectorAudit.sampleParityPage, {
            cursor: cursors[direction], direction,
          });
          addPage(direction, page);
        }
      }
      if (selected.length < 100) return empty(capped.asc || capped.desc ? "sample_limit_reached" : "insufficient_sample");
      const comparison = await compareTopK(ctx, selected);
      if (comparison.code !== "ok") return { ...empty(comparison.code), checked: comparison.checked };
      // Aggregates only: the sampled action never returns IDs.
      const mismatches = comparison.legacyMismatches.map(({ index, oldIds, sideIds }) => {
        const sideSet = new Set(sideIds);
        return {
          index,
          inlineCount: oldIds.length,
          sideCount: sideIds.length,
          overlap: oldIds.reduce((count, id) => count + Number(sideSet.has(id)), 0),
        };
      });
      const report = parityReport(comparison);
      const ok = report.ok && comparison.checked === selected.length;
      return {
        ...report,
        ok,
        sampled: selected.length,
        owners: owners.size,
        mismatchCount: comparison.checked - report.legacyMatched,
        mismatches,
      };
    } catch {
      return empty("sample_failed");
    }
  },
});
