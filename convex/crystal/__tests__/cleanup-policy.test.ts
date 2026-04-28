import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { isProtectedSensoryCapture } from "../cleanup";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/cleanup": () => import("../cleanup"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/auth": () => import("../auth"),
  "crystal/memoryText": () => import("../memoryText"),
  "crystal/retention": () => import("../retention"),
  "crystal/salience": () => import("../salience"),
  "crystal/sensoryPolicy": () => import("../sensoryPolicy"),
  "crystal/consolidate": () => import("../consolidate"),
};

describe("cleanup protected sensory policy", () => {
  it("protects explicit/import/media/external sensory rows from default raw cleanup", () => {
    expect(isProtectedSensoryCapture({ tags: ["sensory-mode:raw_import"] })).toBe(true);
    expect(isProtectedSensoryCapture({ tags: ["media"] })).toBe(true);
    expect(isProtectedSensoryCapture({ tags: ["external_observation"] })).toBe(true);
    expect(isProtectedSensoryCapture({ source: "external", tags: ["user-tool"] })).toBe(true);
    expect(isProtectedSensoryCapture({ source: "external", tags: ["auto-capture"] })).toBe(false);
    expect(isProtectedSensoryCapture({ tags: ["auto-capture"] })).toBe(false);
  });

  it("marks protected sensory rows out of the raw cleanup queue so legacy bloat behind them can drain", async () => {
    const t = convexTest(schema, modules);
    const userId = "cleanup-user";
    const now = Date.now();
    let protectedId: any;
    let legacyId: any;

    await t.run(async (ctx) => {
      protectedId = await ctx.db.insert("crystalMemories", {
        userId,
        title: "Protected import",
        content: "Raw imported observation that should be preserved.",
        store: "sensory",
        category: "conversation",
        tags: ["sensory-mode:raw_import"],
        source: "external",
        strength: 0.8,
        confidence: 0.8,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now - 100_000,
        createdAt: now - 100_000,
        archived: false,
        embedding: [],
        rawRetentionState: "raw",
        rawContentExpiresAt: now - 50_000,
      });
      legacyId = await ctx.db.insert("crystalMemories", {
        userId,
        title: "Legacy auto capture",
        content: "Auto-captured transcript bloat.",
        store: "sensory",
        category: "conversation",
        tags: ["auto-capture"],
        source: "conversation",
        strength: 0.8,
        confidence: 0.8,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now - 90_000,
        createdAt: now - 90_000,
        archived: false,
        embedding: [],
        rawRetentionState: "raw",
        rawContentExpiresAt: now - 40_000,
      });
    });

    const firstBatch = await t.query(internal.crystal.cleanup.getSensoryRawCandidatesForCleanup, {
      userId,
      now,
      sensoryRawTtlDays: 7,
      limit: 1,
    }) as Array<{ _id: unknown }>;
    expect(String(firstBatch[0]?._id)).toBe(String(protectedId));

    await t.mutation(internal.crystal.cleanup.markProtectedSensoryRawRetention, {
      memoryId: protectedId,
      now,
    });

    const secondBatch = await t.query(internal.crystal.cleanup.getSensoryRawCandidatesForCleanup, {
      userId,
      now,
      sensoryRawTtlDays: 7,
      limit: 1,
    }) as Array<{ _id: unknown }>;
    expect(String(secondBatch[0]?._id)).toBe(String(legacyId));
  });

  it("keeps protected sensory rows out of reflection low-salience promotion and decay", async () => {
    const t = convexTest(schema, modules);
    const userId = "reflection-user";
    const now = Date.now();
    let protectedId: any;
    let legacyId: any;

    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index += 1) {
        const id = await ctx.db.insert("crystalMemories", {
          userId,
          title: `Protected raw import ${index}`,
          content: "Explicitly imported sensory record.",
          store: "sensory",
          category: "conversation",
          tags: ["sensory-mode:raw_import"],
          source: "external",
          strength: 0.2,
          confidence: 0.8,
          valence: 0,
          arousal: 0,
          accessCount: 0,
          lastAccessedAt: now,
          createdAt: now + index,
          archived: false,
          embedding: [],
          salienceScore: 0.1,
        });
        if (index === 0) protectedId = id;
      }
      legacyId = await ctx.db.insert("crystalMemories", {
        userId,
        title: "Legacy auto capture",
        content: "Ordinary auto-captured sensory row.",
        store: "sensory",
        category: "conversation",
        tags: ["auto-capture"],
        source: "conversation",
        strength: 0.2,
        confidence: 0.8,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now + 100,
        archived: false,
        embedding: [],
        salienceScore: 0.1,
      });
    });

    const candidates = await t.query(internal.crystal.salience.getLowSalienceMemoriesForPromotion, {
      userId,
      store: "sensory",
      limit: 10,
      maxSalienceScore: 0.45,
    }) as Array<{ _id: unknown }>;
    expect(candidates.map((memory) => String(memory._id))).toEqual([String(legacyId)]);

    await t.mutation(internal.crystal.salience.decayLowSalienceMemory, {
      userId,
      memoryId: protectedId,
      archivedAt: now,
    });
    await t.mutation(internal.crystal.salience.promoteLowSalienceMemory, {
      userId,
      memoryId: protectedId,
      salienceScore: 0.9,
      strength: 0.9,
    });

    const protectedMemory = await t.run((ctx) => ctx.db.get(protectedId)) as any;
    expect(protectedMemory.archived).toBe(false);
    expect(protectedMemory.store).toBe("sensory");
    expect(protectedMemory.salienceScore).toBe(0.1);
  });

  it("keeps protected sensory rows out of consolidation selection and archive mutation", async () => {
    const t = convexTest(schema, modules);
    const userId = "consolidate-user";
    const now = Date.now();
    let protectedId: any;
    let legacyId: any;

    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index += 1) {
        const id = await ctx.db.insert("crystalMemories", {
          userId,
          title: `Protected media import ${index}`,
          content: "Explicit imported media sensory row.",
          store: "sensory",
          category: "conversation",
          tags: ["media", "sensory-mode:raw_import"],
          source: "external",
          strength: 0.4,
          confidence: 0.8,
          valence: 0,
          arousal: 0,
          accessCount: 0,
          lastAccessedAt: now,
          createdAt: now - 100_000 + index,
          archived: false,
          embedding: [0.1, 0.2],
        });
        if (index === 0) protectedId = id;
      }
      legacyId = await ctx.db.insert("crystalMemories", {
        userId,
        title: "Legacy sensory",
        content: "Auto-captured sensory row eligible for consolidation.",
        store: "sensory",
        category: "conversation",
        tags: ["auto-capture"],
        source: "conversation",
        strength: 0.4,
        confidence: 0.8,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now - 90_000,
        archived: false,
        embedding: [0.1, 0.2],
      });
    });

    const candidates = await t.query(internal.crystal.consolidate.getSensoryMemories, {
      userId,
      createdBefore: now,
      limit: 1,
    }) as Array<{ _id: unknown }>;
    expect(candidates.map((memory) => String(memory._id))).toEqual([String(legacyId)]);

    await t.mutation(internal.crystal.consolidate.archiveConsolidatedMemory, {
      userId,
      memoryId: protectedId,
      archivedAt: now,
    });

    const protectedMemory = await t.run((ctx) => ctx.db.get(protectedId)) as any;
    expect(protectedMemory.archived).toBe(false);
  });
});
