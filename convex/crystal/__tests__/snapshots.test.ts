import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/snapshots": () => import("../snapshots"),
  "crystal/userProfiles": () => import("../userProfiles"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/mcp": () => import("../mcp"),
  "crystal/salience": () => import("../salience"),
  "crystal/graphEnrich": () => import("../graphEnrich"),
  "crystal/geminiGuardrail": () => import("../geminiGuardrail"),
};

describe("conversation snapshots", () => {
  const owner = { subject: "owner-user", tokenIdentifier: "owner-token", issuer: "test" };
  const otherUser = { subject: "other-user", tokenIdentifier: "other-token", issuer: "test" };
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("EMBEDDING_PROVIDER", "gemini");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a snapshot with valid data", async () => {
    const result = await t.mutation(internal.crystal.snapshots.createSnapshot, {
      userId: "snapshot-user",
      sessionKey: "session-1",
      channel: "openclaw:test",
      messages: [
        { role: "user", content: "Alpha beta gamma delta", timestamp: 1_710_000_000_000 },
        { role: "assistant", content: "Short reply", timestamp: 1_710_000_000_100 },
      ],
      reason: "compaction",
    });

    expect(result.messageCount).toBe(2);
    expect(result.totalTokens).toBe(Math.ceil(("Alpha beta gamma delta".length + "Short reply".length) / 4));

    const snapshot = await t.query(internal.crystal.snapshots.getSnapshot, {
      snapshotId: result.id,
      userId: "snapshot-user",
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.sessionKey).toBe("session-1");
    expect(snapshot?.messages).toHaveLength(2);
  });

  it("rejects an empty messages array", async () => {
    await expect(
      t.mutation(internal.crystal.snapshots.createSnapshot, {
        userId: "snapshot-user",
        sessionKey: "session-empty",
        channel: "openclaw:test",
        messages: [],
        reason: "compaction",
      })
    ).rejects.toThrow();
  });

  it("throws unauthorized for the wrong userId", async () => {
    const result = await t.mutation(internal.crystal.snapshots.createSnapshot, {
      userId: "owner-user",
      sessionKey: "session-auth",
      channel: "openclaw:test",
      messages: [{ role: "user", content: "Owner only" }],
      reason: "compaction",
    });

    await expect(
      t.query(internal.crystal.snapshots.getSnapshot, {
        snapshotId: result.id,
        userId: "other-user",
      })
    ).rejects.toThrow("unauthorized");
  });

  it("estimates tokens at roughly four characters per token", async () => {
    const result = await t.mutation(internal.crystal.snapshots.createSnapshot, {
      userId: "token-user",
      sessionKey: "session-tokens",
      channel: "openclaw:test",
      messages: [
        { role: "user", content: "1234" },
        { role: "assistant", content: "12345" },
      ],
      reason: "compaction",
    });

    expect(result.totalTokens).toBe(3);
  });

  it("rejects messages with invalid roles", async () => {
    await expect(
      t.mutation(internal.crystal.snapshots.createSnapshot, {
        userId: "snapshot-user",
        sessionKey: "session-invalid-role",
        channel: "openclaw:test",
        messages: [{ role: "tool", content: "not allowed" }],
        reason: "compaction",
      })
    ).rejects.toThrow("invalid message role");
  });

  it("rejects messages with empty content", async () => {
    await expect(
      t.mutation(internal.crystal.snapshots.createSnapshot, {
        userId: "snapshot-user",
        sessionKey: "session-empty-content",
        channel: "openclaw:test",
        messages: [{ role: "user", content: "   " }],
        reason: "compaction",
      })
    ).rejects.toThrow("message content");
  });

  it("rejects snapshots with more than 10000 messages", async () => {
    await expect(
      t.mutation(internal.crystal.snapshots.createSnapshot, {
        userId: "snapshot-user",
        sessionKey: "session-overflow",
        channel: "openclaw:test",
        messages: Array.from({ length: 10001 }, () => ({ role: "user" as const, content: "x" })),
        reason: "compaction",
      })
    ).rejects.toThrow("10000");
  });

  it("rejects a blank reason", async () => {
    await expect(
      t.mutation(internal.crystal.snapshots.createSnapshot, {
        userId: "snapshot-user",
        sessionKey: "session-blank-reason",
        channel: "openclaw:test",
        messages: [{ role: "user", content: "hello" }],
        reason: "   ",
      })
    ).rejects.toThrow("reason");
  });

  it("rejects a blank sessionKey", async () => {
    await expect(
      t.mutation(internal.crystal.snapshots.createSnapshot, {
        userId: "snapshot-user",
        sessionKey: "   ",
        channel: "openclaw:test",
        messages: [{ role: "user", content: "hello" }],
        reason: "compaction",
      })
    ).rejects.toThrow("sessionKey");
  });

  it("rejects a blank channel", async () => {
    await expect(
      t.mutation(internal.crystal.snapshots.createSnapshot, {
        userId: "snapshot-user",
        sessionKey: "session-blank-channel",
        channel: "   ",
        messages: [{ role: "user", content: "hello" }],
        reason: "compaction",
      })
    ).rejects.toThrow("channel");
  });

  it("lists snapshots for the authenticated user only", async () => {
    await t.mutation(internal.crystal.snapshots.createSnapshot, {
      userId: "owner-user",
      sessionKey: "shared-session",
      channel: "openclaw:test",
      messages: [{ role: "user", content: "owner snapshot" }],
      reason: "compaction",
    });
    await t.mutation(internal.crystal.snapshots.createSnapshot, {
      userId: "other-user",
      sessionKey: "shared-session",
      channel: "openclaw:test",
      messages: [{ role: "user", content: "other snapshot" }],
      reason: "compaction",
    });

    const snapshots = await t.withIdentity(owner).query(api.crystal.snapshots.listSnapshots, {
      sessionKey: "shared-session",
      limit: 10,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.userId).toBe("owner-user");

    const otherSnapshots = await t.withIdentity(otherUser).query(api.crystal.snapshots.listSnapshots, {
      sessionKey: "shared-session",
      limit: 10,
    });
    expect(otherSnapshots).toHaveLength(1);
    expect(otherSnapshots[0]?.userId).toBe("other-user");
  });

  it("persists sourceSnapshotId when a memory is captured from a snapshot", async () => {
    const snapshot = await t.mutation(internal.crystal.snapshots.createSnapshot, {
      userId: "snapshot-user",
      sessionKey: "session-source",
      channel: "openclaw:test",
      messages: [{ role: "user", content: "source turn" }],
      reason: "compaction",
    });

    const result = await t.mutation(internal.crystal.mcp.captureMemory, {
      userId: "snapshot-user",
      title: "Compaction memory",
      content: "This memory came from a snapshot",
      store: "episodic",
      category: "event",
      tags: ["snapshot"],
      actionTriggers: [],
      channel: "openclaw:test",
      sourceSnapshotId: snapshot.id,
    });

    const memory = await t.query(internal.crystal.mcp.getMemoryById, {
      memoryId: result.id as any,
    });

    expect(memory?.sourceSnapshotId).toBe(snapshot.id);
  });
});
