import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // apps/web tests require @testing-library/react + jsdom env, which are
    // declared in apps/web/package.json devDependencies but not yet installed
    // (per M0 user-side `pnpm install` requirement). Until they are, the
    // convex-only vitest project runs in CI; apps/web tests will move to
    // their own vitest config (`apps/web/vitest.config.ts`) post-install.
    include: ["convex/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "packages/mcp-server/test/**",
      "tests/e2e/**",
      "tests/chaos/**",
      "apps/web/**",
    ],
  },
});
