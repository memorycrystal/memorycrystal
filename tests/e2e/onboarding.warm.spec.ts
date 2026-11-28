/**
 * ILL-433: the self-hosted tunnel onboarding is not offered (decision
 * 2026-10-08). /onboard redirects to the normal onboarding at /get-started.
 * The tenant flow (OnboardForm, provisioning) stays in the repo, dormant, and
 * the cold-cache spec that drove it is skipped.
 */

import { test, expect } from "@playwright/test";
import { setupMockHarness } from "./_helpers/mockHarness";

test.describe("/onboard is retired (ILL-433)", () => {
  test("redirects to the normal onboarding at /get-started", async ({ page }) => {
    await setupMockHarness(page);

    await page.goto("/onboard");
    // As in the old flow, the auth guard may bounce through /login once before
    // the stubbed session is in place.
    if (page.url().includes("/login")) {
      await page.goto("/onboard");
    }

    await expect(page).toHaveURL(/\/get-started(?:[?#]|$)/);
    await expect(page.getByRole("heading", { level: 1, name: "GET STARTED" })).toBeVisible();
    // The retired tenant form must not render.
    await expect(page.locator('input[placeholder="my-team"]')).toHaveCount(0);
  });
});
