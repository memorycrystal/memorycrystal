import test from "node:test";
import assert from "node:assert/strict";

const originalEnv = {
  MEMORY_CRYSTAL_API_URL: process.env.MEMORY_CRYSTAL_API_URL,
  MEMORY_CRYSTAL_API_KEY: process.env.MEMORY_CRYSTAL_API_KEY,
  MEMORY_CRYSTAL_BACKEND_URL: process.env.MEMORY_CRYSTAL_BACKEND_URL,
  CRYSTAL_BASE_URL: process.env.CRYSTAL_BASE_URL,
  CRYSTAL_API_KEY: process.env.CRYSTAL_API_KEY,
  MC_MCP_TOKEN: process.env.MC_MCP_TOKEN,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.afterEach(restoreEnv);

test("legacy MCP API key env reports upgrade guidance", async () => {
  process.env.MEMORY_CRYSTAL_API_URL = "https://backend.example";
  process.env.CRYSTAL_API_KEY = "legacy-key";
  delete process.env.MEMORY_CRYSTAL_API_KEY;

  const { ConvexClient } = await import("../dist/lib/convexClient.js");

  assert.throws(
    () => new ConvexClient(),
    /CRYSTAL_API_KEY is no longer supported.*MEMORY_CRYSTAL_API_KEY/
  );
});

test("legacy MCP API URL env reports upgrade guidance", async () => {
  process.env.MEMORY_CRYSTAL_BACKEND_URL = "https://backend.example";
  process.env.MEMORY_CRYSTAL_API_KEY = "api-key";
  delete process.env.MEMORY_CRYSTAL_API_URL;
  delete process.env.CRYSTAL_BASE_URL;

  const { ConvexClient } = await import("../dist/lib/convexClient.js");

  assert.throws(
    () => new ConvexClient(),
    /MEMORY_CRYSTAL_BACKEND_URL and CRYSTAL_BASE_URL are no longer supported.*MEMORY_CRYSTAL_API_URL/
  );
});

test("HTTP transport token does not replace backend API key", async () => {
  process.env.MC_MCP_TOKEN = "transport-token";
  process.env.MEMORY_CRYSTAL_API_KEY = "backend-api-key";

  const { resolveBackendContextBearerToken } = await import("../dist/index.js");

  assert.equal(resolveBackendContextBearerToken("transport-token"), "backend-api-key");
});
