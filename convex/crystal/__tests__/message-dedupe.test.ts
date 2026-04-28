import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { sha256Hex } from "../crypto";
import { buildMessageDedupeScopeInput, buildMessageHashInput } from "../contentHash";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/messages": () => import("../messages"),
  "crystal/userProfiles": () => import("../userProfiles"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/crypto": () => import("../crypto"),
  "crystal/contentHash": () => import("../contentHash"),
};

describe("message content-hash dedupe", () => {
  let t: ReturnType<typeof convexTest>;
  const userId = "message-dedupe-user";

  beforeEach(() => {
    process.env.MC_DISABLE_MESSAGE_EMBED_SCHEDULE = "1";
    t = convexTest(schema, modules);
  });

  it("returns the existing id for exact duplicates in the same scope", async () => {
    const first = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: "The deployment plan is to ship stable after Convex deploy.",
      channel: "coach:123",
      sessionKey: "session-a",
      turnId: "turn-1",
      turnMessageIndex: 1,
    });

    const second = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: "The deployment plan is to ship stable after Convex deploy.",
      channel: "coach:123",
      sessionKey: "session-a",
      turnId: "turn-1",
      turnMessageIndex: 1,
    });

    expect(second).toBe(first);

    const count = await t.query(internal.crystal.messages.getMessageCount, { userId });
    expect(count).toBe(1);
  });

  it("keeps identical wording in a different session as a separate message", async () => {
    const first = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "Remember that my birthday is May 2.",
      channel: "coach:123",
      sessionKey: "session-a",
    });

    const second = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "Remember that my birthday is May 2.",
      channel: "coach:123",
      sessionKey: "session-b",
    });

    expect(second).not.toBe(first);

    const count = await t.query(internal.crystal.messages.getMessageCount, { userId });
    expect(count).toBe(2);
  });

  it("finds live duplicates by exact dedupe scope even after many same-content other scopes", async () => {
    const contentHash = await sha256Hex(buildMessageHashInput({ role: "assistant", content: "Common response" }));
    for (let i = 0; i < 40; i += 1) {
      const sessionKey = `other-${i}`;
      const dedupeScopeHash = await sha256Hex(buildMessageDedupeScopeInput({
        userId,
        role: "assistant",
        contentHash,
        channel: "coach:999",
        sessionKey,
      }));
      await t.run((ctx) => ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Common response",
        channel: "coach:999",
        sessionKey,
        timestamp: i,
        embedded: false,
        expiresAt: 100_000,
        contentHash,
        dedupeScopeHash,
      }));
    }

    const first = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: "Common response",
      channel: "coach:123",
      sessionKey: "target",
    });
    const second = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: "Common response",
      channel: "coach:123",
      sessionKey: "target",
    });

    expect(second).toBe(first);
  });

  it("dedupes queue-spawned first turns by session turn index without turnId after time has passed", async () => {
    const first = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "Capture this queued first prompt.",
      channel: "codex:/repo",
      sessionKey: "queue-session-1",
      turnMessageIndex: 0,
    });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(first);
      if (!row) throw new Error("missing first message");
      await ctx.db.patch(first, { timestamp: row.timestamp - 60_000 });
    });

    const second = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "Capture this queued first prompt.",
      channel: "codex:/repo",
      sessionKey: "queue-session-1",
      turnMessageIndex: 0,
    });

    expect(second).toBe(first);
    const count = await t.query(internal.crystal.messages.getMessageCount, { userId });
    expect(count).toBe(1);
  });

});
