import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Doc, Id } from "../../_generated/dataModel";
import { todayDateString, callOrganicModel, isRecord, parseGeminiJson, vectorSearchUserFilter } from "./utils";
import { estimateModelSpend, type EstimatedSpend } from "./spend";
import { getModelPreset, type ModelPreset } from "./models";
import { type DiscoveryFinding } from "./discoveryFiber";

const RESONANCE_SIM_LOW = 0.65;
const RESONANCE_SIM_HIGH = 0.85;
const RESONANCE_MIN_SOURCES = 3;
const RESONANCE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_RESONANCES_PER_DAY = 2;

// ── Types ────────────────────────────────────────────────────────────────────

type EnsembleDoc = Doc<"organicEnsembles">;

type ResonanceResult = {
  isResonance: boolean;
  theme: string;
  confidence: number;
  insight: string;
  actionable: boolean;
};

// ── Gemini API ───────────────────────────────────────────────────────────────

async function verifyResonance(
  ensemble1: { label: string; summary: string },
  ensemble2: { label: string; summary: string },
  ensemble3: { label: string; summary: string },
  preset: ModelPreset,
  apiKeyOverride?: string,
): Promise<ResonanceResult & { spend: EstimatedSpend }> {
  const prompt = `You are a resonance detector. Given these memory clusters from the same user, determine if they share an underlying theme the user hasn't explicitly stated.

Cluster 1: "${ensemble1.label}" — ${ensemble1.summary}
Cluster 2: "${ensemble2.label}" — ${ensemble2.summary}
Cluster 3: "${ensemble3.label}" — ${ensemble3.summary}

Is there a meaningful cross-cutting pattern? Respond in JSON:
{
  "isResonance": true/false,
  "theme": "<the underlying pattern>",
  "confidence": 0.0-1.0,
  "insight": "<what this means for the user>",
  "actionable": true/false
}`;

  const text = await callOrganicModel(prompt, preset, apiKeyOverride);
  const spend = estimateModelSpend(prompt, text, preset);
  if (!text) {
    return { isResonance: false, theme: "", confidence: 0, insight: "", actionable: false, spend };
  }

  const parsed = parseGeminiJson<unknown>(text);
  const payload = unwrapGeminiObject(parsed);
  if (!payload) {
    console.error(`[organic-resonance] Failed to parse Gemini response: ${text.slice(0, 200)}`);
    return { isResonance: false, theme: "", confidence: 0, insight: "", actionable: false, spend };
  }

  return {
    isResonance: !!payload.isResonance,
    theme: typeof payload.theme === "string" ? payload.theme : "",
    confidence: Math.max(0, Math.min(1, typeof payload.confidence === "number" ? payload.confidence : 0)),
    insight: typeof payload.insight === "string" ? payload.insight : "",
    actionable: !!payload.actionable,
    spend,
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────

export const writeResonanceTrace = internalMutation({
  args: {
    userId: v.string(),
    tickId: v.string(),
    predictedQuery: v.string(),
    predictedContext: v.string(),
    confidence: v.float64(),
    sourceMemoryIds: v.array(v.id("crystalMemories")),
    sourcePattern: v.string(),
    resonanceCluster: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("organicProspectiveTraces", {
      userId: args.userId,
      createdAt: now,
      tickId: args.tickId,
      predictedQuery: args.predictedQuery,
      predictedContext: args.predictedContext,
      traceType: "resonance",
      confidence: args.confidence,
      expiresAt: now + RESONANCE_TTL_MS,
      validated: null,
      sourceMemoryIds: args.sourceMemoryIds,
      sourcePattern: args.sourcePattern,
      accessCount: 0,
      usefulness: 0.0,
      resonanceCluster: args.resonanceCluster,
    });
  },
});

export const getRecentResonanceForCluster = internalQuery({
  args: { userId: v.string(), resonanceCluster: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    const traces = await ctx.db
      .query("organicProspectiveTraces")
      .withIndex("by_user_expires", (q) =>
        q.eq("userId", args.userId).gt("expiresAt", args.since)
      )
      .take(200);
    return traces.find(
      (t) => t.traceType === "resonance" && t.resonanceCluster === args.resonanceCluster
    ) ?? null;
  },
});

// ── Main Action ──────────────────────────────────────────────────────────────

export const detectResonance = internalAction({
  args: {
    userId: v.string(),
    tickId: v.string(),
    budget: v.number(),
    organicModel: v.optional(v.string()),
    openrouterApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, tickId, budget } = args;
    const preset = getModelPreset(args.organicModel);
    const apiKeyOverride = args.openrouterApiKey;
    let verificationsRemaining = budget;
    let verificationsPerformed = 0;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;
    const findings: DiscoveryFinding[] = [];

    const emptyResult = () => ({
      verificationsPerformed,
      resonancesFound: 0,
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
    if ((alertBudget?.resonancesFired ?? 0) >= MAX_RESONANCES_PER_DAY) {
      console.log(`[organic-resonance] ${userId}: daily budget exhausted`);
      return emptyResult();
    }
    let dailyRemaining = MAX_RESONANCES_PER_DAY - (alertBudget?.resonancesFired ?? 0);

    // Get all active ensembles
    const ensembles = await ctx.runQuery(
      internal.crystal.organic.ensembles.getEnsemblesForUser,
      { userId }
    );

    if (ensembles.length < RESONANCE_MIN_SOURCES) {
      console.log(`[organic-resonance] ${userId}: not enough ensembles (${ensembles.length})`);
      return emptyResult();
    }

    // Track which ensemble sets we've already checked to avoid dupes
    const checkedSets = new Set<string>();
    let totalResonances = 0;

    for (const ensemble of ensembles) {
      if (verificationsRemaining <= 0 || dailyRemaining <= 0) break;

      // Vector search for moderately-similar peers
      const peers = (await ctx.vectorSearch("organicEnsembles", "by_centroid", {
        vector: ensemble.centroidEmbedding,
        limit: 20,
        filter: vectorSearchUserFilter(userId),
      })) as Array<{ _id: Id<"organicEnsembles">; _score: number }>;

      const resonantPeers = peers.filter(
        (p) =>
          p._score >= RESONANCE_SIM_LOW &&
          p._score <= RESONANCE_SIM_HIGH &&
          String(p._id) !== String(ensemble._id)
      );

      if (resonantPeers.length < RESONANCE_MIN_SOURCES - 1) continue;

      // Take the top peers for verification
      const topPeers = resonantPeers.slice(0, RESONANCE_MIN_SOURCES - 1);
      const peerIds = [String(ensemble._id), ...topPeers.map((p) => String(p._id))].sort();
      const setKey = peerIds.join("|");

      if (checkedSets.has(setKey)) continue;
      checkedSets.add(setKey);

      // Skip if a resonance trace for this cluster already exists (cross-tick dedup)
      const existingResonance = await ctx.runQuery(
        internal.crystal.organic.resonance.getRecentResonanceForCluster,
        { userId, resonanceCluster: setKey, since: Date.now() - 24 * 60 * 60 * 1000 }
      );
      if (existingResonance) continue;

      // Fetch peer ensemble docs
      const peerEnsembles = (await ctx.runQuery(
        internal.crystal.organic.ensembles.getEnsemblesByIds,
        { ensembleIds: topPeers.map((p) => p._id) }
      )).filter((e: EnsembleDoc | null): e is EnsembleDoc => e !== null && !e.archived);

      if (peerEnsembles.length < RESONANCE_MIN_SOURCES - 1) continue;

      // LLM verification — always pass 3 distinct ensembles
      const result = await verifyResonance(
        { label: ensemble.label, summary: ensemble.summary },
        { label: peerEnsembles[0].label, summary: peerEnsembles[0].summary },
        { label: peerEnsembles[1].label, summary: peerEnsembles[1].summary },
        preset,
        apiKeyOverride,
      );
      verificationsRemaining--;
      verificationsPerformed++;
      estimatedInputTokens += result.spend.estimatedInputTokens;
      estimatedOutputTokens += result.spend.estimatedOutputTokens;
      estimatedCostUsd += result.spend.estimatedCostUsd;

      if (result.isResonance && result.confidence >= 0.5) {
        // Collect source memory IDs from all resonant ensembles (first from each)
        const allEnsembles = [ensemble, ...peerEnsembles];
        const sourceMemoryIds: Id<"crystalMemories">[] = [];
        for (const e of allEnsembles) {
          if (e.memberMemoryIds.length > 0) {
            sourceMemoryIds.push(e.memberMemoryIds[0]);
          }
        }

        const ensembleLabels = allEnsembles.map((e) => `"${e.label}"`).join(", ");
        const predictedContext = [
          `**Resonance detected** across ${allEnsembles.length} memory clusters (confidence: ${result.confidence.toFixed(2)})`,
          ``,
          `Theme: ${result.theme}`,
          `Clusters: ${ensembleLabels}`,
          ``,
          `Insight: ${result.insight}`,
          result.actionable ? `This pattern appears actionable.` : "",
        ].filter(Boolean).join("\n");

        await ctx.runMutation(
          internal.crystal.organic.resonance.writeResonanceTrace,
          {
            userId,
            tickId,
            predictedQuery: `Resonance: ${result.theme}`,
            predictedContext,
            confidence: result.confidence,
            sourceMemoryIds,
            sourcePattern: `Cross-cluster resonance detected across ${ensembleLabels}`,
            resonanceCluster: setKey,
          }
        );
        findings.push({
          predictedQuery: `Resonance: ${result.theme}`,
          predictedContext,
          confidence: result.confidence,
          sourceMemoryIds,
        });

        // Increment daily budget
        await ctx.runMutation(
          internal.crystal.organic.contradictions.incrementAlertBudget,
          { userId, date: today, field: "resonancesFired" }
        );
        dailyRemaining--;
        totalResonances++;
      }
    }

    console.log(
      `[organic-resonance] ${userId}: ${budget - verificationsRemaining} verifications, ${totalResonances} resonances found`
    );

    return {
      verificationsPerformed,
      resonancesFound: totalResonances,
      findings,
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
