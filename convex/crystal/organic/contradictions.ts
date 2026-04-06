import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Doc } from "../../_generated/dataModel";
import {
  averageEmbeddings,
  cosineSimilarity,
  todayDateString,
  callOrganicModel,
  isRecord,
  parseGeminiJson,
} from "./utils";
import { estimateModelSpend, type EstimatedSpend } from "./spend";
import { getModelPreset, type ModelPreset } from "./models";
import { type DiscoveryFinding } from "./discoveryFiber";

const CONTRADICTION_SIM_LOW = 0.70;
const CONTRADICTION_SIM_HIGH = 0.90;
const CONTRADICTION_TRACE_SCORE = 0.6;
const CONFLICT_GROUP_SCORE = 0.8;
const CONTRADICTION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_CONTRADICTIONS_PER_DAY = 3;

// ── Types ────────────────────────────────────────────────────────────────────

type MemoryDoc = Doc<"crystalMemories">;
type EnsembleMembershipDoc = Doc<"organicEnsembleMemberships">;

type ContradictionResult = {
  score: number;
  explanation: string;
  conflictType: "factual" | "temporal" | "opinion" | "scope" | "none";
  suggestedResolution: string;
};

// ── Utilities ────────────────────────────────────────────────────────────────

// ── Gemini API ───────────────────────────────────────────────────────────────

async function checkContradictionPair(
  memA: { title: string; content: string; createdAt: number },
  memB: { title: string; content: string; createdAt: number },
  preset: ModelPreset,
  apiKeyOverride?: string,
): Promise<ContradictionResult & { spend: EstimatedSpend }> {
  const prompt = `You are a contradiction detector. Given two memories from the same user's memory system, determine if they contradict each other.

Memory A:
Title: ${memA.title}
Content: ${memA.content}
Created: ${new Date(memA.createdAt).toISOString()}

Memory B:
Title: ${memB.title}
Content: ${memB.content}
Created: ${new Date(memB.createdAt).toISOString()}

Score the contradiction on this scale:
- 0.0: No contradiction. Compatible or unrelated.
- 0.3: Minor tension. Different emphasis but not conflicting.
- 0.6: Moderate contradiction. Claims that can't both be fully true.
- 0.9: Direct contradiction. Mutually exclusive claims.
- 1.0: Factual conflict. Explicit opposite statements about the same thing.

Respond in JSON:
{
  "score": <number>,
  "explanation": "<one sentence explaining the conflict or lack thereof>",
  "conflictType": "factual" | "temporal" | "opinion" | "scope" | "none",
  "suggestedResolution": "<optional: how to resolve if score > 0.5>"
}`;

  const text = await callOrganicModel(prompt, preset, apiKeyOverride);
  const spend = estimateModelSpend(prompt, text, preset);
  if (!text) {
    return { score: 0, explanation: "LLM unavailable", conflictType: "none", suggestedResolution: "", spend };
  }

  const parsed = parseGeminiJson<unknown>(text);
  const payload = unwrapGeminiObject(parsed);
  if (!payload) {
    console.error(`[organic-contradictions] Failed to parse model response (${text.length} chars)`);
    return { score: 0, explanation: "Parse error", conflictType: "none", suggestedResolution: "", spend };
  }

  const validTypes = new Set<ContradictionResult["conflictType"]>([
    "factual",
    "temporal",
    "opinion",
    "scope",
    "none",
  ]);
  const conflictType: ContradictionResult["conflictType"] =
    typeof payload.conflictType === "string" &&
    validTypes.has(payload.conflictType as ContradictionResult["conflictType"])
      ? (payload.conflictType as ContradictionResult["conflictType"])
      : "none";

  return {
    score: Math.max(0, Math.min(1, typeof payload.score === "number" ? payload.score : 0)),
    explanation: typeof payload.explanation === "string" ? payload.explanation : "",
    conflictType,
    suggestedResolution:
      typeof payload.suggestedResolution === "string" ? payload.suggestedResolution : "",
    spend,
  };
}

function unwrapGeminiObject(parsed: unknown): Record<string, unknown> | null {
  if (isRecord(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed) && parsed.length > 0 && isRecord(parsed[0])) {
    return parsed[0];
  }

  return null;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export const getAlertBudget = internalQuery({
  args: { userId: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicAlertBudget")
      .withIndex("by_user_date", (q) => q.eq("userId", args.userId).eq("date", args.date))
      .first();
  },
});

export const getEnsemblesModifiedSince = internalQuery({
  args: { userId: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicEnsembles")
      .withIndex("by_updated", (q) => q.eq("userId", args.userId).gte("updatedAt", args.since))
      .collect();
  },
});

export const getExistingConflictGroup = internalQuery({
  args: { userId: v.string(), memAId: v.id("crystalMemories"), memBId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    const conflictGroups = await ctx.db
      .query("organicEnsembles")
      .withIndex("by_user_type", (q) =>
        q.eq("userId", args.userId).eq("ensembleType", "conflict_group").eq("archived", false)
      )
      .take(200);

    return conflictGroups.find((g) => {
      const members = new Set(g.memberMemoryIds.map(String));
      return members.has(String(args.memAId)) && members.has(String(args.memBId));
    }) ?? null;
  },
});

// ── Mutations ────────────────────────────────────────────────────────────────

export const incrementAlertBudget = internalMutation({
  args: {
    userId: v.string(),
    date: v.string(),
    field: v.union(v.literal("contradictionsFired"), v.literal("resonancesFired")),
  },
  handler: async (ctx, args) => {
    // Collect all rows (handles duplicate-row race condition by merging)
    const rows = await ctx.db
      .query("organicAlertBudget")
      .withIndex("by_user_date", (q) => q.eq("userId", args.userId).eq("date", args.date))
      .collect();

    if (rows.length === 0) {
      await ctx.db.insert("organicAlertBudget", {
        userId: args.userId,
        date: args.date,
        contradictionsFired: args.field === "contradictionsFired" ? 1 : 0,
        resonancesFired: args.field === "resonancesFired" ? 1 : 0,
        updatedAt: Date.now(),
      });
    } else {
      // Merge all rows into the first (deletes duplicates created by concurrent inserts)
      const primary = rows[0];
      const totalContradictions = rows.reduce((s, r) => s + (r.contradictionsFired ?? 0), 0)
        + (args.field === "contradictionsFired" ? 1 : 0);
      const totalResonances = rows.reduce((s, r) => s + (r.resonancesFired ?? 0), 0)
        + (args.field === "resonancesFired" ? 1 : 0);

      await ctx.db.patch(primary._id, {
        contradictionsFired: totalContradictions,
        resonancesFired: totalResonances,
        updatedAt: Date.now(),
      });
      for (const row of rows.slice(1)) {
        await ctx.db.delete(row._id);
      }
    }
  },
});

export const writeContradictionTrace = internalMutation({
  args: {
    userId: v.string(),
    tickId: v.string(),
    predictedQuery: v.string(),
    predictedContext: v.string(),
    confidence: v.float64(),
    sourceMemoryIds: v.array(v.id("crystalMemories")),
    sourcePattern: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("organicProspectiveTraces", {
      userId: args.userId,
      createdAt: now,
      tickId: args.tickId,
      predictedQuery: args.predictedQuery,
      predictedContext: args.predictedContext,
      traceType: "contradiction",
      confidence: args.confidence,
      expiresAt: now + CONTRADICTION_TTL_MS,
      validated: null,
      sourceMemoryIds: args.sourceMemoryIds,
      sourcePattern: args.sourcePattern,
      accessCount: 0,
      usefulness: 0.0,
    });
  },
});

export const createConflictGroupEnsemble = internalMutation({
  args: {
    userId: v.string(),
    memAId: v.id("crystalMemories"),
    memBId: v.id("crystalMemories"),
    label: v.string(),
    summary: v.string(),
    centroid: v.array(v.float64()),
    tickId: v.string(),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ensembleId = await ctx.db.insert("organicEnsembles", {
      userId: args.userId,
      ensembleType: "conflict_group",
      label: args.label,
      summary: args.summary,
      memberMemoryIds: [args.memAId, args.memBId],
      centroidEmbedding: args.centroid,
      strength: 0.5,
      confidence: 0.5,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
      lastTickId: args.tickId,
      archived: false,
    });

    for (const memoryId of [args.memAId, args.memBId]) {
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

export const updateConflictGroupMetadata = internalMutation({
  args: {
    ensembleId: v.id("organicEnsembles"),
    metadata: v.string(),
    tickId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ensembleId, {
      metadata: args.metadata,
      updatedAt: Date.now(),
      lastTickId: args.tickId,
    });
  },
});

// ── Main Action ──────────────────────────────────────────────────────────────

export const scanContradictions = internalAction({
  args: {
    userId: v.string(),
    lastTickTime: v.number(),
    tickId: v.string(),
    budget: v.number(),
    organicModel: v.optional(v.string()),
    openrouterApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, lastTickTime, tickId, budget } = args;
    const preset = getModelPreset(args.organicModel);
    const apiKeyOverride = args.openrouterApiKey;
    let checksRemaining = budget;
    let checksPerformed = 0;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;
    const findings: DiscoveryFinding[] = [];

    const emptyResult = () => ({
      checksPerformed,
      contradictionsFound: 0,
      findings,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
    });

    // Check daily budget
    const today = todayDateString();
    const alertBudget = await ctx.runQuery(
      internal.crystal.organic.contradictions.getAlertBudget,
      { userId, date: today }
    );
    if ((alertBudget?.contradictionsFired ?? 0) >= MAX_CONTRADICTIONS_PER_DAY) {
      console.log(`[organic-contradictions] ${userId}: daily budget exhausted`);
      return emptyResult();
    }
    let dailyRemaining = MAX_CONTRADICTIONS_PER_DAY - (alertBudget?.contradictionsFired ?? 0);

    // Get ensembles modified since last tick
    const modifiedEnsembles = await ctx.runQuery(
      internal.crystal.organic.contradictions.getEnsemblesModifiedSince,
      { userId, since: lastTickTime }
    );

    if (modifiedEnsembles.length === 0) {
      console.log(`[organic-contradictions] ${userId}: no modified ensembles`);
      return emptyResult();
    }

    let totalContradictions = 0;

    for (const ensemble of modifiedEnsembles) {
      if (checksRemaining <= 0 || dailyRemaining <= 0) break;

      // Fetch all member memories and their memberships
      const allMembers = (await ctx.runQuery(
        internal.crystal.organic.ensembles.getMemoriesByIds,
        { memoryIds: ensemble.memberMemoryIds }
      )).filter((m: MemoryDoc | null): m is MemoryDoc => m !== null && !m.archived);

      const memberships = await ctx.runQuery(
        internal.crystal.organic.ensembles.getMembershipsByEnsemble,
        { ensembleId: ensemble._id }
      );
      const membershipByMemory = new Map<string, EnsembleMembershipDoc>(
        memberships.map((m: EnsembleMembershipDoc) => [String(m.memoryId), m])
      );

      // Split into new vs existing based on when the memory joined the ensemble
      const newMembers = allMembers.filter((m: MemoryDoc) => {
        const membership = membershipByMemory.get(String(m._id));
        const memberJoinedAt = membership?.joinedAt ?? m.createdAt;
        return memberJoinedAt > lastTickTime;
      });
      const existingMembers = allMembers.filter((m: MemoryDoc) => {
        const membership = membershipByMemory.get(String(m._id));
        const memberJoinedAt = membership?.joinedAt ?? m.createdAt;
        return memberJoinedAt <= lastTickTime;
      });

      if (newMembers.length === 0) continue;

      const candidatePairs: Array<[MemoryDoc, MemoryDoc]> = [];

      for (const newMem of newMembers) {
        for (const existingMem of existingMembers) {
          candidatePairs.push([newMem, existingMem]);
        }
      }

      // Also compare memories that both joined since the last tick. Without this,
      // contradictions introduced by the same batch/cluster pass are never seen.
      for (let i = 0; i < newMembers.length; i++) {
        for (let j = i + 1; j < newMembers.length; j++) {
          candidatePairs.push([newMembers[i], newMembers[j]]);
        }
      }

      for (const [newMem, existingMem] of candidatePairs) {
        if (checksRemaining <= 0 || dailyRemaining <= 0) break;

        // Pre-filter: only check pairs in the sweet spot
        const sim = cosineSimilarity(newMem.embedding, existingMem.embedding);
        if (sim > CONTRADICTION_SIM_HIGH || sim < CONTRADICTION_SIM_LOW) continue;

        // LLM contradiction check
        const result = await checkContradictionPair(
          { title: newMem.title, content: newMem.content, createdAt: newMem.createdAt },
          { title: existingMem.title, content: existingMem.content, createdAt: existingMem.createdAt },
          preset,
          apiKeyOverride,
        );
        checksRemaining--;
        checksPerformed++;
        estimatedInputTokens += result.spend.estimatedInputTokens;
        estimatedOutputTokens += result.spend.estimatedOutputTokens;
        estimatedCostUsd += result.spend.estimatedCostUsd;

        if (result.score >= CONTRADICTION_TRACE_SCORE) {
          // Build context for the trace
          const predictedContext = [
            `**Contradiction detected** (${result.conflictType}, score: ${result.score.toFixed(2)})`,
            ``,
            `Memory A: "${newMem.title}" — ${newMem.content.slice(0, 150)}`,
            `Memory B: "${existingMem.title}" — ${existingMem.content.slice(0, 150)}`,
            ``,
            `Explanation: ${result.explanation}`,
            result.suggestedResolution ? `Suggested resolution: ${result.suggestedResolution}` : "",
          ].filter(Boolean).join("\n");

          // Write contradiction trace
          await ctx.runMutation(
            internal.crystal.organic.contradictions.writeContradictionTrace,
            {
              userId,
              tickId,
              predictedQuery: `Contradiction: ${result.explanation}`,
              predictedContext,
              confidence: result.score,
              sourceMemoryIds: [newMem._id, existingMem._id],
              sourcePattern: `Detected ${result.conflictType} contradiction within ensemble "${ensemble.label}"`,
            }
          );
          findings.push({
            predictedQuery: `Contradiction: ${result.explanation}`,
            predictedContext,
            confidence: result.score,
            sourceMemoryIds: [newMem._id, existingMem._id],
          });

          // Increment daily budget
          await ctx.runMutation(
            internal.crystal.organic.contradictions.incrementAlertBudget,
            { userId, date: today, field: "contradictionsFired" }
          );
          dailyRemaining--;
          totalContradictions++;

          // Create/update conflict_group ensemble for high-scoring pairs
          if (result.score >= CONFLICT_GROUP_SCORE) {
            const existing = await ctx.runQuery(
              internal.crystal.organic.contradictions.getExistingConflictGroup,
              { userId, memAId: newMem._id, memBId: existingMem._id }
            );

            const metadata = JSON.stringify({
              conflictType: result.conflictType,
              score: result.score,
              explanation: result.explanation,
              suggestedResolution: result.suggestedResolution,
              detectedAt: Date.now(),
            });

            if (existing) {
              await ctx.runMutation(
                internal.crystal.organic.contradictions.updateConflictGroupMetadata,
                { ensembleId: existing._id, metadata, tickId }
              );
            } else {
              const centroid = averageEmbeddings([newMem.embedding, existingMem.embedding]);
              await ctx.runMutation(
                internal.crystal.organic.contradictions.createConflictGroupEnsemble,
                {
                  userId,
                  memAId: newMem._id,
                  memBId: existingMem._id,
                  label: `Conflict: ${result.explanation.slice(0, 50)}`,
                  summary: result.explanation,
                  centroid,
                  tickId,
                  metadata,
                }
              );
            }
          }
        }
      }
    }

    console.log(
      `[organic-contradictions] ${userId}: ${budget - checksRemaining} checks, ${totalContradictions} contradictions found`
    );

    return {
      checksPerformed,
      contradictionsFound: totalContradictions,
      findings,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
    };
  },
});
