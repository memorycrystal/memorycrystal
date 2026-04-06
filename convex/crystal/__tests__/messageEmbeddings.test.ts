import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/impersonation": () => import("../impersonation"),
  "crystal/messages": () => import("../messages"),
  "crystal/permissions": () => import("../permissions"),
  "crystal/stmEmbedder": () => import("../stmEmbedder"),
  "crystal/userProfiles": () => import("../userProfiles"),
};

const user = { subject: "user_a", tokenIdentifier: "token_a", issuer: "test" };
const embedding = Array.from({ length: 3072 }, (_, i) => (i + 1) * 0.0001);

describe("message embedding pipeline", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T20:00:00.000Z"));
    t = convexTest(schema, modules);

    process.env.EMBEDDING_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ embedding: { values: embedding } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.GEMINI_API_KEY;
  });

  it("embeds newly logged messages via the scheduled background job", async () => {
    const messageId = await t.withIdentity(user).mutation(api.crystal.messages.logMessage, {
      role: "user",
      content: "Remember the red notebook from the meeting.",
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const message = await t.withIdentity(user).query(api.crystal.messages.getMessage, { messageId });
    expect(message?.embedded).toBe(true);
    expect(message?.embedding).toHaveLength(3072);
  });

  it("returns oldest unembedded messages first so backlog items do not starve", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("crystalMessages", {
        userId: "user_a",
        role: "user",
        content: "first pending message",
        timestamp: 1,
        embedded: false,
        expiresAt: 10_000,
      });
      await ctx.db.insert("crystalMessages", {
        userId: "user_a",
        role: "assistant",
        content: "second pending message",
        timestamp: 2,
        embedded: false,
        expiresAt: 10_001,
      });
      await ctx.db.insert("crystalMessages", {
        userId: "user_a",
        role: "user",
        content: "third pending message",
        timestamp: 3,
        embedded: false,
        expiresAt: 10_002,
      });
    });

    const pending = await t.withIdentity(user).query(api.crystal.messages.getUnembeddedMessagesForUser, {
      limit: 2,
    });

    expect(pending.map((message: any) => message.content)).toEqual([
      "first pending message",
      "second pending message",
    ]);
  });
});
