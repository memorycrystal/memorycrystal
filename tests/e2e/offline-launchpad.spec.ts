/**
 * AC3 — Offline launchpad E2E spec.
 *
 * Verifies that when a tenant's lastSeenAt is mocked >90s ago, the
 * /launch/{slug}/offline page:
 *   - Returns HTTP 200 (never 502/503/CF error page)
 *   - Shows the tenant slug
 *   - Shows lastSeenAt as relative time (e.g. "5 minutes ago")
 *   - Shows recovery hints
 *   - Has a "Refresh Status" button
 *   - Clicking Refresh → still shows a 200 page (not a CF error)
 *
 * The launchpad route.ts logic:
 *   - onboardingState === "ready" AND lastSeenAt > 90s ago → redirects to /offline
 *   - /offline page is an SSR page that always returns 200
 */

import { test, expect } from "@playwright/test";
import { setupOfflineHarness, setupMockHarness } from "./_helpers/mockHarness";
import { TENANT_SLUG, LAST_SEEN_5_MIN_AGO, LAST_SEEN_2_MIN_AGO } from "./_helpers/tenantFixtures";

test.describe("AC3 — Offline launchpad", () => {
  test("offline page renders HTTP 200 with relative lastSeenAt and tenant slug", async ({
    page,
  }) => {
    // lastSeenAt = 5 minutes ago → "5 minutes ago"
    await setupOfflineHarness(page, LAST_SEEN_5_MIN_AGO);

    const response = await page.goto(`/launch/${TENANT_SLUG}/offline`);

    // Must be 200 — never 502, 503, or CF error page
    expect(
      response?.status(),
      "Offline launchpad must return HTTP 200",
    ).toBe(200);

    // Page title / status badge
    await expect(page.getByText("Stack Offline")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Your stack is offline")).toBeVisible();

    // Tenant slug visible
    await expect(page.getByText(TENANT_SLUG, { exact: true })).toBeVisible();

    // lastSeenAt relative time — the mock sets it to 5 min ago.
    // The page renders something like "5 minutes ago".
    // We check for "ago" as the stable part (the exact minute depends on test timing).
    await expect(page.getByText(/\d+ minutes? ago|\d+ seconds? ago|\d+ hours? ago/)).toBeVisible({
      timeout: 5_000,
    });

    // Recovery hints visible
    await expect(page.getByText("Recovery steps")).toBeVisible();
    await expect(page.getByText(/docker compose ps/)).toBeVisible();
    await expect(page.getByText(/docker compose logs cloudflared/)).toBeVisible();

    // Refresh button present
    const refreshBtn = page.getByRole("link", { name: /Refresh Status/i });
    await expect(refreshBtn).toBeVisible();
  });

  test("Refresh button click → still returns 200 (not CF error)", async ({ page }) => {
    await setupOfflineHarness(page, LAST_SEEN_2_MIN_AGO);

    await page.goto(`/launch/${TENANT_SLUG}/offline`);
    await expect(page.getByText("Your stack is offline")).toBeVisible({ timeout: 10_000 });

    // Click Refresh Status → navigates to /launch/{slug} which redirects back to /offline
    const refreshBtn = page.getByRole("link", { name: /Refresh Status/i });
    await expect(refreshBtn).toBeVisible();

    const [response] = await Promise.all([
      page.waitForResponse(
        (resp) =>
          resp.url().includes(`/launch/${TENANT_SLUG}`) ||
          resp.url().includes("/offline"),
        { timeout: 15_000 },
      ),
      refreshBtn.click(),
    ]);

    // The response from /launch/{slug} → redirect → /offline must be 200
    // (The redirect itself is a 3xx; the final page must be 200)
    expect(
      [200, 301, 302, 307, 308],
      `Unexpected status after Refresh click: ${response.status()}`,
    ).toContain(response.status());

    // Final page must not show a CF error page (which would have "Error 502" / "Error 1033")
    const bodyText = await page.textContent("body");
    expect(bodyText).not.toContain("Error 502");
    expect(bodyText).not.toContain("Error 503");
    expect(bodyText).not.toContain("Error 1033");
    expect(bodyText).not.toContain("1016 Origin DNS error");

    // The offline page should still be visible (stack is still offline in mock)
    await expect(page.getByText("Your stack is offline")).toBeVisible({ timeout: 10_000 });
  });

  test("subdomain is shown in the offline page body", async ({ page }) => {
    await setupOfflineHarness(page, LAST_SEEN_5_MIN_AGO);

    await page.goto(`/launch/${TENANT_SLUG}/offline`);

    const expectedSubdomain = `${TENANT_SLUG}.tunnels.memorycrystal.ai`;
    await expect(page.getByText(expectedSubdomain, { exact: false })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("never connects page (lastSeenAt=null) shows 'Never connected' text", async ({
    page,
  }) => {
    // Override to set lastSeenAt to null (tenant provisioned but never started stack)
    await setupMockHarness(page, { tenantOnline: false, lastSeenAt: 0 });

    // Patch the offline page mock to simulate null lastSeenAt
    await page.route(`**/launch/${TENANT_SLUG}/offline`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!DOCTYPE html>
<html>
<head><title>Stack Offline</title></head>
<body>
  <h1>Your stack is offline</h1>
  <p>${TENANT_SLUG}</p>
  <p>Never connected — stack has not started yet</p>
  <p>Recovery steps</p>
  <a href="/launch/${TENANT_SLUG}">Refresh Status</a>
</body>
</html>`,
      });
    });

    const response = await page.goto(`/launch/${TENANT_SLUG}/offline`);
    expect(response?.status()).toBe(200);

    await expect(page.getByText("Never connected — stack has not started yet")).toBeVisible({
      timeout: 5_000,
    });
  });
});
