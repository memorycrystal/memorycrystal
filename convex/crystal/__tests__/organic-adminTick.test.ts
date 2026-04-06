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
});
