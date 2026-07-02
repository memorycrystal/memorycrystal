/**
 * Chaos: Tier-2 Worker path — Mac off / cloudflared unreachable.
 *
 * Imports the Worker handler from `infra/cloudflare/worker/src/auth.ts` and
 * runs it in a Node runtime harness (Miniflare is not in the project; we
 * import the handler directly and mock the KV namespace + fetch).
 *
 * Scenarios:
 *   1. CF returns 1033 origin-unreachable (cf-error-code header) →
 *      Worker emits structured 503 with status="worker-tier2-mac-off" and
 *      a non-null last_seen_at from KV.
 *   2. CF returns 530 (legacy Worker error status) →
 *      same structured 503.
 *   3. Origin fetch throws (network-level failure, Mac truly off) →
 *      same structured 503.
 *   4. KV missing (tenant never came online) →
 *      structured 503 with last_seen_at=null (documented behavior).
 *   5. Well-shaped key on healthy origin → 200 pass-through.
 *   6. Malformed key → 401 with {error:"malformed_key"}.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertValid503Envelope, assertStatusIs } from "./__helpers__/mock503Envelope";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock KvNamespace. */
function makeKv(entry: { lastSeenAt?: number } | null): { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(entry),
  };
}

/** Valid-shape MCP API key. */
const VALID_KEY = "mck_v1_" + "a".repeat(64);
/** Malformed key (wrong prefix). */
const BAD_KEY = "bad_key_short";

type WorkerHandler = (request: Request, env: Record<string, unknown>, ctx: unknown) => Promise<Response>;

let workerHandler: WorkerHandler;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Dynamically import the Worker handler so each test gets a fresh module
  // evaluation (vi.resetModules() in afterEach ensures isolation).
  const mod = await import("../../infra/cloudflare/worker/src/auth.js");
  workerHandler = (mod.default as { fetch: WorkerHandler }).fetch;
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mac-off — Tier-2 Worker path", () => {
  it("emits structured 503 with last_seen_at from KV when cf-error-code=1033", async () => {
    const lastSeenAt = Date.now() - 120_000; // 2 min ago
    const kv = makeKv({ lastSeenAt });

    // Simulate CF returning a 530 with cf-error-code: 1033 header.
    const stubFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 530,
        headers: { "cf-error-code": "1033" },
      }),
    );
    vi.stubGlobal("fetch", stubFetch);

    const request = new Request("https://myslug.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: kv }, {});

    expect(response.status).toBe(503);
    const body = await response.json();
    assertValid503Envelope(body);
    assertStatusIs(body, "worker-tier2-mac-off");
    expect(body.last_seen_at).toBe(lastSeenAt);
    expect(body.tenant_slug).toBe("myslug");
  });

  it("emits structured 503 when CF returns 530 origin-unreachable status", async () => {
    const lastSeenAt = Date.now() - 60_000;
    const kv = makeKv({ lastSeenAt });

    const stubFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 530 }),
    );
    vi.stubGlobal("fetch", stubFetch);

    const request = new Request("https://alice.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: kv }, {});

    expect(response.status).toBe(503);
    const body = await response.json();
    assertValid503Envelope(body);
    assertStatusIs(body, "worker-tier2-mac-off");
    expect(body.last_seen_at).toBe(lastSeenAt);
  });

  it("emits structured 503 when origin fetch throws (network-level failure)", async () => {
    const lastSeenAt = Date.now() - 300_000;
    const kv = makeKv({ lastSeenAt });

    const stubFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", stubFetch);

    const request = new Request("https://bob.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: kv }, {});

    expect(response.status).toBe(503);
    const body = await response.json();
    assertValid503Envelope(body);
    assertStatusIs(body, "worker-tier2-mac-off");
    expect(body.last_seen_at).toBe(lastSeenAt);
  });

  it("returns null last_seen_at when KV has no entry (tenant never came online)", async () => {
    const kv = makeKv(null); // KV.get returns null

    const stubFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", stubFetch);

    const request = new Request("https://fresh.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: kv }, {});

    expect(response.status).toBe(503);
    const body = await response.json();
    assertValid503Envelope(body);
    assertStatusIs(body, "worker-tier2-mac-off");
    expect(body.last_seen_at).toBeNull();
  });

  it("returns null last_seen_at when MC_TUNNEL_STATUS KV binding is absent", async () => {
    const stubFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", stubFetch);

    const request = new Request("https://noenv.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    // env has no MC_TUNNEL_STATUS binding (mimics wrangler.toml without KV binding).
    const response = await workerHandler(request, {}, {});

    expect(response.status).toBe(503);
    const body = await response.json();
    assertValid503Envelope(body);
    expect(body.last_seen_at).toBeNull();
  });

  it("passes through healthy traffic (well-shaped key, origin returns 200)", async () => {
    const stubFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", stubFetch);

    const kv = makeKv({ lastSeenAt: Date.now() });

    const request = new Request("https://healthy.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });

    const response = await workerHandler(request, { MC_TUNNEL_STATUS: kv }, {});
    expect(response.status).toBe(200);
  });

  it("rejects malformed key with 401 before attempting origin", async () => {
    const stubFetch = vi.fn();
    vi.stubGlobal("fetch", stubFetch);

    const request = new Request("https://any.tunnels.memorycrystal.ai/api/mcp/recall", {
      headers: { Authorization: `Bearer ${BAD_KEY}` },
    });

    const response = await workerHandler(request, {}, {});

    expect(response.status).toBe(401);
    expect(stubFetch).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).toMatchObject({ error: "malformed_key" });
  });
});
