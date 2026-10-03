/**
 * Tests for the local first-boot consumer (convex/local/bootstrap.ts):
 * lenient contract parsing and status handling (ILL-323, audit A13), and the
 * total retry budget measured from the first attempt (ILL-327, audit A07).
 *
 * The cloud endpoint is replaced by a stubbed global fetch; the real
 * producer-to-consumer round trip lives in
 * convex/cloud/__tests__/bootstrapCrossBoundary.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { computeBackoffMs } from "../bootstrap";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "local/bootstrap": () => import("../bootstrap"),
  "local/apiKeys": () => import("../apiKeys"),
};

const RECOVERY_DOCS = "https://memorycrystal.ai/docs/bootstrap-recovery";
const T0 = 1_900_000_000_000;

function stubCloud(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("MC_BOOTSTRAP_TOKEN", "local-test-bootstrap-token");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("local fetchInitialState", () => {
  it("accepts the legacy base payload (slug, null label/mcVersion) and becomes ready", async () => {
    const t = convexTest(schema, modules);
    stubCloud(200, {
      tenantId: "tenant-1",
      slug: "acme",
      mcVersion: null,
      apiKeys: [{ keyHash: "hash-unlabelled", keyVersion: "v1", label: null, createdAt: 5 }],
      serverTime: T0,
    });
    const result = await t.action(internal.local.bootstrap.fetchInitialState, {});
    expect(result).toStrictEqual({ ok: true, tenantId: "tenant-1", tenantSlug: "acme" });
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("ready");
    expect(state.tenantSlug).toBe("acme");
    expect(state.mcVersion).toBeUndefined();
    const keys = await t.run((ctx) => ctx.db.query("localApiKeys").collect());
    expect(keys).toHaveLength(1);
    expect(keys[0].label).toBeUndefined();
  });

  it("treats a malformed payload as retryable and stays pending", async () => {
    const t = convexTest(schema, modules);
    stubCloud(200, { tenantId: "tenant-1", tenantSlug: "acme", version: 1 });
    const result = await t.action(internal.local.bootstrap.fetchInitialState, {});
    expect(result).toStrictEqual({ ok: false, error: "malformed_bootstrap_payload" });
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("pending");
  });

  it("409 is terminal: points to recovery and makes no further fetch on the next tick", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = stubCloud(409, { error: "Bootstrap token already consumed" });
    const result = await t.action(internal.local.bootstrap.fetchInitialState, {});
    expect(result).toStrictEqual({ ok: false, error: "bootstrap_token_consumed" });
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("expired");
    expect(state.errorMessage).toBe(`bootstrap_token_consumed; see ${RECOVERY_DOCS}`);

    // Next tick, well past any backoff window.
    vi.setSystemTime(T0 + 10 * 60 * 1000);
    const next = await t.action(internal.local.bootstrap.fetchInitialState, {});
    expect(next).toStrictEqual({ skipped: true, reason: "expired" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("410 keeps the expired behaviour", async () => {
    const t = convexTest(schema, modules);
    stubCloud(410, { error: "bootstrap_expired" });
    const result = await t.action(internal.local.bootstrap.fetchInitialState, {});
    expect(result).toStrictEqual({ ok: false, error: "bootstrap_token_expired" });
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("expired");
    expect(state.errorMessage).toBe(`bootstrap_token_expired; see ${RECOVERY_DOCS}`);
  });

  it("500 stays retryable", async () => {
    const t = convexTest(schema, modules);
    stubCloud(500, { error: "Invalid bootstrap payload" });
    const result = await t.action(internal.local.bootstrap.fetchInitialState, {});
    expect(result).toStrictEqual({ ok: false, error: "cloud_error_500" });
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("pending");
  });
});

// ILL-327 (audit A07): the 1-hour total budget is measured from the immutable
// first fetch attempt, not the last one.
describe("local fetchInitialState total budget", () => {
  const BUDGET_MS = 60 * 60 * 1000;
  const STEP_MS = 300_001; // Just past the 5-minute backoff cap.
  const BUDGET_ERROR = `bootstrap_budget_exceeded; see ${RECOVERY_DOCS}`;
  const readyPayload = {
    version: 1,
    tenantId: "tenant-1",
    tenantSlug: "acme",
    apiKeys: [{ keyHash: "hash-1", keyVersion: "v1", createdAt: 5 }],
    serverTime: T0,
  };

  it("(a) sustained failures expire at the deadline and fetch no more after it", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = stubCloud(503, {});
    const results = [];
    for (let n = 0; n <= 24; n++) {
      vi.setSystemTime(T0 + n * STEP_MS);
      results.push(await t.action(internal.local.bootstrap.fetchInitialState, {}));
    }
    expect(fetchMock).toHaveBeenCalledTimes(12);
    for (let n = 0; n < 12; n++) {
      expect(results[n]).toStrictEqual({ ok: false, error: "cloud_error_503" });
    }
    for (let n = 12; n <= 24; n++) {
      expect(results[n]).toStrictEqual({ skipped: true, reason: "expired" });
    }
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("expired");
    expect(state.errorMessage).toBe(BUDGET_ERROR);
    expect(state.firstFetchAttemptAt).toBe(T0);
    // 12 failed fetches plus the single expiring tick.
    expect(state.attemptCount).toBe(13);
  });

  it("(b) success before the deadline becomes ready", async () => {
    const t = convexTest(schema, modules);
    stubCloud(503, {});
    for (let n = 0; n < 11; n++) {
      vi.setSystemTime(T0 + n * STEP_MS);
      await t.action(internal.local.bootstrap.fetchInitialState, {});
    }
    vi.setSystemTime(T0 + BUDGET_MS);
    const fetchMock = stubCloud(200, readyPayload);
    const result = await t.action(internal.local.bootstrap.fetchInitialState, {});
    expect(result).toStrictEqual({ ok: true, tenantId: "tenant-1", tenantSlug: "acme" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("ready");
    expect(state.errorMessage).toBeUndefined();
  });

  it("(c) backoff delays are unchanged", async () => {
    expect([0, 1, 2, 3, 10, 11, 20].map(computeBackoffMs)).toStrictEqual([
      5_000, 7_500, 11_250, 16_875, 5_000 * 1.5 ** 10, 300_000, 300_000,
    ]);
    const t = convexTest(schema, modules);
    const fetchMock = stubCloud(503, {});
    let now = T0;
    await t.action(internal.local.bootstrap.fetchInitialState, {});
    for (let attempts = 1; attempts <= 3; attempts++) {
      const delay = computeBackoffMs(attempts);
      vi.setSystemTime(now + delay - 1);
      expect(await t.action(internal.local.bootstrap.fetchInitialState, {})).toStrictEqual({
        skipped: true,
        reason: "backoff",
        waitMs: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
      now += delay;
      vi.setSystemTime(now);
      expect(await t.action(internal.local.bootstrap.fetchInitialState, {})).toStrictEqual({
        ok: false,
        error: "cloud_error_503",
      });
      expect(fetchMock).toHaveBeenCalledTimes(attempts + 1);
    }
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.firstFetchAttemptAt).toBe(T0);
    expect(state.lastFetchAttemptAt).toBe(now);
  });

  it("(d) an upgraded pending row without the field starts its budget at its next attempt", async () => {
    const t = convexTest(schema, modules);
    // Written before firstFetchAttemptAt existed: last attempt 2h ago.
    await t.run((ctx) =>
      ctx.db.insert("bootstrapState", {
        marker: "singleton",
        state: "pending",
        attemptCount: 20,
        lastFetchAttemptAt: T0 - 2 * BUDGET_MS,
        errorMessage: "cloud_error_503",
      }),
    );
    const fetchMock = stubCloud(503, {});
    expect(await t.action(internal.local.bootstrap.fetchInitialState, {})).toStrictEqual({
      ok: false,
      error: "cloud_error_503",
    });
    let state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("pending");
    expect(state.firstFetchAttemptAt).toBe(T0);

    vi.setSystemTime(T0 + BUDGET_MS);
    await t.action(internal.local.bootstrap.fetchInitialState, {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + BUDGET_MS + 1);
    expect(await t.action(internal.local.bootstrap.fetchInitialState, {})).toStrictEqual({
      skipped: true,
      reason: "expired",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("expired");
    expect(state.firstFetchAttemptAt).toBe(T0);
  });

  it("(e) without MC_BOOTSTRAP_TOKEN the budget never starts", async () => {
    vi.stubEnv("MC_BOOTSTRAP_TOKEN", "");
    const t = convexTest(schema, modules);
    const fetchMock = stubCloud(503, {});
    // 30-second cron ticks for 90 minutes.
    for (let now = T0; now <= T0 + 90 * 60 * 1000; now += 30_000) {
      vi.setSystemTime(now);
      const result = await t.action(internal.local.bootstrap.fetchInitialState, {});
      expect(["no_token", "backoff"]).toContain((result as { reason?: string }).reason);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("pending");
    expect(state.firstFetchAttemptAt).toBeUndefined();
    expect(state.errorMessage).toBe("MC_BOOTSTRAP_TOKEN env var is unset");
  });

  it("(f) the budget boundary is strict and is checked before the backoff skip", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = stubCloud(503, {});
    await t.action(internal.local.bootstrap.fetchInitialState, {});
    // Exactly at the budget: still fetches.
    vi.setSystemTime(T0 + BUDGET_MS);
    expect(await t.action(internal.local.bootstrap.fetchInitialState, {})).toStrictEqual({
      ok: false,
      error: "cloud_error_503",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 1 ms later: inside the new backoff window, but past the deadline.
    vi.setSystemTime(T0 + BUDGET_MS + 1);
    expect(await t.action(internal.local.bootstrap.fetchInitialState, {})).toStrictEqual({
      skipped: true,
      reason: "expired",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("expired");
    expect(state.errorMessage).toBe(BUDGET_ERROR);
  });

  it("(g) a row reset for a re-issued token fetches again", async () => {
    const t = convexTest(schema, modules);
    stubCloud(503, {});
    for (let n = 0; n <= 12; n++) {
      vi.setSystemTime(T0 + n * STEP_MS);
      await t.action(internal.local.bootstrap.fetchInitialState, {});
    }
    expect((await t.query(api.local.bootstrap.getBootstrapState, {})).state).toBe("expired");

    vi.stubEnv("MC_BOOTSTRAP_TOKEN", "local-test-reissued-token");
    expect(await t.mutation(internal.local.bootstrap._resetForNewToken, {})).toStrictEqual({
      reset: true,
      state: "pending",
    });
    const reset = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(reset).toMatchObject({ state: "pending", attemptCount: 0 });
    expect(reset.firstFetchAttemptAt).toBeUndefined();
    expect(reset.lastFetchAttemptAt).toBeUndefined();
    expect(reset.errorMessage).toBeUndefined();

    const resetAt = T0 + 13 * STEP_MS;
    vi.setSystemTime(resetAt);
    const fetchMock = stubCloud(200, readyPayload);
    expect(await t.action(internal.local.bootstrap.fetchInitialState, {})).toStrictEqual({
      ok: true,
      tenantId: "tenant-1",
      tenantSlug: "acme",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const state = await t.query(api.local.bootstrap.getBootstrapState, {});
    expect(state.state).toBe("ready");
    expect(state.firstFetchAttemptAt).toBe(resetAt);

    // A ready row is left alone.
    expect(await t.mutation(internal.local.bootstrap._resetForNewToken, {})).toStrictEqual({
      reset: false,
      state: "ready",
    });
    expect((await t.query(api.local.bootstrap.getBootstrapState, {})).state).toBe("ready");
  });
});
