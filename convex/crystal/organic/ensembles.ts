import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Doc, Id } from "../../_generated/dataModel";
import {
  cosineSimilarity,
  callOrganicModel,
  isRecord,
  parseGeminiJson,
  vectorSearchUserFilter,
} from "./utils";
import { estimateModelSpend, type EstimatedSpend } from "./spend";
import { getModelPreset, type ModelPreset } from "./models";

// ── Constants ────────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.85;
const DRIFT_THRESHOLD = 0.75;
const MIN_CLUSTER_SIZE = 5;
const MIN_CLUSTER_KEEP = 3;
const NEIGHBORS_LIMIT = 20;
const UNCLUSTERED_BATCH = 50;

// ── Types ────────────────────────────────────────────────────────────────────

type MemoryDoc = Doc<"crystalMemories">;
type EnsembleDoc = Doc<"organicEnsembles">;

// ── Utilities ────────────────────────────────────────────────────────────────

function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }
  return centroid;
}

async function callModelForLabel(memberSummary: string, preset: ModelPreset, apiKeyOverride?: string): Promise<{ label: string; summary: string; spend: EstimatedSpend }> {
  const prompt = `Given these memory titles and contents, generate:
1. A short label (3-6 words) for this cluster
2. A 1-sentence summary

Memories: ${memberSummary}

Return JSON: {"label": "...", "summary": "..."}`;

  const text = await callOrganicModel(prompt, preset, apiKeyOverride);
  if (!text) throw new Error("Model unavailable");
  const spend = estimateModelSpend(prompt, text, preset);

  const parsed = parseGeminiJson<unknown>(text);
  const payload = unwrapGeminiObject(parsed);
  if (payload) {
    return {
      label: typeof payload.label === "string" && payload.label.trim() ? payload.label.trim() : "Unnamed cluster",
      summary: typeof payload.summary === "string" ? payload.summary.trim() : "",
      spend,
    };
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"));
  const labelLine = lines[0]?.replace(/^label:\s*/i, "").trim();
  const summaryLine = lines[1]?.replace(/^summary:\s*/i, "").trim() ?? "";
  if (labelLine) {
    return {
      label: labelLine,
      summary: summaryLine,
      spend,
    };
  }

  console.error("callGeminiForLabel: JSON parse failed, using fallback label");
  return { label: "memory cluster", summary: "", spend };
}

// ── Queries ──────────────────────────────────────────────────────────────────

export const getEnsembleById = internalQuery({
  args: { ensembleId: v.id("organicEnsembles") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.ensembleId);
  },
});

export const getUnclusteredMemories = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    // Fetch candidate memories (most recent first to prioritize fresh content)
    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) =>
        q.eq("userId", args.userId)
      )
      .order("desc")
      .take(args.limit * 5);

    const candidates = memories.filter((m) => !m.archived && m.embedding.length > 0);
    if (candidates.length === 0) return [];

    // Check membership per-candidate using the index (avoids 5k hard cap)
    const unclustered: typeof candidates = [];
    for (const memory of candidates) {
      if (unclustered.length >= args.limit) break;
      const membership = await ctx.db
        .query("organicEnsembleMemberships")
        .withIndex("by_user_memory", (q) =>
          q.eq("userId", args.userId).eq("memoryId", memory._id)
        )
        .first();
      if (!membership) unclustered.push(memory);
    }
    return unclustered;
  },
});

export const getEnsemblesForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicEnsembles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .collect();
  },
});

export const getEnsembleMembers = internalQuery({
  args: { ensembleId: v.id("organicEnsembles") },
  handler: async (ctx, args) => {
    const ensemble = await ctx.db.get(args.ensembleId);
    if (!ensemble) return [];
    const memories = await Promise.all(
      ensemble.memberMemoryIds.map((id) => ctx.db.get(id))
    );
    return memories.filter((m): m is MemoryDoc => m !== null && !m.archived);
  },
});

export const getMembershipsByMemory = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicEnsembleMemberships")
      .withIndex("by_memory", (q) => q.eq("memoryId", args.memoryId))
      .collect();
  },
});

export const getMembershipsByMemories = internalQuery({
  args: { userId: v.string(), memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, args) => {
    const results = await Promise.all(
      args.memoryIds.map((memoryId) =>
        ctx.db
          .query("organicEnsembleMemberships")
          .withIndex("by_user_memory", (q) => q.eq("userId", args.userId).eq("memoryId", memoryId))
          .collect()
      )
    );
    return results.flat();
  },
});

export const getMembershipsByEnsemble = internalQuery({
  args: { ensembleId: v.id("organicEnsembles") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicEnsembleMemberships")
      .withIndex("by_ensemble", (q) => q.eq("ensembleId", args.ensembleId))
      .collect();
  },
});

export const getMemoriesByIds = internalQuery({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.id("crystalMemories")),
  },
  handler: async (ctx, args) => {
    // Defense-in-depth tenant filter: the vector-search filter builder uses `as never` casts
    // and relies on every index keeping `userId` in filterFields. Re-check ownership here so a
    // schema drift or legacy row cannot leak a neighbor across tenants.
    const rows = await Promise.all(args.memoryIds.map((id) => ctx.db.get(id)));
    return rows.map((row) => (row && row.userId === args.userId ? row : null));
  },
});

export const getEnsemblesByIds = internalQuery({
  args: { ensembleIds: v.array(v.id("organicEnsembles")) },
  handler: async (ctx, args) => {
    return Promise.all(args.ensembleIds.map((id) => ctx.db.get(id)));
  },
});

// ── Ensemble-aware recall prep ───────────────────────────────────────────────

export const searchEnsemblesByVector = internalAction({
  args: {
    userId: v.string(),
    embedding: v.array(v.float64()),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<Array<EnsembleDoc & { _score: number }>> => {
    const results = (await ctx.vectorSearch("organicEnsembles", "by_centroid", {
      vector: args.embedding,
      limit: args.limit,
      filter: vectorSearchUserFilter(args.userId),
    })) as Array<{ _id: Id<"organicEnsembles">; _score: number }>;

    const ensembles = await ctx.runQuery(
      internal.crystal.organic.ensembles.getEnsemblesByIds,
      { ensembleIds: results.map((r) => r._id) }
    );

    return ensembles
      .map((e: EnsembleDoc | null, i: number) => (e ? { ...e, _score: results[i]?._score ?? 0 } : null))
      .filter((e: (EnsembleDoc & { _score: number }) | null): e is EnsembleDoc & { _score: number } => e !== null && e.archived === false);
  },
});

// ── Mutations ────────────────────────────────────────────────────────────────

export const createEnsemble = internalMutation({
  args: {
    userId: v.string(),
    ensembleType: v.union(
      v.literal("cluster"),
      v.literal("motif"),
      v.literal("conflict_group"),
      v.literal("trajectory"),
      v.literal("project_arc")
    ),
    memberIds: v.array(v.id("crystalMemories")),
    label: v.string(),
    summary: v.string(),
    centroid: v.array(v.float64()),
    strength: v.float64(),
    confidence: v.float64(),
    tickId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ensembleId = await ctx.db.insert("organicEnsembles", {
      userId: args.userId,
      ensembleType: args.ensembleType,
      label: args.label,
      summary: args.summary,
      memberMemoryIds: args.memberIds,
      centroidEmbedding: args.centroid,
      strength: args.strength,
      confidence: args.confidence,
      createdAt: now,
      updatedAt: now,
      lastTickId: args.tickId,
      archived: false,
    });

    for (const memoryId of args.memberIds) {
      await ctx.db.insert("organicEnsembleMemberships", {
        userId: args.userId,
        memoryId,
        ensembleId,
        addedAt: now,
        joinedAt: now,
      });
    }

    return ensembleId;
  },
});

export const updateEnsemble = internalMutation({
  args: {
    ensembleId: v.id("organicEnsembles"),
    memberIds: v.array(v.id("crystalMemories")),
    centroid: v.array(v.float64()),
    label: v.string(),
    summary: v.string(),
    strength: v.float64(),
    confidence: v.float64(),
    tickId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ensemble = await ctx.db.get(args.ensembleId);
    if (!ensemble) return;

    await ctx.db.patch(args.ensembleId, {
      memberMemoryIds: args.memberIds,
      centroidEmbedding: args.centroid,
      label: args.label,
      summary: args.summary,
      strength: args.strength,
      confidence: args.confidence,
      updatedAt: now,
      lastTickId: args.tickId,
    });

    const existing = await ctx.db
      .query("organicEnsembleMemberships")
      .withIndex("by_ensemble", (q) => q.eq("ensembleId", args.ensembleId))
      .collect();

    const existingMemIds = new Set(existing.map((m) => m.memoryId));
    const newMemIds = new Set(args.memberIds);

    for (const m of existing) {
      if (!newMemIds.has(m.memoryId)) {
        await ctx.db.delete(m._id);
      }
    }

    for (const memoryId of args.memberIds) {
      if (!existingMemIds.has(memoryId)) {
        await ctx.db.insert("organicEnsembleMemberships", {
          userId: ensemble.userId,
          memoryId,
          ensembleId: args.ensembleId,
          addedAt: now,
          joinedAt: now,
        });
      }
    }
  },
});

export const archiveEnsemble = internalMutation({
  args: { ensembleId: v.id("organicEnsembles") },
  handler: async (ctx, args) => {
    const ensemble = await ctx.db.get(args.ensembleId);
    if (!ensemble) return;

    await ctx.db.patch(args.ensembleId, {
      archived: true,
      updatedAt: Date.now(),
    });

    const memberships = await ctx.db
      .query("organicEnsembleMemberships")
      .withIndex("by_ensemble", (q) => q.eq("ensembleId", args.ensembleId))
      .collect();

    for (const m of memberships) {
      await ctx.db.delete(m._id);
    }
  },
});

// ── Main Ensemble Tick ───────────────────────────────────────────────────────

export const processEnsembleTick = internalAction({
  args: { userId: v.string(), tickId: v.string(), organicModel: v.optional(v.string()), openrouterApiKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, tickId } = args;
    const preset = getModelPreset(args.organicModel);
    const apiKeyOverride = args.openrouterApiKey;

    // Phase 1: Process unclustered memories
    const unclustered = await ctx.runQuery(
      internal.crystal.organic.ensembles.getUnclusteredMemories,
      { userId, limit: UNCLUSTERED_BATCH }
    );

    if (unclustered.length === 0) {
      console.log(`[organic-ensembles] ${userId}: no unclustered memories`);
    }

    let created = 0;
    const processedIds = new Set<string>();
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;

    for (const memory of unclustered) {
      if (processedIds.has(memory._id)) continue;

      const neighbors = (await ctx.vectorSearch("crystalMemories", "by_embedding", {
        vector: memory.embedding,
        limit: NEIGHBORS_LIMIT,
        filter: vectorSearchUserFilter(userId),
      })) as Array<{ _id: Id<"crystalMemories">; _score: number }>;

      const similar = neighbors.filter(
        (n) => n._score > SIMILARITY_THRESHOLD && n._id !== memory._id
      );

      if (similar.length >= MIN_CLUSTER_SIZE - 1) {
        const memberIds: Id<"crystalMemories">[] = [memory._id, ...similar.map((n) => n._id)];

        // Batch-check which are already clustered
        const memberships = await ctx.runQuery(
          internal.crystal.organic.ensembles.getMembershipsByMemories,
          { userId, memoryIds: memberIds }
        );
        const alreadyClustered = new Set<string>(memberships.map((m: { memoryId: any }) => String(m.memoryId)));

        const newMembers = memberIds.filter((id) => !alreadyClustered.has(id));
        if (newMembers.length < MIN_CLUSTER_SIZE) continue;

        const memberMemories = (await ctx.runQuery(
          internal.crystal.organic.ensembles.getMemoriesByIds,
          { userId, memoryIds: newMembers }
        )).filter((m: MemoryDoc | null): m is MemoryDoc => m !== null && !m.archived);

        if (memberMemories.length < MIN_CLUSTER_SIZE) continue;

        const embeddings = memberMemories.map((m: MemoryDoc) => m.embedding);
        const centroid = computeCentroid(embeddings);
        const validMembers = memberMemories.map((m: MemoryDoc) => m._id);

        // Generate label + summary
        const memberSummary = memberMemories
          .slice(0, 10)
          .map((m: MemoryDoc) => `[${m.store}/${m.category}] ${m.title}: ${m.content.slice(0, 80)}`)
          .join("\n");

        let label: string;
        let summary: string;
        try {
          const result = await callModelForLabel(memberSummary, preset, apiKeyOverride);
          label = result.label;
          summary = result.summary;
          estimatedInputTokens += result.spend.estimatedInputTokens;
          estimatedOutputTokens += result.spend.estimatedOutputTokens;
          estimatedCostUsd += result.spend.estimatedCostUsd;
        } catch {
          const first = memberMemories[0];
          label = first ? first.title.slice(0, 50) : "Unnamed cluster";
          summary = `Cluster of ${validMembers.length} related memories`;
        }

        const avgStrength = memberMemories.reduce((s: number, m: MemoryDoc) => s + m.strength, 0) / validMembers.length;
        const avgSim = embeddings.reduce((s: number, emb: number[]) => s + cosineSimilarity(emb, centroid), 0) / embeddings.length;

        await ctx.runMutation(
          internal.crystal.organic.ensembles.createEnsemble,
          {
            userId,
            ensembleType: "cluster",
            memberIds: validMembers,
            label,
            summary,
            centroid,
            strength: avgStrength,
            confidence: avgSim,
            tickId,
          }
        );

        for (const id of validMembers) processedIds.add(id);
        created++;
      }
    }

    // Phase 2: Maintain existing ensembles — check for drift
    const ensembles = await ctx.runQuery(
      internal.crystal.organic.ensembles.getEnsemblesForUser,
      { userId }
    );

    let updated = 0;
    let archived = 0;

    for (const ensemble of ensembles) {
      const members = (await ctx.runQuery(
        internal.crystal.organic.ensembles.getMemoriesByIds,
        { userId, memoryIds: ensemble.memberMemoryIds }
      )).filter((m: MemoryDoc | null): m is MemoryDoc => m !== null && !m.archived);

      if (members.length < MIN_CLUSTER_KEEP && ensemble.ensembleType !== "conflict_group") {
        await ctx.runMutation(
          internal.crystal.organic.ensembles.archiveEnsemble,
          { ensembleId: ensemble._id }
        );
        archived++;
        continue;
      }

      // Check for drifted members
      const centroid = ensemble.centroidEmbedding;
      const keptMembers = members.filter(
        (m: MemoryDoc) => cosineSimilarity(m.embedding, centroid) >= DRIFT_THRESHOLD
      );

      if (keptMembers.length < MIN_CLUSTER_KEEP && ensemble.ensembleType !== "conflict_group") {
        await ctx.runMutation(
          internal.crystal.organic.ensembles.archiveEnsemble,
          { ensembleId: ensemble._id }
        );
        archived++;
        continue;
      }

      if (keptMembers.length !== ensemble.memberMemoryIds.length) {
        const keptIds = keptMembers.map((m: MemoryDoc) => m._id);
        const newCentroid = computeCentroid(keptMembers.map((m: MemoryDoc) => m.embedding));
        const avgStrength = keptMembers.reduce((s: number, m: MemoryDoc) => s + m.strength, 0) / keptMembers.length;
        const avgSim = keptMembers.reduce(
          (s: number, m: MemoryDoc) => s + cosineSimilarity(m.embedding, newCentroid), 0
        ) / keptMembers.length;

        await ctx.runMutation(
          internal.crystal.organic.ensembles.updateEnsemble,
          {
            ensembleId: ensemble._id,
            memberIds: keptIds,
            centroid: newCentroid,
            label: ensemble.label,
            summary: ensemble.summary,
            strength: avgStrength,
            confidence: avgSim,
            tickId,
          }
        );
        updated++;
      }

      // Re-fetch ensemble after potential drift update to avoid stale state
      const refreshedEnsemble = await ctx.runQuery(
        internal.crystal.organic.ensembles.getEnsembleById,
        { ensembleId: ensemble._id }
      );
      if (!refreshedEnsemble || refreshedEnsemble.archived) continue;

      // Guard against an empty centroid. If the ensemble lost all members in the
      // drift check above, `computeCentroid([])` returns `[]` and the vector search
      // below throws. Archive the ensemble instead of crashing the whole Phase 2 loop.
      if (!Array.isArray(refreshedEnsemble.centroidEmbedding) || refreshedEnsemble.centroidEmbedding.length === 0) {
        await ctx.runMutation(
          internal.crystal.organic.ensembles.archiveEnsemble,
          { ensembleId: refreshedEnsemble._id }
        );
        archived++;
        continue;
      }

      // Wrap the neighbor search in try/catch so a single failure (e.g. rate limit,
      // transient vector-index error, dimension mismatch on a legacy embedding) only
      // skips this one ensemble instead of aborting the remainder of the Phase 2 loop.
      let newNeighbors: Array<{ _id: Id<"crystalMemories">; _score: number }> = [];
      try {
        newNeighbors = (await ctx.vectorSearch("crystalMemories", "by_embedding", {
          vector: refreshedEnsemble.centroidEmbedding,
          limit: 10,
          filter: vectorSearchUserFilter(userId),
        })) as Array<{ _id: Id<"crystalMemories">; _score: number }>;
      } catch (err) {
        console.warn(
          `[organic-ensembles] ${userId}: neighbor search failed for ensemble ${refreshedEnsemble._id} — ${String((err as Error)?.message ?? err)}`,
        );
        continue;
      }

      const currentMemberSet = new Set(refreshedEnsemble.memberMemoryIds.map(String));
      const additions = newNeighbors.filter(
        (n) => n._score > SIMILARITY_THRESHOLD && !currentMemberSet.has(String(n._id))
      );

      if (additions.length > 0) {
        const additionIds = additions.map((a) => a._id);
        const existingMemberships = await ctx.runQuery(
          internal.crystal.organic.ensembles.getMembershipsByMemories,
          { userId, memoryIds: additionIds }
        );
        const alreadyMembered = new Set<string>(existingMemberships.map((m: { memoryId: any }) => String(m.memoryId)));
        const toAdd = additionIds.filter((id) => !alreadyMembered.has(String(id)));

        if (toAdd.length > 0) {
          const addedDocs = (await ctx.runQuery(
            internal.crystal.organic.ensembles.getMemoriesByIds,
            { userId, memoryIds: toAdd }
          )).filter((m: MemoryDoc | null): m is MemoryDoc => m !== null && !m.archived);

          const existingDocs = (await ctx.runQuery(
            internal.crystal.organic.ensembles.getMemoriesByIds,
            { userId, memoryIds: refreshedEnsemble.memberMemoryIds }
          )).filter((m: MemoryDoc | null): m is MemoryDoc => m !== null && !m.archived);

          const allMembers: MemoryDoc[] = [...existingDocs, ...addedDocs];
          const newCentroid = computeCentroid(allMembers.map((m: MemoryDoc) => m.embedding));
          const avgStrength = allMembers.reduce((s: number, m: MemoryDoc) => s + m.strength, 0) / allMembers.length;
          const avgSim = allMembers.reduce(
            (s: number, m: MemoryDoc) => s + cosineSimilarity(m.embedding, newCentroid), 0
          ) / allMembers.length;

          const memberSummary = allMembers
            .slice(0, 10)
            .map((m: MemoryDoc) => `[${m.store}/${m.category}] ${m.title}: ${m.content.slice(0, 80)}`)
            .join("\n");

          let label = refreshedEnsemble.label;
          let summary = refreshedEnsemble.summary;
          try {
            const result = await callModelForLabel(memberSummary, preset, apiKeyOverride);
            label = result.label;
            summary = result.summary;
          } catch {
            // Keep existing label/summary
          }

          await ctx.runMutation(
            internal.crystal.organic.ensembles.updateEnsemble,
            {
              ensembleId: refreshedEnsemble._id,
              memberIds: allMembers.map((m: MemoryDoc) => m._id),
              centroid: newCentroid,
              label,
              summary,
              strength: avgStrength,
              confidence: avgSim,
              tickId,
            }
          );
          updated++;
        }
      }
    }

    console.log(
      `[organic-ensembles] ${userId}: ${created} created, ${updated} updated, ${archived} archived`
    );

    return {
      created,
      updated,
      archived,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
    };
  },
});

function unwrapGeminiObject(parsed: unknown): Record<string, unknown> | null {
  if (isRecord(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed) && parsed.length > 0 && isRecord(parsed[0])) {
    return parsed[0];
  }

  return null;
}
