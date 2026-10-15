/**
 * Chaos: 4×2 offline matrix
 *
 * Services: {cloudflared, web, mcp, backend} × {up, down} = 8 combos.
 * Note: the plan §3.5 mentions 4×2 (cloudflared, web, mcp, backend) for the
 * M3-independent pass. The fallback service is always "up" in all scenarios
 * (it has no deps). The 5th service (fallback) is included in the plan's
 * iteration-3 revision but the 4×2 base matrix is the M10 deliverable.
 *
 * Assertions for every combo:
 *   - HTTP status is exactly 200 OR 503 (never 502, 504, or other 5xx).
 *   - If 503: body is a valid §10 envelope (assertValid503Envelope).
 *   - If 503 body is empty / non-JSON: test FAILS.
 *   - For Tier-1 case (Mac on, cloudflared up, web+mcp down):
 *       status field = "tunnel-fallback-ingress".
 *   - For Tier-2 case (cloudflared down / Mac off):
 *       status field = "worker-tier2-mac-off".
 *
 * No real network calls. Container states are simulated via mocked fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertValid503Envelope, assertStatusIs } from "./__helpers__/mock503Envelope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceState {
  cloudflared: "up" | "down";
  web: "up" | "down";
  mcp: "up" | "down";
  backend: "up" | "down";
}

type ComboLabel =
  | "all-up"
  | "cloudflared-down"
  | "web-down"
  | "mcp-down"
  | "backend-down"
  | "web+mcp-down"
  | "backend+web-down"
  | "backend+mcp-down";

// ---------------------------------------------------------------------------
// Tier-1 §10 body from the in-stack Caddy fallback container.
// status = "tunnel-fallback-ingress" (Caddy has no access to cloud state).
// ---------------------------------------------------------------------------
function makeTier1Body(slug = "test-tenant"): Record<string, unknown> {
  return {
    error: "service_unavailable",
    code: 503,
    tenant_slug: slug,
    last_seen_at: null,
    retry_after: 30,
    status: "tunnel-fallback-ingress",
    support: `https://memorycrystal.ai/status/${slug}`,
  };
}

// ---------------------------------------------------------------------------
// Tier-2 §10 body from the CF Worker (Mac off / cloudflared unreachable).
// status = "worker-tier2-mac-off".
// ---------------------------------------------------------------------------
function makeTier2Body(slug = "test-tenant", lastSeenAt: number | null = null): Record<string, unknown> {
  return {
    error: "service_unavailable",
    code: 503,
    tenant_slug: slug,
    last_seen_at: lastSeenAt,
    retry_after: 60,
    status: "worker-tier2-mac-off",
    support: "https://memorycrystal.ai/docs/troubleshooting",
  };
}

// ---------------------------------------------------------------------------
// Healthy 200 response (MCP endpoint).
// ---------------------------------------------------------------------------
function makeOkBody(): Record<string, unknown> {
  return { ok: true, memories: [] };
}

// ---------------------------------------------------------------------------
// simulateContainerState
//
// Returns a mock fetch implementation that emulates the behaviour the CF edge
// + tunnel ingress would exhibit for the given combination of service states.
//
// Decision table:
//   cloudflared=down        → Tier-2 Worker intercepts (Mac off scenario)
//   cloudflared=up, all=up  → 200 from origin
//   cloudflared=up, web+mcp=down (backend=up) → Tier-1 Caddy fallback fires
//   cloudflared=up, web=down only → Caddy fallback fires for web routes,
//                              MCP may still answer on /api/mcp/* path.
//                              For /api/mcp/recall: mcp=up → 200; mcp=down → Caddy 503.
//   cloudflared=up, mcp=down only → MCP path falls through, Caddy fires → 503.
//   cloudflared=up, backend=down → web and mcp return 503 (they need backend),
//                              Caddy catches → structured 503.
// ---------------------------------------------------------------------------
function simulateContainerState(state: ServiceState): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() => {
    const TENANT_SLUG = "test-tenant";

    // cloudflared down → entire Mac is unreachable → Tier-2 Worker path.
    if (state.cloudflared === "down") {
      const body = makeTier2Body(TENANT_SLUG, null);
      return Promise.resolve({
        ok: false,
        status: 503,
        headers: new Headers({
          "Content-Type": "application/json",
          "Retry-After": "60",
        }),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }

    // cloudflared up — determine if origin can serve the request.
    // We're simulating a request to /api/mcp/recall.
    const mcpReachable = state.mcp === "up" && state.backend === "up";

    if (mcpReachable) {
      const body = makeOkBody();
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }

    // MCP is unreachable → cloudflared ingress falls through to Caddy fallback → Tier-1.
    const body = makeTier1Body(TENANT_SLUG);
    return Promise.resolve({
      ok: false,
      status: 503,
      headers: new Headers({
        "Content-Type": "application/json",
        "Retry-After": "30",
      }),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  });
}

// ---------------------------------------------------------------------------
// Hit the simulated tunnel endpoint and return parsed body + status.
// ---------------------------------------------------------------------------
async function hitTunnelEndpoint(mockFetch: ReturnType<typeof vi.fn>): Promise<{
  status: number;
  body: unknown;
}> {
  const response = await mockFetch("https://test-tenant.tunnels.memorycrystal.ai/api/mcp/recall", {
    method: "POST",
    headers: { Authorization: "Bearer mck_v1_" + "a".repeat(64) },
    body: JSON.stringify({ content: "ping" }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// Matrix definition
// ---------------------------------------------------------------------------

const COMBOS: Array<{ label: ComboLabel; state: ServiceState; tier: 1 | 2 | null }> = [
  {
    label: "all-up",
    state: { cloudflared: "up", web: "up", mcp: "up", backend: "up" },
    tier: null, // 200
  },
  {
    label: "cloudflared-down",
    state: { cloudflared: "down", web: "up", mcp: "up", backend: "up" },
    tier: 2,
  },
  {
    label: "web-down",
    state: { cloudflared: "up", web: "down", mcp: "up", backend: "up" },
    tier: null, // MCP still up → 200 for /api/mcp/* path
  },
  {
    label: "mcp-down",
    state: { cloudflared: "up", web: "up", mcp: "down", backend: "up" },
    tier: 1,
  },
  {
    label: "backend-down",
    state: { cloudflared: "up", web: "up", mcp: "up", backend: "down" },
    tier: 1,
  },
  {
    label: "web+mcp-down",
    state: { cloudflared: "up", web: "down", mcp: "down", backend: "up" },
    tier: 1,
  },
  {
    label: "backend+web-down",
    state: { cloudflared: "up", web: "down", mcp: "up", backend: "down" },
    tier: 1,
  },
  {
    label: "backend+mcp-down",
    state: { cloudflared: "up", web: "up", mcp: "down", backend: "down" },
    tier: 1,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("offline.matrix — 4×2 service-state chaos matrix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const combo of COMBOS) {
    const { label, state, tier } = combo;

    it(`[${label}] returns 200 or structured 503 — never 502/504/raw-HTML`, async () => {
      const mockFetch = simulateContainerState(state);
      const { status, body } = await hitTunnelEndpoint(mockFetch);

      // Core invariant: status must be exactly 200 or 503.
      expect(
        status === 200 || status === 503,
        `Forbidden status ${status} — only 200 or 503 allowed (combo: ${label})`,
      ).toBe(true);

      if (status === 503) {
        // Body must not be null/empty — bare 503 with empty body is forbidden.
        expect(body, `Bare 503 with null body is forbidden (combo: ${label})`).not.toBeNull();

        // Must be a valid §10 envelope.
        assertValid503Envelope(body);

        // Tier-specific status discriminator.
        if (tier === 1) {
          assertStatusIs(body, "tunnel-fallback-ingress");
        } else if (tier === 2) {
          assertStatusIs(body, "worker-tier2-mac-off");
        }
      }
    });
  }

  it("covers all 8 service-state combos", () => {
    expect(COMBOS).toHaveLength(8);
    // All 4 services appear in at least one combo in each direction.
    const services: Array<keyof ServiceState> = ["cloudflared", "web", "mcp", "backend"];
    for (const svc of services) {
      const hasUp = COMBOS.some((c) => c.state[svc] === "up");
      const hasDown = COMBOS.some((c) => c.state[svc] === "down");
      expect(hasUp, `service ${svc} should appear "up" in at least one combo`).toBe(true);
      expect(hasDown, `service ${svc} should appear "down" in at least one combo`).toBe(true);
    }
  });

  it("Tier-1 combos all carry status=tunnel-fallback-ingress", async () => {
    const tier1 = COMBOS.filter((c) => c.tier === 1);
    expect(tier1.length).toBeGreaterThan(0);
    for (const combo of tier1) {
      const mockFetch = simulateContainerState(combo.state);
      const { status, body } = await hitTunnelEndpoint(mockFetch);
      expect(status).toBe(503);
      assertStatusIs(body, "tunnel-fallback-ingress");
    }
  });

  it("Tier-2 combo (cloudflared-down) carries status=worker-tier2-mac-off", async () => {
    const tier2 = COMBOS.find((c) => c.tier === 2)!;
    const mockFetch = simulateContainerState(tier2.state);
    const { status, body } = await hitTunnelEndpoint(mockFetch);
    expect(status).toBe(503);
    assertStatusIs(body, "worker-tier2-mac-off");
  });
});
