import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import {
  mcpCapture,
  mcpEdit,
  mcpGetTriggers,
  mcpMetric,
  mcpRateLimitCheck,
  mcpRecall,
  mcpReflect,
  mcpSnapshot,
  mcpSupersede,
  mcpUpdate,
  mcpWakePost,
  resetMcpRecallCachesForTests,
} from "../mcp";

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

function makeRecallRequest(body: object) {
  return new Request("https://example.test/api/mcp/recall", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeCaptureRequest(body: object) {
  return new Request("https://example.test/api/mcp/capture", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeMetricRequest(body: object) {
  return new Request("https://example.test/api/mcp/metric", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeUnauthedMetricRequest(body: object) {
  return new Request("https://example.test/api/mcp/metric", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeTriggersRequest(body: object) {
  return new Request("https://example.test/api/mcp/triggers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeEmbeddingFetchSpy() {
  const fetchSpy = vi.fn(async () =>
    new Response(
      JSON.stringify({
        embedding: { values: Array.from({ length: 3072 }, (_, index) => index * 0.000001) },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function makeRecallCacheCtx() {
  const runQuery = vi.fn(async (ref: unknown) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/mcp:getApiKeyRecord") {
      return { _id: "key-id", active: true, userId: "recall-user" };
    }
    if (name === "crystal/messages:searchMessagesByTextForUser") {
      return [];
    }
    if (name === "crystal/messages:getRecentMessagesForUser") {
      return [];
    }
    throw new Error(`Unexpected query ref: ${name}`);
  });

  const runMutation = vi.fn(async (ref: unknown) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/mcp:checkAndIncrementRateLimit") {
      return { allowed: true, remaining: 59 };
    }
    if (name === "crystal/apiKeys:touchLastUsedAt") return null;
    if (name === "crystal/mcp:writeAuditLog") return null;
    throw new Error(`Unexpected mutation ref: ${name}`);
  });

  const runAction = vi.fn(async (ref: unknown) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/mcp:semanticSearch") {
      return [{
        _id: "memory-1",
        title: "Atlas decision",
        content: "Ship atlas after QA",
        metadata: undefined,
        store: "semantic",
        category: "decision",
        tags: ["atlas"],
        createdAt: Date.now(),
        score: 0.9,
        confidence: 0.8,
        rankingSignals: {
          vectorScore: 0.9,
          strengthScore: 1,
          freshnessScore: 1,
          accessScore: 0,
          salienceScore: 0,
          continuityScore: 0,
          textMatchScore: 0.5,
        },
      }];
    }
    if (name === "crystal/messages:searchMessagesForUser") {
      return [];
    }
    throw new Error(`Unexpected action ref: ${name}`);
  });

  return { runQuery, runMutation, runAction } as const;
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

describe("mcpMetric", () => {
  it("authenticates and inserts telemetry", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") return { _id: "key-id", active: true, userId: "metric-user" };
      throw new Error(`Unexpected query ref: ${name}`);
    });
    const runMutation = vi.fn(async (ref: unknown, args?: any) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      if (name === "crystal/mcp:insertTelemetry") return "telemetry-id";
      if (name === "crystal/mcp:writeAuditLog") return null;
      throw new Error(`Unexpected mutation ref: ${name}`);
    });

    const response = await (mcpMetric as any)(
      { runQuery, runMutation } as any,
      makeMetricRequest({
        kind: "crystal_capture_stalled",
        sessionKey: "session-1",
        channel: "telegram:123",
        payload: JSON.stringify({ pendingCount: 4 }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, id: "telemetry-id" });
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "metric-user",
      kind: "crystal_capture_stalled",
      sessionKey: "session-1",
      channel: "telegram:123",
      payload: JSON.stringify({ pendingCount: 4 }),
      expiresAt: expect.any(Number),
    }));
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "metric",
      meta: JSON.stringify({
        kind: "crystal_capture_stalled",
        sessionKey: "session-1",
        channel: "telegram:123",
        payloadBytes: JSON.stringify({ pendingCount: 4 }).length,
      }),
    }));
  });

  it("rejects missing bearer auth", async () => {
    const response = await (mcpMetric as any)(
      { runQuery: vi.fn(), runMutation: vi.fn() } as any,
      makeUnauthedMetricRequest({ kind: "crystal_capture_stalled", payload: "{}" }),
    );

    expect(response.status).toBe(401);
  });

  it("validates metric kind and payload size before insert", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") return { _id: "key-id", active: true, userId: "metric-user" };
      throw new Error(`Unexpected query ref: ${name}`);
    });
    const runMutation = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      throw new Error(`Unexpected mutation ref: ${name}`);
    });

    const invalidKind = await (mcpMetric as any)(
      { runQuery, runMutation } as any,
      makeMetricRequest({ kind: "Bad Kind", payload: "{}" }),
    );
    expect(invalidKind.status).toBe(400);

    const oversizedPayload = await (mcpMetric as any)(
      { runQuery, runMutation } as any,
      makeMetricRequest({ kind: "crystal_capture_stalled", payload: "x".repeat(32_001) }),
    );
    expect(oversizedPayload.status).toBe(413);
    expect(runMutation).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: "crystal_capture_stalled",
      payload: "x".repeat(32_001),
    }));
  });

  it("stringifies object payloads and caps scope fields", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") return { _id: "key-id", active: true, userId: "metric-user" };
      throw new Error(`Unexpected query ref: ${name}`);
    });
    const runMutation = vi.fn(async (ref: unknown, args?: any) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      if (name === "crystal/mcp:insertTelemetry") return "telemetry-id";
      if (name === "crystal/mcp:writeAuditLog") return null;
      throw new Error(`Unexpected mutation ref: ${name}`);
    });

    const response = await (mcpMetric as any)(
      { runQuery, runMutation } as any,
      makeMetricRequest({
        kind: "crystal_capture_stalled",
        sessionKey: "s".repeat(300),
        channel: "c".repeat(300),
        payload: { pendingCount: 4 },
      }),
    );

    expect(response.status).toBe(200);
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionKey: "s".repeat(256),
      channel: "c".repeat(256),
      payload: JSON.stringify({ pendingCount: 4 }),
    }));
  });
});

describe("mcpEdit", () => {
  it("returns contradiction details from capture writes", async () => {
    const contradiction = {
      detected: true,
      score: 0.91,
      conflictType: "factual",
      explanation: "Budget values disagree",
      suggestedResolution: "Ask which budget is current",
      conflictingMemory: {
        id: "existing-memory",
        title: "Old budget",
        contentPreview: "Budget is $50K",
        similarity: 0.88,
      },
      pairKey: "existing-memory::new-memory",
      actionRequired: true,
    };
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") return { _id: "key-id", active: true, userId: "capture-user" };
      if (name === "crystal/userProfiles:getUserTier") return "free";
      if (name === "crystal/mcp:getMemoryCount") return 0;
      if (name === "crystal/organic/adminTick:getOrganicStatus") {
        return { enabled: true, organicModel: "potato", openrouterApiKey: "sk-or-user" };
      }
      throw new Error(`Unexpected query ref: ${name}`);
    });
    const runMutation = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      if (name === "crystal/mcp:writeAuditLog") return null;
      if (name === "crystal/mcp:captureMemory") return { id: "new-memory" };
      throw new Error(`Unexpected mutation ref: ${name}`);
    });
    const runAction = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/organic/contradictions:detectImmediateContradiction") {
        return { status: "ok", contradiction };
      }
      throw new Error(`Unexpected action ref: ${name}`);
    });

    const response = await (mcpCapture as any)(
      { runQuery, runMutation, runAction } as any,
      makeCaptureRequest({
        title: "New budget",
        content: "Budget is $75K",
        store: "semantic",
        category: "fact",
        channel: "coder:general",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      id: "new-memory",
      contradiction,
      contradictionCheck: { status: "ok" },
    });
    expect(runAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "capture-user",
      memoryId: "new-memory",
      channel: "coder:general",
      organicModel: "potato",
      openrouterApiKey: "sk-or-user",
    }));
  });

  it("skips write-time contradiction checks when Organic is disabled", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") return { _id: "key-id", active: true, userId: "capture-user" };
      if (name === "crystal/userProfiles:getUserTier") return "free";
      if (name === "crystal/mcp:getMemoryCount") return 0;
      if (name === "crystal/organic/adminTick:getOrganicStatus") return { enabled: false };
      throw new Error(`Unexpected query ref: ${name}`);
    });
    const runMutation = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      if (name === "crystal/mcp:writeAuditLog") return null;
      if (name === "crystal/mcp:captureMemory") return { id: "new-memory" };
      throw new Error(`Unexpected mutation ref: ${name}`);
    });
    const runAction = vi.fn();

    const response = await (mcpCapture as any)(
      { runQuery, runMutation, runAction } as any,
      makeCaptureRequest({
        title: "New budget",
        content: "Budget is $75K",
        store: "semantic",
        category: "fact",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      id: "new-memory",
      contradictionCheck: { status: "skipped", reason: "organic_disabled" },
    });
    expect(runAction).not.toHaveBeenCalled();
  });

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

    const runAction = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/organic/contradictions:detectImmediateContradiction") {
        return { status: "ok", contradiction: null };
      }
      throw new Error(`Unexpected action ref: ${name}`);
    });

    const response = await (mcpEdit as any)(
      { runQuery: vi.fn(async (ref: unknown) => {
          const name = getFunctionName(ref as any);
          if (name === "crystal/mcp:getApiKeyRecord") {
            return { _id: "key-id", active: true, userId: "edit-user" };
          }
          if (name === "crystal/organic/adminTick:getOrganicStatus") {
            return { enabled: true, organicModel: "medium", openrouterApiKey: "sk-or-edit" };
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
        }), runMutation, runAction } as any,
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
      userId: "edit-user",
      updates: {
        title: "Updated title",
        tags: ["alpha", "beta"],
      },
    });
    expect(runAction).toHaveBeenCalled();
  });

  it("exposes crystal_update through the update endpoint with extended fields", async () => {
    const runMutation = vi.fn(async (ref: unknown, args?: any) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      if (name === "crystal/mcp:writeAuditLog") return null;
      if (name === "crystal/mcp:updateMemory") return { success: true, memoryId: args?.memoryId };
      throw new Error(`Unexpected mutation ref: ${name}`);
    });
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") return { _id: "key-id", active: true, userId: "edit-user" };
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

    const response = await (mcpUpdate as any)(
      { runQuery, runMutation } as any,
      new Request("https://example.test/api/mcp/update", {
        method: "POST",
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          memoryId: "memory-123",
          metadata: "corrected",
          confidence: 0.9,
          actionTriggers: ["crystal_recall"],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, memoryId: "memory-123" });
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      memoryId: "memory-123",
      userId: "edit-user",
      updates: {
        metadata: "corrected",
        confidence: 0.9,
        actionTriggers: ["crystal_recall"],
      },
    });
  });
});

describe("mcpSupersede", () => {
  it("creates an atomic supersede request for owned memories", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") return { _id: "key-id", active: true, userId: "owner" };
      if (name === "crystal/organic/adminTick:getOrganicStatus") {
        return { enabled: true, organicModel: "cheap", openrouterApiKey: "sk-or-owner" };
      }
      if (name === "crystal/mcp:getMemoryById") {
        return {
          _id: "old-memory",
          userId: "owner",
          title: "Old title",
          content: "Old content",
          store: "semantic",
          category: "fact",
          tags: ["old"],
          source: "conversation",
          channel: "cli",
          actionTriggers: [],
        };
      }
      throw new Error(`Unexpected query ref: ${name}`);
    });
    const runMutation = vi.fn(async (ref: unknown, args?: any) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      if (name === "crystal/mcp:writeAuditLog") return null;
      if (name === "crystal/mcp:supersedeMemory") {
        return { success: true, action: "superseded", oldMemoryId: args.oldMemoryId, newMemoryId: "new-memory" };
      }
      throw new Error(`Unexpected mutation ref: ${name}`);
    });
    const runAction = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/organic/contradictions:detectImmediateContradiction") {
        return { status: "ok", contradiction: null };
      }
      throw new Error(`Unexpected action ref: ${name}`);
    });

    const response = await (mcpSupersede as any)(
      { runQuery, runMutation, runAction } as any,
      new Request("https://example.test/api/mcp/supercede", {
        method: "POST",
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          oldMemoryId: "old-memory",
          title: "New title",
          content: "New content",
          reason: "correction",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      action: "superseded",
      oldMemoryId: "old-memory",
      newMemoryId: "new-memory",
    });
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      oldMemoryId: "old-memory",
      userId: "owner",
      title: "New title",
      content: "New content",
      reason: "correction",
    }));
    expect(runAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      memoryId: "new-memory",
      excludeMemoryIds: ["old-memory"],
      organicModel: "cheap",
      openrouterApiKey: "sk-or-owner",
    }));
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

describe("mcpGetTriggers", () => {
  it("hydrates only lookup-selected trigger memories and filters stale rows", async () => {
    const runQuery = vi.fn(async (ref: unknown, args?: any) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") {
        return { _id: "key-id", active: true, userId: "trigger-user" };
      }
      if (name === "crystal/mcp:getTriggeredMemoryIdsForTools") {
        expect(args).toMatchObject({
          userId: "trigger-user",
          tools: ["crystal_recall"],
          perToolLimit: 50,
        });
        return ["memory-visible", "memory-stale", "memory-archived", "memory-recent"];
      }
      if (name === "crystal/mcp:getMemoriesByIds") {
        expect(args.memoryIds).toEqual(["memory-visible", "memory-stale", "memory-archived", "memory-recent"]);
        return [
          {
            _id: "memory-visible",
            userId: "trigger-user",
            title: "Visible trigger",
            content: "Use this when recall runs.",
            store: "procedural",
            category: "workflow",
            tags: ["recall"],
            actionTriggers: ["crystal_recall"],
            lastAccessedAt: 30,
            createdAt: 10,
            archived: false,
          },
          {
            _id: "memory-stale",
            userId: "trigger-user",
            title: "Stale trigger row",
            content: "The lookup row is stale.",
            store: "procedural",
            category: "workflow",
            tags: [],
            actionTriggers: ["other_tool"],
            lastAccessedAt: 40,
            createdAt: 10,
            archived: false,
          },
          {
            _id: "memory-archived",
            userId: "trigger-user",
            title: "Archived trigger",
            content: "Do not return archived memories.",
            store: "procedural",
            category: "workflow",
            tags: [],
            actionTriggers: ["crystal_recall"],
            lastAccessedAt: 50,
            createdAt: 10,
            archived: true,
          },
          {
            _id: "memory-recent",
            userId: "trigger-user",
            title: "More recent trigger",
            content: "Return this first after hydration.",
            store: "procedural",
            category: "workflow",
            tags: ["recall"],
            actionTriggers: ["crystal_recall"],
            lastAccessedAt: 80,
            createdAt: 20,
            archived: false,
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
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      throw new Error(`Unexpected mutation ref: ${name}`);
    });

    const response = await (mcpGetTriggers as any)(
      { runQuery, runMutation } as any,
      makeTriggersRequest({ tools: ["crystal_recall"] }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      memories: [
        {
          _id: "memory-recent",
          title: "More recent trigger",
          content: "Return this first after hydration.",
          store: "procedural",
          category: "workflow",
          tags: ["recall"],
          actionTriggers: ["crystal_recall"],
          createdAt: 20,
          score: 1,
        },
        {
          _id: "memory-visible",
          title: "Visible trigger",
          content: "Use this when recall runs.",
          store: "procedural",
          category: "workflow",
          tags: ["recall"],
          actionTriggers: ["crystal_recall"],
          createdAt: 10,
          score: 1,
        },
      ],
    });
    expect(runQuery.mock.calls.map(([ref]) => getFunctionName(ref as any))).not.toContain(
      "crystal/mcp:getMemoriesWithTriggers",
    );
  });
});

describe("mcpRecall caching", () => {
  it("reuses the same query embedding for memory and message search within one request", async () => {
    resetMcpRecallCachesForTests();
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    const fetchSpy = makeEmbeddingFetchSpy();
    const ctx = makeRecallCacheCtx();

    const response = await (mcpRecall as any)(
      ctx as any,
      makeRecallRequest({ query: "atlas qa decision", limit: 5, channel: "discord:memorycrystal" }),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reuses the cached embedding across identical requests", async () => {
    resetMcpRecallCachesForTests();
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    const fetchSpy = makeEmbeddingFetchSpy();
    const ctx = makeRecallCacheCtx();
    const request = makeRecallRequest({ query: "atlas qa decision", limit: 5, channel: "discord:memorycrystal" });

    const first = await (mcpRecall as any)(ctx, request);
    const second = await (mcpRecall as any)(ctx, makeRecallRequest({ query: "atlas qa decision", limit: 5, channel: "discord:memorycrystal" }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ctx.runAction.mock.calls.filter(([ref]) => getFunctionName(ref as any) === "crystal/mcp:semanticSearch")).toHaveLength(2);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
