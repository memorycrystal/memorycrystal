import test from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalEnv = {
  MEMORY_CRYSTAL_API_URL: process.env.MEMORY_CRYSTAL_API_URL,
  MEMORY_CRYSTAL_API_KEY: process.env.MEMORY_CRYSTAL_API_KEY,
  OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH,
};

const contradictionPayload = {
  detected: true,
  score: 0.91,
  conflictType: "factual",
  explanation: "Budget values disagree",
  suggestedResolution: "Ask which budget is current",
  conflictingMemory: {
    id: "existing-memory",
    title: "Old budget",
    contentPreview: "Budget is $50K",
    similarity: 0.88,
  },
  pairKey: "existing-memory::new-memory",
  actionRequired: true,
};

function configureFetch(expectedPath, body) {
  process.env.MEMORY_CRYSTAL_API_URL = "https://backend.example";
  process.env.MEMORY_CRYSTAL_API_KEY = "test-api-key";
  delete process.env.OBSIDIAN_VAULT_PATH;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), `https://backend.example${expectedPath}`);
    assert.equal(init.headers.Authorization, "Bearer test-api-key");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function parseToolJson(result) {
  const text = result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("remember tool preserves contradiction passthrough fields at runtime", async () => {
  const { handleRememberTool } = await import("../dist/tools/remember.js");
  configureFetch("/api/mcp/capture", {
    ok: true,
    id: "new-memory",
    contradiction: contradictionPayload,
    contradictionCheck: { status: "ok" },
  });

  const result = await handleRememberTool({
    store: "semantic",
    category: "fact",
    title: "Current budget",
    content: "Budget is $75K",
  });

  const payload = parseToolJson(result);
  assert.deepEqual(payload.contradiction, contradictionPayload);
  assert.deepEqual(payload.contradictionCheck, { status: "ok" });
});

test("update tool preserves contradiction passthrough fields at runtime", async () => {
  const { handleUpdateTool } = await import("../dist/tools/update.js");
  configureFetch("/api/mcp/update", {
    success: true,
    memoryId: "new-memory",
    contradiction: contradictionPayload,
    contradictionCheck: { status: "ok" },
  });

  const result = await handleUpdateTool({
    memoryId: "new-memory",
    content: "Budget is $75K",
  });

  const payload = parseToolJson(result);
  assert.deepEqual(payload.contradiction, contradictionPayload);
  assert.deepEqual(payload.contradictionCheck, { status: "ok" });
});

test("edit tool preserves contradiction passthrough fields at runtime", async () => {
  const { handleEditTool } = await import("../dist/tools/edit.js");
  configureFetch("/api/mcp/edit", {
    success: true,
    memoryId: "new-memory",
    contradiction: contradictionPayload,
    contradictionCheck: { status: "ok" },
  });

  const result = await handleEditTool({
    memoryId: "new-memory",
    content: "Budget is $75K",
  });

  const payload = parseToolJson(result);
  assert.deepEqual(payload.contradiction, contradictionPayload);
  assert.deepEqual(payload.contradictionCheck, { status: "ok" });
});

test("supersede tool preserves contradiction passthrough fields at runtime", async () => {
  const { handleSupersedeTool } = await import("../dist/tools/supersede.js");
  configureFetch("/api/mcp/supersede", {
    success: true,
    oldMemoryId: "old-memory",
    newMemoryId: "new-memory",
    action: "superseded",
    contradiction: contradictionPayload,
    contradictionCheck: { status: "ok" },
  });

  const result = await handleSupersedeTool({
    oldMemoryId: "old-memory",
    title: "Current budget",
    content: "Budget is $75K",
  });

  const payload = parseToolJson(result);
  assert.deepEqual(payload.contradiction, contradictionPayload);
  assert.deepEqual(payload.contradictionCheck, { status: "ok" });
});
