import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { areIdeaTitlesSimilar } from "../organic/discoveryFiber";
import { averageEmbeddings } from "../organic/utils";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/organic/traces": () => import("../organic/traces"),
  "crystal/organic/recallLog": () => import("../organic/recallLog"),
  "crystal/organic/tick": () => import("../organic/tick"),
};

describe("batch 3 backend fixes", () => {
  describe("idea dedup normalization", () => {
    it("matches titles that only differ by case and whitespace", () => {
      expect(areIdeaTitlesSimilar("  Shipping   checklist  ", "shipping checklist")).toBe(true);
    });

    it("does not fuzzy-match different titles that only share many words", () => {
      expect(
        areIdeaTitlesSimilar(
          "shipping checklist for desktop release",
          "shipping checklist for mobile release"
        )
      ).toBe(false);
    });
  });

  describe("embedding averaging", () => {
    it("keeps the longest vector shape and ignores shorter vectors", () => {
      expect(averageEmbeddings([[2, 4, 6], [4, 8], [8, 10, 12]])).toEqual([5, 7, 9]);
    });

    it("returns an empty array when given no embeddings", () => {
      expect(averageEmbeddings([])).toEqual([]);
    });
  });

  describe("recall stats and cleanup", () => {
    let t: ReturnType<typeof convexTest>;

    beforeEach(() => {
      t = convexTest(schema, modules);
    });

    it("tracks recall stats without scanning the recall log", async () => {
      const userId = "stats-user";

      for (let index = 0; index < 3; index++) {
        await t.mutation(internal.crystal.organic.traces.logRecallQuery, {
          userId,
          query: `query-${index}`,
          resultCount: index + 1,
          topResultIds: [],
          traceHit: index !== 1,
          source: "test",
        });
      }

      const stats = await t.query(internal.crystal.organic.recallLog.getRecallStatsInternal, {
        userId,
      });

      expect(stats).toEqual({
        totalQueries: 3,
        traceHits: 2,
        hitRate: 2 / 3,
        avgResultCount: 2,
      });
    });

    it("prunes only recall-log entries older than 30 days", async () => {
      const now = Date.now();
      const userId = "cleanup-user";
      const oldId = await t.run(async (ctx) => {
        return await ctx.db.insert("organicRecallLog", {
          userId,
          query: "old query",
          resultCount: 1,
          topResultIds: [],
          source: "test",
          createdAt: now - 31 * 24 * 60 * 60 * 1000,
        });
      });
      const freshId = await t.run(async (ctx) => {
        return await ctx.db.insert("organicRecallLog", {
          userId,
          query: "fresh query",
          resultCount: 1,
          topResultIds: [],
          source: "test",
          createdAt: now - 5 * 24 * 60 * 60 * 1000,
        });
      });

      const result = await t.mutation(internal.crystal.organic.recallLog.pruneOldRecallLogEntries, {});

      expect(result.deleted).toBe(1);
      const oldDoc = await t.run((ctx) => ctx.db.get(oldId));
      const freshDoc = await t.run((ctx) => ctx.db.get(freshId));
      expect(oldDoc).toBeNull();
      expect(freshDoc).not.toBeNull();
    });
  });

  describe("source-level backend guards", () => {
    const ideasSrc = readFileSync(join(__dirname, "..", "organic", "ideas.ts"), "utf-8");
    const tickSrc = readFileSync(join(__dirname, "..", "organic", "tick.ts"), "utf-8");
    const recallLogSrc = readFileSync(join(__dirname, "..", "organic", "recallLog.ts"), "utf-8");
    const mcpSrc = readFileSync(join(__dirname, "..", "mcp.ts"), "utf-8");
    const userProfilesSrc = readFileSync(join(__dirname, "..", "userProfiles.ts"), "utf-8");
    const schemaSrc = readFileSync(join(__dirname, "..", "..", "schema.ts"), "utf-8");

    it("uses stable idea pagination cursors with both createdAt and _id", () => {
      expect(ideasSrc).toMatch(/const ideaCursorValidator = v\.object\(\{\s*createdAt:\s*v\.number\(\),\s*id:\s*v\.id\("organicIdeas"\),?\s*\}\)/);
      expect(ideasSrc).toContain("cursor: v.optional(ideaCursorValidator)");
      expect(ideasSrc).toMatch(/doc\.eq\(doc\.field\("createdAt"\),\s*cursor\.[^)]+\)[\s\S]*doc\.lt\(doc\.field\("_id"\),\s*cursor\.[^)]+\)/);
      expect(ideasSrc).toMatch(/nextCursor\s*=\s*hasMore[\s\S]*createdAt:\s*page\[page\.length - 1\]\.createdAt,[\s\S]*id:\s*page\[page\.length - 1\]\._id/);
    });

    it("guards conversation pulses with the same lease used by scheduled ticks", () => {
      expect(tickSrc).toMatch(/triggerConversationPulse[\s\S]*enabled !== true/);
      expect(tickSrc).toMatch(/triggerConversationPulse[\s\S]*acquireTickLease/);
      expect(tickSrc).toMatch(/triggerConversationPulse[\s\S]*releaseTickLease/);
      expect(tickSrc).toMatch(/rateLimitAndCreateConversationPulse[\s\S]*isRunning/);
    });

    it("uses dedicated recall stats storage and bounded recall log cleanup", () => {
      expect(recallLogSrc).toContain("getRecallStatsInternal");
      expect(recallLogSrc).toMatch(/withIndex\("by_created"/);
      expect(recallLogSrc).toMatch(/\.take\(100\)/);
      expect(schemaSrc).toContain("organicRecallStats");
      expect(schemaSrc).toContain('.index("by_created", ["createdAt"])');
    });

    it("bounds audit queries and uses a guardrail-specific memory index", () => {
      expect(mcpSrc).not.toContain('query("crystalMemories").collect()');
      expect(mcpSrc).toMatch(/query\("crystalMemories"\)\.take\(1000\)/);
      expect(mcpSrc).toMatch(/withIndex\("by_user_category_strength"/);
      expect(schemaSrc).toContain('.index("by_user_category_strength", ["userId", "category", "archived", "strength"])');
    });

    it("paginates admin profile listings and batches user lookups", () => {
      expect(userProfilesSrc).toMatch(/query\("crystalUserProfiles"\)\.order\("desc"\)\.paginate/);
      expect(userProfilesSrc).toMatch(/Promise\.all/);
      expect(userProfilesSrc).toMatch(/new Map\(users\)/);
    });
  });
});
