import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex function tests only. apps/web tests now run under their own
    // DOM-enabled project at `apps/web/vitest.config.ts` (ILL-94); this config
    // never matched them (its include is `convex/**`), and the explicit
    // `apps/web/**` exclude has been removed now that the web config exists.
    include: ["convex/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "packages/mcp-server/test/**",
      "tests/e2e/**",
      "tests/chaos/**",
    ],
  },
});
