// ILL-10 — STM/LTM duplicate audit + archive-first cleanup (single-account pilot).
//
// Internal-only incident/maintenance tooling in the leakAudit.ts mold: every
// function here is internalQuery/internalMutation/internalAction, invoked via
// `npx convex run`, and never exposed to HTTP/MCP/plugin surfaces.
//
// Flow:
//   1. auditLtmDuplicates / auditStmBloat — strictly read-only, repeatable.
//      Produce duplicate clusters (exact + near-duplicate) and STM bloat
//      candidates with projected savings.
//   2. Operator reviews the report and approves specific clusters/messages.
//   3. cleanupLtmDuplicateClusters / queueStmBloatForEarlyRetirement — refuse
//      to run without the explicit approved allowlist (the approval gate is
//      structural, not procedural). LTM cleanup is archive-first (reversible:
//      unarchive + clear supersededByMemoryId). STM cleanup only brings
//      expiresAt forward so rows drain through the EXISTING retirement
//      pipeline (which still extracts-or-skips before deleting).
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
const VECTOR_TARGET_BATCH = 25;
const NEAR_DUP_NEIGHBORS = 8;
const TRIVIAL_CONTENT_CHARS = 20;
// Cleanup write caps keep each mutation far inside Convex read/write limits.
const MAX_CLUSTERS_PER_CALL = 20;
const MAX_ARCHIVES_PER_CALL = 50;
const MAX_STM_QUEUE_PER_CALL = 200;
const MERGED_TAGS_CAP = 32;

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
  strength: number;
  hasEmbedding: boolean;
};

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
    pageSize: v.optional(v.number()),
    includeNearDuplicates: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const threshold = Math.min(Math.max(args.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD, 0.8), 1);
    const maxVectorSearches = Math.min(
      Math.max(args.maxVectorSearches ?? DEFAULT_MAX_VECTOR_SEARCHES, 0),
      MAX_VECTOR_SEARCHES,
    );
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
    if (includeNear && maxVectorSearches > 0) {
      const representatives = [...exactGroups.values()]
        .map((group) => group[0])
        .map((id) => rowsById.get(id)!)
        .filter((row) => row.hasEmbedding)
        .sort((a, b) => b.createdAt - a.createdAt);
      representativesSkipped = Math.max(representatives.length - maxVectorSearches, 0);
      const capped = representatives.slice(0, maxVectorSearches);

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
        .sort((a, b) => b.strength - a.strength || b.lastAccessedAt - a.lastAccessedAt);
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
      // Non-zero means the near-dup pass was truncated: raise maxVectorSearches
      // (or re-run) — silence here must not read as full coverage.
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

        await archiveMemoryAndSyncCleanupProjection(
          ctx,
          loser,
          now,
          {
            supersededByMemoryId: cluster.canonicalId,
            supersededAt: now,
          },
        );
        archived += 1;
      }

      await ctx.db.patch(cluster.canonicalId, {
        tags: [...mergedTags].slice(0, MERGED_TAGS_CAP),
        strength: mergedStrength,
        lastAccessedAt: mergedLastAccessedAt,
      });
    }

    return { clustersMerged: args.clusters.length, archived };
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
      // Only terminally processed rows may be expired early: everything else
      // still owes an LTM extraction pass, which the retirement pipeline runs
      // on its normal TTL schedule.
      if (!isTerminallyProcessed(message)) {
        skippedIneligible += 1;
        continue;
      }
      if (message.expiresAt <= now) {
        skippedIneligible += 1; // already in the expiry drain
        continue;
      }
      // Bring the TTL forward; the existing expireOldMessages sweep queues and
      // retires the row through the normal (extract-or-skip → delete) pipeline.
      await ctx.db.patch(messageId, { expiresAt: now });
      queued += 1;
    }

    return { queued, skippedIneligible };
  },
});
