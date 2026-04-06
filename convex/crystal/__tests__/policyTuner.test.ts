import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import {
  normalizePolicyWeights,
  shouldPromotePolicy,
  type RecallPolicyWeights,
} from "../organic/policyTuner";
import { defaultRecallRankingWeights } from "../recallRanking";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/memories": () => import("../memories"),
  "crystal/organic/policyTuner": () => import("../organic/policyTuner"),
  "crystal/organic/replayEval": () => import("../organic/replayEval"),
  "crystal/organic/traces": () => import("../organic/traces"),
};

const baseWeights: RecallPolicyWeights = {
  vectorWeight: 0.3,
  strengthWeight: 0.22,
  freshnessWeight: 0.15,
  accessWeight: 0.06,
  salienceWeight: 0.14,
  continuityWeight: 0.08,
  textMatchWeight: 0.05,
};
const policyTunerApi = ((internal as any).crystal.organic.policyTuner) as any;
const tracesApi = ((internal as any).crystal.organic.traces) as any;

describe("policy tuner helpers", () => {
  it("normalizes perturbed weights so they stay within bounds and sum to one", () => {
    const normalized = normalizePolicyWeights({
      vectorWeight: 0.9,
      strengthWeight: 0.001,
      freshnessWeight: 0.001,
      accessWeight: 0.001,
      salienceWeight: 0.001,
      continuityWeight: 0.001,
      textMatchWeight: 0.001,
    });

    const values = Object.values(normalized);
    const total = values.reduce((sum, value) => sum + value, 0);

    expect(total).toBeCloseTo(1, 8);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0.02);
    expect(Math.max(...values)).toBeLessThanOrEqual(0.5);
  });

  it("requires strictly greater than five percent improvement to promote", () => {
    expect(shouldPromotePolicy(0.5, 0.525)).toBe(false);
    expect(shouldPromotePolicy(0.5, 0.526)).toBe(true);
  });
});

describe("policy tuner integrations", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("starts policy generations at 1 and increments on each promotion", async () => {
    const first = await t.mutation(policyTunerApi.promotePolicy, {
      userId: "policy-user",
      generation: 999,
      weights: baseWeights,
      compositeScore: 0.61,
    });

    expect(first.newGeneration).toBe(1);

    const second = await t.mutation(policyTunerApi.promotePolicy, {
      userId: "policy-user",
      generation: 999,
      weights: normalizePolicyWeights({
        ...baseWeights,
        vectorWeight: 0.34,
        textMatchWeight: 0.09,
      }),
      compositeScore: 0.68,
    });

    expect(second.newGeneration).toBe(2);

    const docs = (await t.run((ctx) =>
      (ctx.db as any)
        .query("organicRecallPolicies")
        .withIndex("by_user_generation", (q: any) => q.eq("userId", "policy-user"))
        .collect()
    )) as Array<{ generation: number; status: string }>;

    const generations = docs
      .map((doc) => ({ generation: doc.generation, status: doc.status }))
      .sort((a, b) => a.generation - b.generation);

    expect(generations).toEqual([
      { generation: 1, status: "rejected" },
      { generation: 2, status: "active" },
    ]);
  });

  it("skips tuning when the active policy is locked", async () => {
    await t.mutation(policyTunerApi.promotePolicy, {
      userId: "locked-user",
      generation: 123,
      weights: baseWeights,
      compositeScore: 0.6,
    });

    await t.mutation(policyTunerApi.lockPolicyWeights, {
      userId: "locked-user",
      locked: true,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("organicTickState", {
        userId: "locked-user",
        lastTickAt: 0,
        lastTickId: "tick-locked",
        tickCount: 0,
        totalTracesGenerated: 0,
        totalTracesValidated: 0,
        hitRate: 0,
        enabled: true,
        tickIntervalMs: 60_000,
        lastPolicyTuneAt: undefined,
        isRunning: false,
        updatedAt: 0,
      });
    });

    const result = await t.action(policyTunerApi.runPolicyTuning, {
      userId: "locked-user",
      organicModel: "gemini-2.5-flash",
    });

    expect(result).toMatchObject({
      evaluated: 0,
      promoted: false,
      skippedReason: "locked",
    });
  });

  it("returns active policy weights directly from the active row", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("organicRecallPolicies", {
        userId: "weights-user",
        ...defaultRecallRankingWeights,
        vectorWeight: 0.31,
        strengthWeight: 0.21,
        freshnessWeight: 0.14,
        accessWeight: 0.07,
        salienceWeight: 0.13,
        continuityWeight: 0.09,
        textMatchWeight: 0.05,
        generation: 3,
        status: "active",
        locked: false,
        createdAt: 100,
        updatedAt: 100,
      });
    });

    const weights = await t.query(policyTunerApi.getActivePolicyWeights, {
      userId: "weights-user",
    });

    expect(weights).toEqual({
      vectorWeight: 0.31,
      strengthWeight: 0.21,
      freshnessWeight: 0.14,
      accessWeight: 0.07,
      salienceWeight: 0.13,
      continuityWeight: 0.09,
      textMatchWeight: 0.05,
      knowledgeBaseWeight: 0.06,
    });
  });

  it("rejects promotePolicy when a requested policyId is invalid", async () => {
    await t.mutation(policyTunerApi.promotePolicy, {
      userId: "invalid-policy-user",
      generation: 1,
      weights: baseWeights,
      compositeScore: 0.61,
    });

    await expect(
      t.mutation(policyTunerApi.promotePolicy, {
        userId: "invalid-policy-user",
        generation: 2,
        weights: baseWeights,
        compositeScore: 0.7,
        policyId: "k17abcdefghijklmnopqrstuvwxys123456" as any,
      })
    ).rejects.toThrow();

    const activePolicies = (await t.run((ctx) =>
      (ctx.db as any)
        .query("organicRecallPolicies")
        .withIndex("by_user_status", (q: any) =>
          q.eq("userId", "invalid-policy-user").eq("status", "active")
        )
        .collect()
    )) as Array<{ generation: number; status: string }>;

    expect(activePolicies).toHaveLength(1);
    expect(activePolicies[0]).toMatchObject({ generation: 1, status: "active" });
  });

  it("allows only the first claim inside a tuning window", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("organicTickState", {
        userId: "claim-user",
        lastTickAt: 0,
        lastTickId: "tick-0",
        tickCount: 0,
        totalTracesGenerated: 0,
        totalTracesValidated: 0,
        hitRate: 0,
        enabled: true,
        tickIntervalMs: 60_000,
        lastPolicyTuneAt: undefined,
        isRunning: false,
        updatedAt: 0,
      });
    });

    const first = await t.mutation(policyTunerApi.claimPolicyTuneWindow, {
      userId: "claim-user",
      interval: 24 * 60 * 60 * 1000,
    });
    const second = await t.mutation(policyTunerApi.claimPolicyTuneWindow, {
      userId: "claim-user",
      interval: 24 * 60 * 60 * 1000,
    });

    expect(first).toEqual({ claimed: true });
    expect(second).toEqual({ claimed: false });
  });

  it("does not stamp the tuning window when evaluation is skipped for lack of samples", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("organicTickState", {
        userId: "no-sample-user",
        lastTickAt: 0,
        lastTickId: "tick-0",
        tickCount: 0,
        totalTracesGenerated: 0,
        totalTracesValidated: 0,
        hitRate: 0,
        enabled: true,
        tickIntervalMs: 60_000,
        lastPolicyTuneAt: undefined,
        isRunning: false,
        updatedAt: 0,
      });
    });

    const result = await t.action(policyTunerApi.runPolicyTuning, {
      userId: "no-sample-user",
      organicModel: "gemini-2.5-flash",
    });

    expect(result).toMatchObject({
      evaluated: 0,
      promoted: false,
      scores: [],
    });

    const tickState = await t.run((ctx) =>
      (ctx.db as any)
        .query("organicTickState")
        .withIndex("by_user", (q: any) => q.eq("userId", "no-sample-user"))
        .first()
    );

    expect((tickState as any)?.lastPolicyTuneAt).toBeUndefined();
  });

  it("tags recall-log entries with the active policy generation", async () => {
    const memoryId = await t.mutation(internal.crystal.memories.createMemoryInternal, {
      userId: "trace-user",
      store: "semantic",
      category: "fact",
      title: "Release note",
      content: "The release candidate ships tonight.",
      metadata: undefined,
      embedding: [],
      strength: 0.8,
      confidence: 0.75,
      valence: 0,
      arousal: 0,
      source: "conversation",
      tags: [],
      archived: false,
    });

    await t.mutation(policyTunerApi.promotePolicy, {
      userId: "trace-user",
      generation: 10,
      weights: baseWeights,
      compositeScore: 0.61,
    });

    await t.mutation(tracesApi.logRecallQuery, {
      userId: "trace-user",
      query: "what ships tonight",
      resultCount: 1,
      topResultIds: [memoryId],
      source: "test",
    });

    await t.mutation(policyTunerApi.promotePolicy, {
      userId: "trace-user",
      generation: 11,
      weights: normalizePolicyWeights({
        ...baseWeights,
        vectorWeight: 0.28,
        textMatchWeight: 0.11,
      }),
      compositeScore: 0.66,
    });

    await t.mutation(tracesApi.logRecallQuery, {
      userId: "trace-user",
      query: "second query",
      resultCount: 1,
      topResultIds: [memoryId],
      source: "test",
    });

    const recallLog = (await t.run((ctx) =>
      (ctx.db as any)
        .query("organicRecallLog")
        .withIndex("by_user", (q: any) => q.eq("userId", "trace-user"))
        .order("asc")
        .collect()
    )) as Array<{ policyGeneration?: number }>;

    expect(recallLog.map((entry) => entry.policyGeneration)).toEqual([1, 2]);
  });
});
