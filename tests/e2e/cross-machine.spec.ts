/**
 * AC2 — Cross-machine API key E2E spec.
 *
 * Verifies that the same MCP API key works from two different browser
 * contexts (representing two separate machines / origins) against the
 * same tenant tunnel.
 *
 * Also verifies:
 *   - Response shape matches the MCP recall schema
 *   - Both contexts receive 200 with the same tenant field
 *   - Invalid key returns 401 with error:"invalid_key"
 */

import { test, expect, Browser, BrowserContext, Page } from "@playwright/test";
import {
  TENANT_SLUG,
  TENANT_API_KEY,
  INVALID_API_KEY,
  TUNNEL_HOST,
  MCP_RECALL_OK,
  MCP_RECALL_401,
} from "./_helpers/tenantFixtures";
import { setupMockHarness } from "./_helpers/mockHarness";

// ---------------------------------------------------------------------------
// MCP recall schema assertion
// ---------------------------------------------------------------------------
function assertMcpRecallSchema(body: unknown): void {
  expect(body).toBeTruthy();
  const b = body as Record<string, unknown>;
  // Per plan §AC2 verification: response has ok:true, tenant slug, memories array
  expect(typeof b.ok).toBe("boolean");
  expect(b.ok).toBe(true);
  expect(typeof b.tenant).toBe("string");
  expect(Array.isArray(b.memories)).toBe(true);
}

// ---------------------------------------------------------------------------
// Helper: POST to the MCP recall endpoint from a page context
// ---------------------------------------------------------------------------
async function mcpRecall(
  page: Page,
  apiKey: string,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ host, key }: { host: string; key: string }) => {
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
    },
    { host: TUNNEL_HOST, key: apiKey },
  );
}

test.describe("AC2 — Cross-machine API key access", () => {
  test("same key from two ephemeral browser contexts — both get 200 with correct tenant", async ({
    browser,
  }) => {
    // Machine A — ephemeral context
    const contextA: BrowserContext = await browser.newContext();
    const pageA: Page = await contextA.newPage();
    await setupMockHarness(pageA);

    // Machine B — separate ephemeral context (no shared cookies/storage)
    const contextB: BrowserContext = await browser.newContext();
    const pageB: Page = await contextB.newPage();
    await setupMockHarness(pageB);

    try {
      // Parallel recall from both "machines"
      const [resultA, resultB] = await Promise.all([
        mcpRecall(pageA, TENANT_API_KEY),
        mcpRecall(pageB, TENANT_API_KEY),
      ]);

      // Both should be 200
      expect(resultA.status, "Machine A recall should return 200").toBe(200);
      expect(resultB.status, "Machine B recall should return 200").toBe(200);

      // Both response bodies match the MCP recall schema
      assertMcpRecallSchema(resultA.body);
      assertMcpRecallSchema(resultB.body);

      // Both refer to the same tenant
      const bodyA = resultA.body as Record<string, unknown>;
      const bodyB = resultB.body as Record<string, unknown>;
      expect(bodyA.tenant).toBe(TENANT_SLUG);
      expect(bodyB.tenant).toBe(TENANT_SLUG);
      expect(bodyA.tenant).toBe(bodyB.tenant);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("invalid key returns 401 with error:'invalid_key' from both contexts", async ({
    browser,
  }) => {
    const contextA: BrowserContext = await browser.newContext();
    const pageA: Page = await contextA.newPage();
    await setupMockHarness(pageA);

    const contextB: BrowserContext = await browser.newContext();
    const pageB: Page = await contextB.newPage();
    await setupMockHarness(pageB);

    try {
      const [resultA, resultB] = await Promise.all([
        mcpRecall(pageA, INVALID_API_KEY),
        mcpRecall(pageB, INVALID_API_KEY),
      ]);

      expect(resultA.status).toBe(401);
      expect(resultB.status).toBe(401);

      const bodyA = resultA.body as Record<string, unknown>;
      const bodyB = resultB.body as Record<string, unknown>;
      expect(bodyA.error).toBe("invalid_key");
      expect(bodyB.error).toBe("invalid_key");
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("valid key from machine A still works while machine B uses invalid key", async ({
    browser,
  }) => {
    const contextA: BrowserContext = await browser.newContext();
    const pageA: Page = await contextA.newPage();
    await setupMockHarness(pageA);

    const contextB: BrowserContext = await browser.newContext();
    const pageB: Page = await contextB.newPage();
    await setupMockHarness(pageB);

    try {
      const [resultA, resultB] = await Promise.all([
        mcpRecall(pageA, TENANT_API_KEY),
        mcpRecall(pageB, INVALID_API_KEY),
      ]);

      // Machine A (valid key) → 200
      expect(resultA.status).toBe(200);
      assertMcpRecallSchema(resultA.body);

      // Machine B (invalid key) → 401
      expect(resultB.status).toBe(401);
      const bodyB = resultB.body as Record<string, unknown>;
      expect(bodyB.error).toBe("invalid_key");
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
