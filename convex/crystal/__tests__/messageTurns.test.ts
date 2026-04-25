import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/messages": () => import("../messages"),
  "crystal/stmEmbedder": () => import("../stmEmbedder"),
  "crystal/userProfiles": () => import("../userProfiles"),
};

const user = {
  subject: "turn_test_user",
  tokenIdentifier: "token_turn_test_user",
  issuer: "test",
};

const otherUser = {
  subject: "turn_test_other_user",
  tokenIdentifier: "token_turn_test_other_user",
  issuer: "test",
};

describe("structured message turns", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    vi.useFakeTimers();
    t = convexTest(schema, modules);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and returns turn-level metadata on recent messages", async () => {
    const typedApi = api as any;
    await t.withIdentity(user).mutation(api.crystal.messages.logMessage, {
      role: "user",
      content: "Can you summarize the deploy issue?",
      channel: "openclaw:discord:test-channel",
      sessionKey: "session-turns-1",
      turnId: "turn-abc123",
      turnMessageIndex: 0,
    });

    await t.withIdentity(user).mutation(api.crystal.messages.logMessage, {
      role: "assistant",
      content: "Yes. The deploy failed because the env var was missing.",
      channel: "openclaw:discord:test-channel",
      sessionKey: "session-turns-1",
      turnId: "turn-abc123",
      turnMessageIndex: 1,
    });

    await t.withIdentity(otherUser).mutation(api.crystal.messages.logMessage, {
      role: "user",
      content: "Leak check from a different user",
      channel: "openclaw:discord:test-channel",
      sessionKey: "session-turns-1",
      turnId: "turn-other-1",
      turnMessageIndex: 0,
    });

    const recent = await t.withIdentity(user).query(api.crystal.messages.getRecentMessages, {
      sessionKey: "session-turns-1",
      limit: 10,
    });

    expect(recent).toHaveLength(2);
    expect(recent.map((message: any) => message.role)).toEqual(["user", "assistant"]);
    expect(recent.map((message: any) => message.turnId)).toEqual(["turn-abc123", "turn-abc123"]);
    expect(recent.map((message: any) => message.turnMessageIndex)).toEqual([0, 1]);
    expect(recent.every((message: any) => message.sessionKey === "session-turns-1")).toBe(true);

    const sessionMessages = await t.withIdentity(user).query(typedApi.crystal.messages.getSessionMessages, {
      sessionKey: "session-turns-1",
    });

    expect(sessionMessages).toHaveLength(2);
    expect(sessionMessages.map((message: any) => message.content)).toEqual([
      "Can you summarize the deploy issue?",
      "Yes. The deploy failed because the env var was missing.",
    ]);

    const otherUserSessionMessages = await t.withIdentity(otherUser).query(typedApi.crystal.messages.getSessionMessages, {
      sessionKey: "session-turns-1",
    });

    expect(otherUserSessionMessages).toHaveLength(1);
    expect(otherUserSessionMessages[0].content).toBe("Leak check from a different user");
  });
});
