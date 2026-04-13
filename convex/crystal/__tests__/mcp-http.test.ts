import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { mcpEdit, mcpRateLimitCheck, mcpReflect, mcpSnapshot, mcpWakePost } from "../mcp";

const AUTH_TOKEN = "test-api-key";

function makeRequest(body: object) {
  return new Request("https://example.test/api/mcp/snapshot", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeWakeRequest(body: object) {
  return new Request("https://example.test/api/mcp/wake", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeCtx(overrides?: {
  tier?: "free" | "starter" | "pro" | "ultra" | "unlimited";
  currentCount?: number;
  snapshotResult?: { id: string; messageCount: number; totalTokens: number };
}) {
  const apiKeyRecord = {
    _id: "key-id",
    active: true,
    userId: "snapshot-user",
  };

  const runQuery = vi.fn(async (ref: unknown, args?: any) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/mcp:getApiKeyRecord") {
      return apiKeyRecord;
    }
    if (name === "crystal/userProfiles:getUserTier") {
      return overrides?.tier ?? "free";
    }
    if (name === "crystal/messages:getMessageCount") {
      return overrides?.currentCount ?? 0;
    }
    if (name === "crystal/mcp:peekRateLimit") {
      return { allowed: true, remaining: 17 };
    }
    throw new Error(`Unexpected query ref: ${name}`);
  });

  const runMutation = vi.fn(async (ref: unknown, args?: any) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/mcp:checkAndIncrementRateLimit") {
      return { allowed: true, remaining: 59 };
    }
    if (name === "crystal/apiKeys:touchLastUsedAt") {
      return null;
    }
    if (name === "crystal/mcp:writeAuditLog") {
      return null;
    }
    if (name === "crystal/snapshots:createSnapshot") {
      return overrides?.snapshotResult ?? {
        id: "snapshot-id",
        messageCount: args?.messages?.length ?? 0,
        totalTokens: 42,
      };
    }
    throw new Error(`Unexpected mutation ref: ${name}`);
  });
  return {
    runQuery,
    runMutation,
  } as any;
}

describe("mcpSnapshot", () => {
  it("rejects when existing messages plus incoming messages exceed the tier limit", async () => {
    const ctx = makeCtx({ tier: "free", currentCount: 490 });

    const response = await (mcpSnapshot as any)(ctx, makeRequest({
      sessionKey: "session-1",
      channel: "openclaw:test",
      reason: "compaction",
      messages: Array.from({ length: 11 }, (_, index) => ({
        role: "user",
        content: `message ${index}`,
      })),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Storage limit reached"),
      limit: 500,
    });
    expect(ctx.runMutation.mock.calls.some(([ref]: any[]) => getFunctionName(ref as any) === "crystal/snapshots:createSnapshot")).toBe(false);
  });

  it("returns only id, messageCount, and totalTokens on success", async () => {
    const ctx = makeCtx({
      snapshotResult: { id: "snapshot-123", messageCount: 2, totalTokens: 7 },
    });

    const response = await (mcpSnapshot as any)(ctx, makeRequest({
      sessionKey: "session-1",
      channel: "openclaw:test",
      reason: "compaction",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "snapshot-123",
      messageCount: 2,
      totalTokens: 7,
    });
  });
});

describe("mcpEdit", () => {
  it("patches only provided fields and returns success with memoryId", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getMemoryById") {
        return {
          _id: "memory-123",
          userId: "edit-user",
          title: "Old title",
          content: "Old content",
          tags: [],
          store: "semantic",
          category: "fact",
        };
      }
      throw new Error(`Unexpected query ref: ${name}`);
    });

    const runMutation = vi.fn(async (ref: unknown, args?: any) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") {
        return { allowed: true, remaining: 59 };
      }
      if (name === "crystal/apiKeys:touchLastUsedAt") {
        return null;
      }
      if (name === "crystal/mcp:writeAuditLog") {
        return null;
      }
      if (name === "crystal/mcp:updateMemory") {
        return { success: true, memoryId: args?.memoryId };
      }
      throw new Error(`Unexpected mutation ref: ${name}`);
    });

    const response = await (mcpEdit as any)(
      { runQuery: vi.fn(async (ref: unknown) => {
          const name = getFunctionName(ref as any);
          if (name === "crystal/mcp:getApiKeyRecord") {
            return { _id: "key-id", active: true, userId: "edit-user" };
          }
          if (name === "crystal/mcp:getMemoryById") {
            return {
              _id: "memory-123",
              userId: "edit-user",
              title: "Old title",
              content: "Old content",
              tags: [],
              store: "semantic",
              category: "fact",
            };
          }
          throw new Error(`Unexpected query ref: ${name}`);
        }), runMutation } as any,
      new Request("https://example.test/api/mcp/edit", {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          memoryId: "memory-123",
          title: "Updated title",
          tags: ["alpha", "beta"],
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      memoryId: "memory-123",
    });
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      memoryId: "memory-123",
      updates: {
        title: "Updated title",
        tags: ["alpha", "beta"],
      },
    });
  });
});

describe("mcpRateLimitCheck", () => {
  it("returns the read-only rate limit status without incrementing", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") {
        return { _id: "key-id", active: true, userId: "rate-limit-user" };
      }
      if (name === "crystal/mcp:peekRateLimit") {
        return { allowed: true, remaining: 17 };
      }
      throw new Error(`Unexpected query ref: ${name}`);
    });

    const runMutation = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/apiKeys:touchLastUsedAt") {
        return null;
      }
      throw new Error(`Unexpected mutation ref: ${name}`);
    });

    const response = await (mcpRateLimitCheck as any)(
      { runQuery, runMutation } as any,
      new Request("https://example.test/api/mcp/rate-limit-check", {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": "application/json",
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      remaining: 17,
    });
    expect(runMutation.mock.calls.every(([ref]) => getFunctionName(ref as any) === "crystal/apiKeys:touchLastUsedAt")).toBe(true);
  });
});

describe("mcpWakePost", () => {
  it("replaces placeholder last-session rows with recent captured conversation and stores accurate counts", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:listRecentMemories") {
        return [];
      }
      if (name === "crystal/mcp:listRecentCheckpoints") {
        return [];
      }
      if (name === "crystal/mcp:getMemoryStoreStats") {
        return { total: 0 };
      }
      if (name === "crystal/mcp:getGuardrailMemories") {
        return [];
      }
      if (name === "crystal/mcp:getLastSessionByUser") {
        return {
          summary: "No recent conversation captured.",
          lastActiveAt: 1_000,
          messageCount: 0,
        };
      }
      if (name === "crystal/messages:getRecentMessagesForUser") {
        return [
          {
            _id: "msg-1",
            role: "user",
            content: "We fixed the wake briefing bug.",
            channel: "cli",
            sessionKey: "previous-session",
            timestamp: 2_000,
          },
          {
            _id: "msg-2",
            role: "assistant",
            content: "The synthetic wake row was overriding the real conversation.",
            channel: "cli",
            sessionKey: "previous-session",
            timestamp: 3_000,
          },
        ];
      }
      throw new Error(`Unexpected query ref: ${name}`);
    });

    const runMutation = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") {
        return { allowed: true, remaining: 59 };
      }
      if (name === "crystal/apiKeys:touchLastUsedAt") {
        return null;
      }
      if (name === "crystal/mcp:writeAuditLog") {
        return null;
      }
      if (name === "crystal/sessions:createSessionInternal") {
        return "session-id";
      }
      throw new Error(`Unexpected mutation ref: ${name}`);
    });

    const response = await (mcpWakePost as any)(
      { runQuery: vi.fn(async (ref: unknown) => {
          const name = getFunctionName(ref as any);
          if (name === "crystal/mcp:getApiKeyRecord") {
            return { _id: "key-id", active: true, userId: "wake-user" };
          }
          if (name === "crystal/mcp:listRecentMemories") return [];
          if (name === "crystal/mcp:listRecentCheckpoints") return [];
          if (name === "crystal/mcp:getMemoryStoreStats") return { total: 0 };
          if (name === "crystal/mcp:getGuardrailMemories") return [];
          if (name === "crystal/mcp:getLastSessionByUser") {
            return { summary: "No recent conversation captured.", lastActiveAt: 1_000, messageCount: 0 };
          }
          if (name === "crystal/messages:getRecentMessagesForUser") {
            return [
              { _id: "msg-1", role: "user", content: "We fixed the wake briefing bug.", channel: "cli", sessionKey: "previous-session", timestamp: 2_000 },
              { _id: "msg-2", role: "assistant", content: "The synthetic wake row was overriding the real conversation.", channel: "cli", sessionKey: "previous-session", timestamp: 3_000 },
            ];
          }
          throw new Error(`Unexpected query ref: ${name}`);
        }), runMutation } as any,
      makeWakeRequest({ channel: "cli" })
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      briefing: expect.stringContaining("## Last session ("),
    });
    expect(payload.briefing).toContain("2 messages");
    expect(payload.briefing).toContain("We fixed the wake briefing bug.");
    expect(payload.briefing).not.toContain("No recent conversation captured.");

    expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "wake-user",
      channel: "cli",
      startedAt: 2_000,
      lastActiveAt: 3_000,
      messageCount: 2,
      summary: expect.stringContaining("We fixed the wake briefing bug."),
    }));
  });
});

describe("mcpReflect", () => {
  it("returns a generic error body when reflection fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") {
        return { _id: "key-id", active: true, userId: "reflect-user" };
      }
      throw new Error(`Unexpected query ref: ${name}`);
    });
    const runMutation = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") {
        return { allowed: true, remaining: 59 };
      }
      if (name === "crystal/apiKeys:touchLastUsedAt") {
        return null;
      }
      throw new Error(`Unexpected mutation ref: ${name}`);
    });
    const runAction = vi.fn(async () => {
      throw new Error("upstream reflected stack path");
    });

    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const response = await (mcpReflect as any)(
      { runQuery, runMutation, runAction } as any,
      new Request("https://example.test/api/mcp/reflect", {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ windowHours: 2 }),
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal error processing request",
    });
    expect(consoleError).toHaveBeenCalled();
  });
});
