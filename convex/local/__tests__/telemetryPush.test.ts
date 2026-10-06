/**
 * Tests for local telemetry push — M6 (T4).
 *
 * Test cases (per spec §3.5 / task T4):
 *   1. compileStatsPayload returns a v1-conformant payload.
 *   2. flushTelemetry retries on 429 with exponential backoff.
 *   3. Local applies revoked_keys from cloud response (calls applyCloudRevocations).
 *   4. Idempotency: same payloadId not enqueued twice.
 *
 * Network calls are fully mocked with vi.fn() — no real HTTP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

// Explicit module map — must include all modules exercised by the action under test.
const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "local/telemetryPush": () => import("../telemetryPush"),
  "local/apiKeys": () => import("../apiKeys"),
};

// Cast to any once — _generated/api.d.ts is stale until `npx convex dev` re-runs.
const iInternal = internal as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildQueueRow(overrides: {
  payloadId?: string;
  payload?: Record<string, unknown>;
  status?: "pending" | "sent" | "failed";
  attemptedCount?: number;
  nextAttemptAt?: number;
  createdAt?: number;
} = {}) {
  const now = Date.now();
  const payloadId = overrides.payloadId ?? crypto.randomUUID();
  return {
    payloadId,
    payload: overrides.payload ?? buildMinimalPayload(payloadId),
    status: overrides.status ?? "pending",
    attemptedCount: overrides.attemptedCount ?? 0,
    nextAttemptAt: overrides.nextAttemptAt ?? now - 1, // due now
    createdAt: overrides.createdAt ?? now,
  };
}

function buildMinimalPayload(payloadId: string = crypto.randomUUID()) {
  return {
    payloadVersion: "v1",
    payloadId,
    tenant_id: "tenant-local-test-id",
    tenantId: "tenant-local-test-id",
    mc_version: "1.0.0",
    last_activity_at: Date.now() - 10_000,
    memory_count: 10,
    archived_count: 2,
    captures_24h: 3,
    storage_bytes: 4096,
    embedder: "none",
    errors_24h: 0,
    online_since: Date.now() - 60_000,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("telemetryPush — local stack", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.MC_CLOUD_TELEMETRY_URL = "https://cloud.memorycrystal.ai";
    process.env.MC_TUNNEL_TELEMETRY_TOKEN = "test-telemetry-token";
    process.env.MC_TENANT_ID = "tenant-local-test-id";
    process.env.MC_VERSION = "1.0.0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MC_CLOUD_TELEMETRY_URL;
    delete process.env.MC_TUNNEL_TELEMETRY_TOKEN;
    delete process.env.MC_TENANT_ID;
    delete process.env.MC_VERSION;
  });

  // ── Test 1: compileStatsPayload returns a v1-conformant payload ───────────
  it("compileStatsPayload returns a v1-conformant payload with all required fields", async () => {
    const t = convexTest(schema, modules);

    // Do not seed crystalMemories — the schema requires `embedding` and other
    // required fields that are not relevant to this test. We just verify that
    // compileStatsPayload works correctly with zero memories (counts = 0 is valid).
    const payload = await t.query(iInternal.local.telemetryPush.compileStatsPayload, {});

    // All required fields from v1.schema.json
    expect(payload.payloadVersion).toBe("v1");
    expect(typeof payload.payloadId).toBe("string");
    expect(payload.payloadId.length).toBeGreaterThan(0);
    expect(typeof payload.tenant_id).toBe("string");
    expect(payload.tenant_id).toBe(payload.tenantId);
    expect(typeof payload.mc_version).toBe("string");
    expect(payload.mc_version.length).toBeGreaterThan(0);
    expect(typeof payload.last_activity_at).toBe("number");
    expect(payload.last_activity_at).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(payload.memory_count)).toBe(true);
    expect(payload.memory_count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(payload.archived_count)).toBe(true);
    expect(payload.archived_count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(payload.captures_24h)).toBe(true);
    expect(payload.captures_24h).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(payload.storage_bytes)).toBe(true);
    expect(payload.storage_bytes).toBeGreaterThanOrEqual(0);
    expect(["gemini", "openai", "none"]).toContain(payload.embedder);
    expect(Number.isInteger(payload.errors_24h)).toBe(true);
    expect(payload.errors_24h).toBeGreaterThanOrEqual(0);
    expect(typeof payload.online_since).toBe("number");
    expect(payload.online_since).toBeGreaterThanOrEqual(0);

    // No forbidden extra keys (additionalProperties: false)
    const ALLOWED_KEYS = new Set([
      "payloadVersion", "payloadId", "tenant_id", "tenantId",
      "mc_version", "last_activity_at", "memory_count", "archived_count",
      "captures_24h", "storage_bytes", "embedder", "errors_24h", "online_since",
    ]);
    for (const key of Object.keys(payload)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  });

  // ── Test 2: flushTelemetry retries on 429 with exponential backoff ────────
  it("flushTelemetry bumps nextAttemptAt exponentially on 429", async () => {
    const t = convexTest(schema, modules);

    const payloadId = crypto.randomUUID();
    const rowId = await t.run(async (ctx) => {
      return String(
        await (ctx.db as any).insert("localTelemetryQueue", buildQueueRow({ payloadId, attemptedCount: 0 })),
      );
    });

    // Mock fetch to return 429
    fetchMock.mockResolvedValueOnce({
      status: 429,
      ok: false,
      json: () => Promise.resolve({ error: "rate_limited" }),
    });

    await t.action(iInternal.local.telemetryPush.flushTelemetry, {});

    // After 429: status stays pending, attemptedCount=1, nextAttemptAt bumped
    const row = await t.run(async (ctx) => (ctx.db as any).get(rowId));
    expect(row?.status).toBe("pending");
    expect(row?.attemptedCount).toBe(1);
    // delay = 60000 * 2^0 = 60000ms → nextAttemptAt ≈ now + 60s
    expect(row?.nextAttemptAt).toBeGreaterThan(Date.now() + 55_000);
  });

  // ── Test 2b: 5xx also triggers exponential backoff with doubling ──────────
  it("flushTelemetry doubles the retry delay on each 5xx (exponential)", async () => {
    const t = convexTest(schema, modules);

    // attemptedCount=2 → delay = min(60000 * 2^2, 3600000) = 240_000ms
    const payloadId = crypto.randomUUID();
    const rowId = await t.run(async (ctx) => {
      return String(
        await (ctx.db as any).insert("localTelemetryQueue", buildQueueRow({ payloadId, attemptedCount: 2 })),
      );
    });

    fetchMock.mockResolvedValueOnce({
      status: 503,
      ok: false,
      json: () => Promise.resolve({ error: "service_unavailable" }),
    });

    await t.action(iInternal.local.telemetryPush.flushTelemetry, {});

    const row = await t.run(async (ctx) => (ctx.db as any).get(rowId));
    expect(row?.status).toBe("pending");
    expect(row?.attemptedCount).toBe(3);
    // delay = 60000 * 2^2 = 240000ms
    expect(row?.nextAttemptAt).toBeGreaterThan(Date.now() + 200_000);
  });

  // ── Test 3: local applies revoked_keys from cloud response ────────────────
  it("flushTelemetry triggers applyCloudRevocations for revoked_keys in response", async () => {
    const t = convexTest(schema, modules);

    const payloadId = crypto.randomUUID();
    await t.run(async (ctx) => {
      await (ctx.db as any).insert("localTelemetryQueue", buildQueueRow({ payloadId }));
    });

    const revokedHash = "revoked_hash_xyz_abc";

    // Seed a localApiKey that should be revoked
    await t.run(async (ctx) => {
      await (ctx.db as any).insert("localApiKeys", {
        keyHash: revokedHash,
        keyVersion: "v1",
        createdAt: Date.now() - 3_600_000,
      });
    });

    // Cloud returns success with a revoked key hash
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          accepted: true,
          server_time: Date.now(),
          revoked_keys: [revokedHash],
        }),
    });

    await t.action(iInternal.local.telemetryPush.flushTelemetry, {});

    // The localApiKey should now have cloudRevokedAt set
    const key = await t.run(async (ctx) => {
      return (ctx.db as any)
        .query("localApiKeys")
        .withIndex("by_keyHash", (q: any) => q.eq("keyHash", revokedHash))
        .unique();
    });
    expect(key?.cloudRevokedAt).toBeDefined();
    expect(typeof key?.cloudRevokedAt).toBe("number");
  });

  // ── Test 4: idempotency — same payloadId not enqueued twice ───────────────
  it("enqueueTelemetry is idempotent: same payloadId not inserted twice", async () => {
    const t = convexTest(schema, modules);

    const payloadId = crypto.randomUUID();
    const payload = buildMinimalPayload(payloadId);

    // Enqueue first time
    await t.mutation(iInternal.local.telemetryPush.enqueueTelemetry, { payload });

    // Enqueue second time — should be a safe no-op
    await t.mutation(iInternal.local.telemetryPush.enqueueTelemetry, { payload });

    // Only one row should exist
    const rows = await t.run(async (ctx) => {
      return (ctx.db as any)
        .query("localTelemetryQueue")
        .withIndex("by_payloadId", (q: any) => q.eq("payloadId", payloadId))
        .collect();
    });

    expect(rows).toHaveLength(1);
  });

  // ── Test 4b: 4xx (non-429) permanently fails the row ─────────────────────
  it("flushTelemetry marks row failed on 400", async () => {
    const t = convexTest(schema, modules);

    const payloadId = crypto.randomUUID();
    const rowId = await t.run(async (ctx) => {
      return String(
        await (ctx.db as any).insert("localTelemetryQueue", buildQueueRow({ payloadId })),
      );
    });

    fetchMock.mockResolvedValueOnce({
      status: 400,
      ok: false,
      json: () => Promise.resolve({ error: "invalid_payload" }),
    });

    await t.action(iInternal.local.telemetryPush.flushTelemetry, {});

    const row = await t.run(async (ctx) => (ctx.db as any).get(rowId));
    expect(row?.status).toBe("failed");
    // No backoff applied for permanent 4xx failures
    expect(row?.attemptedCount).toBe(0);
  });

  // ── Test 5: no-op when env vars not configured ───────────────────────────
  it("flushTelemetry is a no-op when MC_CLOUD_TELEMETRY_URL is missing", async () => {
    delete process.env.MC_CLOUD_TELEMETRY_URL;

    const t = convexTest(schema, modules);
    await t.action(iInternal.local.telemetryPush.flushTelemetry, {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Test 6: tickTelemetry skips enqueue when tenantId not set ───────────
  it("tickTelemetry does not enqueue when MC_TENANT_ID is missing", async () => {
    delete process.env.MC_TENANT_ID;

    const t = convexTest(schema, modules);
    await t.action(iInternal.local.telemetryPush.tickTelemetry, {});

    const rows = await t.run(async (ctx) => {
      return (ctx.db as any).query("localTelemetryQueue").collect();
    });
    expect(rows).toHaveLength(0);
  });
});
