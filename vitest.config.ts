import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["convex/**/*.test.ts"],
    exclude: ["node_modules", "packages/mcp-server/test/**"],
  },
});
