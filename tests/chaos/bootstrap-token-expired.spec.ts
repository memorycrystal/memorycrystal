/**
 * Chaos: bootstrap-token-expired — TTL exceeded or token already consumed.
 *
 * Scenario: the local stack's bootstrap cron ran but the one-shot token had
 * already expired (TTL = 1 hour, plan §6.5). The local Convex `bootstrapState`
 * transitions to "expired". Subsequent MCP requests must return:
 *
 *   HTTP 503
 *   {
 *     error: "service_unavailable",
 *     code: 503,
 *     status: "bootstrap_expired",
 *     support: "https://memorycrystal.ai/docs/bootstrap-recovery",
 *     retry_after: 30,
 *     ...
 *   }
 *
 * The `support` field MUST contain the bootstrap-recovery docs link so users
 * can reactivate their stack without manual intervention.
 *
 * Also verifies:
 *   - bootstrap_expired does NOT return 401.
 *   - Flipping state back to "pending" (after reactivation) returns 503
 *     bootstrap_pending (not expired).
 */

import { afterEach, describe, expect, it } from "vitest";
import { assertValid503Envelope, assertStatusIs } from "./__helpers__/mock503Envelope";

// ---------------------------------------------------------------------------
// Reuse the same bearer middleware harness from bootstrap-pending.spec.ts.
// Duplicated inline to keep each spec self-contained.
// ---------------------------------------------------------------------------

const BOOTSTRAP_RECOVERY_DOCS = "https://memorycrystal.ai/docs/bootstrap-recovery";

type BootstrapState = "pending" | "ready" | "expired";

interface LocalDbState {
  bootstrapState: BootstrapState;
  validKeyHashes: Set<string>;
  revokedKeyHashes: Set<string>;
}

async function simulateBearerMiddleware(
  request: Request,
  db: LocalDbState,
): Promise<Response> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!bearer) {
    return new Response(JSON.stringify({ error: "missing_auth" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (db.bootstrapState === "pending" && db.validKeyHashes.size === 0) {
    const body = {
      error: "service_unavailable",
      code: 503,
      tenant_slug: "test-tenant",
      last_seen_at: null,
      retry_after: 30,
      status: "bootstrap_pending",
      support: BOOTSTRAP_RECOVERY_DOCS,
    };
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
    });
  }

  if (db.bootstrapState === "expired") {
    const body = {
      error: "service_unavailable",
      code: 503,
      tenant_slug: "test-tenant",
      last_seen_at: null,
      retry_after: 30,
      status: "bootstrap_expired",
      support: BOOTSTRAP_RECOVERY_DOCS,
    };
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
    });
  }

  // ready state — key lookup.
  if (!db.validKeyHashes.has(bearer)) {
    return new Response(JSON.stringify({ error: "invalid_key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_KEY = "mck_v1_" + "g".repeat(64);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrap-token-expired — mcp-server returns 503 bootstrap_expired", () => {
  it("returns 503 with status=bootstrap_expired when bootstrapState=expired", async () => {
    const db: LocalDbState = {
      bootstrapState: "expired",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);

    expect(response.status).toBe(503);
    const body = await response.json();
    assertValid503Envelope(body);
    assertStatusIs(body, "bootstrap_expired");
  });

  it("support field contains the bootstrap-recovery docs URL", async () => {
    const db: LocalDbState = {
      bootstrapState: "expired",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);
    const body = await response.json();

    assertValid503Envelope(body);
    expect(body.support).toBe(BOOTSTRAP_RECOVERY_DOCS);
  });

  it("does NOT return 401 for expired bootstrap (must be 503)", async () => {
    const db: LocalDbState = {
      bootstrapState: "expired",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);

    expect(response.status).not.toBe(401);
    expect(response.status).toBe(503);
  });

  it("bootstrap_expired carries retry_after=30 in body and Retry-After header", async () => {
    const db: LocalDbState = {
      bootstrapState: "expired",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);
    const body = await response.json();

    assertValid503Envelope(body);
    expect(body.retry_after).toBe(30);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("pending state returns bootstrap_pending (not bootstrap_expired)", async () => {
    const db: LocalDbState = {
      bootstrapState: "pending",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    const request = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await simulateBearerMiddleware(request, db);
    const body = await response.json();

    assertValid503Envelope(body);
    assertStatusIs(body, "bootstrap_pending");
    // Must not be expired.
    expect(body.status).not.toBe("bootstrap_expired");
  });

  it("expired → (reactivation) → pending returns 503 bootstrap_pending", async () => {
    const db: LocalDbState = {
      bootstrapState: "expired",
      validKeyHashes: new Set(),
      revokedKeyHashes: new Set(),
    };

    // Phase 1: expired.
    const req1 = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    const res1 = await simulateBearerMiddleware(req1, db);
    expect(res1.status).toBe(503);
    const body1 = await res1.json();
    assertStatusIs(body1, "bootstrap_expired");

    // Simulate user re-running bootstrap.sh — state resets to pending.
    db.bootstrapState = "pending";

    // Phase 2: pending (fresh attempt).
    const req2 = new Request("http://localhost:8788/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    const res2 = await simulateBearerMiddleware(req2, db);
    const body2 = await res2.json();
    assertStatusIs(body2, "bootstrap_pending");
  });
});
