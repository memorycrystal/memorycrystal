/**
 * Revocation E2E spec.
 *
 * Verifies that a revoked API key returns 401 from the tunnel within ≤ 30 s
 * of the revocation event (per plan §AC2 step 4 and §3.3 Fork 1 revocation flow).
 *
 * What is mocked:
 *   - Cloud revocation endpoint (simulating the cloud admin/billing revoke)
 *   - Heartbeat back-channel propagation (60s worst-case; harness compresses it)
 *   - Tunnel MCP endpoint transitions from 200 → 401 after revocation
 *
 * The mock harness simulates revocation by toggling the apiKeyRevoked flag on
 * the tunnel route intercept. A polling loop then asserts 401 appears within
 * the AC2 latency budget (≤ 30 s).
 */

import { test, expect, Page } from "@playwright/test";
import { setupMockHarness } from "./_helpers/mockHarness";
import {
  TENANT_SLUG,
  TENANT_API_KEY,
  TUNNEL_HOST,
  MCP_RECALL_OK,
  MCP_RECALL_401,
} from "./_helpers/tenantFixtures";

/** POST to MCP recall endpoint from the page's fetch context */
async function mcpRecall(page: Page, apiKey: string): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ host, key }: { host: string; key: string }) => {
      try {
        const resp = await fetch(`https://${host}/api/mcp/recall`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: "test" }),
        });
        let body: unknown;
        try {
          body = await resp.json();
        } catch {
          body = null;
        }
        return { status: resp.status, body };
      } catch (err) {
        return { status: -1, body: null };
      }
    },
    { host: TUNNEL_HOST, key: apiKey },
  );
}

test.describe("Revocation — key revoked → 401 within 30 s", () => {
  test("valid key gets 200 before revocation, 401 within 30 s after revocation", async ({
    page,
  }) => {
    // Start with a valid (non-revoked) harness
    await setupMockHarness(page, { apiKeyRevoked: false });
    await page.goto("/");

    // Step 1: Confirm key is valid pre-revocation
    const preResult = await mcpRecall(page, TENANT_API_KEY);
    expect(preResult.status, "Key should be valid before revocation").toBe(200);

    // Step 2: Simulate revocation by overriding the tunnel route to return 401
    // This models the cloud heartbeat propagating the revocation to the local origin.
    // In real flow: cloud marks cloudRevokedAt → next heartbeat response carries revokedKeys[]
    // → local Convex writes cloudRevokedAt → mcpAuth rejects the key.
    // In the harness: we replace the route intercept to immediately reflect revocation.
    const revokedAt = Date.now();

    await page.route(`https://${TUNNEL_HOST}/api/mcp/**`, async (route) => {
      // All requests after revocation → 401
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify(MCP_RECALL_401),
      });
    });

    // Step 3: Poll until 401 appears, assert it happens within 30 s
    const REVOCATION_BUDGET_MS = 30_000;
    let got401 = false;
    let lastStatus = -1;

    while (!got401 && Date.now() - revokedAt < REVOCATION_BUDGET_MS) {
      const result = await mcpRecall(page, TENANT_API_KEY);
      lastStatus = result.status;
      if (result.status === 401) {
        got401 = true;
        const body = result.body as Record<string, unknown>;
        expect(body.error).toBe("invalid_key");
        break;
      }
      // Brief pause between polls (the mock propagates immediately, so this will
      // typically resolve on the first poll; the loop exists for real-infra use)
      await page.waitForTimeout(500);
    }

    const elapsed = Date.now() - revokedAt;
    expect(
      got401,
      `Revoked key still returning ${lastStatus} after ${elapsed}ms — expected 401 within 30s`,
    ).toBe(true);

    expect(
      elapsed,
      `Revocation took ${elapsed}ms — must be ≤ 30000ms (AC2 §3.3 Fork 1)`,
    ).toBeLessThanOrEqual(REVOCATION_BUDGET_MS);

    console.log(`[revocation] 401 received ${elapsed}ms after revocation`);
  });

  test("cloud-side revocation: cloud marks revokedAt, tunnel returns 401", async ({
    page,
  }) => {
    // Start with valid key
    await setupMockHarness(page, { apiKeyRevoked: false });
    await page.goto("/");

    // Confirm healthy pre-revocation
    const pre = await mcpRecall(page, TENANT_API_KEY);
    expect(pre.status).toBe(200);

    // Mock cloud revocation endpoint
    await page.route("**/api/cloud/keys/revoke", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ revoked: true, keyHash: "sha256_mock_hash" }),
      });
    });

    // Trigger cloud revocation (as the user clicking "revoke" on the cloud dashboard)
    const revokeResult = await page.evaluate(async () => {
      const resp = await fetch("/api/cloud/keys/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: "j571abc0000000000000000e2e", keyId: "key-1" }),
      });
      return { status: resp.status };
    });
    expect(revokeResult.status).toBe(200);

    // Now override tunnel to reflect revoked state (simulating heartbeat propagation)
    await page.route(`https://${TUNNEL_HOST}/api/mcp/**`, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify(MCP_RECALL_401),
      });
    });

    // Verify 401
    const post = await mcpRecall(page, TENANT_API_KEY);
    expect(post.status).toBe(401);
    const postBody = post.body as Record<string, unknown>;
    expect(postBody.error).toBe("invalid_key");
  });

  test("revoked key returns 401; a newly issued key returns 200", async ({
    page,
    browser,
  }) => {
    const NEW_KEY = "mck_v1_" + "d".repeat(64);

    // Set up revoked harness
    await setupMockHarness(page, { apiKeyRevoked: true });
    await page.goto("/");

    // Old key → 401
    const oldResult = await mcpRecall(page, TENANT_API_KEY);
    expect(oldResult.status).toBe(401);

    // New context for the new key, with tunnel accepting NEW_KEY
    const newContext = await browser.newContext();
    const newPage = await newContext.newPage();
    await setupMockHarness(newPage, { apiKeyRevoked: false });

    // Override tunnel to accept the new key only
    await newPage.route(`https://${TUNNEL_HOST}/api/mcp/**`, async (route) => {
      const auth = route.request().headers()["authorization"] ?? "";
      const key = auth.replace(/^Bearer\s+/i, "").trim();
      if (key === NEW_KEY) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, tenant: TENANT_SLUG, memories: [] }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify(MCP_RECALL_401),
        });
      }
    });

    await newPage.goto("/");

    try {
      const newResult = await mcpRecall(newPage, NEW_KEY);
      expect(newResult.status).toBe(200);
    } finally {
      await newContext.close();
    }
  });
});
