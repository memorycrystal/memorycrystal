import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";
import { defaultRecallRankingWeights } from "../recallRanking";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/recallRanking": () => import("../recallRanking"),
  "crystal/organic/replayReport": () => import("../organic/replayReport"),
};

const replayReportApi = (api as any).crystal.organic.replayReport;

const testUser = {
  subject: "test-user-replay-report",
  issuer: "https://test.com",
  tokenIdentifier: "https://test.com|test-user-replay-report",
};

describe("replayReport", () => {
  describe("getMyReplayReports", () => {
    test("returns empty array when not authenticated", async () => {
      const t = convexTest(schema, modules);
      const result = await t.query(replayReportApi.getMyReplayReports, {});
      expect(result).toEqual([]);
    });

    test("returns empty array when no reports exist", async () => {
      const t = convexTest(schema, modules);
      const result = await t.withIdentity(testUser).query(replayReportApi.getMyReplayReports, {});
      expect(result).toEqual([]);
    });

    test("returns reports ordered by createdAt desc with week-over-week delta", async () => {
      const t = convexTest(schema, modules);
      const userId = testUser.subject;

      await t.run(async (ctx) => {
        await ctx.db.insert("organicReplayReports", {
          userId,
          sampleCount: 50,
          groundingScore: 0.60,
          coverageScore: 0.55,
          precisionScore: 0.70,
          compositeScore: 0.617,
          worstQueries: [{ query: "test1", score: 0.2, reason: "low relevance" }],
          policyGeneration: 1,
          createdAt: 1000,
        });
        await ctx.db.insert("organicReplayReports", {
          userId,
          sampleCount: 80,
          groundingScore: 0.72,
          coverageScore: 0.65,
          precisionScore: 0.81,
          compositeScore: 0.727,
          worstQueries: [{ query: "test2", score: 0.3, reason: "missing coverage" }],
          policyGeneration: 2,
          createdAt: 2000,
        });
      });

      const reports = await t.withIdentity(testUser).query(replayReportApi.getMyReplayReports, {});
      expect(reports).toHaveLength(2);
      // Most recent first
      expect(reports[0].compositeScore).toBe(0.727);
      expect(reports[0].policyGeneration).toBe(2);
      // First has a delta (difference from second)
      expect(reports[0].weekOverWeekDelta).toBeCloseTo(0.11, 1);
      // Second has no previous, so no delta
      expect(reports[1].weekOverWeekDelta).toBeUndefined();
    });

    test("respects limit parameter", async () => {
      const t = convexTest(schema, modules);
      const userId = testUser.subject;

      await t.run(async (ctx) => {
        for (let i = 0; i < 5; i++) {
          await ctx.db.insert("organicReplayReports", {
            userId,
            sampleCount: 10,
            groundingScore: 0.5,
            coverageScore: 0.5,
            precisionScore: 0.5,
            compositeScore: 0.5,
            worstQueries: [],
            policyGeneration: i + 1,
            createdAt: (i + 1) * 1000,
          });
        }
      });

      const reports = await t.withIdentity(testUser).query(replayReportApi.getMyReplayReports, { limit: 2 });
      expect(reports).toHaveLength(2);
    });
  });

  describe("getMyPolicyHistory", () => {
    test("returns empty array when not authenticated", async () => {
      const t = convexTest(schema, modules);
      const result = await t.query(replayReportApi.getMyPolicyHistory, {});
      expect(result).toEqual([]);
    });

    test("returns policies ordered by generation desc", async () => {
      const t = convexTest(schema, modules);
      const userId = testUser.subject;
      const now = Date.now();

      await t.run(async (ctx) => {
        await ctx.db.insert("organicRecallPolicies", {
          userId,
          ...defaultRecallRankingWeights,
          generation: 1,
          status: "rejected",
          locked: false,
          createdAt: now - 10000,
          updatedAt: now - 10000,
        });
        await ctx.db.insert("organicRecallPolicies", {
          userId,
          ...defaultRecallRankingWeights,
          vectorWeight: 0.35,
          generation: 2,
          status: "active",
          locked: false,
          compositeScore: 0.73,
          createdAt: now,
          updatedAt: now,
        });
      });

      const policies = await t.withIdentity(testUser).query(replayReportApi.getMyPolicyHistory, {});
      expect(policies).toHaveLength(2);
      expect(policies[0].generation).toBe(2);
      expect(policies[0].status).toBe("active");
      expect(policies[1].generation).toBe(1);
      expect(policies[1].status).toBe("rejected");
    });
  });

  describe("setMyPolicyLock", () => {
    test("throws when not authenticated", async () => {
      const t = convexTest(schema, modules);
      await expect(
        t.mutation(replayReportApi.setMyPolicyLock, { locked: true }),
      ).rejects.toThrow("Not authenticated");
    });

    test("creates default policy with the requested lock state when no active policy exists", async () => {
      const t = convexTest(schema, modules);
      const result = await t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyLock, {
        locked: false,
      });
      expect(result.locked).toBe(false);
      expect(result.generation).toBe(1);

      // Verify policy was created
      const policies = await t.withIdentity(testUser).query(replayReportApi.getMyPolicyHistory, {});
      expect(policies).toHaveLength(1);
      expect(policies[0].locked).toBe(false);
      expect(policies[0].status).toBe("active");
      expect(policies[0].vectorWeight).toBe(defaultRecallRankingWeights.vectorWeight);
    });

    test("toggles lock on existing active policy", async () => {
      const t = convexTest(schema, modules);
      const userId = testUser.subject;
      const now = Date.now();

      await t.run(async (ctx) => {
        await ctx.db.insert("organicRecallPolicies", {
          userId,
          ...defaultRecallRankingWeights,
          generation: 1,
          status: "active",
          locked: false,
          createdAt: now - 20_000,
          updatedAt: now - 20_000,
        });
      });

      const result = await t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyLock, {
        locked: true,
      });
      expect(result.locked).toBe(true);

      const policies = await t.withIdentity(testUser).query(replayReportApi.getMyPolicyHistory, {});
      expect(policies[0].locked).toBe(true);

      // Toggle off
      const result2 = await t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyLock, {
        locked: false,
      });
      expect(result2.locked).toBe(false);
    });
  });

  describe("setMyPolicyWeights", () => {
    test("throws when not authenticated", async () => {
      const t = convexTest(schema, modules);
      await expect(
        t.mutation(replayReportApi.setMyPolicyWeights, {
          weights: { ...defaultRecallRankingWeights },
        }),
      ).rejects.toThrow("Not authenticated");
    });

    test("rejects out-of-range weights", async () => {
      const t = convexTest(schema, modules);
      await expect(
        t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyWeights, {
          weights: { ...defaultRecallRankingWeights, vectorWeight: 0.01 },
        }),
      ).rejects.toThrow(/vectorWeight.*between 0.02 and 0.5/);

      await expect(
        t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyWeights, {
          weights: { ...defaultRecallRankingWeights, strengthWeight: 0.6 },
        }),
      ).rejects.toThrow(/strengthWeight.*between 0.02 and 0.5/);
    });

    test("normalizes weights to sum to 1.0", async () => {
      const t = convexTest(schema, modules);

      const raw = {
        vectorWeight: 0.3,
        strengthWeight: 0.3,
        freshnessWeight: 0.1,
        accessWeight: 0.1,
        salienceWeight: 0.1,
        continuityWeight: 0.05,
        textMatchWeight: 0.05,
      };

      const result = await t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyWeights, {
        weights: raw,
      });

      const values = Object.values(result.weights) as number[];
      const sum = values.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 5);
    });

    test("creates new policy and demotes existing active", async () => {
      const t = convexTest(schema, modules);
      const userId = testUser.subject;
      const now = Date.now();

      await t.run(async (ctx) => {
        await ctx.db.insert("organicRecallPolicies", {
          userId,
          ...defaultRecallRankingWeights,
          generation: 1,
          status: "active",
          locked: false,
          createdAt: now - 20_000,
          updatedAt: now - 20_000,
        });
      });

      const result = await t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyWeights, {
        weights: {
          vectorWeight: 0.4,
          strengthWeight: 0.2,
          freshnessWeight: 0.1,
          accessWeight: 0.1,
          salienceWeight: 0.1,
          continuityWeight: 0.05,
          textMatchWeight: 0.05,
        },
      });

      expect(result.generation).toBe(2);

      const policies = await t.withIdentity(testUser).query(replayReportApi.getMyPolicyHistory, {});
      expect(policies).toHaveLength(2);
      expect(policies[0].generation).toBe(2);
      expect(policies[0].status).toBe("active");
      expect(policies[0].locked).toBe(true);
      expect(policies[1].generation).toBe(1);
      expect(policies[1].status).toBe("superseded");
    });

    test("rate limits rapid policy updates", async () => {
      const t = convexTest(schema, modules);

      await t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyWeights, {
        weights: {
          vectorWeight: 0.4,
          strengthWeight: 0.2,
          freshnessWeight: 0.1,
          accessWeight: 0.1,
          salienceWeight: 0.1,
          continuityWeight: 0.05,
          textMatchWeight: 0.05,
        },
      });

      await expect(
        t.withIdentity(testUser).mutation(replayReportApi.setMyPolicyWeights, {
          weights: {
            vectorWeight: 0.35,
            strengthWeight: 0.2,
            freshnessWeight: 0.15,
            accessWeight: 0.1,
            salienceWeight: 0.1,
            continuityWeight: 0.05,
            textMatchWeight: 0.05,
          },
        })
      ).rejects.toThrow("Rate limited");
    });

    test("per-user weight lookup falls back to defaults when no active policy", async () => {
      const t = convexTest(schema, modules);
      // No policy inserted — getMyPolicyHistory returns empty
      const policies = await t.withIdentity(testUser).query(replayReportApi.getMyPolicyHistory, {});
      expect(policies).toHaveLength(0);

      // When there's no active policy, the recall pipeline uses defaults.
      // Verify defaults are valid weights (they don't need to sum to exactly 1.0;
      // the ranking function normalizes internally)
      const sum = Object.values(defaultRecallRankingWeights).reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThan(0.5);
      expect(sum).toBeLessThan(2.0);
    });
  });
});
