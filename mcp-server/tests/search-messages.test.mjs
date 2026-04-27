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

test("search messages filters mixed-channel backend rows before text and JSON output", async () => {
  process.env.MEMORY_CRYSTAL_API_URL = "https://backend.example";
  process.env.MEMORY_CRYSTAL_API_KEY = "test-api-key";
  delete process.env.CONVEX_URL;
  delete process.env.CRYSTAL_API_KEY;

  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://backend.example/api/mcp/search-messages");
    assert.equal(init.headers.Authorization, "Bearer test-api-key");
    const body = JSON.parse(String(init.body));
    assert.equal(body.channel, "morrow-coach:511172388");
    return new Response(JSON.stringify({
      messages: [
        { messageId: "right", role: "user", content: "right peer birthday", channel: "morrow-coach:511172388", timestamp: 1, score: 0.9 },
        { messageId: "wrong", role: "user", content: "wrong peer birthday", channel: "morrow-coach:999", timestamp: 2, score: 1 },
      ],
      turns: [
        { turnId: "wrong-turn", messages: [{ messageId: "wrong", role: "user", content: "wrong turn", channel: "morrow-coach:999", timestamp: 2 }] },
        { turnId: "right-turn", messages: [{ messageId: "right", role: "user", content: "right turn", channel: "morrow-coach:511172388", timestamp: 1 }] },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { handleSearchMessagesTool } = await import("../dist/tools/search-messages.js");
  const result = await handleSearchMessagesTool({
    query: "birthday",
    channel: "morrow-coach:511172388",
    limit: 5,
  });

  assert.equal(result?.isError, undefined);
  const text = result.content[0].text;
  const payload = JSON.parse(result.content[1].text);
  assert.match(text, /right peer birthday/);
  assert.doesNotMatch(text, /wrong peer birthday/);
  assert.deepEqual(payload.results.map((message) => message.messageId), ["right"]);
  assert.deepEqual(payload.turns.map((turn) => turn.turnId), ["right-turn"]);
  assert.equal(JSON.stringify(payload).includes("wrong"), false);
});
