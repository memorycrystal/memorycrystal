import test from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalEnv = {
  MEMORY_CRYSTAL_API_URL: process.env.MEMORY_CRYSTAL_API_URL,
  MEMORY_CRYSTAL_API_KEY: process.env.MEMORY_CRYSTAL_API_KEY,
  CONVEX_URL: process.env.CONVEX_URL,
  CRYSTAL_API_KEY: process.env.CRYSTAL_API_KEY,
};

function restoreEnv() {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.afterEach(restoreEnv);

test("what do I know normalizes HTTP recall rows without strength", async () => {
  process.env.MEMORY_CRYSTAL_API_URL = "https://backend.example";
  process.env.MEMORY_CRYSTAL_API_KEY = "test-api-key";
  delete process.env.CONVEX_URL;
  delete process.env.CRYSTAL_API_KEY;

  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://backend.example/api/mcp/recall");
    assert.equal(init.headers.Authorization, "Bearer test-api-key");
    const body = JSON.parse(String(init.body));
    assert.equal(body.query, "atlas");
    return new Response(JSON.stringify({
      memories: [
        {
          _id: "memory-1",
          title: "Atlas launch decision",
          content: "Ship after QA",
          store: "semantic",
          category: "decision",
          score: 0.82,
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { handleWhatDoIKnowTool } = await import("../dist/tools/what-do-i-know.js");
  const result = await handleWhatDoIKnowTool({ topic: "atlas", limit: 5 });

  assert.equal(result?.isError, undefined);
  assert.match(result.content[0].text, /Atlas launch decision \(0\.82\)/);
  const payload = JSON.parse(result.content[1].text);
  assert.equal(payload.topMemories[0].memoryId, "memory-1");
  assert.equal(payload.topMemories[0].strength, 0.82);
});
