import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/messages": () => import("../messages"),
  "crystal/stmEmbedder": () => import("../stmEmbedder"),
  "crystal/userProfiles": () => import("../userProfiles"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
};

describe("message lexical search", () => {
  let t: ReturnType<typeof convexTest>;
  const userId = "search_test_user";

  beforeEach(() => {
    vi.useFakeTimers();
    t = convexTest(schema, modules);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds exact older wording beyond the recent-message scan window", async () => {
    const target = "release blocker: unable to pair Android bootstrap token";

    await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: `Pin this exact wording: ${target}`,
    });

    for (let i = 0; i < 260; i += 1) {
      await t.mutation(internal.crystal.messages.logMessageInternal, {
        userId,
        role: "assistant",
        content: `filler message ${i} about routine housekeeping and dashboard cleanup`,
      });
    }

    const results = await t.query(internal.crystal.messages.searchMessagesByTextForUser, {
      userId,
      query: target,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain(target);
  });

  it("treats quoted phrases as exact lexical searches and ranks the exact hit first", async () => {
    const phrase = "phase shift alarm";

    await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: `The exact phrase is ${phrase} and it matters.`,
    });
    await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: "We discussed a phase shift during the alarm review.",
    });
    await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: "Alarm status changed after the phase shift experiment.",
    });

    const results = await t.query(internal.crystal.messages.searchMessagesByTextForUser, {
      userId,
      query: `"${phrase}"`,
      limit: 3,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain(`exact phrase is ${phrase}`);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });
});
