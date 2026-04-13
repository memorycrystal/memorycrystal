import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
  buildMemoryTransitionDelta,
} from "./dashboardTotals";
import { scanMemoryContent } from "./contentScanner";

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

type ScoredCandidate = {
  _id: string;
  title: string;
  content: string;
  _score?: number;
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

const summarizeMemories = (docs: MemoryRecord[]) =>
  docs
    .map(
      (memory, index) => `${index + 1}. [${memory.store}] ${shortText(memory.title, 80)}\n${shortText(memory.content, 180)}`
    )
    .join("\n\n");

export const getSensoryMemories = internalQuery({
  args: { limit: v.number(), userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .filter((q: any) => q.eq(q.field("store"), "sensory"))
      .take(args.limit);
  },
});

export const getMemoryForConsolidation = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.memoryId);
  },
});

export const archiveConsolidatedMemory = internalMutation({
  args: { memoryId: v.id("crystalMemories"), archivedAt: v.number(), userId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.userId !== args.userId) throw new Error("Not found");
    if (!existing.archived) {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        buildMemoryTransitionDelta({
          oldArchived: false,
          oldStore: existing.store,
          newArchived: true,
          newStore: existing.store,
        })
      );
    }
    await ctx.db.patch(args.memoryId, { archived: true, archivedAt: args.archivedAt });
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
      })
    );

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
    })) as MemoryRecord[];

    const deferred = Math.max(0, sensory.length - MAX_BATCH);
    const sensoryBatch = sensory.slice(0, MAX_BATCH);
    if (deferred > 0) {
      console.log(`[runConsolidation] deferred ${deferred} sensory memories to next run`);
    }

    const candidates = sensoryBatch
      .filter((memory) => !memory.knowledgeBaseId && now - memory.createdAt >= sensoryAgeMs)
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
        const nearest = (await ctx.vectorSearch("crystalMemories", "by_embedding", {
          vector: memory.embedding,
          limit: neighborWindow + 1,
          filter: (q: any) =>
            q.and(q.eq("userId", userId), q.eq("store", "sensory"), q.eq("archived", false)),
        })) as unknown as ScoredCandidate[];

        const cluster = nearest
          .map((entry) => ({
            entry,
            score: clamp01(entry._score ?? 0),
          }))
          .filter((candidate) => candidate.score >= clusterThreshold)
          .map((candidate) => candidate.entry._id);

        for (const id of cluster) {
          processed.add(id);
        }

        if (cluster.length < minClusterSize) {
          stats.skipped += 1;
          continue;
        }

        const docs = (
          await Promise.all(
            cluster.map(async (memoryId) =>
              ctx.runQuery(internal.crystal.consolidate.getMemoryForConsolidation, {
                memoryId,
              }) as Promise<MemoryRecord | null>
            )
          )
        ).filter(
          (item): item is MemoryRecord =>
            item !== null &&
            item.userId === userId &&
            item.store === "sensory" &&
            item.archived === false &&
            !item.knowledgeBaseId
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
          limit: 3,
          filter: (q: any) =>
            q.and(q.eq("userId", userId), q.eq("store", "semantic"), q.eq("archived", false)),
        })) as Array<{ _score?: number; score?: number }>;

        const topScore = semanticCandidates[0]?._score ?? semanticCandidates[0]?.score ?? 0;
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

// Top-level cron entry point: iterate all users
export const runConsolidation = action({
  args: consolidationInput,
  handler: async (ctx, args) => {
    const userIds: string[] = await ctx.runQuery(
      internal.crystal.userProfiles.listAllUserIds,
      {}
    );

    const results = [];
    for (const userId of userIds) {
      try {
        const result = await runConsolidationForUser(ctx, userId, args);
        results.push({ userId, ...result });
        console.log(`[runConsolidation] user ${userId}: processed ${result.processed}, promoted ${result.promoted}`);
      } catch (error) {
        console.log(`[runConsolidation] user ${userId} failed`, error);
      }
    }
    return { users: results.length, results };
  },
});
