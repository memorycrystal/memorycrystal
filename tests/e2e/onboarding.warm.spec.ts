/**
 * AC1 — Onboarding warm-cache E2E spec.
 *
 * Asserts the full signup → success screen → copy button → launchpad flow
 * completes in ≤ 180 seconds with a warm image cache and mocked cloud
 * endpoints (no real Convex/CF calls).
 *
 * What is mocked:
 *   - Convex provisionTenantPublic action → returns success in <1s
 *   - isSlugAvailable query → always available
 *   - CF tunnel stub at {slug}.tunnels.memorycrystal.ai → healthy
 *   - /_e2e/local-stack-mock redirect destination
 */

import { test, expect } from "@playwright/test";
import { setupMockHarness } from "./_helpers/mockHarness";
import { TENANT_SLUG, TENANT_API_KEY, BOOTSTRAP_TOKEN } from "./_helpers/tenantFixtures";

test.describe("AC1 — Onboarding (warm cache)", () => {
  test("full flow completes in ≤ 180 s, success screen shows docker command and copy button", async ({
    page,
  }) => {
    await setupMockHarness(page);

    const startMs = Date.now();

    // Step 1: Visit /onboard
    await page.goto("/onboard");

    // The page may redirect to /login if auth guard triggers.
    // In the E2E mock harness the auth is stubbed, but handle the redirect if needed.
    const currentUrl = page.url();
    if (currentUrl.includes("/login")) {
      // Auth guard redirected — navigate directly with mocked auth cookie in place
      await page.goto("/onboard");
    }

    // Step 2: Fill slug field
    const slugInput = page.getByRole("textbox", { name: /slug/i }).or(
      page.locator('input[placeholder="my-team"]'),
    );
    await slugInput.waitFor({ state: "visible", timeout: 15_000 });
    await slugInput.fill(TENANT_SLUG);

    // Step 3: Wait for slug availability check (debounced 400ms + mock response)
    // The mock returns available:true immediately.
    await expect(page.getByText("Available")).toBeVisible({ timeout: 3_000 });

    // Step 4: Tier should default to "free_selfhosted" — verify it is selected
    const freeTierRadio = page.locator('input[value="free_selfhosted"]');
    await expect(freeTierRadio).toBeChecked();

    // Step 5: Submit the form
    const submitBtn = page.getByRole("button", { name: /provision stack/i });
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click();

    // Step 6: Success screen should appear with docker command
    await expect(page.getByText("Stack Provisioned")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Your stack is ready")).toBeVisible();

    // The docker compose launch command is shown in a <pre> / CodeBlock
    await expect(page.getByText("docker compose up -d")).toBeVisible();

    // API key and bootstrap token are shown
    await expect(page.getByText(TENANT_API_KEY, { exact: true })).toBeVisible();
    await expect(page.getByText(BOOTSTRAP_TOKEN, { exact: true })).toBeVisible();

    // Step 7: Copy button is present and clickable
    // There are multiple "Copy value" buttons (one per CodeBlock); the first is for API key
    const copyButtons = page.getByRole("button", { name: /copy/i });
    const firstCopy = copyButtons.first();
    await expect(firstCopy).toBeVisible();
    // Click it — in the mock harness clipboard.writeText is allowed
    await firstCopy.click();
    // Should show "Copied!" feedback
    await expect(page.getByText("Copied!")).toBeVisible({ timeout: 2_000 });

    // Step 8: "Open Launchpad" button navigates to /launch/{slug}
    // (in the harness the launchpad route.ts will redirect to offline/progress/tunnel
    //  but the button href is what we verify here — the mock handles the launchpad page)
    const launchpadLink = page.getByRole("link", { name: /open launchpad/i });
    await expect(launchpadLink).toBeVisible();
    await expect(launchpadLink).toHaveAttribute("href", `/launch/${TENANT_SLUG}`);

    // Step 9: Assert wall-clock ≤ 180 s
    const elapsedMs = Date.now() - startMs;
    expect(
      elapsedMs,
      `AC1 warm-cache exceeded 180 s budget: ${elapsedMs}ms`,
    ).toBeLessThanOrEqual(180_000);
  });

  test("slug availability check shows error for taken slug", async ({ page }) => {
    await setupMockHarness(page);
    await page.goto("/onboard");

    // Override slug-check route to return unavailable for this specific test
    await page.route(/convex\.cloud|convex\.site/, async (route) => {
      const url = route.request().url();
      if (url.includes("isSlugAvailable")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: 200, value: { available: false, reason: "taken" } }),
        });
        return;
      }
      await route.continue();
    });

    const slugInput = page.locator('input[placeholder="my-team"]');
    await slugInput.waitFor({ state: "visible", timeout: 10_000 });
    await slugInput.fill("taken-slug");

    await expect(page.getByText("Already taken")).toBeVisible({ timeout: 3_000 });

    // Submit button should be disabled
    const submitBtn = page.getByRole("button", { name: /provision stack/i });
    await expect(submitBtn).toBeDisabled();
  });
});
