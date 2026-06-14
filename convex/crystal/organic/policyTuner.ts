import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import {
  defaultRecallRankingWeights,
  scoreRecallCandidate,
  type RecallRankingWeights,
} from "../recallRanking";

const MIN_WEIGHT = 0.02;
const MAX_WEIGHT = 0.5;
const CANDIDATE_COUNT = 4;
const TUNING_SAMPLE_LIMIT = 50;
const POLICY_TUNE_INTERVAL = 24 * 60 * 60 * 1000;
const policyTunerApi = ((internal as any).crystal.organic.policyTuner) as any;
const replayEvalApi = ((internal as any).crystal.organic.replayEval) as any;

const weightKeys = [
  "vectorWeight",
  "strengthWeight",
  "freshnessWeight",
  "accessWeight",
  "salienceWeight",
  "continuityWeight",
  "textMatchWeight",
  "knowledgeBaseWeight",
] as const;

export type RecallPolicyWeights = RecallRankingWeights;

const weightsValidator = v.object({
  vectorWeight: v.float64(),
  strengthWeight: v.float64(),
  freshnessWeight: v.float64(),
  accessWeight: v.float64(),
  salienceWeight: v.float64(),
  continuityWeight: v.float64(),
  textMatchWeight: v.float64(),
  knowledgeBaseWeight: v.optional(v.float64()),
});

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const pickWeights = (doc: Partial<RecallPolicyWeights>): RecallPolicyWeights => ({
  vectorWeight: doc.vectorWeight ?? defaultRecallRankingWeights.vectorWeight,
  strengthWeight: doc.strengthWeight ?? defaultRecallRankingWeights.strengthWeight,
  freshnessWeight: doc.freshnessWeight ?? defaultRecallRankingWeights.freshnessWeight,
  accessWeight: doc.accessWeight ?? defaultRecallRankingWeights.accessWeight,
  salienceWeight: doc.salienceWeight ?? defaultRecallRankingWeights.salienceWeight,
  continuityWeight: doc.continuityWeight ?? defaultRecallRankingWeights.continuityWeight,
  textMatchWeight: doc.textMatchWeight ?? defaultRecallRankingWeights.textMatchWeight,
  knowledgeBaseWeight: doc.knowledgeBaseWeight ?? defaultRecallRankingWeights.knowledgeBaseWeight,
});

export const normalizePolicyWeights = (weights: RecallPolicyWeights): RecallPolicyWeights => {
  const current = { ...pickWeights(weights) } as Record<(typeof weightKeys)[number], number>;
  const fixed = new Set<(typeof weightKeys)[number]>();
  let remaining = 1;

  while (fixed.size < weightKeys.length) {
    const freeKeys = weightKeys.filter((key) => !fixed.has(key));
    const freeSum = freeKeys.reduce((sum, key) => sum + Math.max(current[key], 0), 0) || freeKeys.length;
    let boundedKey: (typeof weightKeys)[number] | null = null;

    for (const key of freeKeys) {
      const proposed = (Math.max(current[key], 0) / freeSum) * remaining;
      if (proposed < MIN_WEIGHT) {
        current[key] = MIN_WEIGHT;
        fixed.add(key);
        remaining -= MIN_WEIGHT;
        boundedKey = key;
        break;
      }
      if (proposed > MAX_WEIGHT) {
        current[key] = MAX_WEIGHT;
        fixed.add(key);
        remaining -= MAX_WEIGHT;
        boundedKey = key;
        break;
      }
    }

    if (boundedKey) {
      continue;
    }

    for (const key of freeKeys) {
      current[key] = (Math.max(current[key], 0) / freeSum) * remaining;
    }
    break;
  }

  const final = weightKeys.reduce((acc, key) => {
    acc[key] = clamp(current[key], MIN_WEIGHT, MAX_WEIGHT);
    return acc;
  }, {} as Record<(typeof weightKeys)[number], number>);

  const total = weightKeys.reduce((sum, key) => sum + final[key], 0);
  const diff = 1 - total;
  final.vectorWeight = clamp(final.vectorWeight + diff, MIN_WEIGHT, MAX_WEIGHT);

  return final;
};

export const shouldPromotePolicy = (baselineScore: number, candidateScore: number) => {
  if (candidateScore <= baselineScore) {
    return false;
  }
  const threshold = baselineScore <= 0 ? 0.05 : baselineScore * 1.05;
  return candidateScore > threshold;
};

const sampleWithoutReplacement = <T>(items: readonly T[], count: number, random: () => number) => {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length > 0 && out.length < count) {
    const index = Math.floor(random() * pool.length);
    out.push(pool.splice(index, 1)[0]);
  }
  return out;
};

export const generateCandidateWeights = (
  weights: RecallPolicyWeights,
  random: () => number = Math.random
) => {
  const candidates: RecallPolicyWeights[] = [];
  for (let index = 0; index < CANDIDATE_COUNT; index += 1) {
    const next = { ...weights } as Record<(typeof weightKeys)[number], number>;
    const keys = sampleWithoutReplacement(weightKeys, 2 + Math.floor(random() * 2), random);
    for (const key of keys) {
      const direction = random() >= 0.5 ? 1.15 : 0.85;
      next[key] = clamp(next[key] * direction, MIN_WEIGHT, MAX_WEIGHT);
    }
    candidates.push(normalizePolicyWeights(next));
  }
  return candidates;
};

type PolicyEvaluationSample = {
  query: string;
  createdAt: number;
  resultCount: number;
  topResultIds: string[];
  relevantMemoryIds: string[];
  activities: Array<{ memoryId: string; timestamp: number }>;
  candidates: Array<{
    memoryId: string;
    title: string;
    content: string;
    store: string;
    category: string;
    tags: string[];
    strength: number;
    confidence: number;
    accessCount: number;
    lastAccessedAt: number;
    createdAt: number;
    salienceScore?: number;
    channel?: string;
    vectorScore?: number;
    textMatchScore?: number;
  }>;
};

type PolicyEvaluationCandidate = PolicyEvaluationSample["candidates"][number];

type ActivityWindowResult = {
  events: Array<{ memoryId: string; eventType: string; timestamp: number }>;
  truncated: boolean;
};

export const getActivePolicyState = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const active = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId).eq("status", "active"))
      .first();

    if (!active) {
      return {
        weights: defaultRecallRankingWeights,
        generation: 1,
        locked: false,
        source: "default" as const,
      };
    }

    return {
      policyId: active._id,
      weights: pickWeights(active),
      generation: active.generation,
      locked: active.locked,
      source: "policy" as const,
      compositeScore: active.compositeScore,
    };
  },
});

export const getActivePolicyWeights = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const active = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId).eq("status", "active"))
      .first();
    if (!active) return defaultRecallRankingWeights;
    return pickWeights(active);
  },
});

export const getRecentPolicySamples = internalQuery({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? TUNING_SAMPLE_LIMIT, TUNING_SAMPLE_LIMIT);
    return ctx.db
      .query("organicRecallLog")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(limit)
      .then((rows) => rows.filter((row) => row.topResultIds.length > 0));
  },
});

export const touchLastPolicyTuneAt = internalMutation({
  args: { userId: v.string(), timestamp: v.number() },
  handler: async (ctx, args) => {
    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (tickState) {
      await ctx.db.patch(tickState._id, {
        lastPolicyTuneAt: args.timestamp,
        updatedAt: args.timestamp,
      });
    }
  },
});

export const claimPolicyTuneWindow = internalMutation({
  args: { userId: v.string(), interval: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const tickState = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (!tickState) return { claimed: false };
    if (tickState.lastPolicyTuneAt && now - tickState.lastPolicyTuneAt < args.interval) {
      return { claimed: false };
    }
    await ctx.db.patch(tickState._id, { lastPolicyTuneAt: now, updatedAt: now });
    return { claimed: true };
  },
});

export const promotePolicy = internalMutation({
  args: {
    userId: v.string(),
    generation: v.number(),
    weights: weightsValidator,
    compositeScore: v.optional(v.float64()),
    policyId: v.optional(v.id("organicRecallPolicies")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const active = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId).eq("status", "active"))
      .first();
    const nextGeneration = active ? active.generation + 1 : 1;

    if (args.policyId) {
      const nominatedPolicy = await ctx.db.get(args.policyId);
      if (!nominatedPolicy || nominatedPolicy.userId !== args.userId) {
        throw new Error("Policy not found");
      }
    }

    if (active) {
      await ctx.db.patch(active._id, {
        status: "rejected",
        updatedAt: now,
      });
    }

    const sameGeneration = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_generation", (q) => q.eq("userId", args.userId).eq("generation", nextGeneration))
      .collect();

    for (const policy of sameGeneration) {
      await ctx.db.patch(policy._id, {
        status: args.policyId && policy._id === args.policyId ? "active" : "rejected",
        generation: nextGeneration,
        parentGeneration: active?.generation,
        compositeScore: args.policyId && policy._id === args.policyId ? args.compositeScore : policy.compositeScore,
        promotedAt: args.policyId && policy._id === args.policyId ? now : policy.promotedAt,
        evaluatedAt: policy.evaluatedAt ?? now,
        locked: args.policyId && policy._id === args.policyId ? active?.locked ?? false : policy.locked,
        updatedAt: now,
      });
    }

    if (!args.policyId) {
      await ctx.db.insert("organicRecallPolicies", {
        userId: args.userId,
        ...normalizePolicyWeights(args.weights),
        generation: nextGeneration,
        compositeScore: args.compositeScore,
        evaluatedAt: now,
        promotedAt: now,
        parentGeneration: active?.generation,
        status: "active",
        locked: active?.locked ?? false,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { newGeneration: nextGeneration };
  },
});

export const lockPolicyWeights = internalMutation({
  args: { userId: v.string(), locked: v.boolean() },
  handler: async (ctx, args) => {
    const active = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId).eq("status", "active"))
      .first();
    if (!active) {
      return { updated: false };
    }
    await ctx.db.patch(active._id, {
      locked: args.locked,
      updatedAt: Date.now(),
    });
    return { updated: true };
  },
});

const buildPolicyEvaluationSample = async (
  ctx: any,
  userId: string,
  sample: {
    query: string;
    createdAt: number;
    resultCount: number;
    topResultIds: Array<any>;
    candidateSignals?: Array<{
      memoryId: any;
      strength: number;
      confidence: number;
      accessCount: number;
      lastAccessedAt?: number;
      createdAt: number;
      salienceScore?: number;
      vectorScore?: number;
      textMatchScore?: number;
    }>;
  }
): Promise<PolicyEvaluationSample | null> => {
  const topResultIds: string[] = sample.topResultIds.map((value) => String(value));
  let candidates: PolicyEvaluationCandidate[] = [];

  if (sample.candidateSignals?.length) {
    candidates = sample.candidateSignals.map((candidate) => ({
      memoryId: String(candidate.memoryId),
      title: "",
      content: "",
      store: "semantic",
      category: "fact",
      tags: [],
      strength: candidate.strength,
      confidence: candidate.confidence,
      accessCount: candidate.accessCount,
      lastAccessedAt: candidate.lastAccessedAt ?? candidate.createdAt,
      createdAt: candidate.createdAt,
      salienceScore: candidate.salienceScore,
      vectorScore: candidate.vectorScore,
      textMatchScore: candidate.textMatchScore,
    }));
  } else {
    const memoryDocs = (
      await Promise.all(
        topResultIds.map((memoryId) =>
          ctx.runQuery(internal.crystal.memories.getMemoryInternal, { memoryId: memoryId as any })
        )
      )
    ).filter(Boolean);
    if (memoryDocs.length === 0) {
      return null;
    }
    candidates = memoryDocs.map((doc: any) => ({
      memoryId: String(doc._id),
      title: doc.title,
      content: doc.content,
      store: doc.store,
      category: doc.category,
      tags: doc.tags ?? [],
      strength: doc.strength ?? 0,
      confidence: doc.confidence ?? 0,
      accessCount: doc.accessCount ?? 0,
      lastAccessedAt: doc.lastAccessedAt,
      createdAt: doc.createdAt,
      salienceScore: doc.salienceScore,
      channel: doc.channel,
    }));
  }

  const activityWindowResult = await ctx.runQuery(replayEvalApi.getActivityWindow, {
    userId,
    start: sample.createdAt,
    end: sample.createdAt + 30 * 60 * 1000,
  });
  const activityWindow: ActivityWindowResult = Array.isArray(activityWindowResult)
    ? { events: activityWindowResult, truncated: false }
    : activityWindowResult;
  const relevantMemoryIds: string[] = Array.from(
    new Set<string>(
      activityWindow.events
        .filter((activity: any) => activity.eventType === "memory_recalled" || activity.eventType === "memory_stored")
        .map((activity: any) => String(activity.memoryId))
    )
  );

  return {
    query: sample.query,
    createdAt: sample.createdAt,
    resultCount: sample.resultCount,
    topResultIds,
    relevantMemoryIds,
    activities: activityWindow.events.map((activity: any) => ({
      memoryId: String(activity.memoryId),
      timestamp: activity.timestamp,
    })),
    candidates,
  };
};

const evaluatePolicyWeights = (weights: RecallPolicyWeights, samples: PolicyEvaluationSample[]) => {
  if (samples.length === 0) {
    return 0;
  }
  const total = samples.reduce((sum, sample) => {
    const rerankedIds = sample.candidates
      .map((candidate) =>
        scoreRecallCandidate(candidate, {
          now: sample.createdAt + 30 * 60 * 1000,
          query: sample.query,
          weights,
        })
      )
      .sort((a, b) => b.scoreValue - a.scoreValue)
      .slice(0, Math.max(1, sample.resultCount))
      .map((candidate) => candidate.memoryId);
    const replayScore = sample.relevantMemoryIds.length === 0
      ? 0
      : (() => {
          const relevantSet = new Set(sample.relevantMemoryIds);
          const hits = rerankedIds.filter((memoryId) => relevantSet.has(memoryId));
          const hitCount = hits.length;
          const missedCount = sample.relevantMemoryIds.filter((memoryId) => !rerankedIds.includes(memoryId)).length;
          const grounding = hitCount / Math.max(rerankedIds.length, 1);
          const coverage = hitCount + missedCount > 0 ? hitCount / (hitCount + missedCount) : 0;
          return grounding * 0.5 + coverage * 0.5;
        })();
    return sum + replayScore;
  }, 0);
  return total / samples.length;
};

export const runPolicyTuning = internalAction({
  args: { userId: v.string(), organicModel: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.runQuery(policyTunerApi.getActivePolicyState, {
      userId: args.userId,
    });

    if (state.locked) {
      return {
        evaluated: 0,
        promoted: false,
        scores: [],
        skippedReason: "locked" as const,
      };
    }

    const recentSamples = await ctx.runQuery(policyTunerApi.getRecentPolicySamples, {
      userId: args.userId,
      limit: TUNING_SAMPLE_LIMIT,
    });
    const evaluationSamples = (
      await Promise.all(
        recentSamples.map((sample: any) => buildPolicyEvaluationSample(ctx, args.userId, sample))
      )
    ).filter((sample): sample is PolicyEvaluationSample => sample !== null);

    if (evaluationSamples.length === 0) {
      return {
        evaluated: 0,
        promoted: false,
        scores: [],
      };
    }

    const claim = await ctx.runMutation(policyTunerApi.claimPolicyTuneWindow, {
      userId: args.userId,
      interval: POLICY_TUNE_INTERVAL,
    });
    if (!claim.claimed) {
      return {
        evaluated: 0,
        promoted: false,
        scores: [],
        skippedReason: "interval" as const,
      };
    }

    const baselineWeights = pickWeights(state.weights);
    const baselineScore = evaluatePolicyWeights(baselineWeights, evaluationSamples);
    const candidateGeneration = state.source === "policy" ? state.generation + 1 : 1;
    const candidates = generateCandidateWeights(baselineWeights);
    const insertedCandidates = [];

    for (const weights of candidates) {
      const compositeScore = evaluatePolicyWeights(weights, evaluationSamples);
      const policyId = await ctx.runMutation(policyTunerApi.storeCandidatePolicy, {
        userId: args.userId,
        generation: candidateGeneration,
        parentGeneration: state.source === "policy" ? state.generation : undefined,
        weights,
        compositeScore,
      });
      insertedCandidates.push({ policyId, weights, compositeScore });
    }

    const best = [...insertedCandidates].sort((a, b) => b.compositeScore - a.compositeScore)[0];
    let promoted = false;
    let newGeneration: number | undefined;

    if (best && shouldPromotePolicy(baselineScore, best.compositeScore)) {
      const result = await ctx.runMutation(policyTunerApi.promotePolicy, {
        userId: args.userId,
        generation: candidateGeneration,
        weights: best.weights,
        compositeScore: best.compositeScore,
        policyId: best.policyId,
      });
      promoted = true;
      newGeneration = result.newGeneration;
    } else {
      await ctx.runMutation(policyTunerApi.rejectCandidateGeneration, {
        userId: args.userId,
        generation: candidateGeneration,
      });
    }

    return {
      evaluated: evaluationSamples.length,
      promoted,
      newGeneration,
      scores: insertedCandidates.map((candidate) => candidate.compositeScore),
      baselineScore,
    };
  },
});

export const storeCandidatePolicy = internalMutation({
  args: {
    userId: v.string(),
    generation: v.number(),
    parentGeneration: v.optional(v.number()),
    weights: weightsValidator,
    compositeScore: v.float64(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return ctx.db.insert("organicRecallPolicies", {
      userId: args.userId,
      ...normalizePolicyWeights(args.weights),
      generation: args.generation,
      compositeScore: args.compositeScore,
      evaluatedAt: now,
      promotedAt: undefined,
      parentGeneration: args.parentGeneration,
      status: "evaluating",
      locked: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rejectCandidateGeneration = internalMutation({
  args: { userId: v.string(), generation: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_generation", (q) => q.eq("userId", args.userId).eq("generation", args.generation))
      .collect();
    const now = Date.now();
    for (const row of rows) {
      if (row.status !== "active") {
        await ctx.db.patch(row._id, {
          status: "rejected",
          updatedAt: now,
        });
      }
    }
  },
});

export { POLICY_TUNE_INTERVAL };
