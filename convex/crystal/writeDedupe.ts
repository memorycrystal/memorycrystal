// ILL-11 — near-duplicate write dedupe for non-KB memories.
//
// Exact duplicates are caught at insert time by contentHash lookups
// (by_user_content_hash_channel — see memories.ts, mcp.ts remember,
// messageRetirement capsules, ltmExtraction). This module adds the SEMANTIC
// layer: when a freshly inserted memory reaches the shared embedMemory
// finalizer, we vector-search active non-KB rows in the exact owner+channel
// scope and merge above-threshold restatements into the existing canonical.
//
// Isolation invariant (2026-07-02 leak): dedupe NEVER crosses channel scopes.
// peer-coach:peerA and peer-coach:peerB are different clients' data even
// when the text is identical; channel equality here is exact (undefined only
// matches undefined).
//
// Merge semantics mirror ltmHygiene cleanup: the OLDER row is canonical, the
// new row is archived with supersededByMemoryId provenance (reversible), tags
// and strength fold into the canonical. Every eligible semantic check records
// a hit or miss; extraction-originated rows carry the extraction run identity.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  archiveMemoryAndSyncCleanupProjection,
  patchMemoryAndSyncCleanupProjection,
} from "./cleanupProjection";
import {
  applyDashboardTotalsDelta,
  buildMemoryTransitionDelta,
  buildStrengthDelta,
} from "./dashboardTotals";

const DEFAULT_THRESHOLD = 0.95;
const MIN_THRESHOLD = 0.8;
// Convex vector filters cannot AND user + channel + archive/KB predicates.
// Keep the mandatory user filter in-index, then use an 8x wider bounded pool
// before exact channel/archive/KB checks so ineligible hits cannot easily starve
// a valid same-channel candidate without blowing the async latency budget.
const NEIGHBOR_LIMIT = 64;
const MERGED_TAGS_CAP = 32;
const TELEMETRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Env-gated so production can raise/disable the threshold without redeploy.
// MEMORY_CRYSTAL_NEAR_DEDUPE: unset/"1"/"true"/"on" = enabled; "0"/"false"/"off" = disabled.
// MEMORY_CRYSTAL_NEAR_DEDUPE_THRESHOLD: cosine threshold, clamped to [0.8, 1].
export function parseNearDedupeConfig(env: {
  MEMORY_CRYSTAL_NEAR_DEDUPE?: string;
  MEMORY_CRYSTAL_NEAR_DEDUPE_THRESHOLD?: string;
}): { enabled: boolean; threshold: number } {
  const raw = (env.MEMORY_CRYSTAL_NEAR_DEDUPE ?? "").trim().toLowerCase();
  const enabled = !["0", "false", "off", "disabled"].includes(raw);
  const parsed = Number.parseFloat(env.MEMORY_CRYSTAL_NEAR_DEDUPE_THRESHOLD ?? "");
  const threshold = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, MIN_THRESHOLD), 1)
    : DEFAULT_THRESHOLD;
  return { enabled, threshold };
}

export type NearDupHit = { id: string; score: number };
export type NearDupCandidate = {
  id: string;
  userId: string;
  channel: string | undefined;
  archived: boolean;
  isKbChunk: boolean;
  createdAt: number;
};

// Pure decision function (unit-tested): pick the canonical an incoming memory
// should merge into, or null. Same exact channel scope only, active non-KB
// rows only, score at/above threshold; oldest qualifying row wins so repeated
// restatements keep converging on one canonical.
export function pickNearDuplicate(
  hits: NearDupHit[],
  candidates: NearDupCandidate[],
  args: { selfId: string; userId: string; channel: string | undefined; threshold: number },
): { id: string; score: number } | null {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  let best: { id: string; score: number; createdAt: number } | null = null;
  for (const hit of hits) {
    if (hit.id === args.selfId) continue;
    if (hit.score < args.threshold) continue;
    const candidate = byId.get(hit.id);
    if (!candidate) continue;
    if (candidate.userId !== args.userId) continue;
    if (candidate.archived || candidate.isKbChunk) continue;
    if ((candidate.channel ?? null) !== (args.channel ?? null)) continue;
    if (!best || candidate.createdAt < best.createdAt) {
      best = { id: hit.id, score: hit.score, createdAt: candidate.createdAt };
    }
  }
  return best ? { id: best.id, score: best.score } : null;
}

export const getNearDupCandidates = internalQuery({
  args: { memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, args): Promise<NearDupCandidate[]> => {
    if (args.memoryIds.length > NEIGHBOR_LIMIT) {
      throw new Error(`getNearDupCandidates accepts at most ${NEIGHBOR_LIMIT} ids per call`);
    }
    const candidates: NearDupCandidate[] = [];
    for (const memoryId of args.memoryIds) {
      const memory = await ctx.db.get(memoryId);
      if (!memory) continue;
      candidates.push({
        id: String(memory._id),
        userId: memory.userId,
        channel: memory.channel,
        archived: memory.archived,
        isKbChunk: Boolean(memory.knowledgeBaseId),
        createdAt: memory.createdAt,
      });
    }
    return candidates;
  },
});

async function deleteMemoryTriggerRows(ctx: any, memoryId: Id<"crystalMemories">) {
  const rows = await ctx.db
    .query("crystalMemoryTriggers")
    .withIndex("by_memory", (q: any) => q.eq("memoryId", memoryId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

export const mergeNearDuplicateMemory = internalMutation({
  args: {
    userId: v.string(),
    canonicalId: v.id("crystalMemories"),
    duplicateId: v.id("crystalMemories"),
    score: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.canonicalId === args.duplicateId) {
      throw new Error("near-dedupe: canonical and duplicate are the same row");
    }
    const canonical = await ctx.db.get(args.canonicalId);
    const duplicate = await ctx.db.get(args.duplicateId);
    if (!canonical || !duplicate) return { merged: false, reason: "missing_row" };
    if (canonical.userId !== args.userId || duplicate.userId !== args.userId) {
      throw new Error("near-dedupe: row belongs to another user; refusing");
    }
    if (canonical.knowledgeBaseId || duplicate.knowledgeBaseId) {
      throw new Error("near-dedupe: KB chunks are out of scope; refusing");
    }
    // Channel scopes must match EXACTLY (undefined == undefined included);
    // cross-channel merging is how client data leaks.
    if ((canonical.channel ?? null) !== (duplicate.channel ?? null)) {
      throw new Error("near-dedupe: cross-channel merges are forbidden");
    }
    // Rows can change between the action's vector search and this mutation —
    // fail soft on staleness rather than archiving something already handled.
    if (canonical.archived || duplicate.archived) {
      return { merged: false, reason: "stale_row" };
    }

    const now = Date.now();
    const mergedTags = new Set<string>(canonical.tags);
    for (const tag of duplicate.tags) mergedTags.add(tag);
    const mergedSourceIds = Array.from(
      new Set(
        [...(canonical.sourceMessageIds ?? []), ...(duplicate.sourceMessageIds ?? [])].map(String),
      ),
    ).map((id) => id as Id<"crystalMessages">);

    const nextStrength = Math.max(canonical.strength, duplicate.strength);
    await patchMemoryAndSyncCleanupProjection(ctx, canonical, {
      tags: [...mergedTags].slice(0, MERGED_TAGS_CAP),
      strength: nextStrength,
      confidence: Math.max(canonical.confidence ?? 0, duplicate.confidence ?? 0),
      lastAccessedAt: now,
      extractionSessionKey: duplicate.extractionSessionKey ?? canonical.extractionSessionKey,
      extractionRunId: duplicate.extractionRunId ?? canonical.extractionRunId,
      ...(mergedSourceIds.length > 0 ? { sourceMessageIds: mergedSourceIds } : {}),
    }, now);
    await archiveMemoryAndSyncCleanupProjection(ctx, duplicate, now, {
      supersededByMemoryId: args.canonicalId,
      supersededAt: now,
    });
    await deleteMemoryTriggerRows(ctx, args.duplicateId);
    await applyDashboardTotalsDelta(ctx, args.userId, {
      ...buildMemoryTransitionDelta({
        oldArchived: false,
        oldStore: duplicate.store,
        oldGraphEnriched: duplicate.graphEnriched === true,
        oldEnrichmentSkippedReason: duplicate.enrichmentSkippedReason,
        oldAccessCount: duplicate.accessCount,
        newArchived: true,
        newStore: duplicate.store,
        newGraphEnriched: duplicate.graphEnriched === true,
        newEnrichmentSkippedReason: duplicate.enrichmentSkippedReason,
        newAccessCount: duplicate.accessCount,
      }),
      ...buildStrengthDelta(canonical.strength, nextStrength),
    });

    return { merged: true };
  },
});

export const recordNearDedupeOutcome = internalMutation({
  args: {
    userId: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    runId: v.optional(v.string()),
    memoryId: v.id("crystalMemories"),
    canonicalId: v.optional(v.id("crystalMemories")),
    outcome: v.union(v.literal("hit"), v.literal("miss")),
    reason: v.optional(v.string()),
    score: v.optional(v.number()),
    threshold: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const extractionScoped = Boolean(args.runId);
    await ctx.db.insert("crystalTelemetry", {
      userId: args.userId,
      kind: extractionScoped ? "ltm_extraction" : "near_dedupe",
      channel: args.channel,
      sessionKey: args.sessionKey,
      payload: JSON.stringify({
        scopeKey: extractionScoped
          ? [args.userId, args.channel ?? "", args.sessionKey ?? ""].join("|")
          : undefined,
        runId: args.runId,
        status: args.outcome === "hit" ? "near_hit" : "near_miss",
        exactHits: 0,
        nearHits: args.outcome === "hit" ? 1 : 0,
        misses: args.outcome === "miss" ? 1 : 0,
        memoryId: String(args.memoryId),
        canonicalId: args.canonicalId ? String(args.canonicalId) : undefined,
        score: args.score,
        threshold: args.threshold,
        reason: args.reason,
      }),
      createdAt: now,
      expiresAt: now + TELEMETRY_TTL_MS,
    });
  },
});

// Action-side helper: called from mcp.embedMemory the moment a new memory's
// vector exists (it is NOT yet in the vector index, so no self-hit). Returns
// whether the memory was merged away; the caller skips the embedding patch on
// a merged (now archived) row.
//
// accessCount guard: embedMemory also fires when an EXISTING memory is edited
// (content change clears the embedding). A row that has already been recalled
// is established user-visible state — never merge it away; only never-accessed
// rows (fresh writes) are dedupe candidates.
export async function checkAndMergeNearDuplicate(
  ctx: any,
  memory: {
    _id: Id<"crystalMemories">;
    userId: string;
    channel?: string;
    archived: boolean;
    knowledgeBaseId?: Id<"knowledgeBases">;
    accessCount: number;
    extractionSessionKey?: string;
    extractionRunId?: string;
  },
  vector: number[],
): Promise<{ merged: boolean; canonicalId?: string; score?: number }> {
  const config = parseNearDedupeConfig(
    typeof process !== "undefined" ? (process.env as any) : {},
  );
  if (memory.archived || memory.knowledgeBaseId) return { merged: false };
  if (memory.accessCount > 0) return { merged: false };

  const recordOutcome = async (
    outcome: "hit" | "miss",
    details: { reason?: string; canonicalId?: Id<"crystalMemories">; score?: number } = {},
  ) => {
    await ctx.runMutation(internal.crystal.writeDedupe.recordNearDedupeOutcome, {
      userId: memory.userId,
      channel: memory.channel,
      sessionKey: memory.extractionSessionKey,
      runId: memory.extractionRunId,
      memoryId: memory._id,
      outcome,
      reason: details.reason,
      canonicalId: details.canonicalId,
      score: details.score,
      threshold: config.threshold,
    }).catch(() => null);
  };

  if (!config.enabled) {
    await recordOutcome("miss", { reason: "disabled" });
    return { merged: false };
  }

  const hits = (await ctx.vectorSearch("crystalMemories", "by_embedding", {
    vector,
    limit: NEIGHBOR_LIMIT,
    filter: (q: any) => q.eq("userId", memory.userId),
  })) as Array<{ _id: Id<"crystalMemories">; _score: number }>;
  const qualifying = hits.filter(
    (hit) => String(hit._id) !== String(memory._id) && hit._score >= config.threshold,
  );
  if (qualifying.length === 0) {
    await recordOutcome("miss", { reason: "below_threshold" });
    return { merged: false };
  }

  const candidates: NearDupCandidate[] = await ctx.runQuery(
    internal.crystal.writeDedupe.getNearDupCandidates,
    { memoryIds: qualifying.map((hit) => hit._id) },
  );
  const pick = pickNearDuplicate(
    qualifying.map((hit) => ({ id: String(hit._id), score: hit._score })),
    candidates,
    {
      selfId: String(memory._id),
      userId: memory.userId,
      channel: memory.channel,
      threshold: config.threshold,
    },
  );
  if (!pick) {
    await recordOutcome("miss", { reason: "no_eligible_candidate" });
    return { merged: false };
  }

  const canonicalId = pick.id as Id<"crystalMemories">;
  const result = (await ctx.runMutation(internal.crystal.writeDedupe.mergeNearDuplicateMemory, {
    userId: memory.userId,
    canonicalId,
    duplicateId: memory._id,
    score: pick.score,
  })) as { merged: boolean; reason?: string };
  if (!result.merged) {
    await recordOutcome("miss", { reason: result.reason ?? "merge_rejected" });
    return { merged: false };
  }
  await recordOutcome("hit", { canonicalId, score: pick.score });
  console.log(
    `[near-dedupe] merged ${String(memory._id)} into ${pick.id} (score=${pick.score.toFixed(4)}, channel=${memory.channel ?? "global"})`,
  );
  return { merged: true, canonicalId: pick.id, score: pick.score };
}
