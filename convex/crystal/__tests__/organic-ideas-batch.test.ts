import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    vi.useRealTimers();
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

  it("allows dashboard status transitions beyond a one-way star action", async () => {
    const ideaId = await t.run(async (ctx) => ctx.db.insert("organicIdeas", {
      userId: "ideas-user",
      title: "Flexible idea",
      summary: "Summary",
      ideaType: "insight",
      sourceMemoryIds: [],
      confidence: 0.9,
      status: "starred",
      notifiedAt: 1,
      starredAt: 2,
      pulseId: "pulse-flex",
      createdAt: 1,
      updatedAt: 1,
    }));

    await t.mutation(ideasApi.updateIdeaStatusInternal, {
      userId: "ideas-user",
      ideaId,
      status: "dismissed",
    });

    const dismissed = await t.run((ctx) => ctx.db.get(ideaId));
    expect(dismissed?.status).toBe("dismissed");
    expect(dismissed?.dismissedAt).toBeDefined();
    expect(dismissed?.readAt).toBeDefined();

    await t.mutation(ideasApi.updateIdeaStatusInternal, {
      userId: "ideas-user",
      ideaId,
      status: "read",
    });

    const reopened = await t.run((ctx) => ctx.db.get(ideaId));
    expect(reopened?.status).toBe("read");
    expect(reopened?.dismissedAt).toBeUndefined();
    expect(reopened?.readAt).toBeDefined();

    await t.mutation(ideasApi.updateIdeaStatusInternal, {
      userId: "ideas-user",
      ideaId,
      status: "notified",
    });

    const unread = await t.run((ctx) => ctx.db.get(ideaId));
    expect(unread?.status).toBe("notified");
    expect(unread?.dismissedAt).toBeUndefined();
    expect(unread?.readAt).toBeUndefined();
  });

  it("filters starred ideas by starredAt even when their primary status differs", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("organicIdeas", {
        userId: "ideas-user",
        title: "Dismissed but starred",
        summary: "Summary",
        ideaType: "insight",
        sourceMemoryIds: [],
        confidence: 0.8,
        status: "dismissed",
        dismissedAt: 3,
        starredAt: 4,
        pulseId: "pulse-starred",
        createdAt: 4,
        updatedAt: 4,
      });
    });

    const page = await t.query(ideasApi.getMyIdeasInternal, { userId: "ideas-user", status: "starred" });
    expect(page.ideas.some((idea: any) => idea.title === "Dismissed but starred")).toBe(true);
  });

  it("marks and clears starredAt without overwriting the primary status", async () => {
    const ideaId = await t.run(async (ctx) => ctx.db.insert("organicIdeas", {
      userId: "ideas-user",
      title: "Star toggle idea",
      summary: "Summary",
      ideaType: "insight",
      sourceMemoryIds: [],
      confidence: 0.8,
      status: "dismissed",
      dismissedAt: 1,
      pulseId: "pulse-toggle",
      createdAt: 5,
      updatedAt: 5,
    }));

    await t.withIdentity({ subject: "ideas-user", tokenIdentifier: "token", issuer: "test" } as any).mutation(ideasApi.setIdeaStarred, {
      ideaId,
      starred: true,
    });
    let idea = await t.run((ctx) => ctx.db.get(ideaId));
    expect(idea?.status).toBe("dismissed");
    expect(idea?.starredAt).toBeDefined();

    await t.withIdentity({ subject: "ideas-user", tokenIdentifier: "token", issuer: "test" } as any).mutation(ideasApi.setIdeaStarred, {
      ideaId,
      starred: false,
    });
    idea = await t.run((ctx) => ctx.db.get(ideaId));
    expect(idea?.status).toBe("dismissed");
    expect(idea?.starredAt).toBeUndefined();
  });

  it("includes surfaced but not-yet-emailed ideas in the current digest window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00.000Z"));

    const windowStart = Date.now() - 6 * 60 * 60 * 1000;

    const [pendingId, notifiedId, emailedId] = await t.run(async (ctx) => {
      const pending = await ctx.db.insert("organicIdeas", {
        userId: "ideas-user",
        title: "Pending idea",
        summary: "Summary",
        ideaType: "insight",
        sourceMemoryIds: [],
        confidence: 0.8,
        status: "pending_notification",
        pulseId: "pulse-p",
        createdAt: windowStart + 30 * 60 * 1000,
        updatedAt: windowStart + 30 * 60 * 1000,
      });
      const notified = await ctx.db.insert("organicIdeas", {
        userId: "ideas-user",
        title: "Surfaced idea",
        summary: "Summary",
        ideaType: "insight",
        sourceMemoryIds: [],
        confidence: 0.8,
        status: "notified",
        notifiedAt: windowStart + 60 * 60 * 1000,
        pulseId: "pulse-n",
        createdAt: windowStart + 60 * 60 * 1000,
        updatedAt: windowStart + 60 * 60 * 1000,
      });
      const emailed = await ctx.db.insert("organicIdeas", {
        userId: "ideas-user",
        title: "Emailed idea",
        summary: "Summary",
        ideaType: "insight",
        sourceMemoryIds: [],
        confidence: 0.8,
        status: "notified",
        notifiedAt: windowStart + 90 * 60 * 1000,
        emailDigestSentAt: windowStart + 120 * 60 * 1000,
        pulseId: "pulse-e",
        createdAt: windowStart + 90 * 60 * 1000,
        updatedAt: windowStart + 90 * 60 * 1000,
      });
      await ctx.db.insert("organicIdeas", {
        userId: "ideas-user",
        title: "Stale idea",
        summary: "Summary",
        ideaType: "insight",
        sourceMemoryIds: [],
        confidence: 0.8,
        status: "pending_notification",
        pulseId: "pulse-old",
        createdAt: windowStart - 60_000,
        updatedAt: windowStart - 60_000,
      });
      return [pending, notified, emailed];
    });

    const eligible = await t.query(ideasApi.getIdeasForEmailDigest, {
      userId: "ideas-user",
      windowStart,
    });

    expect(eligible).toHaveLength(2);
    expect(eligible.map((idea: any) => idea._id)).toEqual(expect.arrayContaining([pendingId, notifiedId]));
    expect(eligible.map((idea: any) => idea._id)).not.toContain(emailedId);

    await t.mutation(ideasApi.markIdeasNotifiedInternal, {
      userId: "ideas-user",
      ideaIds: [notifiedId],
    });
    const updated = await t.run((ctx) => ctx.db.get(notifiedId));
    expect(updated?.emailDigestSentAt).toBeDefined();
    expect(updated?.status).toBe("notified");
  });

});
