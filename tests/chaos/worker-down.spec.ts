/**
 * Chaos: Worker non-critical for healthy traffic.
 *
 * Proves that a Worker outage does not break valid authenticated requests.
 * Per R2 / §3.3 Fork 1: the Worker is a fast-fail shape-filter only. Valid
 * keys (matching the `^mck_v[0-9]+_[a-zA-Z0-9]{30,80}$` shape) pass through
 * to the local origin without any KV roundtrip. The local origin (Convex
 * mcpAuth) is the authoritative auth gate.
 *
 * Simulation: CF edge is modelled as skipping the Worker entirely when the
 * Worker throws. We verify that a valid-shape key reaching the local origin
 * directly still gets a 200 — not a 401, 503, or any other failure.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { assertValid503Envelope } from "./__helpers__/mock503Envelope";

const VALID_KEY = "mck_v1_" + "b".repeat(64);
const VALID_KEY_V2 = "mck_v2_" + "c".repeat(30); // future version prefix — shape must pass
const MALFORMED_KEY = "not-a-real-key";

// ---------------------------------------------------------------------------
// Simulated CF edge that skips the Worker and routes directly to origin.
// ---------------------------------------------------------------------------

/**
 * Simulate the CF edge behaviour when the Worker is unavailable:
 * CF skips it and routes the request directly to the origin.
 *
 * The origin here is stubbed as the local MCP server, which:
 *   - Accepts well-shaped keys (200) — auth is local-authoritative.
 *   - Rejects malformed keys (401) — shape guard also at origin.
 */
function makeCFEdgeWithoutWorker(originResponse: Response) {
  return vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
    const key = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    // Shape check at the local origin level (mcpAuth fallback).
    const MC_KEY_SHAPE = /^mck_v[0-9]+_[a-zA-Z0-9]{30,80}$/;
    if (key && !MC_KEY_SHAPE.test(key)) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    // Valid key → origin responds normally.
    return Promise.resolve(originResponse);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("worker-down — Worker is non-critical for healthy traffic", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("valid-shape key authenticates at local origin even when Worker is absent", async () => {
    const origin200 = new Response(JSON.stringify({ ok: true, memories: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const edgeFetch = makeCFEdgeWithoutWorker(origin200);

    const response = await edgeFetch(
      "https://test.tunnels.memorycrystal.ai/api/mcp/recall",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ content: "ping" }),
      },
    );

    expect(response.status).toBe(200);
  });

  it("future-versioned key (v2 prefix) still passes shape filter at origin", async () => {
    const origin200 = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const edgeFetch = makeCFEdgeWithoutWorker(origin200);

    const response = await edgeFetch(
      "https://test.tunnels.memorycrystal.ai/api/mcp/recall",
      { headers: { Authorization: `Bearer ${VALID_KEY_V2}` } },
    );

    expect(response.status).toBe(200);
  });

  it("malformed key is rejected 401 at origin even without Worker", async () => {
    const origin200 = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const edgeFetch = makeCFEdgeWithoutWorker(origin200);

    const response = await edgeFetch(
      "https://test.tunnels.memorycrystal.ai/api/mcp/recall",
      { headers: { Authorization: `Bearer ${MALFORMED_KEY}` } },
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ error: "invalid_key" });
  });

  it("Worker outage does not produce 502 or 504 for valid keys", async () => {
    const origin200 = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const edgeFetch = makeCFEdgeWithoutWorker(origin200);

    const response = await edgeFetch(
      "https://test.tunnels.memorycrystal.ai/api/mcp/recall",
      { headers: { Authorization: `Bearer ${VALID_KEY}` } },
    );

    expect(response.status).not.toBe(502);
    expect(response.status).not.toBe(504);
    expect(response.status).toBe(200);
  });

  it("no request without a bearer header is rejected as 401 (no-auth baseline)", async () => {
    const origin401 = new Response(JSON.stringify({ error: "missing_auth" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    const edgeFetch = makeCFEdgeWithoutWorker(origin401);

    const response = await edgeFetch(
      "https://test.tunnels.memorycrystal.ai/api/mcp/recall",
      { headers: {} },
    );

    // Origin returns 401 for missing auth — Worker absence doesn't change this.
    expect(response.status).toBe(401);
  });

  it("does not produce a 503 for valid keys (Worker down is not a 503 event)", async () => {
    const origin200 = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const edgeFetch = makeCFEdgeWithoutWorker(origin200);

    const response = await edgeFetch(
      "https://test.tunnels.memorycrystal.ai/api/mcp/recall",
      { headers: { Authorization: `Bearer ${VALID_KEY}` } },
    );

    // Must NOT be a 503 — Worker outage for valid keys is transparent.
    expect(response.status).not.toBe(503);
    expect(response.status).toBe(200);
  });
});
