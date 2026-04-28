import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { organicListIdeas } from "../organic/http";

const AUTH_TOKEN = "test-api-key";

function makeRequest(body: object = {}) {
  return new Request("https://example.test/api/organic/ideas", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * `requireAuth` now calls `ctx.runQuery(internal.crystal.mcp.getApiKeyRecord, { keyHash })`
 * and `ctx.runMutation(internal.crystal.apiKeys.touchLastUsedAt, { keyHash })`.
 * Rate limiting calls `ctx.runMutation(internal.crystal.mcp.checkAndIncrementRateLimit, ...)`.
 * Ideas listing calls `ctx.runQuery(internal.crystal.organic.ideas.getMyIdeasInternal, ...)`.
 */
function makeCtx(apiKeyRecord: { _id: string; userId: unknown; active: boolean; expiresAt?: number } | null) {
  const touchCalls: unknown[] = [];
  const ideaQueryArgs: unknown[] = [];

  const runQuery = vi.fn(async (ref: unknown, args: any) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/mcp:getApiKeyRecord") {
      return apiKeyRecord;
    }
    if (name === "crystal/organic/ideas:getMyIdeasInternal") {
      ideaQueryArgs.push(args);
      return { ideas: [], nextCursor: null };
    }
    throw new Error(`Unexpected query ref: ${name}`);
  });

  const runMutation = vi.fn(async (ref: unknown, args: any) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/apiKeys:touchLastUsedAt") {
      touchCalls.push(args);
      return;
    }
    if (name === "crystal/mcp:checkAndIncrementRateLimit") {
      return { allowed: true, remaining: 59 };
    }
    throw new Error(`Unexpected mutation ref: ${name}`);
  });

  return { runQuery, runMutation, _touchCalls: touchCalls, _ideaQueryArgs: ideaQueryArgs } as any;
}

describe("organic HTTP auth — active/expiry checks (C-4)", () => {
  it("rejects when getApiKeyRecord returns null (no key)", async () => {
    const ctx = makeCtx(null);
    const response = await (organicListIdeas as any)(ctx, makeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects when userId is not a string", async () => {
    const ctx = makeCtx({ _id: "key-id", userId: 42, active: true } as any);
    const response = await (organicListIdeas as any)(ctx, makeRequest());
    expect(response.status).toBe(401);
  });

  it("accepts when key record is valid", async () => {
    const ctx = makeCtx({ _id: "key-id", userId: "user-1", active: true });
    const response = await (organicListIdeas as any)(ctx, makeRequest());
    expect(response.status).toBe(200);
  });

  it("calls touchLastUsedAt after successful auth", async () => {
    const ctx = makeCtx({ _id: "key-id", userId: "user-1", active: true });
    await (organicListIdeas as any)(ctx, makeRequest());
    const touchCall = ctx.runMutation.mock.calls.find(
      ([ref]: [unknown]) => getFunctionName(ref as any) === "crystal/apiKeys:touchLastUsedAt"
    );
    expect(touchCall).toBeDefined();
  });

  it("rejects malformed cursor payloads before hitting the internal query", async () => {
    const ctx = makeCtx({ _id: "key-id", userId: "user-1", active: true });
    const response = await (organicListIdeas as any)(
      ctx,
      makeRequest({ cursor: { createdAt: "bad", id: "not-a-real-id" } })
    );
    expect(response.status).toBe(400);
    expect(ctx._ideaQueryArgs).toHaveLength(0);
  });

  it("rejects cursor ids that do not match Convex id format", async () => {
    const ctx = makeCtx({ _id: "key-id", userId: "user-1", active: true });
    const response = await (organicListIdeas as any)(
      ctx,
      makeRequest({ cursor: { createdAt: Date.now(), id: "bad-id!" } })
    );
    expect(response.status).toBe(400);
    expect(ctx._ideaQueryArgs).toHaveLength(0);
  });

  it("passes valid cursor payloads through to the internal query", async () => {
    const ctx = makeCtx({ _id: "key-id", userId: "user-1", active: true });
    const cursor = { createdAt: 1234567890, id: "abc123def456" };
    const response = await (organicListIdeas as any)(ctx, makeRequest({ cursor }));
    expect(response.status).toBe(200);
    expect(ctx._ideaQueryArgs).toHaveLength(1);
    expect(ctx._ideaQueryArgs[0]).toMatchObject({ cursor });
  });
});
