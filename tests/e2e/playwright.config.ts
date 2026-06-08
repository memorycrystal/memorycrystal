import { defineConfig, devices } from "@playwright/test";

/**
 * E2E Playwright configuration for Memory Crystal.
 *
 * Tests run against a Next.js dev server with mocked Convex and
 * mocked Cloudflare endpoints — no real CF/Convex calls are made.
 *
 * Fast suite: npm run e2e
 * Full suite (incl. slow cold-cache): RUN_COLD_E2E=1 npm run e2e
 */

export default defineConfig({
  testDir: ".",
  /* Maximum time one test can run */
  timeout: 360_000,
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 1 : 0,
  /* Reporter */
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    /* Base URL points at the local dev server */
    baseURL: "http://localhost:3000",
    /* Collect trace on first retry */
    trace: "on-first-retry",
    /* Screenshot on failure */
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "cd ../../apps/web && MC_E2E_AUTH_BYPASS=1 NEXT_PUBLIC_MC_E2E_AUTH_BYPASS=1 npm run dev",
    port: 3000,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
