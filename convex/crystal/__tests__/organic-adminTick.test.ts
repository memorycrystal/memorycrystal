import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/organic/adminTick": () => import("../organic/adminTick"),
  "crystal/organic/tick": () => import("../organic/tick"),
  "crystal/organic/spend": () => import("../organic/spend"),
  "crystal/organic/models": () => import("../organic/models"),
  "crystal/knowledgeBases": () => import("../knowledgeBases"),
};

const userA = { subject: "organic_user_a", tokenIdentifier: "token_a", issuer: "test" };
const userB = { subject: "organic_user_b", tokenIdentifier: "token_b", issuer: "test" };

describe("organic dashboard interval settings", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("lets each authenticated user manage their own interval", async () => {
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userA.subject,
      enabled: true,
    });
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userB.subject,
      enabled: true,
    });

    // 5 minutes is a valid tier (300000ms)
    await t.withIdentity(userA).mutation(api.crystal.organic.adminTick.setMyOrganicTickInterval, {
      tickIntervalMs: 5 * 60 * 1000,
    });

    const dashboardA = await t.withIdentity(userA).query(api.crystal.organic.adminTick.getMyOrganicDashboard, {});
    const dashboardB = await t.withIdentity(userB).query(api.crystal.organic.adminTick.getMyOrganicDashboard, {});

    expect(dashboardA?.tickState.tickIntervalMs).toBe(5 * 60 * 1000);
    expect(dashboardB?.tickState.tickIntervalMs).toBe(60 * 60 * 1000);
  });

  it("supports pulse-named dashboard wrappers without changing tick storage fields", async () => {
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userA.subject,
      enabled: true,
    });

    const pulseIntervalMutation = (api.crystal.organic.adminTick as Record<string, any>).setMyOrganicPulseInterval;
    const pulseDashboardQuery = (api.crystal.organic.adminTick as Record<string, any>).getMyOrganicPulseDashboard;

    expect(pulseIntervalMutation).toBeDefined();
    expect(pulseDashboardQuery).toBeDefined();

    await t.withIdentity(userA).mutation(pulseIntervalMutation, {
      pulseIntervalMs: 15 * 60 * 1000,
    });

    const dashboard = await t.withIdentity(userA).query(pulseDashboardQuery, {});

    expect(dashboard?.tickState.tickIntervalMs).toBe(15 * 60 * 1000);
    // Also verify pulse-named shape
    expect(dashboard?.pulseState.pulseIntervalMs).toBe(15 * 60 * 1000);
  });

  it("clamps user interval settings correctly for the tier system", async () => {
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userA.subject,
      enabled: true,
    });

    // 1000ms (1 second) is now a valid tier — should be accepted
    await t.withIdentity(userA).mutation(api.crystal.organic.adminTick.setMyOrganicTickInterval, {
      tickIntervalMs: 1_000,
    });

    let dashboard = await t.withIdentity(userA).query(api.crystal.organic.adminTick.getMyOrganicDashboard, {});
    expect(dashboard?.tickState.tickIntervalMs).toBe(1_000);

    // 48 hours exceeds the max — should clamp to 24h
    await t.withIdentity(userA).mutation(api.crystal.organic.adminTick.setMyOrganicTickInterval, {
      tickIntervalMs: 48 * 60 * 60 * 1000,
    });

    dashboard = await t.withIdentity(userA).query(api.crystal.organic.adminTick.getMyOrganicDashboard, {});
    expect(dashboard?.tickState.tickIntervalMs).toBe(24 * 60 * 60 * 1000);

    // 0ms (Live mode) should be accepted
    await t.withIdentity(userA).mutation(api.crystal.organic.adminTick.setMyOrganicTickInterval, {
      tickIntervalMs: 0,
    });

    dashboard = await t.withIdentity(userA).query(api.crystal.organic.adminTick.getMyOrganicDashboard, {});
    expect(dashboard?.tickState.tickIntervalMs).toBe(0);
  });

  it("lets users set and query model presets", async () => {
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userA.subject,
      enabled: true,
    });

    const setModel = (api.crystal.organic.adminTick as Record<string, any>).setMyOrganicPulseModel;
    expect(setModel).toBeDefined();

    await t.withIdentity(userA).mutation(setModel, { organicModel: "potato" });

    const dashboard = await t.withIdentity(userA).query(
      (api.crystal.organic.adminTick as Record<string, any>).getMyOrganicPulseDashboard,
      {}
    );

    expect(dashboard?.pulseState.organicModel).toBe("potato");
    expect(dashboard?.modelPresets).toBeDefined();
    expect(dashboard?.modelPresets.length).toBeGreaterThan(0);
  });

  it("groups same-timestamp activity rows so recent activity reflects pulses instead of raw duplicates", async () => {
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userA.subject,
      enabled: true,
    });

    const now = Date.now();
    const firstMemoryId = await t.run(async (ctx) => {
      return ctx.db.insert("crystalMemories", {
        userId: userA.subject,
        store: "semantic",
        category: "fact",
        title: "Recent activity memory A",
        content: "Recent activity memory A",
        embedding: Array.from({ length: 3072 }, () => 0),
        strength: 1,
        confidence: 1,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: "conversation",
        tags: [],
        archived: false,
      });
    });

    const secondMemoryId = await t.run(async (ctx) => {
      return ctx.db.insert("crystalMemories", {
        userId: userA.subject,
        store: "semantic",
        category: "fact",
        title: "Recent activity memory B",
        content: "Recent activity memory B",
        embedding: Array.from({ length: 3072 }, () => 1),
        strength: 1,
        confidence: 1,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: "conversation",
        tags: [],
        archived: false,
      });
    });

    const thirdMemoryId = await t.run(async (ctx) => {
      return ctx.db.insert("crystalMemories", {
        userId: userA.subject,
        store: "semantic",
        category: "fact",
        title: "Recent activity memory C",
        content: "Recent activity memory C",
        embedding: Array.from({ length: 3072 }, () => 2),
        strength: 1,
        confidence: 1,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: "conversation",
        tags: [],
        archived: false,
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("organicActivityLog", {
        userId: userA.subject,
        eventType: "memory_recalled",
        memoryId: firstMemoryId,
        timestamp: now,
      });
      await ctx.db.insert("organicActivityLog", {
        userId: userA.subject,
        eventType: "memory_recalled",
        memoryId: secondMemoryId,
        timestamp: now,
      });
      await ctx.db.insert("organicActivityLog", {
        userId: userA.subject,
        eventType: "memory_stored",
        memoryId: thirdMemoryId,
        timestamp: now - 60 * 60 * 1000,
      });
    });

    const dashboard = await t.withIdentity(userA).query(
      (api.crystal.organic.adminTick as Record<string, any>).getMyOrganicPulseDashboard,
      {}
    );

    expect(dashboard?.recentActivity).toHaveLength(2);
    expect(dashboard?.recentActivity[0]).toMatchObject({
      eventType: "memory_recalled",
      timestamp: now,
      eventCount: 2,
    });
    expect(dashboard?.recentActivity[1]).toMatchObject({
      eventType: "memory_stored",
      timestamp: now - 60 * 60 * 1000,
      eventCount: 1,
    });
    expect(dashboard?.pulseState.pulseIntervalMs).toBe(60 * 60 * 1000);
  });

  it("includes recent pulses and generated ideas in the overview activity feed", async () => {
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userA.subject,
      enabled: true,
    });

    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("organicTickRuns", {
        userId: userA.subject,
        tickId: "tick-activity",
        triggerSource: "scheduled",
        status: "completed",
        startedAt: now - 10_000,
        completedAt: now - 5_000,
        durationMs: 5_000,
        tickIntervalMs: 60 * 60 * 1000,
        previousTickAt: now - 60 * 60 * 1000,
        tracesGenerated: 2,
        tracesValidated: 1,
        tracesExpired: 0,
        ensemblesCreated: 1,
        ensemblesUpdated: 1,
        ensemblesArchived: 0,
        contradictionChecks: 1,
        contradictionsFound: 0,
        resonanceChecks: 1,
        resonancesFound: 1,
        ideasCreated: 2,
        estimatedInputTokens: 1000,
        estimatedOutputTokens: 400,
        estimatedCostUsd: 0.01,
      });

      await ctx.db.insert("organicIdeas", {
        userId: userA.subject,
        title: "Fresh idea",
        summary: "Summary",
        ideaType: "insight",
        sourceMemoryIds: [],
        confidence: 0.82,
        status: "pending_notification",
        pulseId: "tick-activity",
        createdAt: now - 4_000,
        updatedAt: now - 4_000,
      });
    });

    const dashboard = await t.withIdentity(userA).query(
      (api.crystal.organic.adminTick as Record<string, any>).getMyOrganicPulseDashboard,
      {}
    );

    expect(dashboard?.recentActivity[0]).toMatchObject({
      eventType: "idea_generated",
      timestamp: now - 4_000,
      eventCount: 1,
    });
    expect(dashboard?.recentActivity[1]).toMatchObject({
      eventType: "pulse_completed",
      timestamp: now - 5_000,
      eventCount: 1,
    });
  });

  it("uses scheduled runs as the basis for interval cost projections when available", async () => {
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userA.subject,
      enabled: true,
    });

    const now = Date.now();
    const tickState = await t.query(internal.crystal.organic.adminTick.getOrganicStatus, {
      userId: userA.subject,
    });
    if (!tickState) throw new Error("tick state missing");

    await t.run(async (ctx) => {
      await ctx.db.patch(tickState._id, { organicModel: "medium" });
      await ctx.db.insert("organicTickRuns", {
        userId: userA.subject,
        tickId: "scheduled-1",
        triggerSource: "scheduled",
        status: "completed",
        startedAt: now - 10_000,
        completedAt: now - 9_000,
        durationMs: 1000,
        tickIntervalMs: 60 * 60 * 1000,
        previousTickAt: now - 70 * 60 * 1000,
        tracesGenerated: 1,
        ensemblesCreated: 0,
        ensemblesUpdated: 0,
        ensemblesArchived: 0,
        tracesValidated: 1,
        tracesExpired: 0,
        estimatedInputTokens: 1000,
        estimatedOutputTokens: 1000,
        estimatedCostUsd: 0.1,
        contradictionChecks: 0,
        contradictionsFound: 0,
        resonanceChecks: 0,
        resonancesFound: 0,
        ideasCreated: 0,
      });
      await ctx.db.insert("organicTickRuns", {
        userId: userA.subject,
        tickId: "conversation-1",
        triggerSource: "conversation",
        status: "completed",
        startedAt: now - 5_000,
        completedAt: now - 4_000,
        durationMs: 1000,
        tickIntervalMs: 0,
        previousTickAt: now - 15_000,
        tracesGenerated: 0,
        ensemblesCreated: 0,
        ensemblesUpdated: 0,
        ensemblesArchived: 0,
        tracesValidated: 0,
        tracesExpired: 0,
        estimatedInputTokens: 50_000,
        estimatedOutputTokens: 50_000,
        estimatedCostUsd: 9.9,
        contradictionChecks: 0,
        contradictionsFound: 0,
        resonanceChecks: 0,
        resonancesFound: 0,
        ideasCreated: 0,
      });
    });

    const dashboard = await t.withIdentity(userA).query(api.crystal.organic.adminTick.getMyOrganicPulseDashboard, {});
    expect(dashboard?.spend.completedRunCount).toBe(1);
    expect(dashboard?.spend.costProjectionSource).toBe("scheduled");
    expect(dashboard?.spend.averagePulseCostUsd).toBeLessThan(0.01);
  });

  it("treats a shared workspace OpenRouter key as pulse-ready even without a personal key", async () => {
    await t.mutation(internal.crystal.organic.adminTick.setOrganicEnabled, {
      userId: userA.subject,
      enabled: true,
    });

    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-shared-test";
    try {
      const dashboard = await t.withIdentity(userA).query(api.crystal.organic.adminTick.getMyOrganicPulseDashboard, {});
      expect(dashboard?.hasOpenRouterKey).toBe(true);
      expect(dashboard?.openRouterKeySource).toBe("shared");
      expect(dashboard?.openRouterKeyPrefix).toBeNull();
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });

});
