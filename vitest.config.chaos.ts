/**
 * Vitest config for the chaos test suite.
 *
 * Runs only `tests/chaos/` specs — isolated from the unit-test config
 * (`vitest.config.ts`) which covers `convex/**`.
 *
 * Usage:
 *   pnpm chaos
 *   # or directly:
 *   vitest run --config vitest.config.chaos.ts
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/chaos/**/*.spec.ts"],
    exclude: ["node_modules"],
    // Use Node environment — the chaos suite imports the Worker handler
    // directly and stubs `globalThis.fetch` via vi.stubGlobal.
    environment: "node",
    // Each spec file gets a fresh module registry so vi.resetModules() in
    // afterEach() works correctly for the Worker handler import pattern.
    isolate: true,
    // No global test injection — specs import from "vitest" explicitly
    // (matching existing codebase style in convex/**/__tests__/).
    globals: false,
  },
});
