import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
  buildMemoryTransitionDelta,
} from "./dashboardTotals";
import { scanMemoryContent } from "./contentScanner";
import { isProtectedSensoryCapture } from "./sensoryPolicy";
import { archiveMemoryAndSyncCleanupProjection } from "./cleanupProjection";

const dayMs = 24 * 60 * 60 * 1000;
const nowMs = () => Date.now();
const MAX_BATCH = 200;
const MAX_VECTOR_EXPANSIONS_PER_RUN = 50;

const consolidationInput = v.object({
  sensoryMaxAgeHours: v.optional(v.number()),
  minClusterSize: v.optional(v.number()),
  maxSensorySamples: v.optional(v.number()),
  clusterThreshold: v.optional(v.float64()),
});

type MemoryRecord = {
  _id: string;
  userId: string;
  store: string;
  category: string;
  title: string;
  content: string;
  embedding: number[];
  strength: number;
  confidence: number;
  valence: number;
  arousal: number;
  archived: boolean;
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  archivedAt?: number;
  source: string;
  tags: string[];
  promotedFrom?: string;
  knowledgeBaseId?: string;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const shortText = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit).trim()}…` : value;

const normalize = (tags: string[]) =>
  Array.from(new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort();

const average = (vectors: number[][]) => {
  if (vectors.length === 0) {
    return [];
  }

  const width = vectors[0].length;
  const totals = new Array<number>(width).fill(0);

  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) {
      totals[i] += vector[i] ?? 0;
    }
  }

  return totals.map((sum) => sum / vectors.length);
};

const cosineSimilarity = (a: number[], b: number[]) => {
  const width = Math.min(a.length, b.length);
  if (width === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < width; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return clamp01(dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm)));
};

const summarizeMemories = (docs: MemoryRecord[]) =>
  docs
    .map(
      (memory, index) => `${index + 1}. [${memory.store}] ${shortText(memory.title, 80)}\n${shortText(memory.content, 180)}`
    )
    .join("\n\n");

export const getSensoryMemories = internalQuery({
  args: { limit: v.number(), userId: v.string(), createdBefore: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), MAX_BATCH + 1);
    // Convex allows only ONE paginated query per function. The previous
    // while-loop over .paginate() crashed with "ran multiple paginated queries"
    // whenever the first 100-doc page did not yield `limit` non-protected rows
    // (common on accounts with sensory bloat or a tight createdBefore filter),
    // which silently broke consolidation and let sensory accumulate. Read a
    // single bounded page via .take() and filter protected captures in-memory.
    const rows = await ctx.db
      .query("crystalMemories")
      .withIndex("by_store_archived_created", (q) => {
        const indexed = q.eq("userId", args.userId).eq("store", "sensory").eq("archived", false);
        return args.createdBefore !== undefined ? indexed.lte("createdAt", args.createdBefore) : indexed;
      })
      .take(MAX_BATCH + 1);

    const memories = [];
    for (const memory of rows) {
      if (isProtectedSensoryCapture(memory)) continue;
      memories.push(memory);
      if (memories.length >= limit) break;
    }

    return memories;
  },
});

export const getMemoryForConsolidation = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.memoryId);
  },
});

export const getMemoriesForConsolidationByIds = internalQuery({
  args: { memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, args) => {
    return Promise.all(args.memoryIds.map((memoryId) => ctx.db.get(memoryId)));
  },
});

export const archiveConsolidatedMemory = internalMutation({
  args: { memoryId: v.id("crystalMemories"), archivedAt: v.number(), userId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.userId !== args.userId) throw new Error("Not found");
    if (existing.store === "sensory" && isProtectedSensoryCapture(existing)) return;
    if (!existing.archived) {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        buildMemoryTransitionDelta({
          oldArchived: false,
          oldStore: existing.store,
          oldGraphEnriched: existing.graphEnriched === true,
          oldEnrichmentSkippedReason: existing.enrichmentSkippedReason,
          oldAccessCount: existing.accessCount,
          newArchived: true,
          newStore: existing.store,
          newGraphEnriched: existing.graphEnriched === true,
          newEnrichmentSkippedReason: existing.enrichmentSkippedReason,
          newAccessCount: existing.accessCount,
        })
      );
    }
    await archiveMemoryAndSyncCleanupProjection(
      ctx,
      existing,
      args.archivedAt,
    );
  },
});

export const insertConsolidatedMemory = internalMutation({
  args: {
    userId: v.string(),
    store: v.string(),
    category: v.string(),
    title: v.string(),
    content: v.string(),
    embedding: v.array(v.float64()),
    strength: v.float64(),
    confidence: v.float64(),
    valence: v.float64(),
    arousal: v.float64(),
    accessCount: v.number(),
    lastAccessedAt: v.number(),
    createdAt: v.number(),
    source: v.string(),
    tags: v.array(v.string()),
    archived: v.boolean(),
    promotedFrom: v.optional(v.id("crystalMemories")),
  },
  handler: async (ctx, args) => {
    const scanResult = scanMemoryContent(args.content);
    if (!scanResult.allowed) {
      throw new Error(`Memory blocked: ${scanResult.reason} [${scanResult.threatId}]`);
    }

    const memoryId = await ctx.db.insert("crystalMemories", args as any);

    await applyDashboardTotalsDelta(
      ctx,
      args.userId,
      buildMemoryCreateDelta({
        store: args.store,
        archived: args.archived,
        title: args.title,
        memoryId,
        createdAt: args.createdAt,
        strength: args.strength,
        accessCount: args.accessCount,
      })
    );
    if (!args.archived) {
      await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, { memoryId });
    }

    return memoryId;
  },
});

// Per-user consolidation (called by runConsolidation for each user)
export const consolidateForUser = internalAction({
  args: { userId: v.string(), ...consolidationInput.fields },
  handler: async (ctx, args) => {
    const { userId, ...consolidationArgs } = args;
    return runConsolidationForUser(ctx, userId, consolidationArgs);
  },
});

async function runConsolidationForUser(ctx: any, userId: string, args: {
  sensoryMaxAgeHours?: number;
  minClusterSize?: number;
  maxSensorySamples?: number;
  clusterThreshold?: number;
}) {
    const now = nowMs();
    const sensoryAgeMs = Math.max(args.sensoryMaxAgeHours ?? 24, 2) * 60 * 60 * 1000;
    const minClusterSize = Math.min(Math.max(args.minClusterSize ?? 2, 2), 12);
    const maxSensorySamples = Math.min(Math.max(args.maxSensorySamples ?? 200, 20), MAX_BATCH);
    const clusterThreshold = Math.min(Math.max(args.clusterThreshold ?? 0.75, 0.65), 0.98);
    const neighborWindow = 8;

    const sensory = (await ctx.runQuery(internal.crystal.consolidate.getSensoryMemories, {
      limit: MAX_BATCH + 1,
      userId,
      createdBefore: now - sensoryAgeMs,
    })) as MemoryRecord[];

    const deferred = Math.max(0, sensory.length - MAX_BATCH);
    const sensoryBatch = sensory.slice(0, MAX_BATCH);
    if (deferred > 0) {
      console.log(`[runConsolidation] deferred ${deferred} sensory memories to next run`);
    }

      const candidates = sensoryBatch
      .filter((memory) => !memory.knowledgeBaseId && !isProtectedSensoryCapture(memory) && now - memory.createdAt >= sensoryAgeMs)
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, maxSensorySamples);

    const processed = new Set<string>();
    const createdEpisodic: string[] = [];
    const stats = {
      processed: 0,
      skipped: 0,
      promoted: 0,
      errors: 0,
    };

    for (const memory of candidates.slice(0, MAX_VECTOR_EXPANSIONS_PER_RUN)) {
      if (processed.has(memory._id)) {
        stats.skipped += 1;
        continue;
      }
      stats.processed += 1;

      try {
        const cluster = candidates
          .map((candidate) => ({
            memory: candidate,
            score: cosineSimilarity(memory.embedding, candidate.embedding),
          }))
          .filter((candidate) => candidate.score >= clusterThreshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, neighborWindow + 1)
          .map((candidate) => candidate.memory);

        for (const item of cluster) {
          processed.add(item._id);
        }

        if (cluster.length < minClusterSize) {
          stats.skipped += 1;
          continue;
        }

        const docs = cluster.filter(
          (item): item is MemoryRecord =>
            item !== null &&
            item.userId === userId &&
            item.store === "sensory" &&
            item.archived === false &&
            !item.knowledgeBaseId &&
            !isProtectedSensoryCapture(item)
        );

        if (docs.length < minClusterSize) {
          stats.skipped += 1;
          continue;
        }

        const base = docs[0];
        const embedding = average(docs.map((item) => item.embedding));
        if (embedding.length === 0) {
          stats.skipped += 1;
          continue;
        }

        const title = shortText(`Episodic cluster: ${docs.map((item) => item.title).join(" | ")}`, 110);
        const content = [
          `Source cluster summary (${docs.length} memories):`,
          "",
          summarizeMemories(docs),
        ].join("\n\n");

        const episodicId = await ctx.runMutation(internal.crystal.consolidate.insertConsolidatedMemory, {
          userId,
          store: "episodic",
          category: "event",
          title,
          content,
          embedding,
          strength: clamp01(0.45 + Math.min(docs.length, 12) * 0.05),
          confidence: clamp01(0.55 + Math.min(docs.length, 20) * 0.02),
          valence: Math.min(1, docs.reduce((sum, item) => sum + item.valence, 0) / docs.length),
          arousal: Math.min(1, docs.reduce((sum, item) => sum + item.arousal, 0) / docs.length),
          accessCount: docs.length,
          lastAccessedAt: now,
          createdAt: now,
          source: "cron",
          tags: normalize(docs.flatMap((item) => item.tags)),
          archived: false,
          promotedFrom: base._id,
        });

        for (const item of docs) {
          await ctx.runMutation(internal.crystal.consolidate.archiveConsolidatedMemory, {
            memoryId: item._id,
            archivedAt: now,
            userId,
          });
        }

        createdEpisodic.push(episodicId);
      } catch (error) {
        stats.errors += 1;
        console.log(`[runConsolidation] failed to process source memory ${memory._id}`, error);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    for (const episodicId of createdEpisodic) {
      try {
        const episodic = (await ctx.runQuery(internal.crystal.consolidate.getMemoryForConsolidation, {
          memoryId: episodicId,
        })) as (MemoryRecord & { _id: string }) | null;
        if (!episodic || episodic.userId !== userId || episodic.knowledgeBaseId) {
          continue;
        }

        if (episodic.accessCount < 3 || episodic.confidence < 0.8 || episodic.strength < 0.8) {
          stats.skipped += 1;
          continue;
        }

        const semanticCandidates = (await ctx.vectorSearch("crystalMemories", "by_embedding", {
          vector: episodic.embedding,
          limit: 24,
          filter: (q: any) => q.eq("userId", userId),
        })) as Array<{ _score?: number; score?: number }>;

        const candidateMemories = await ctx.runQuery(internal.crystal.consolidate.getMemoriesForConsolidationByIds, {
          memoryIds: semanticCandidates.map((candidate: any) => candidate._id),
        });

        const semanticMatches = [];
        for (let index = 0; index < semanticCandidates.length; index += 1) {
          const candidate = semanticCandidates[index];
          const candidateMemory = candidateMemories[index];
          if (
            candidateMemory &&
            candidateMemory.userId === userId &&
            candidateMemory.store === "semantic" &&
            candidateMemory.archived === false
          ) {
            semanticMatches.push(candidate);
          }
          if (semanticMatches.length >= 3) break;
        }

        const topScore = semanticMatches[0]?._score ?? semanticMatches[0]?.score ?? 0;
        if (topScore >= 0.92) {
          continue;
        }

        await ctx.runMutation(internal.crystal.consolidate.insertConsolidatedMemory, {
          userId,
          store: "semantic",
          category: episodic.category,
          title: `Semantic: ${episodic.title}`,
          content: episodic.content,
          embedding: episodic.embedding,
          strength: clamp01(episodic.strength * 0.95 + 0.05),
          confidence: clamp01(episodic.confidence + 0.05),
          valence: episodic.valence,
          arousal: episodic.arousal,
          accessCount: 0,
          lastAccessedAt: now,
          createdAt: now,
          source: "cron",
          tags: episodic.tags,
          archived: false,
          promotedFrom: episodicId,
        });
        stats.promoted += 1;
      } catch (error) {
        stats.errors += 1;
        console.log(`[runConsolidation] failed to promote episodic memory ${episodicId}`, error);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return {
      ...stats,
    };
}

// Top-level cron entry point: iterate ALL users every tick.
//
// Consolidation is frequency-dependent, so this deliberately does NOT use the
// crystalJobCursors rotation pattern: (1) candidates become eligible at age
// 24h while cleanup tombstones the same rows' raw content at the tier TTL, so
// visiting a user less often shifts consolidations past the wipe boundary and
// changes the episodic output (tombstone text instead of real content);
// (2) per-visit throughput is capped (MAX_BATCH=200 rows,
// MAX_VECTOR_EXPANSIONS_PER_RUN=50 seeds) with overflow merely deferred, so
// capacity = cap x visit frequency and rotation would diverge backlogs.
//
// Instead the old listAllUserIds .collect() is replaced by an in-tick page
// loop over listUserIdsPage: identical coverage and semantics (every user,
// every 12h tick, same table order), but memory per query stays bounded.
// NOTE: this is not a read-cost win — the same profile rows are read each
// tick — it only bounds per-query memory.
const USERS_PAGE_SIZE = 100;

export const runConsolidation = action({
  args: consolidationInput,
  handler: async (ctx, args) => {
    const results = [];
    let cursor: string | undefined;
    let isDone = false;
    while (!isDone) {
      const page: { userIds: string[]; continueCursor: string; isDone: boolean } =
        await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          cursor,
          numItems: USERS_PAGE_SIZE,
        });

      for (const userId of page.userIds) {
        try {
          const result = await runConsolidationForUser(ctx, userId, args);
          results.push({ userId, ...result });
          console.log(`[runConsolidation] user ${userId}: processed ${result.processed}, promoted ${result.promoted}`);
        } catch (error) {
          console.log(`[runConsolidation] user ${userId} failed`, error);
        }
      }

      cursor = page.continueCursor;
      isDone = page.isDone;
    }
    return { users: results.length, results };
  },
});
