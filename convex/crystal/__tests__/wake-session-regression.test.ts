import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/knowledgeBases": () => import("../knowledgeBases"),
  "crystal/messages": () => import("../messages"),
  "crystal/sessions": () => import("../sessions"),
  "crystal/stmEmbedder": () => import("../stmEmbedder"),
  "crystal/userProfiles": () => import("./stubs/userProfiles"),
  "crystal/wake": () => import("../wake"),
};

const user = {
  subject: "wake-session-user",
  tokenIdentifier: "token-wake-session-user",
  issuer: "test",
};

describe("wake session regression", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(async () => {
    vi.useFakeTimers();
    t = convexTest(schema, modules);
    await t.mutation(internal.crystal.userProfiles.upsertSubscriptionByUserInternal, {
      userId: user.subject,
      subscriptionStatus: "active",
      plan: "starter",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows actual recent conversation instead of a stale placeholder after a reset/new session", async () => {
    const channel = "cli";
    const base = Date.UTC(2026, 3, 7, 12, 0, 0);

    vi.setSystemTime(base - 60_000);
    await t.withIdentity(user).mutation(api.crystal.sessions.createSession, {
      channel,
      startedAt: base - 60_000,
      lastActiveAt: base - 60_000,
      messageCount: 0,
      memoryCount: 0,
      summary: "No recent conversation captured.",
      participants: [],
    });

    vi.setSystemTime(base - 30_000);
    await t.withIdentity(user).mutation(api.crystal.messages.logMessage, {
      role: "user",
      content: "We fixed the wake briefing bug.",
      channel,
      sessionKey: "previous-session",
    });

    vi.setSystemTime(base - 20_000);
    await t.withIdentity(user).mutation(api.crystal.messages.logMessage, {
      role: "assistant",
      content: "The wake row was shadowing the real conversation.",
      channel,
      sessionKey: "previous-session",
    });

    vi.setSystemTime(base);
    const wake = await t.withIdentity(user).action((api as any).crystal.wake.getWakePrompt, {
      channel,
    });

    expect(wake.briefing).toContain("## Last session (");
    expect(wake.briefing).toContain("2 messages");
    expect(wake.briefing).toContain("We fixed the wake briefing bug.");
    expect(wake.briefing).not.toContain("No recent conversation captured.");
    expect(wake.recentMessages).toHaveLength(2);

    const lastSession = await t.withIdentity(user).query(api.crystal.sessions.getLastSession, {
      channel,
    });

    expect(lastSession?.messageCount).toBe(2);
    expect(lastSession?.lastActiveAt).toBe(base - 20_000);
    expect(lastSession?.summary).toContain("We fixed the wake briefing bug.");
  });
});
