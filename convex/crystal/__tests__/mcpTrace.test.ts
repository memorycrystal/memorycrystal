import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { mcpTrace } from "../mcp";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/mcp": () => import("../mcp"),
  "crystal/snapshots": () => import("../snapshots"),
};

function createFakeTraceCtx({
  userId = "user-1",
  memory,
  snapshot,
}: {
  userId?: string;
  memory: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
}) {
  return {
    db: {
      query: (table: string) => ({
        withIndex: () => ({
          first: async () => {
            if (table === "crystalApiKeys") {
              return {
                _id: "key-id",
                active: true,
                userId,
              };
            }
            if (table === "crystalRateLimits") {
              return null;
            }
            throw new Error(`Unexpected table: ${table}`);
          },
        }),
      }),
      patch: async () => undefined,
      insert: async () => "rate-limit-id",
    },
    runQuery: async (ref: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") {
        return {
          _id: "key-id",
          active: true,
          userId,
        };
      }
      if ("memoryId" in args) return memory;
      if ("snapshotId" in args) return snapshot;
      return true;
    },
    runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
      if ("key" in args) {
        return { allowed: true, remaining: 59 };
      }
      return null;
    },
  };
}

describe("mcpTrace", () => {
  it("returns 20 real messages plus omittedCount when truncating a large snapshot", async () => {
    const messages = Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index + 1}`,
    }));

    const response = await (mcpTrace as any)._handler(
      createFakeTraceCtx({
        memory: {
          title: "Traceable",
          content: "Memory content",
          store: "semantic",
          category: "fact",
          userId: "user-1",
          sourceSnapshotId: "snapshot-1",
        },
        snapshot: {
          userId: "user-1",
          messages,
          reason: "compaction",
          createdAt: 1_710_000_000_000,
        },
      }),
      new Request("https://example.test/api/mcp/trace", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ memoryId: "memory-1" }),
      })
    );

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.snapshot.messages).toHaveLength(20);
    expect(payload.snapshot.messages.map((message: { content: string }) => message.content)).toEqual([
      ...messages.slice(0, 10).map((message) => message.content),
      ...messages.slice(-10).map((message) => message.content),
    ]);
    expect(payload.snapshot.omittedCount).toBe(5);
    expect(
      payload.snapshot.messages.some((message: { content: string }) => message.content.includes("messages omitted"))
    ).toBe(false);
  });

  it("treats a snapshot owned by another user as not found", async () => {
    const response = await (mcpTrace as any)._handler(
      createFakeTraceCtx({
        memory: {
          title: "Traceable",
          content: "Memory content",
          store: "semantic",
          category: "fact",
          userId: "user-1",
          sourceSnapshotId: "snapshot-1",
        },
        snapshot: {
          userId: "user-2",
          messages: [{ role: "user", content: "private snapshot" }],
          reason: "compaction",
          createdAt: 1_710_000_000_000,
        },
      }),
      new Request("https://example.test/api/mcp/trace", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ memoryId: "memory-1" }),
      })
    );

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.snapshot).toBeNull();
    expect(payload.reason).toBe("Source snapshot not found — it may have been deleted.");
  });
});

describe("getSnapshotById", () => {
  it("rejects a plain string that is not a crystalSnapshots document ID", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.query(internal.crystal.mcp.getSnapshotById, {
        snapshotId: "not-a-convex-id" as any,
      })
    ).rejects.toThrow();
  });
});
