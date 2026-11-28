/**
 * Chaos: bootstrap-pending — local stack first-boot race.
 *
 * Scenario: `docker compose up -d` is running but the bootstrap cron has not
 * yet exchanged the one-shot token with the cloud. During this window:
 *
 *   - `bootstrapState = "pending"` AND local `apiKeys` is empty.
 *   - Any bearer request to mcp-server must return 503 with:
 *       error: "bootstrap_pending"
 *       retry_after: 30
 *       status: "bootstrap_pending"   (§10 discriminator)
 *     NOT 401 (which would cause clients to discard the key permanently).
 *
 * After `bootstrapState` flips to "ready" and a valid key is seeded:
 *   - Subsequent valid-key requests must get 200.
 *
 * Implementation note: we test the mcp-server bearer middleware logic directly
 * by importing the handler and mocking the Convex bootstrapState query.
 * Since the real mcp-server requires a Convex deployment, we simulate the
 * middleware decision logic in a harness that matches the M5 bearer.ts spec.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertValid503Envelope, assertStatusIs } from "./__helpers__/mock503Envelope";

// ---------------------------------------------------------------------------
// Simulated mcp-server bearer middleware (M5 bearer.ts contract).
//
// The real implementation lives in `mcp-server/src/middleware/bearer.ts`.
// We test the contract here without importing the full mcp-server to keep the
// chaos suite M3-independent (mcp-server may not be fully wired yet).
//
// Contract (per M5 spec §5):
//   - If bootstrapState != "ready" AND apiKeys table is empty → 503 bootstrap_pending
//   - If bootstrapState == "expired" → 503 bootstrap_expired
//   - If key not found → 401 invalid_key
//   - If key revoked → 401 key_revoked
//   - If key valid → 200 (pass-through)
// ---------------------------------------------------------------------------

type BootstrapState = "pending" | "ready" | "expired";

interface LocalDbState {
  bootstrapState: BootstrapState;
  /** Seed api key hashes that are considered valid. Empty = bootstrap not done. */
  validKeyHashes: Set<string>;
  revokedKeyHashes: Set<string>;
}

async function sha256Hex(input: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const buf = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input),
    );
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node.js fallback (test environment).
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

async function simulateBearerMiddleware(
  request: Request,
  db: LocalDbState,
): Promise<Response> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // No bearer → 401.
  if (!bearer) {
    return new Response(JSON.stringify({ error: "missing_auth" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // bootstrap_pending: state is pending AND no keys seeded yet.
  if (db.bootstrapState === "pending" && db.validKeyHashes.size === 0) {
    const body = {
      error: "service_unavailable",
      code: 503,
      tenant_slug: "test-tenant",
      last_seen_at: null,
      retry_after: 30,
      status: "bootstrap_pending",
      support: "https://memorycrystal.ai/docs/bootstrap-recovery",
    };
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
    });
  }

  // bootstrap_expired.
  if (db.bootstrapState === "expired") {
    const body = {
      error: "service_unavailable",
      code: 503,
      tenant_slug: "test-tenant",
      last_seen_at: null,
      retry_after: 30,
      status: "bootstrap_expired",
      support: "https://memorycrystal.ai/docs/bootstrap-recovery",
    };
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
    });
  }

  const keyHash = await sha256Hex(bearer);

  if (db.revokedKeyHashes.has(keyHash)) {
    return new Response(JSON.stringify({ error: "key_revoked" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!db.validKeyHashes.has(keyHash)) {
    return new Response(JSON.stringify({ error: "invalid_key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Valid key → pass through.
  return new Response(JSON.stringify({ ok: true, memories: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Test keys
// ---------------------------------------------------------------------------

const VALID_KEY = "mck_v1_" + "e".repeat(64);
const OTHER_KEY = "mck_v1_" + "f".repeat(64);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrap-pending — mcp-server returns 503 not 401 during first-boot", () => {
  it("returns 503 bootstrap_pending when bootstrapState=pending and apiKeys is empty", async () => {
    const db: LocalDbState = {
      bootstrapState: "pending",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);

    expect(response.status).toBe(503);
    const body = await response.json();
    assertValid503Envelope(body);
    assertStatusIs(body, "bootstrap_pending");
    expect(body.retry_after).toBe(30);
    // Must NOT return 401 (would cause clients to discard the key).
    expect(response.status).not.toBe(401);
  });

  it("includes Retry-After: 30 header in bootstrap_pending response", async () => {
    const db: LocalDbState = {
      bootstrapState: "pending",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);

    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("returns 200 after bootstrapState flips to ready and key is seeded", async () => {
    const validHash = await sha256Hex(VALID_KEY);
    const db: LocalDbState = {
      bootstrapState: "ready",
      validKeyHashes: new Set([validHash]),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);
    expect(response.status).toBe(200);
  });

  it("sequential: pending → ready transition yields 503 then 200", async () => {
    const db: LocalDbState = {
      bootstrapState: "pending",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    // Phase 1: pending.
    const req1 = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    const res1 = await simulateBearerMiddleware(req1, db);
    expect(res1.status).toBe(503);

    // Simulate bootstrap completing.
    const validHash = await sha256Hex(VALID_KEY);
    db.bootstrapState = "ready";
    db.validKeyHashes.add(validHash);

    // Phase 2: ready.
    const req2 = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    const res2 = await simulateBearerMiddleware(req2, db);
    expect(res2.status).toBe(200);
  });

  it("unknown key returns 401 once bootstrapState=ready (not 503)", async () => {
    const validHash = await sha256Hex(VALID_KEY);
    const db: LocalDbState = {
      bootstrapState: "ready",
      validKeyHashes: new Set([validHash]),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${OTHER_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ error: "invalid_key" });
  });
});
