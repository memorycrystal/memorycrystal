/**
 * Chaos: CF API 429 rate-limit during pool refill.
 *
 * Verifies the `cfFetch` retry layer in `infra/cloudflare/api.ts`:
 *   - Exponential backoff: 1s → ×1.5 → max 30s.
 *   - Max 5 attempts.
 *   - No CFError thrown until attempts exhausted.
 *   - After exhaustion: CFError thrown with status=429 and a redacted message
 *     (the CF API token must NOT appear in the error message).
 *
 * Uses vi.useFakeTimers() to advance through backoff delays synchronously.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCFFetchMock, makeCFFetchMockWithRateLimit } from "./__helpers__/mockCFFetch";

const FAKE_TOKEN = "test_cf_api_token_chaos_ratelimit_abc123";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.CF_API_TOKEN = FAKE_TOKEN;
  process.env.CF_TUNNELS_ZONE_ID = "zone-chaos-test";
  vi.useFakeTimers();
});

afterEach(() => {
  delete process.env.CF_API_TOKEN;
  delete process.env.CF_TUNNELS_ZONE_ID;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helper: advance timers past all backoff windows (1s+1.5s+2.25s+3.375s+5.0625s ≈ 13s; cap 30s).
// ---------------------------------------------------------------------------
async function advancePastAllRetries() {
  // Advance 60s to be safe — the max cumulative backoff under 5 attempts with
  // 1.5× multiplier starting at 1s is well under 60s.
  await vi.advanceTimersByTimeAsync(60_000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cf-api-rate-limit — exponential backoff on 429", () => {
  it("retries on 429 and succeeds without throwing CFError", async () => {
    // 2 rate-limit responses, then success.
    const mock = makeCFFetchMockWithRateLimit(2, { id: "tun-ok" });
    vi.stubGlobal("fetch", mock);

    const { cfFetch } = await import("../../infra/cloudflare/api.js");

    const promise = cfFetch<{ result: { id: string } }>("/test/endpoint");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    // No throw; returned the success result.
    expect(result).toBeDefined();
    expect(mock).toHaveBeenCalledTimes(3); // 2 failures + 1 success
  });

  it("applies 1s → 1.5× → max 30s backoff schedule", async () => {
    // 4 failures then success — lets us observe the 3 inter-retry delays.
    const mock = makeCFFetchMockWithRateLimit(4, {});
    vi.stubGlobal("fetch", mock);

    const { cfFetch } = await import("../../infra/cloudflare/api.js");

    const promise = cfFetch("/test/backoff");

    // After 0ms: attempt 1 (429)
    expect(mock).toHaveBeenCalledTimes(1);

    // After <1s: no new attempt yet.
    await vi.advanceTimersByTimeAsync(900);
    expect(mock).toHaveBeenCalledTimes(1);

    // After 1s: attempt 2 (429).
    await vi.advanceTimersByTimeAsync(200);
    expect(mock).toHaveBeenCalledTimes(2);

    // After ~1s more (1.5s delay from attempt 2): attempt 3 (429).
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mock).toHaveBeenCalledTimes(3);

    // After ~2.25s more: attempt 4 (429).
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mock).toHaveBeenCalledTimes(4);

    // Advance through remaining delay to attempt 5 (success).
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result).toBeDefined();
    expect(mock).toHaveBeenCalledTimes(5);
  });

  it("throws CFError with status=429 after max 5 attempts exhausted", async () => {
    // All 5 attempts return 429.
    const mock = makeCFFetchMock(Array.from({ length: 5 }, () => ({ type: "rate429" as const })));
    vi.stubGlobal("fetch", mock);

    const { cfFetch, CFError } = await import("../../infra/cloudflare/api.js");

    const promise = cfFetch("/test/exhaust").catch((e) => e);
    await advancePastAllRetries();
    const err = await promise;

    expect(err).toBeInstanceOf(CFError);
    expect((err as InstanceType<typeof CFError>).status).toBe(429);
    expect(mock).toHaveBeenCalledTimes(5);
  });

  it("CFError message does not contain the CF API token (token is redacted)", async () => {
    const mock = makeCFFetchMock(Array.from({ length: 5 }, () => ({ type: "rate429" as const })));
    vi.stubGlobal("fetch", mock);

    const { cfFetch } = await import("../../infra/cloudflare/api.js");

    const promise = cfFetch("/test/redact").catch((e) => e);
    await advancePastAllRetries();
    const err = (await promise) as Error;

    // The API token must NOT appear in the error message.
    expect(err.message).not.toContain(FAKE_TOKEN);
  });

  it("does not retry on 4xx errors other than 429", async () => {
    const mock = makeCFFetchMock([{ type: "server5xx", status: 400 }]);
    vi.stubGlobal("fetch", mock);

    const { cfFetch, CFError } = await import("../../infra/cloudflare/api.js");

    const err = await cfFetch("/test/no-retry-400").catch((e) => e);
    expect(err).toBeInstanceOf(CFError);
    // Only one attempt — 400 is not retryable.
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx up to max attempts", async () => {
    const mock = makeCFFetchMock(
      Array.from({ length: 5 }, () => ({ type: "server5xx" as const })),
    );
    vi.stubGlobal("fetch", mock);

    const { cfFetch, CFError } = await import("../../infra/cloudflare/api.js");

    const promise = cfFetch("/test/5xx-exhaust").catch((e) => e);
    await advancePastAllRetries();
    const err = await promise;

    expect(err).toBeInstanceOf(CFError);
    expect(mock).toHaveBeenCalledTimes(5);
  });

  it("succeeds on first attempt when no rate limit (no CFError thrown)", async () => {
    const mock = makeCFFetchMock([{ type: "success", result: { tunnelId: "t-1" } }]);
    vi.stubGlobal("fetch", mock);

    const { cfFetch } = await import("../../infra/cloudflare/api.js");

    const result = await cfFetch("/test/instant-success");
    expect(result).toBeDefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
