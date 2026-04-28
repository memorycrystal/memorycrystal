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

test("checkpoint list mode posts list request without a label", async () => {
  process.env.MEMORY_CRYSTAL_API_URL = "https://backend.example";
  process.env.MEMORY_CRYSTAL_API_KEY = "test-api-key";

  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://backend.example/api/mcp/checkpoint");
    assert.equal(init.headers.Authorization, "Bearer test-api-key");
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, {
      mode: "list",
      sessionId: "session-a",
      limit: 3,
      channel: "codex:local",
    });
    return new Response(JSON.stringify({
      checkpoints: [
        { checkpointId: "checkpoint-1", label: "Milestone", createdAt: 123 },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { handleCheckpointTool } = await import("../dist/tools/checkpoint.js");
  const result = await handleCheckpointTool({
    mode: "list",
    sessionId: "session-a",
    channel: "codex:local",
    limit: 3,
  });

  assert.equal(result?.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.checkpoints[0].checkpointId, "checkpoint-1");
});
