import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

const adminSupportApi = (api as unknown as Record<string, any>)["crystal/adminSupport"];

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/adminSupport": () => import("../adminSupport"),
  "crystal/messages": () => import("../messages"),
  "crystal/userProfiles": () => import("../userProfiles"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/crypto": () => import("../crypto"),
  "crystal/contentHash": () => import("../contentHash"),
  "crystal/permissions": () => import("../permissions"),
};

describe("recalled-context STM cleanup", () => {
  let t: ReturnType<typeof convexTest>;
  const userId = "recalled-context-cleanup-user";

  async function insertRawMessage(args: {
    content: string;
    channel?: string;
    sessionKey?: string;
    turnMessageIndex?: number;
    timestamp?: number;
  }) {
    const timestamp = args.timestamp ?? Date.now();
    return await t.run((ctx) => ctx.db.insert("crystalMessages", {
      userId,
      role: "user",
      content: args.content,
      channel: args.channel,
      sessionKey: args.sessionKey,
      turnMessageIndex: args.turnMessageIndex,
      timestamp,
      embedded: false,
      expiresAt: timestamp + 86_400_000,
    }));
  }

  async function setMessageTotal(totalMessages: number) {
    await t.run((ctx) => ctx.db.insert("crystalDashboardTotals", {
      userId,
      totalMemories: 0,
      activeMemories: 0,
      archivedMemories: 0,
      totalMessages,
      enrichedMemories: 0,
      activeMemoriesByStore: { sensory: 0, episodic: 0, semantic: 0, procedural: 0, prospective: 0 },
      activeStoreCount: 0,
      updatedAt: Date.now(),
    }));
  }

  async function seedManagerProfile(userId: string) {
    await t.run((ctx) => ctx.db.insert("crystalUserProfiles", {
      userId,
      subscriptionStatus: "active",
      plan: "pro",
      roles: ["manager"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
  }

  beforeEach(() => {
    process.env.MC_DISABLE_MESSAGE_EMBED_SCHEDULE = "1";
    t = convexTest(schema, modules);
  });

  it("dry-runs without mutating polluted rows", async () => {
    const polluted = await insertRawMessage({
      content: "<recalled_context><user>old context</user></recalled_context>real prompt",
      channel: "discord:amdo",
      sessionKey: "session-a",
    });

    const dryRun = await t.mutation(internal.crystal.messages.cleanupRecalledContextMessages, {
      userId,
      applyMode: "dry-run",
      channel: "discord:amdo",
    });

    expect(dryRun).toMatchObject({
      scanned: 1,
      candidates: 1,
      wouldPatch: 1,
      patched: 0,
      wouldDelete: 0,
      deleted: 0,
    });

    const row = await t.run((ctx) => ctx.db.get(polluted));
    expect(row?.content).toContain("<recalled_context>");
  });

  it("rejects ambiguous channel and session cleanup scope", async () => {
    await insertRawMessage({
      content: "<recalled_context><user>old context</user></recalled_context>real prompt",
      channel: "discord:amdo",
      sessionKey: "session-a",
    });

    await expect(t.mutation(internal.crystal.messages.cleanupRecalledContextMessages, {
      userId,
      applyMode: "dry-run",
      channel: "discord:amdo",
      sessionKey: "session-a",
    })).rejects.toThrow("provide channel or sessionKey, not both");
  });

  it("exposes admin cleanup dry-run through a public mutation wrapper", async () => {
    const actor = { subject: "manager-user|session", email: "manager@example.com" };
    await seedManagerProfile("manager-user");
    await insertRawMessage({
      content: "<recalled_context><user>old context</user></recalled_context>wrapped prompt",
      channel: "discord:amdo",
    });

    const dryRun = await t.withIdentity(actor).mutation(adminSupportApi.adminDryRunRecalledContextCleanup, {
      targetUserId: userId,
      channel: "discord:amdo",
    });

    expect(dryRun).toMatchObject({
      scanned: 1,
      candidates: 1,
      wouldPatch: 1,
      patched: 0,
    });
  });

  it("patches polluted rows to the trailing prompt and resets stale indexing state", async () => {
    const polluted = await insertRawMessage({
      content: "<recalled_context><user><recalled_context>old</recalled_context>real</user></recalled_context>new prompt",
      channel: "discord:amdo",
      sessionKey: "session-b",
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(polluted, {
        embedded: true,
        embedding: Array.from({ length: 3072 }, () => 0.1),
        ltmExtractedAt: 123,
        ltmExtractionSkippedReason: "already_processed",
      });
    });

    const applied = await t.mutation(internal.crystal.messages.cleanupRecalledContextMessages, {
      userId,
      applyMode: "apply",
      channel: "discord:amdo",
    });

    expect(applied).toMatchObject({
      candidates: 1,
      wouldPatch: 1,
      patched: 1,
      deleted: 0,
      malformed: 0,
    });

    const row = await t.run((ctx) => ctx.db.get(polluted));
    expect(row?.content).toBe("new prompt");
    expect(row?.embedded).toBe(false);
    expect(row?.embedding).toBeUndefined();
    expect(row?.ltmExtractedAt).toBeUndefined();
    expect(row?.ltmExtractionSkippedReason).toBeUndefined();
    expect(row?.metadata).toContain("recalled_context_cleanup:");
    expect(row?.contentHash).toBeTruthy();
    expect(row?.dedupeScopeHash).toBeTruthy();
  });

  it("deletes wrapper-only rows and decrements dashboard message totals", async () => {
    await insertRawMessage({
      content: "<recalled_context><user>only context</user></recalled_context>",
      channel: "discord:amdo",
    });
    await setMessageTotal(1);
    expect(await t.query(internal.crystal.messages.getMessageCount, { userId })).toBe(1);

    const applied = await t.mutation(internal.crystal.messages.cleanupRecalledContextMessages, {
      userId,
      applyMode: "apply",
      channel: "discord:amdo",
    });

    expect(applied).toMatchObject({
      candidates: 1,
      wouldDelete: 1,
      deleted: 1,
    });
    expect(await t.query(internal.crystal.messages.getMessageCount, { userId })).toBe(0);
  });

  it("merge-deletes polluted rows when the cleaned prompt already exists in the same scope", async () => {
    await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "duplicate prompt",
      channel: "discord:amdo",
      sessionKey: "session-c",
      turnMessageIndex: 0,
    });
    const polluted = await insertRawMessage({
      content: "<recalled_context>old context</recalled_context>duplicate prompt",
      channel: "discord:amdo",
      sessionKey: "session-c",
      turnMessageIndex: 0,
    });
    await setMessageTotal(2);
    expect(await t.run((ctx) => ctx.db.get(polluted))).toBeTruthy();

    const applied = await t.mutation(internal.crystal.messages.cleanupRecalledContextMessages, {
      userId,
      applyMode: "apply",
      channel: "discord:amdo",
    });

    expect(applied).toMatchObject({
      candidates: 1,
      wouldMergeDelete: 1,
      mergedDeleted: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(polluted))).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.query("crystalMessages").collect()).filter((m) => m.userId === userId).length)).toBe(1);
  });

  it("merge-deletes polluted rows when the clean duplicate was inserted later", async () => {
    const polluted = await insertRawMessage({
      content: "<recalled_context>old context</recalled_context>later duplicate prompt",
      channel: "discord:amdo",
      sessionKey: "session-later",
      turnMessageIndex: 0,
      timestamp: Date.now() - 10_000,
    });
    await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "later duplicate prompt",
      channel: "discord:amdo",
      sessionKey: "session-later",
      turnMessageIndex: 0,
    });
    await setMessageTotal(2);

    const applied = await t.mutation(internal.crystal.messages.cleanupRecalledContextMessages, {
      userId,
      applyMode: "apply",
      channel: "discord:amdo",
    });

    expect(applied).toMatchObject({
      candidates: 1,
      wouldMergeDelete: 1,
      mergedDeleted: 1,
      patched: 0,
    });
    expect(await t.run((ctx) => ctx.db.get(polluted))).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.query("crystalMessages").collect()).filter((m) => m.userId === userId).length)).toBe(1);
  });

  it("drops malformed leading wrappers at write time and ignores mid-message literal tags", async () => {
    const malformedWrite = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "<recalled_context><user>truncated",
      channel: "discord:amdo",
    });
    const literal = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "please explain <recalled_context> as a literal tag",
      channel: "discord:amdo",
    });

    expect(malformedWrite).toBeNull();
    expect(literal).toBeTruthy();
    expect((await t.run((ctx) => ctx.db.get(literal)))?.content).toBe("please explain <recalled_context> as a literal tag");
  });

  it("cleanup deletes malformed pre-existing polluted rows but leaves mid-message literals", async () => {
    const malformed = await insertRawMessage({
      content: "<recalled_context><user>truncated",
      channel: "discord:amdo",
    });
    const literal = await insertRawMessage({
      content: "please explain <recalled_context> as a literal tag",
      channel: "discord:amdo",
    });

    const applied = await t.mutation(internal.crystal.messages.cleanupRecalledContextMessages, {
      userId,
      applyMode: "apply",
      channel: "discord:amdo",
    });

    expect(applied).toMatchObject({ candidates: 1, malformed: 1, deleted: 1, patched: 0 });
    expect(await t.run((ctx) => ctx.db.get(malformed))).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(literal)))?.content).toBe("please explain <recalled_context> as a literal tag");
  });
});
