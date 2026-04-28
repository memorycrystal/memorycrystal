import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import {
  scoreReplaySample,
  type ReplayActivityEvent,
} from "../organic/replayEval";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/memories": () => import("../memories"),
  "crystal/organic/policyTuner": () => import("../organic/policyTuner"),
  "crystal/organic/replayEval": () => import("../organic/replayEval"),
};
const replayEvalApi = ((internal as any).crystal.organic.replayEval) as any;
const replayEvalPublicApi = ((api as any).crystal.organic.replayEval) as any;

describe("replay evaluation helpers", () => {
  it("computes a 50/50 grounding and coverage composite from observed follow-up access", () => {
    const activities: ReplayActivityEvent[] = [
      { memoryId: "memory-b", eventType: "memory_recalled", timestamp: 1 },
      { memoryId: "memory-c", eventType: "memory_stored", timestamp: 2 },
      { memoryId: "memory-d", eventType: "memory_recalled", timestamp: 3 },
    ];

    const score = scoreReplaySample({
      query: "shipping plan",
      topResultIds: ["memory-a", "memory-b"],
      activities,
    });

    expect(score.groundingScore).toBeCloseTo(0.5, 8);
    expect(score.coverageScore).toBeCloseTo(1 / 3, 8);
    expect(score.precisionScore).toBeCloseTo(0.5, 8);
    expect(score.compositeScore).toBeCloseTo((0.5 + 1 / 3) / 2, 8);
  });
});

describe("replay evaluation integration", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("writes replay reports and exposes latest reports to the authenticated user", async () => {
    const now = Date.parse("2026-03-20T18:00:00.000Z");
    const userId = "replay-user";
    const identity = { subject: userId, tokenIdentifier: "token-replay", issuer: "test" };

    const memoryA = await t.mutation(internal.crystal.memories.createMemoryInternal, {
      userId,
      store: "semantic",
      category: "fact",
      title: "Alpha",
      content: "Alpha memory",
      metadata: undefined,
      embedding: [],
      strength: 0.8,
      confidence: 0.7,
      valence: 0,
      arousal: 0,
      source: "conversation",
      tags: [],
      archived: false,
    });
    const memoryB = await t.mutation(internal.crystal.memories.createMemoryInternal, {
      userId,
      store: "semantic",
      category: "fact",
      title: "Beta",
      content: "Beta memory",
      metadata: undefined,
      embedding: [],
      strength: 0.7,
      confidence: 0.7,
      valence: 0,
      arousal: 0,
      source: "conversation",
      tags: [],
      archived: false,
    });
    const memoryC = await t.mutation(internal.crystal.memories.createMemoryInternal, {
      userId,
      store: "episodic",
      category: "event",
      title: "Gamma",
      content: "Gamma memory",
      metadata: undefined,
      embedding: [],
      strength: 0.6,
      confidence: 0.7,
      valence: 0,
      arousal: 0,
      source: "conversation",
      tags: [],
      archived: false,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("organicRecallLog", {
        userId,
        query: "alpha recall",
        resultCount: 2,
        topResultIds: [memoryA, memoryB],
        source: "test",
        policyGeneration: 1,
        createdAt: now - 10_000,
      });
      await ctx.db.insert("organicRecallLog", {
        userId,
        query: "gamma recall",
        resultCount: 1,
        topResultIds: [memoryC],
        source: "test",
        policyGeneration: 1,
        createdAt: now - 5_000,
      });

      await ctx.db.insert("organicActivityLog", {
        userId,
        eventType: "memory_recalled",
        memoryId: memoryA,
        timestamp: now - 9_000,
      });
      await ctx.db.insert("organicActivityLog", {
        userId,
        eventType: "memory_stored",
        memoryId: memoryC,
        timestamp: now - 4_000,
      });
      await ctx.db.insert("organicActivityLog", {
        userId,
        eventType: "memory_recalled",
        memoryId: memoryB,
        timestamp: now + 60 * 60 * 1000,
      });
    });

    const report = await t.action(replayEvalApi.runReplayEvaluation, {
      userId,
    });

    expect(report.sampleCount).toBe(2);
    expect(report.policyGeneration).toBe(1);
    expect(report.worstQueries).toHaveLength(2);

    const reports = await t.withIdentity(identity).query(replayEvalPublicApi.getMyReplayReports, {
      limit: 5,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.sampleCount).toBe(2);
    expect(reports[0]?.policyGeneration).toBe(1);
    expect(reports[0]?.compositeScore).toBeCloseTo(report.compositeScore, 8);
  });
});
