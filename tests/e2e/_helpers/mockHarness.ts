/**
 * Mock harness for Memory Crystal E2E tests.
 *
 * Registers page.route() intercepts that simulate:
 *   - Convex queries / actions (provisionTenantPublic, isSlugAvailable,
 *     getTenantBySlug, getMyTenant)
 *   - Cloud bootstrap endpoint (/api/cloud/bootstrap/fetchInitialState)
 *   - CF tunnel endpoints ({slug}.tunnels.memorycrystal.ai/api/mcp/*)
 *   - Stub local-stack page (/_e2e/local-stack-mock)
 *
 * No real network calls leave the test process.
 */

import type { Page } from "@playwright/test";
import {
  TENANT_SLUG,
  TENANT_ID,
  TENANT_API_KEY,
  BOOTSTRAP_TOKEN,
  TUNNEL_TOKEN,
  TUNNEL_HOST,
  PROVISION_RESULT,
  MCP_RECALL_OK,
  MCP_RECALL_401,
  LAST_SEEN_5_MIN_AGO,
} from "./tenantFixtures";

// ---------------------------------------------------------------------------
// Convex HTTP action / query base patterns
// ---------------------------------------------------------------------------

const CONVEX_BASE = /https:\/\/[a-z0-9-]+\.convex\.cloud\//;

function isConvexUrl(url: string): boolean {
  return CONVEX_BASE.test(url) || url.includes("convex.cloud") || url.includes("convex.site");
}

// ---------------------------------------------------------------------------
// setupMockHarness
//
// Call in test's beforeEach or at the top of the test:
//   await setupMockHarness(page);
//
// Options:
//   tenantOnline    — if false, getTenantBySlug returns lastSeenAt >90s ago
//   apiKeyRevoked   — if true, tunnel MCP endpoint returns 401
//   lastSeenAt      — override lastSeenAt value (ms since epoch)
// ---------------------------------------------------------------------------

export interface MockHarnessOptions {
  tenantOnline?: boolean;
  apiKeyRevoked?: boolean;
  lastSeenAt?: number;
}

export async function setupMockHarness(
  page: Page,
  options: MockHarnessOptions = {},
): Promise<void> {
  const {
    tenantOnline = true,
    apiKeyRevoked = false,
    lastSeenAt = tenantOnline ? Date.now() - 10_000 : LAST_SEEN_5_MIN_AGO,
  } = options;

  // -----------------------------------------------------------------------
  // Convex actions + queries — intercept all convex.cloud traffic
  // -----------------------------------------------------------------------
  await page.route(/convex\.cloud|convex\.site/, async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const body = route.request().postData() ?? "";

    // provisionTenantPublic action
    if (
      method === "POST" &&
      (url.includes("provisionTenantPublic") || url.includes("provision_tenant_public"))
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: 200, value: PROVISION_RESULT }),
      });
      return;
    }

    // isSlugAvailable query
    if (url.includes("isSlugAvailable")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: 200, value: { available: true } }),
      });
      return;
    }

    // getTenantBySlug query
    if (url.includes("getTenantBySlug") || (url.includes("tenants") && method === "POST" && body.includes("slug"))) {
      const tenant = {
        _id: TENANT_ID,
        slug: TENANT_SLUG,
        onboardingState: "ready",
        lastSeenAt,
        tier: "free_selfhosted",
        subdomain: TUNNEL_HOST,
        createdAt: Date.now() - 86_400_000,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: 200, value: tenant }),
      });
      return;
    }

    // getMyTenant query
    if (url.includes("getMyTenant")) {
      const tenant = {
        _id: TENANT_ID,
        slug: TENANT_SLUG,
        onboardingState: "ready",
        lastSeenAt,
        tier: "free_selfhosted",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: 200, value: tenant }),
      });
      return;
    }

    // getBootstrapToken query
    if (url.includes("getBootstrapToken")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: 200,
          value: {
            tokenHash: "sha256hash_of_" + BOOTSTRAP_TOKEN,
            expiresAt: Date.now() + 3_600_000,
            consumedAt: null,
            tenantId: TENANT_ID,
          },
        }),
      });
      return;
    }

    // consumeBootstrapToken mutation
    if (url.includes("consumeBootstrapToken")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: 200,
          value: {
            tenantId: TENANT_ID,
            slug: TENANT_SLUG,
            mcVersion: "1.0.0",
            apiKeys: [{ key: TENANT_API_KEY, createdAt: Date.now() }],
          },
        }),
      });
      return;
    }

    // Fallback — pass unknown Convex calls through with empty success
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: 200, value: null }),
    });
  });

  // -----------------------------------------------------------------------
  // Cloud bootstrap endpoint
  // -----------------------------------------------------------------------
  await page.route("**/api/cloud/bootstrap/fetchInitialState", async (route) => {
    const authHeader = route.request().headers()["authorization"] ?? "";
    const hasValidToken = authHeader.includes(BOOTSTRAP_TOKEN);

    if (!hasValidToken) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Invalid bootstrap token" }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tenantId: TENANT_ID,
        slug: TENANT_SLUG,
        mcVersion: "1.0.0",
        apiKeys: [{ key: TENANT_API_KEY }],
        serverTime: Date.now(),
      }),
    });
  });

  // -----------------------------------------------------------------------
  // CF tunnel MCP endpoint: {slug}.tunnels.memorycrystal.ai/api/mcp/*
  // -----------------------------------------------------------------------
  await page.route(`**/${TENANT_SLUG}.tunnels.memorycrystal.ai/api/mcp/**`, async (route) => {
    const authHeader = route.request().headers()["authorization"] ?? "";
    const bearerKey = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (apiKeyRevoked || bearerKey !== TENANT_API_KEY) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify(MCP_RECALL_401),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MCP_RECALL_OK),
    });
  });

  // Also intercept via full URL pattern
  await page.route(
    `https://${TENANT_SLUG}.tunnels.memorycrystal.ai/**`,
    async (route) => {
      const url = route.request().url();
      const authHeader = route.request().headers()["authorization"] ?? "";
      const bearerKey = authHeader.replace(/^Bearer\s+/i, "").trim();

      if (url.includes("/api/mcp/")) {
        if (apiKeyRevoked || bearerKey !== TENANT_API_KEY) {
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify(MCP_RECALL_401),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MCP_RECALL_OK),
        });
        return;
      }

      if (url.includes("/healthz")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      await route.fulfill({ status: 404, body: "not found" });
    },
  );

  // -----------------------------------------------------------------------
  // Stub local-stack page: /_e2e/local-stack-mock
  // Simulates the redirect destination after onboarding success.
  // -----------------------------------------------------------------------
  await page.route("**/_e2e/local-stack-mock**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!DOCTYPE html>
<html>
<head><title>Local Stack Mock</title></head>
<body>
  <h1>Memory Crystal Local Stack</h1>
  <p data-testid="stack-status">running</p>
  <p data-testid="tenant-slug">${TENANT_SLUG}</p>
</body>
</html>`,
    });
  });

  // -----------------------------------------------------------------------
  // Convex Auth — mock the auth token endpoint so ConvexAuth doesn't 401
  // -----------------------------------------------------------------------
  await page.route("**/auth/**", async (route) => {
    const url = route.request().url();
    if (url.includes("signIn") || url.includes("session") || url.includes("token")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "e2e_mock_auth_token_abc123", userId: "e2e_user_id" }),
      });
      return;
    }
    await route.continue();
  });
}

// ---------------------------------------------------------------------------
// setupRevokedKeyHarness — convenience wrapper for revocation tests
// ---------------------------------------------------------------------------
export async function setupRevokedKeyHarness(page: Page): Promise<void> {
  return setupMockHarness(page, { apiKeyRevoked: true });
}

// ---------------------------------------------------------------------------
// setupOfflineHarness — convenience wrapper for AC3 offline tests
// ---------------------------------------------------------------------------
export async function setupOfflineHarness(page: Page, lastSeenAt?: number): Promise<void> {
  return setupMockHarness(page, {
    tenantOnline: false,
    lastSeenAt: lastSeenAt ?? LAST_SEEN_5_MIN_AGO,
  });
}
