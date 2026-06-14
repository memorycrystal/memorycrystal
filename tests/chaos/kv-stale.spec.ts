/**
 * Chaos: Stale KV data.
 *
 * KV (`MC_TUNNEL_STATUS`) is cosmetic for healthy traffic — it is only read
 * by the Tier-2 Worker on the Mac-off path. This test file proves:
 *
 *   (a) Stale KV does NOT affect valid-key auth on the local origin (the
 *       local origin never reads KV; it reads its own apiKeys table).
 *
 *   (b) When the Mac IS off and the Worker reads stale KV, it still emits a
 *       structured §10 503 with `last_seen_at` from KV (may be stale —
 *       documented behavior; surfaced via `support` link to live status page).
 *
 *   (c) The `support` field in the stale Tier-2 503 points to the live status
 *       page so users can discover the real last-seen timestamp from cloud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertValid503Envelope, assertStatusIs } from "./__helpers__/mock503Envelope";

const VALID_KEY = "mck_v1_" + "d".repeat(64);

type WorkerHandler = (request: Request, env: Record<string, unknown>, ctx: unknown) => Promise<Response>;
let workerHandler: WorkerHandler;

beforeEach(async () => {
  const mod = await import("../../infra/cloudflare/worker/src/auth.js");
  workerHandler = (mod.default as { fetch: WorkerHandler }).fetch;
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: build a mock KV namespace with a given lastSeenAt timestamp.
// ---------------------------------------------------------------------------
function makeStaleKv(lastSeenAt: number) {
  return {
    get: vi.fn().mockResolvedValue({ lastSeenAt }),
  };
}

// ---------------------------------------------------------------------------
// (a) Stale KV does not affect local origin auth
// ---------------------------------------------------------------------------

describe("kv-stale — (a) valid-key auth unaffected by stale KV", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("valid key gets 200 from origin regardless of stale KV", async () => {
    // Simulate the CF edge + local origin (no Worker involvement on healthy path).
    // The local origin authenticates via its apiKeys table, not KV.
    const mockOriginFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, memories: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockOriginFetch);

    // The stale KV — on the healthy path the Worker does NOT read this.
    const staleKv = makeStaleKv(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    const request = new Request("https://myslug.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    // Pass stale KV to Worker — on healthy traffic it is never consulted.
    const response = await workerHandler(request, { MC_TUNNEL_STATUS: staleKv }, {});

    expect(response.status).toBe(200);
    // Verify KV.get was NOT called on the healthy path.
    expect(staleKv.get).not.toHaveBeenCalled();
  });

  it("stale KV with a valid key never triggers a 503", async () => {
    const mockOriginFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockOriginFetch);

    const staleKv = makeStaleKv(Date.now() - 48 * 60 * 60 * 1000); // 48h ago

    const request = new Request("https://tenant2.tunnels.memorycrystal.ai/api/mcp/capture", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "test" }),
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: staleKv }, {});

    expect(response.status).not.toBe(503);
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (b) Stale KV is surfaced in Tier-2 503 (Mac off scenario)
// ---------------------------------------------------------------------------

describe("kv-stale — (b) Tier-2 503 with stale last_seen_at from KV", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits structured 503 with the stale last_seen_at value from KV", async () => {
    const staleTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago
    const staleKv = makeStaleKv(staleTimestamp);

    // Mac is off → fetch throws.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const request = new Request("https://offlineslug.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: staleKv }, {});

    expect(response.status).toBe(503);
    const body = await response.json();

    assertValid503Envelope(body);
    assertStatusIs(body, "worker-tier2-mac-off");
    // The stale KV value is surfaced — documented behavior.
    expect(body.last_seen_at).toBe(staleTimestamp);
    expect(body.tenant_slug).toBe("offlineslug");
  });

  it("stale last_seen_at in Tier-2 503 is a number, not null", async () => {
    const staleTimestamp = Date.now() - 10_000; // 10 seconds ago — still "stale" if KV wasn't updated
    const staleKv = makeStaleKv(staleTimestamp);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const request = new Request("https://recent.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: staleKv }, {});
    const body = await response.json();

    assertValid503Envelope(body);
    expect(typeof body.last_seen_at).toBe("number");
    expect(body.last_seen_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) Support link in stale Tier-2 503
// ---------------------------------------------------------------------------

describe("kv-stale — (c) support link in Tier-2 503", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("503 body includes a non-empty support URL for stale KV scenario", async () => {
    const staleKv = makeStaleKv(Date.now() - 24 * 60 * 60 * 1000);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const request = new Request("https://staleslug.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: staleKv }, {});
    const body = await response.json() as Record<string, unknown>;

    assertValid503Envelope(body);
    // Worker uses support_link (Shape B). At least one of support/support_link must be a URL.
    const supportUrl = (body.support_link ?? body.support) as string;
    expect(typeof supportUrl).toBe("string");
    expect(supportUrl.length).toBeGreaterThan(0);
    expect(supportUrl).toMatch(/^https?:\/\//);
  });
});
