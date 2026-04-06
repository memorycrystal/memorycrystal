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
 * `requireAuth` calls `validateApiKey` which handles active/expiry checks
 * internally and returns a plain userId string (or null on rejection).
 * Then it fire-and-forgets `touchLastUsedAt`.
 */
function makeCtx(validateResult: string | null) {
  const runQuery = vi.fn(async (ref: unknown) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/apiKeys:validateApiKey") {
      return validateResult;
    }
    if (name === "crystal/organic/ideas:getMyIdeasInternal") {
      return { ideas: [], cursor: null };
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

  return { runQuery, runMutation } as any;
}

describe("organic HTTP auth — active/expiry checks (C-4)", () => {
  it("rejects when validateApiKey returns null (inactive key)", async () => {
    const ctx = makeCtx(null);
    const response = await (organicListIdeas as any)(ctx, makeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects when validateApiKey returns a non-string value", async () => {
    // Simulate validateApiKey returning an unexpected shape
    const ctx = makeCtx({ userId: "user-1" } as any);
    const response = await (organicListIdeas as any)(ctx, makeRequest());
    expect(response.status).toBe(401);
  });

  it("accepts when validateApiKey returns a valid userId", async () => {
    const ctx = makeCtx("user-1");
    const response = await (organicListIdeas as any)(ctx, makeRequest());
    expect(response.status).toBe(200);
  });

  it("calls touchLastUsedAt after successful auth", async () => {
    const ctx = makeCtx("user-1");
    await (organicListIdeas as any)(ctx, makeRequest());
    const touchCalls = ctx.runMutation.mock.calls.filter(
      ([ref]: [unknown]) => getFunctionName(ref as any) === "crystal/apiKeys:touchLastUsedAt"
    );
    expect(touchCalls.length).toBe(1);
  });
});
