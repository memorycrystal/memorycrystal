// ILL-10 / ILL-285 — STM/LTM duplicate audit + archive-first cleanup
// (single-account pilot) plus keep-if-strong fluff loner archive.
//
// Internal-only incident/maintenance tooling in the leakAudit.ts mold: every
// function here is internalQuery/internalMutation/internalAction, invoked via
// `npx convex run`, and never exposed to HTTP/MCP/plugin surfaces.
//
// Flow:
//   1. auditLtmDuplicates / auditLtmFluff / auditStmBloat — strictly
//      read-only, repeatable. Produce duplicate clusters (exact +
//      near-duplicate), fluff loners, and STM bloat candidates.
//   2. Operator reviews the report and approves specific clusters/messages.
//   3. cleanupLtmDuplicateClusters / archiveLtmFluff /
//      queueStmBloatForEarlyRetirement — refuse to run without the explicit
//      approved allowlist (the approval gate is structural, not procedural).
//      LTM cleanup is archive-first (reversible: unarchive + clear
//      supersededByMemoryId + re-embed). Merge losers also drop their
//      embedding so they leave crystalMemories.by_embedding — archivedPurge
//      never hard-deletes non-sensory superseded predecessors, so a leftover
//      3072-d vector would stay in searchlight RAM forever. STM cleanup only
//      brings expiresAt forward so already-distilled rows drain through the
//      EXISTING expire sweep (plain bounded delete; undistilled rows are
//      never deleted).
//
// Isolation invariant: clustering and cleanup NEVER cross channel scopes.
// Two similar memories in peer-coach:peerA and peer-coach:peerB are
// different clients' data; merging them would recreate the 2026-07-02 leak.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "./crypto";
import { normalizeMemoryContentForHash } from "./contentHash";
import { isTerminallyProcessed } from "./messageRetirement";
import { sanitizeText } from "./leakAudit";
import { archiveMemoryAndSyncCleanupProjection } from "./cleanupProjection";

// Rows carry inline 3072-float embeddings (~24KB each), so page sizes are kept
// small to stay well under the 8MiB/16k-doc query limits (150 × ~25KB ≈ 3.7MB).
const DEFAULT_MEMORY_PAGE_SIZE = 150;
const MAX_MEMORY_PAGE_SIZE = 300;
const DEFAULT_MESSAGE_PAGE_SIZE = 400;
const MAX_MESSAGE_PAGE_SIZE = 1000;
const DEFAULT_SIMILARITY_THRESHOLD = 0.95;
const DEFAULT_MAX_VECTOR_SEARCHES = 800;
const MAX_VECTOR_SEARCHES = 4000;
const MAX_NEIGHBOR_SEARCH_IDS = 200;
const VECTOR_TARGET_BATCH = 25;
const NEAR_DUP_NEIGHBORS = 8;
const TRIVIAL_CONTENT_CHARS = 20;
// Cleanup write caps keep each mutation far inside Convex read/write limits.
const MAX_CLUSTERS_PER_CALL = 20;
const MAX_ARCHIVES_PER_CALL = 50;
const MAX_STM_QUEUE_PER_CALL = 200;
const MERGED_TAGS_CAP = 32;
const KEEP_RECALL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DIGEST_TITLE_RE = /^(Lesson|Decision|Reflection summary|Open loop):/i;

const EMBEDDING_BYTES_PER_FLOAT = 8;

type AuditMemoryRow = {
  id: string;
  channel: string | undefined;
  store: string;
  category: string;
  title: string;
  normHash: string;
  bytes: number;
  createdAt: number;
  lastAccessedAt: number;
  lastRecalledAt: number | undefined;
  sourceMessageCount: number;
  contentChars: number;
  strength: number;
  hasEmbedding: boolean;
};

export type KeepIfStrongInput = {
  knowledgeBaseId?: unknown;
  coreTier?: boolean;
  tags: string[];
  strength: number;
  confidence: number;
  lastRecalledAt?: number;
  accessCount: number;
  sourceMessageIds?: unknown[];
  promotedFrom?: unknown;
};

export type HygieneSurvivorRank = {
  strength: number;
  sourceMessageCount: number;
  contentChars: number;
  lastRecalledAt?: number;
  lastAccessedAt: number;
};

// INTENT: code ranked suggested canonicals by strength then lastAccessedAt;
// the issue expects strength, then richest content (sourceMessageIds length,
// then content length), then lastRecalledAt, then lastAccessedAt; writeDedupe
// older-wins is a different rule and stays untouched.
export function compareHygieneSurvivors(a: HygieneSurvivorRank, b: HygieneSurvivorRank): number {
  if (b.strength !== a.strength) return b.strength - a.strength;
  if (b.sourceMessageCount !== a.sourceMessageCount) return b.sourceMessageCount - a.sourceMessageCount;
  if (b.contentChars !== a.contentChars) return b.contentChars - a.contentChars;
  const aRecalled = a.lastRecalledAt ?? 0;
  const bRecalled = b.lastRecalledAt ?? 0;
  if (bRecalled !== aRecalled) return bRecalled - aRecalled;
  return b.lastAccessedAt - a.lastAccessedAt;
}

export function isKeepIfStrong(row: KeepIfStrongInput, now: number): boolean {
  if (row.knowledgeBaseId) return true;
  if (row.coreTier === true) return true;
  if (row.tags.includes("core")) return true;
  if (row.strength >= 0.7) return true;
  if (row.confidence >= 0.85) return true;
  if (row.lastRecalledAt !== undefined && now - row.lastRecalledAt <= KEEP_RECALL_WINDOW_MS) {
    return true;
  }
  if (row.accessCount >= 2) return true;
  if ((row.sourceMessageIds?.length ?? 0) > 0) return true;
  if (row.promotedFrom) return true;
  return false;
}

function normalizeForRestatement(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// INTENT: code treated a title that prefixes or sits inside longer unique
// content as a Session Digest restatement; the issue expects only an obvious
// leftover (title regex or content that restates the title); ADR 0008 leftovers
// are ungrounded Lesson/Decision rows, not every distilled note whose title
// appears in its body.
export function isTitleNearRestatement(title: string, content: string): boolean {
  const normalizedTitle = normalizeForRestatement(title);
  const normalizedContent = normalizeForRestatement(content);
  if (!normalizedTitle || !normalizedContent) return false;
  return normalizedContent === normalizedTitle;
}

export function isSessionDigestLeftover(row: {
  source: string;
  tags: string[];
  title: string;
  content: string;
}): boolean {
  if (row.source !== "inference") return false;
  if (!row.tags.includes("reflection") && !row.tags.includes("distilled")) return false;
  return DIGEST_TITLE_RE.test(row.title) || isTitleNearRestatement(row.title, row.content);
}

export function isLowSignalFluff(row: {
  strength: number;
  confidence: number;
  sourceMessageIds?: unknown[];
  promotedFrom?: unknown;
}): boolean {
  return (
    row.strength < 0.4 &&
    row.confidence < 0.6 &&
    (row.sourceMessageIds?.length ?? 0) === 0 &&
    !row.promotedFrom
  );
}

// INTENT: code had no loner keep/fluff pass; the issue expects unused
// singletons to stay unless they fail every keep-if-strong signal and match
// an obvious Session Digest leftover or low-signal shape; schema already
// carries coreTier, lastRecalledAt, confidence, accessCount, sourceMessageIds,
// and promotedFrom.
export function fluffKindForMemory(
  row: KeepIfStrongInput & { source: string; title: string; content: string },
  now: number,
): "digest" | "low_signal" | null {
  if (isKeepIfStrong(row, now)) return null;
  const recalledRecently =
    row.lastRecalledAt !== undefined && now - row.lastRecalledAt <= KEEP_RECALL_WINDOW_MS;
  if (recalledRecently) return null;
  if (isSessionDigestLeftover(row)) return "digest";
  if (isLowSignalFluff(row)) return "low_signal";
  return null;
}

const approxMemoryBytes = (memory: {
  content: string;
  title: string;
  embedding: number[];
}): number =>
  memory.content.length +
  memory.title.length +
  memory.embedding.length * EMBEDDING_BYTES_PER_FLOAT;

// ── Audit page queries (read-only) ────────────────────────────────────────────

export const listNonKbMemoryHygienePage = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(args.numItems ?? DEFAULT_MEMORY_PAGE_SIZE, 1),
      MAX_MEMORY_PAGE_SIZE,
    );
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .paginate({ cursor: args.cursor ?? null, numItems });

    const rows: AuditMemoryRow[] = [];
    for (const memory of page.page) {
      if (memory.knowledgeBaseId) continue;
      rows.push({
        id: String(memory._id),
        channel: memory.channel,
        store: memory.store,
        category: memory.category,
        // Sanitize AFTER truncation: the 80-char cut can split a surrogate
        // pair, and lone surrogates have crashed Convex return serialization
        // before (leakAudit incident).
        title: sanitizeText(memory.title.slice(0, 80)),
        // Content-only normalized hash (store/category excluded on purpose:
        // the same fact re-extracted as `fact` vs `lesson` is still a dupe).
        normHash: await sha256Hex(normalizeMemoryContentForHash(memory.content)),
        bytes: approxMemoryBytes(memory),
        createdAt: memory.createdAt,
        lastAccessedAt: memory.lastAccessedAt,
        lastRecalledAt: memory.lastRecalledAt,
        sourceMessageCount: memory.sourceMessageIds?.length ?? 0,
        contentChars: memory.content.length,
        strength: memory.strength,
        hasEmbedding: memory.embedding.length > 0,
      });
    }

    return { rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const getMemoryVectorTargets = internalQuery({
  args: { memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, args) => {
    if (args.memoryIds.length > VECTOR_TARGET_BATCH) {
      throw new Error(`getMemoryVectorTargets accepts at most ${VECTOR_TARGET_BATCH} ids per call`);
    }
    const targets: Array<{ id: string; embedding: number[] }> = [];
    for (const memoryId of args.memoryIds) {
      const memory = await ctx.db.get(memoryId);
      if (!memory || memory.archived || memory.knowledgeBaseId) continue;
      if (memory.embedding.length === 0) continue;
      targets.push({ id: String(memory._id), embedding: memory.embedding });
    }
    return targets;
  },
});

const probeEmbeddingIndexReturns = v.object({
  memoryId: v.string(),
  hit: v.boolean(),
  score: v.union(v.number(), v.null()),
  neighborCount: v.number(),
});

// Operator-only HNSW membership check. Search with a captured pre-cleanup
// vector after archive+embedding:[] and confirm the loser ID is gone from
// crystalMemories.by_embedding. Filter is userId only — the live recall
// path does not filter archived, so an archived leftover vector would still
// hit. Never HTTP/MCP.
export const probeMemoryInEmbeddingIndex = internalAction({
  args: {
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  returns: probeEmbeddingIndexReturns,
  handler: async (ctx, args) => {
    if (args.embedding.length === 0) {
      throw new Error("probeMemoryInEmbeddingIndex requires a non-empty embedding");
    }
    const limit = Math.min(Math.max(args.limit ?? 16, 1), 64);
    const hits = await ctx.vectorSearch("crystalMemories", "by_embedding", {
      vector: args.embedding,
      limit,
      filter: (q) => q.eq("userId", args.userId),
    });
    const match = hits.find((hit) => String(hit._id) === String(args.memoryId));
    const rawScore = match?._score;
    return {
      memoryId: String(args.memoryId),
      hit: match !== undefined,
      score: typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null,
      neighborCount: hits.length,
    };
  },
});

const nearDupNeighborHit = v.object({
  queryId: v.string(),
  neighborId: v.string(),
  score: v.number(),
});

// Operator paging primitive: search a slice of query vectors without
// re-scanning every active LTM row. Channel isolation stays with the
// caller (same-channel union + cleanup's hard refuse). Never HTTP/MCP.
export const searchLtmNearDupNeighbors = internalAction({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.id("crystalMemories")),
    similarityThreshold: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    userId: v.string(),
    requested: v.number(),
    searches: v.number(),
    hits: v.array(nearDupNeighborHit),
  }),
  handler: async (ctx, args) => {
    if (args.memoryIds.length === 0) {
      throw new Error("searchLtmNearDupNeighbors requires at least one memoryId");
    }
    if (args.memoryIds.length > MAX_NEIGHBOR_SEARCH_IDS) {
      throw new Error(
        `searchLtmNearDupNeighbors accepts at most ${MAX_NEIGHBOR_SEARCH_IDS} ids per call`,
      );
    }
    const threshold = Math.min(Math.max(args.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD, 0.8), 1);
    const neighborLimit = Math.min(Math.max(args.limit ?? NEAR_DUP_NEIGHBORS, 1), 16);
    const hits: Array<{ queryId: string; neighborId: string; score: number }> = [];
    let searches = 0;

    for (let offset = 0; offset < args.memoryIds.length; offset += VECTOR_TARGET_BATCH) {
      const batch = args.memoryIds.slice(offset, offset + VECTOR_TARGET_BATCH);
      const targets: Array<{ id: string; embedding: number[] }> = await ctx.runQuery(
        internal.crystal.ltmHygiene.getMemoryVectorTargets,
        { memoryIds: batch },
      );
      for (const target of targets) {
        const neighbors = await ctx.vectorSearch("crystalMemories", "by_embedding", {
          vector: target.embedding,
          limit: neighborLimit,
          filter: (q) => q.eq("userId", args.userId),
        });
        searches += 1;
        for (const hit of neighbors) {
          const neighborId = String(hit._id);
          if (neighborId === target.id) continue;
          if (hit._score < threshold) continue;
          hits.push({ queryId: target.id, neighborId, score: hit._score });
        }
      }
    }

    return { userId: args.userId, requested: args.memoryIds.length, searches, hits };
  },
});

// ── LTM duplicate audit ───────────────────────────────────────────────────────

type DuplicateCluster = {
  clusterId: string;
  kind: "exact" | "near";
  channel: string | undefined;
  memberCount: number;
  members: Array<{
    id: string;
    title: string;
    createdAt: number;
    strength: number;
    bytes: number;
  }>;
  suggestedCanonicalId: string;
  suggestedArchiveIds: string[];
  minSimilarity: number;
  reclaimableBytes: number;
};

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export const auditLtmDuplicates = internalAction({
  args: {
    userId: v.string(),
    similarityThreshold: v.optional(v.number()),
    maxVectorSearches: v.optional(v.number()),
    representativeOffset: v.optional(v.number()),
    pageSize: v.optional(v.number()),
    includeNearDuplicates: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const threshold = Math.min(Math.max(args.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD, 0.8), 1);
    const maxVectorSearches = Math.min(
      Math.max(args.maxVectorSearches ?? DEFAULT_MAX_VECTOR_SEARCHES, 0),
      MAX_VECTOR_SEARCHES,
    );
    const representativeOffset = Math.max(args.representativeOffset ?? 0, 0);
    const includeNear = args.includeNearDuplicates ?? true;

    // Phase 1 — paginated scalar scan of every active non-KB memory.
    const rowsById = new Map<string, AuditMemoryRow>();
    let cursor: string | null = null;
    let rowsScanned = 0;
    for (;;) {
      const page: { rows: AuditMemoryRow[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.crystal.ltmHygiene.listNonKbMemoryHygienePage, {
          userId: args.userId,
          cursor,
          numItems: args.pageSize,
        });
      for (const row of page.rows) rowsById.set(row.id, row);
      rowsScanned += page.rows.length;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    // Phase 2 — exact clusters: same channel scope + same normalized content.
    // Visible, collision-free channel-scope grouping key (JSON encodes the
    // undefined-vs-named distinction without magic sentinel strings).
    const channelKey = (channel: string | undefined) => JSON.stringify(channel ?? null);
    const uf = new UnionFind();
    const exactGroups = new Map<string, string[]>();
    for (const row of rowsById.values()) {
      const key = `${channelKey(row.channel)}|${row.normHash}`;
      const group = exactGroups.get(key) ?? [];
      group.push(row.id);
      exactGroups.set(key, group);
    }
    for (const group of exactGroups.values()) {
      for (let i = 1; i < group.length; i += 1) uf.union(group[0], group[i]);
    }

    // Phase 3 — near-duplicate pass. One vector search per representative
    // (newest first, capped), merging same-channel hits above the threshold.
    // Cross-channel hits are ignored no matter how similar (client isolation).
    const pairSimilarity = new Map<string, number>();
    let vectorSearchesRun = 0;
    let representativesSkipped = 0;
    let representativeTotal = 0;
    if (includeNear && maxVectorSearches > 0) {
      const representatives = [...exactGroups.values()]
        .map((group) => group[0])
        .map((id) => rowsById.get(id)!)
        .filter((row) => row.hasEmbedding)
        .sort((a, b) => b.createdAt - a.createdAt);
      representativeTotal = representatives.length;
      representativesSkipped = Math.max(representatives.length - representativeOffset - maxVectorSearches, 0);
      const capped = representatives.slice(representativeOffset, representativeOffset + maxVectorSearches);

      for (let offset = 0; offset < capped.length; offset += VECTOR_TARGET_BATCH) {
        const batch = capped.slice(offset, offset + VECTOR_TARGET_BATCH);
        const targets: Array<{ id: string; embedding: number[] }> = await ctx.runQuery(
          internal.crystal.ltmHygiene.getMemoryVectorTargets,
          { memoryIds: batch.map((row) => row.id as Id<"crystalMemories">) },
        );
        for (const target of targets) {
          const self = rowsById.get(target.id);
          if (!self) continue;
          const hits = await ctx.vectorSearch("crystalMemories", "by_embedding", {
            vector: target.embedding,
            limit: NEAR_DUP_NEIGHBORS,
            filter: (q) => q.eq("userId", args.userId),
          });
          vectorSearchesRun += 1;
          for (const hit of hits) {
            const hitId = String(hit._id);
            if (hitId === target.id) continue;
            if (hit._score < threshold) continue;
            const other = rowsById.get(hitId);
            // Unknown rows are archived/KB rows the scan excluded — skip them.
            if (!other) continue;
            if (channelKey(other.channel) !== channelKey(self.channel)) continue;
            uf.union(target.id, hitId);
            const pairKey = [target.id, hitId].sort().join("|");
            const existing = pairSimilarity.get(pairKey);
            if (existing === undefined || hit._score < existing) {
              pairSimilarity.set(pairKey, hit._score);
            }
          }
        }
      }
    }

    // Phase 4 — assemble clusters and suggestions.
    const clustersByRoot = new Map<string, string[]>();
    for (const id of rowsById.keys()) {
      const root = uf.find(id);
      const members = clustersByRoot.get(root) ?? [];
      members.push(id);
      clustersByRoot.set(root, members);
    }

    const exactPairKeys = new Set<string>();
    for (const group of exactGroups.values()) {
      for (let i = 1; i < group.length; i += 1) {
        exactPairKeys.add([group[0], group[i]].sort().join("|"));
      }
    }

    const clusters: DuplicateCluster[] = [];
    let duplicateRows = 0;
    let reclaimableBytes = 0;
    for (const memberIds of clustersByRoot.values()) {
      if (memberIds.length < 2) continue;
      const members = memberIds
        .map((id) => rowsById.get(id)!)
        .sort(compareHygieneSurvivors);
      const canonical = members[0];
      const losers = members.slice(1);
      const sortedIds = memberIds.slice().sort();
      let minSimilarity = 1;
      let kind: "exact" | "near" = "exact";
      for (let i = 0; i < sortedIds.length; i += 1) {
        for (let j = i + 1; j < sortedIds.length; j += 1) {
          const pairKey = `${sortedIds[i]}|${sortedIds[j]}`;
          if (exactPairKeys.has(pairKey)) continue;
          const similarity = pairSimilarity.get(pairKey);
          if (similarity !== undefined) {
            kind = "near";
            minSimilarity = Math.min(minSimilarity, similarity);
          }
        }
      }
      const clusterBytes = losers.reduce((sum, row) => sum + row.bytes, 0);
      duplicateRows += losers.length;
      reclaimableBytes += clusterBytes;
      clusters.push({
        clusterId: (await sha256Hex(sortedIds.join("|"))).slice(0, 16),
        kind,
        channel: canonical.channel,
        memberCount: members.length,
        members: members.map((row) => ({
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          strength: row.strength,
          bytes: row.bytes,
        })),
        suggestedCanonicalId: canonical.id,
        suggestedArchiveIds: losers.map((row) => row.id),
        minSimilarity,
        reclaimableBytes: clusterBytes,
      });
    }
    clusters.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);

    return {
      userId: args.userId,
      rowsScanned,
      nonKbActiveRows: rowsById.size,
      similarityThreshold: threshold,
      vectorSearchesRun,
      representativeOffset,
      representativeTotal,
      // Non-zero means the near-dup pass was truncated: raise maxVectorSearches
      // or representativeOffset — silence here must not read as full coverage.
      representativesSkippedByCap: representativesSkipped,
      clusterCount: clusters.length,
      duplicateRows,
      reclaimableBytes,
      clusters,
    };
  },
});

// ── STM bloat audit ───────────────────────────────────────────────────────────

export const listStmHygienePage = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(args.numItems ?? DEFAULT_MESSAGE_PAGE_SIZE, 1),
      MAX_MESSAGE_PAGE_SIZE,
    );
    const page = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_time", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor ?? null, numItems });

    return {
      rows: page.page.map((message) => ({
        id: String(message._id),
        role: message.role,
        contentChars: message.content.length,
        trivial: message.content.replace(/\s+/g, " ").trim().length < TRIVIAL_CONTENT_CHARS,
        timestamp: message.timestamp,
        expiresAt: message.expiresAt,
        retiredAt: message.retiredAt,
        ltmExtractedAt: message.ltmExtractedAt,
        ltmExtractionSkippedReason: message.ltmExtractionSkippedReason,
        terminallyProcessed: isTerminallyProcessed(message),
        embeddingBytes: (message.embedding?.length ?? 0) * EMBEDDING_BYTES_PER_FLOAT,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const auditStmBloat = internalAction({
  args: {
    userId: v.string(),
    pageSize: v.optional(v.number()),
    minAgeMs: v.optional(v.number()),
    sampleLimit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const minAgeMs = Math.max(args.minAgeMs ?? 24 * 60 * 60 * 1000, 0);
    const sampleLimit = Math.min(Math.max(args.sampleLimit ?? 200, 0), 2000);
    const now = Date.now();

    let cursor: string | null = null;
    let rowsScanned = 0;
    const totals = {
      activeRows: 0,
      activeBytes: 0,
      alreadyExtracted: 0,
      terminallySkipped: 0,
      trivial: 0,
      earlyRetireEligible: 0,
      earlyRetireBytes: 0,
    };
    const earlyRetireSample: string[] = [];

    for (;;) {
      const page: { rows: any[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(
        internal.crystal.ltmHygiene.listStmHygienePage,
        { userId: args.userId, cursor, numItems: args.pageSize },
      );
      for (const row of page.rows) {
        rowsScanned += 1;
        if (row.retiredAt) continue;
        const bytes = row.contentChars + row.embeddingBytes;
        totals.activeRows += 1;
        totals.activeBytes += bytes;
        if (row.ltmExtractedAt) totals.alreadyExtracted += 1;
        else if (row.terminallyProcessed) totals.terminallySkipped += 1;
        if (row.trivial) totals.trivial += 1;
        // Early-retire candidates: terminally processed (extracted or terminal
        // skip) rows older than the age floor whose TTL hasn't fired yet — pure
        // dead weight the retirement pipeline can drain today. Trivial rows are
        // reported but NOT auto-eligible: retirement extracts-or-skips them.
        const oldEnough = now - row.timestamp >= minAgeMs;
        if (row.terminallyProcessed && oldEnough && row.expiresAt > now) {
          totals.earlyRetireEligible += 1;
          totals.earlyRetireBytes += bytes;
          if (earlyRetireSample.length < sampleLimit) earlyRetireSample.push(row.id);
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    return { userId: args.userId, rowsScanned, minAgeMs, ...totals, earlyRetireSample };
  },
});

// ── Approved cleanup (archive-first, allowlist-gated) ─────────────────────────

export const cleanupLtmDuplicateClusters = internalMutation({
  args: {
    userId: v.string(),
    clusters: v.array(
      v.object({
        canonicalId: v.id("crystalMemories"),
        archiveIds: v.array(v.id("crystalMemories")),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // The approval gate is structural: no allowlist, no writes.
    if (args.clusters.length === 0) {
      throw new Error(
        "cleanupLtmDuplicateClusters requires the operator-approved cluster allowlist from auditLtmDuplicates; refusing to run without one",
      );
    }
    if (args.clusters.length > MAX_CLUSTERS_PER_CALL) {
      throw new Error(`at most ${MAX_CLUSTERS_PER_CALL} clusters per call; split the approved plan`);
    }
    const totalArchives = args.clusters.reduce((sum, c) => sum + c.archiveIds.length, 0);
    if (totalArchives > MAX_ARCHIVES_PER_CALL) {
      throw new Error(`at most ${MAX_ARCHIVES_PER_CALL} archived rows per call; split the approved plan`);
    }

    const now = Date.now();
    let archived = 0;
    for (const cluster of args.clusters) {
      const canonical = await ctx.db.get(cluster.canonicalId);
      if (!canonical) throw new Error(`canonical ${cluster.canonicalId} not found`);
      if (canonical.userId !== args.userId) throw new Error(`canonical ${cluster.canonicalId} belongs to another user; refusing`);
      if (canonical.archived) throw new Error(`canonical ${cluster.canonicalId} is archived; re-run the audit`);
      if (canonical.knowledgeBaseId) throw new Error(`canonical ${cluster.canonicalId} is a KB chunk; KB rows are out of scope`);

      const mergedTags = new Set<string>(canonical.tags);
      let mergedStrength = canonical.strength;
      let mergedLastAccessedAt = canonical.lastAccessedAt;
      let mergedLastRecalledAt = canonical.lastRecalledAt;

      for (const archiveId of cluster.archiveIds) {
        if (archiveId === cluster.canonicalId) {
          throw new Error(`cluster canonical ${cluster.canonicalId} listed in its own archiveIds`);
        }
        const loser = await ctx.db.get(archiveId);
        if (!loser) throw new Error(`memory ${archiveId} not found`);
        if (loser.userId !== args.userId) throw new Error(`memory ${archiveId} belongs to another user; refusing`);
        if (loser.knowledgeBaseId) throw new Error(`memory ${archiveId} is a KB chunk; KB rows are out of scope`);
        if (loser.archived) throw new Error(`memory ${archiveId} is already archived; re-run the audit`);
        // Channel scopes must match EXACTLY (undefined == undefined included).
        // Cross-channel merging is how client data leaks; hard refusal.
        if ((loser.channel ?? null) !== (canonical.channel ?? null)) {
          throw new Error(
            `memory ${archiveId} channel scope does not match canonical ${cluster.canonicalId}; cross-channel merges are forbidden`,
          );
        }

        for (const tag of loser.tags) mergedTags.add(tag);
        mergedStrength = Math.max(mergedStrength, loser.strength);
        mergedLastAccessedAt = Math.max(mergedLastAccessedAt, loser.lastAccessedAt);
        if (loser.lastRecalledAt !== undefined) {
          mergedLastRecalledAt =
            mergedLastRecalledAt === undefined
              ? loser.lastRecalledAt
              : Math.max(mergedLastRecalledAt, loser.lastRecalledAt);
        }

        // INTENT: code archived losers with their 3072-d embedding intact;
        // the issue expects the loser to leave crystalMemories.by_embedding;
        // archivedPurge never deletes non-sensory supersededByMemoryId rows
        // and recall filters userId only, so stripping is the only way those
        // rows stop consuming searchlight RAM. embedding: [] is the in-repo
        // tombstone (KB/import/extraction already write it).
        await archiveMemoryAndSyncCleanupProjection(
          ctx,
          loser,
          now,
          {
            supersededByMemoryId: cluster.canonicalId,
            supersededAt: now,
            embedding: [],
          },
        );
        archived += 1;
      }

      const survivorPatch: {
        tags: string[];
        strength: number;
        lastAccessedAt: number;
        lastRecalledAt?: number;
      } = {
        tags: [...mergedTags].slice(0, MERGED_TAGS_CAP),
        strength: mergedStrength,
        lastAccessedAt: mergedLastAccessedAt,
      };
      if (mergedLastRecalledAt !== undefined) survivorPatch.lastRecalledAt = mergedLastRecalledAt;
      await ctx.db.patch(cluster.canonicalId, survivorPatch);
    }

    return { clustersMerged: args.clusters.length, archived };
  },
});

type FluffAuditRow = {
  id: string;
  channel: string | undefined;
  title: string;
  fluffKind: "digest" | "low_signal";
  bytes: number;
  strength: number;
  confidence: number;
};

export const listNonKbFluffHygienePage = internalQuery({
  args: {
    userId: v.string(),
    now: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(args.numItems ?? DEFAULT_MEMORY_PAGE_SIZE, 1),
      MAX_MEMORY_PAGE_SIZE,
    );
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .paginate({ cursor: args.cursor ?? null, numItems });

    const rows: FluffAuditRow[] = [];
    for (const memory of page.page) {
      if (memory.knowledgeBaseId) continue;
      const kind = fluffKindForMemory(memory, args.now);
      if (!kind) continue;
      rows.push({
        id: String(memory._id),
        channel: memory.channel,
        title: sanitizeText(memory.title.slice(0, 80)),
        fluffKind: kind,
        bytes: approxMemoryBytes(memory),
        strength: memory.strength,
        confidence: memory.confidence,
      });
    }

    return { rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const auditLtmFluff = internalAction({
  args: {
    userId: v.string(),
    pageSize: v.optional(v.number()),
    includeNearDuplicates: v.optional(v.boolean()),
    similarityThreshold: v.optional(v.number()),
    maxVectorSearches: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const now = Date.now();
    const duplicateReport: {
      clusters: Array<{ members: Array<{ id: string }> }>;
    } = await ctx.runAction(internal.crystal.ltmHygiene.auditLtmDuplicates, {
      userId: args.userId,
      includeNearDuplicates: args.includeNearDuplicates,
      similarityThreshold: args.similarityThreshold,
      maxVectorSearches: args.maxVectorSearches,
      pageSize: args.pageSize,
    });
    const clusterMemberIds = new Set<string>();
    for (const cluster of duplicateReport.clusters) {
      for (const member of cluster.members) clusterMemberIds.add(member.id);
    }

    const candidates: FluffAuditRow[] = [];
    let cursor: string | null = null;
    let rowsScanned = 0;
    for (;;) {
      const page: { rows: FluffAuditRow[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.crystal.ltmHygiene.listNonKbFluffHygienePage, {
          userId: args.userId,
          now,
          cursor,
          numItems: args.pageSize,
        });
      rowsScanned += page.rows.length;
      for (const row of page.rows) {
        if (clusterMemberIds.has(row.id)) continue;
        candidates.push(row);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    return {
      userId: args.userId,
      now,
      rowsScanned,
      clusterMemberCount: clusterMemberIds.size,
      candidateCount: candidates.length,
      reclaimableBytes: candidates.reduce((sum, row) => sum + row.bytes, 0),
      clusterMemberIds: [...clusterMemberIds],
      candidates,
    };
  },
});

// INTENT: fluff apply used to paginate every active LTM row inside one
// mutation. Andy's pilot account is ~45k rows; Convex's 4096-read cap
// fails that scan after ~27 pages and nothing archives. Exact-hash peers
// are recomputed in the action via runQuery pages (same as
// auditLtmDuplicates). This write path only touches the allowlist.
export const applyArchiveLtmFluffAllowlist = internalMutation({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.id("crystalMemories")),
    clusterMemberIds: v.array(v.id("crystalMemories")),
  },
  handler: async (ctx, args) => {
    if (args.memoryIds.length === 0) {
      throw new Error(
        "archiveLtmFluff requires the operator-approved fluff allowlist from auditLtmFluff; refusing to run without one",
      );
    }
    if (args.memoryIds.length > MAX_ARCHIVES_PER_CALL) {
      throw new Error(`at most ${MAX_ARCHIVES_PER_CALL} archived rows per call; split the approved plan`);
    }

    const clusterMembers = new Set(args.clusterMemberIds.map((id) => String(id)));
    const now = Date.now();
    const loaded = [];
    for (const memoryId of args.memoryIds) {
      if (clusterMembers.has(String(memoryId))) {
        throw new Error(`memory ${memoryId} belongs to a duplicate cluster; refuse fluff archive`);
      }
      const memory = await ctx.db.get(memoryId);
      if (!memory) throw new Error(`memory ${memoryId} not found`);
      if (memory.userId !== args.userId) {
        throw new Error(`memory ${memoryId} belongs to another user; refusing`);
      }
      if (memory.knowledgeBaseId) {
        throw new Error(`memory ${memoryId} is a KB chunk; KB rows are out of scope`);
      }
      if (memory.archived) {
        throw new Error(`memory ${memoryId} is already archived; re-run the audit`);
      }
      if (!fluffKindForMemory(memory, now)) {
        throw new Error(`memory ${memoryId} is keep-if-strong or not obvious fluff; refusing`);
      }
      loaded.push(memory);
    }

    const wanted = new Map<string, string[]>();
    for (const memory of loaded) {
      const hash = await sha256Hex(normalizeMemoryContentForHash(memory.content));
      const key = `${JSON.stringify(memory.channel ?? null)}|${hash}`;
      const ids = wanted.get(key) ?? [];
      ids.push(String(memory._id));
      wanted.set(key, ids);
    }
    for (const ids of wanted.values()) {
      if (ids.length > 1) {
        throw new Error(`memory ${ids[0]} belongs to a duplicate cluster; refuse fluff archive`);
      }
    }

    let archived = 0;
    for (const memory of loaded) {
      await archiveMemoryAndSyncCleanupProjection(ctx, memory, now, { embedding: [] });
      archived += 1;
    }

    return { archived };
  },
});

export const archiveLtmFluff = internalAction({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.id("crystalMemories")),
    clusterMemberIds: v.optional(v.array(v.id("crystalMemories"))),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ archived: number }> => {
    if (args.memoryIds.length === 0) {
      throw new Error(
        "archiveLtmFluff requires the operator-approved fluff allowlist from auditLtmFluff; refusing to run without one",
      );
    }
    if (args.memoryIds.length > MAX_ARCHIVES_PER_CALL) {
      throw new Error(`at most ${MAX_ARCHIVES_PER_CALL} archived rows per call; split the approved plan`);
    }

    const allowlisted = new Set(args.memoryIds.map((id) => String(id)));
    const clusterMembers = new Set((args.clusterMemberIds ?? []).map((id) => String(id)));
    const channelKey = (channel: string | undefined) => JSON.stringify(channel ?? null);
    const groups = new Map<string, string[]>();
    let cursor: string | null = null;
    for (;;) {
      const page: { rows: AuditMemoryRow[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.crystal.ltmHygiene.listNonKbMemoryHygienePage, {
          userId: args.userId,
          cursor,
          numItems: args.pageSize,
        });
      for (const row of page.rows) {
        const key = `${channelKey(row.channel)}|${row.normHash}`;
        const group = groups.get(key) ?? [];
        group.push(row.id);
        groups.set(key, group);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const id of group) {
        if (allowlisted.has(id)) {
          throw new Error(`memory ${id} belongs to a duplicate cluster; refuse fluff archive`);
        }
      }
    }

    for (const memoryId of args.memoryIds) {
      if (clusterMembers.has(String(memoryId))) {
        throw new Error(`memory ${memoryId} belongs to a duplicate cluster; refuse fluff archive`);
      }
    }

    return await ctx.runMutation(internal.crystal.ltmHygiene.applyArchiveLtmFluffAllowlist, {
      userId: args.userId,
      memoryIds: args.memoryIds,
      clusterMemberIds: [...clusterMembers] as Array<Id<"crystalMemories">>,
    });
  },
});

export const queueStmBloatForEarlyRetirement = internalMutation({
  args: {
    userId: v.string(),
    messageIds: v.array(v.id("crystalMessages")),
  },
  handler: async (ctx, args) => {
    if (args.messageIds.length === 0) {
      throw new Error(
        "queueStmBloatForEarlyRetirement requires the operator-approved message list from auditStmBloat; refusing to run without one",
      );
    }
    if (args.messageIds.length > MAX_STM_QUEUE_PER_CALL) {
      throw new Error(`at most ${MAX_STM_QUEUE_PER_CALL} messages per call; split the approved plan`);
    }

    const now = Date.now();
    let queued = 0;
    let skippedIneligible = 0;
    for (const messageId of args.messageIds) {
      const message = await ctx.db.get(messageId);
      if (!message) throw new Error(`message ${messageId} not found`);
      if (message.userId !== args.userId) throw new Error(`message ${messageId} belongs to another user; refusing`);
      if (message.retiredAt) {
        skippedIneligible += 1;
        continue;
      }
      // Only distilled rows may be expired early. Undistilled messages are
      // undeletable (ILL-182 fail-closed); shortening their window would
      // leave them stuck in the expired range forever.
      if (message.ltmExtractedAt === undefined) {
        skippedIneligible += 1;
        continue;
      }
      if (message.expiresAt <= now) {
        skippedIneligible += 1; // already in the expiry drain
        continue;
      }
      // Bring the TTL forward; expireOldMessages deletes already-distilled
      // expired rows with no model call.
      await ctx.db.patch(messageId, { expiresAt: now });
      queued += 1;
    }

    return { queued, skippedIneligible };
  },
});
