import test from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalEnv = {
  MEMORY_CRYSTAL_API_URL: process.env.MEMORY_CRYSTAL_API_URL,
  MEMORY_CRYSTAL_API_KEY: process.env.MEMORY_CRYSTAL_API_KEY,
};

function restoreEnv() {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.afterEach(restoreEnv);

test("idea action posts deterministic status update", async () => {
  process.env.MEMORY_CRYSTAL_API_URL = "https://backend.example";
  process.env.MEMORY_CRYSTAL_API_KEY = "test-api-key";

  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://backend.example/api/organic/ideas/update");
    assert.equal(init.headers.Authorization, "Bearer test-api-key");
    assert.deepEqual(JSON.parse(String(init.body)), {
      ideaId: "idea-1",
      status: "starred",
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { handleIdeaActionTool } = await import("../dist/tools/idea-action.js");
  const result = await handleIdeaActionTool({ ideaId: "idea-1", action: "star" });

  assert.equal(result?.isError, undefined);
  assert.match(result.content[0].text, /starred/);
});
