import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/organic/adminTick": () => import("../organic/adminTick"),
  "crystal/memories": () => import("../memories"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/contentScanner": () => import("../contentScanner"),
  "crystal/organic/activityLog": () => import("../organic/activityLog"),
};

const user = { subject: "skills_user", tokenIdentifier: "token_skills", issuer: "test" };

describe("organic skills query", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("returns procedural memories with parsed skill metadata ordered by observation count", async () => {
    const lowId = await t.mutation(internal.crystal.memories.createMemoryInternal, {
      userId: user.subject,
      store: "procedural",
      category: "workflow",
      title: "How to clear a cache",
      content: "Clear the cache and verify.",
      metadata: JSON.stringify({
        skillFormat: true,
        triggerConditions: ["when stale reads appear"],
        steps: [{ order: 1, action: "Clear the cache" }],
        pitfalls: [],
        verification: "Fresh reads appear",
        patternType: "workflow",
        observationCount: 2,
        lastObserved: 10,
      }),
      embedding: [],
      strength: 0.8,
      confidence: 0.7,
      valence: 0,
      arousal: 0.1,
      source: "inference",
      tags: ["organic"],
      archived: false,
    });

    const highId = await t.mutation(internal.crystal.memories.createMemoryInternal, {
      userId: user.subject,
      store: "procedural",
      category: "workflow",
      title: "How to recover a deploy",
      content: "Recover a failed deployment.",
      metadata: JSON.stringify({
        skillFormat: true,
        triggerConditions: ["when deploys fail"],
        steps: [{ order: 1, action: "Inspect logs" }],
        pitfalls: ["Do not skip rollback validation"],
        verification: "Deploy health checks pass",
        patternType: "workflow",
        observationCount: 5,
        lastObserved: 20,
      }),
      embedding: [],
      strength: 0.9,
      confidence: 0.8,
      valence: 0,
      arousal: 0.1,
      source: "inference",
      tags: ["organic"],
      archived: false,
    });

    expect(lowId).toBeTruthy();
    expect(highId).toBeTruthy();

    const skills = await t.withIdentity(user).query(api.crystal.organic.adminTick.getMyOrganicSkills, {});

    expect(skills).toHaveLength(2);
    expect(skills?.[0].title).toBe("How to recover a deploy");
    expect(skills?.[0].metadata?.observationCount).toBe(5);
    expect(skills?.[0].metadata?.steps).toEqual([{ order: 1, action: "Inspect logs" }]);
    expect(skills?.[1].metadata?.triggerConditions).toEqual(["when stale reads appear"]);
  });

  it("supports filtering organic skills by category", async () => {
    await t.mutation(internal.crystal.memories.createMemoryInternal, {
      userId: user.subject,
      store: "procedural",
      category: "workflow",
      title: "How to clear a cache",
      content: "Clear the cache and verify.",
      metadata: JSON.stringify({
        skillFormat: true,
        triggerConditions: ["when stale reads appear"],
        steps: [{ order: 1, action: "Clear the cache" }],
        pitfalls: [],
        verification: "Fresh reads appear",
        patternType: "workflow",
        observationCount: 2,
        lastObserved: 10,
      }),
      embedding: [],
      strength: 0.8,
      confidence: 0.7,
      valence: 0,
      arousal: 0.1,
      source: "inference",
      tags: ["organic"],
      archived: false,
    });

    await t.mutation(internal.crystal.memories.createMemoryInternal, {
      userId: user.subject,
      store: "procedural",
      category: "skill",
      title: "Deploy Troubleshooting",
      content: "# Deploy Troubleshooting",
      metadata: JSON.stringify({
        skillFormat: true,
        triggerConditions: ["when deploys fail repeatedly"],
        steps: [{ order: 1, action: "Inspect the failing logs" }],
        pitfalls: ["Do not redeploy without isolating the error"],
        verification: "The deploy completes and health checks pass",
        patternType: "workflow",
        observationCount: 4,
        lastObserved: 20,
      }),
      embedding: [],
      strength: 0.95,
      confidence: 0.85,
      valence: 0,
      arousal: 0.1,
      source: "inference",
      tags: ["organic", "skill"],
      archived: false,
    });

    const patterns = await t.withIdentity(user).query(api.crystal.organic.adminTick.getMyOrganicSkills, {
      category: "workflow",
    });
    const approvedSkills = await t.withIdentity(user).query(api.crystal.organic.adminTick.getMyOrganicSkills, {
      category: "skill",
    });

    expect(patterns?.map((entry: any) => entry.title)).toEqual(["How to clear a cache"]);
    expect(approvedSkills?.map((entry: any) => entry.title)).toEqual(["Deploy Troubleshooting"]);
  });
});
