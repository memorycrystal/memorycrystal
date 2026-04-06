import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/organic/ideas": () => import("../organic/ideas"),
};

const ideasApi = ((internal as any).crystal.organic.ideas) as any;

describe("organic idea batch updates", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("updates multiple ideas atomically for the same owner", async () => {
    const [firstIdeaId, secondIdeaId] = await t.run(async (ctx) => {
      const first = await ctx.db.insert("organicIdeas", {
        userId: "ideas-user",
        title: "Idea 1",
        summary: "Summary 1",
        ideaType: "insight",
        sourceMemoryIds: [],
        confidence: 0.8,
        status: "pending_notification",
        pulseId: "pulse-1",
        createdAt: 1,
        updatedAt: 1,
      });
      const second = await ctx.db.insert("organicIdeas", {
        userId: "ideas-user",
        title: "Idea 2",
        summary: "Summary 2",
        ideaType: "pattern",
        sourceMemoryIds: [],
        confidence: 0.7,
        status: "pending_notification",
        pulseId: "pulse-2",
        createdAt: 2,
        updatedAt: 2,
      });
      return [first, second];
    });

    const result = await t.mutation(ideasApi.updateIdeaStatusesInternal, {
      userId: "ideas-user",
      ideaIds: [firstIdeaId, secondIdeaId],
      status: "notified",
    });

    expect(result).toEqual({ success: true, updated: 2 });

    const [first, second] = await t.run((ctx) =>
      Promise.all([ctx.db.get(firstIdeaId), ctx.db.get(secondIdeaId)])
    );
    expect(first?.status).toBe("notified");
    expect(second?.status).toBe("notified");
  });

  it("does not partially update when any idea fails validation", async () => {
    const [ownedIdeaId, foreignIdeaId] = await t.run(async (ctx) => {
      const owned = await ctx.db.insert("organicIdeas", {
        userId: "ideas-user",
        title: "Owned idea",
        summary: "Summary",
        ideaType: "insight",
        sourceMemoryIds: [],
        confidence: 0.9,
        status: "pending_notification",
        pulseId: "pulse-owned",
        createdAt: 1,
        updatedAt: 1,
      });
      const foreign = await ctx.db.insert("organicIdeas", {
        userId: "other-user",
        title: "Foreign idea",
        summary: "Summary",
        ideaType: "connection",
        sourceMemoryIds: [],
        confidence: 0.4,
        status: "pending_notification",
        pulseId: "pulse-foreign",
        createdAt: 2,
        updatedAt: 2,
      });
      return [owned, foreign];
    });

    await expect(
      t.mutation(ideasApi.updateIdeaStatusesInternal, {
        userId: "ideas-user",
        ideaIds: [ownedIdeaId, foreignIdeaId],
        status: "dismissed",
      })
    ).rejects.toThrow("Idea not found");

    const ownedIdea = await t.run((ctx) => ctx.db.get(ownedIdeaId));
    expect(ownedIdea?.status).toBe("pending_notification");
  });
});
