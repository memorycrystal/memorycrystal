"use strict";

/**
 * Tests for the legacy handler.js plugin-config bridge: documented plugin-config
 * recall knobs (maxMemories / previewChars) must actually reach the recall
 * child — both on the stdin payload (`config`) and via MEMORY_CRYSTAL_* env
 * vars — without clobbering an explicit operator env override.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");

const handler = require("./handler.js");

const RECALL_STDOUT = JSON.stringify({ injectionBlock: "", memories: [] });

const BRIDGED_ENV_KEYS = [
  "MEMORY_CRYSTAL_MAX_MEMORIES",
  "MEMORY_CRYSTAL_PREVIEW_CHARS",
];

// Stub the child spawn AND clear any ambient MEMORY_CRYSTAL_* recall env so the
// assertions are hermetic regardless of the developer/CI environment.
const withStubbedSpawnSync = async (fn) => {
  const originalSpawnSync = childProcess.spawnSync;
  const savedEnv = {};
  for (const key of BRIDGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const calls = [];
  childProcess.spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: RECALL_STDOUT, stderr: "" };
  };
  try {
    return await fn(calls);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    for (const key of BRIDGED_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  }
};

const recallCallOf = (calls) => {
  assert.equal(calls.length, 1, "expected exactly one child spawn");
  const call = calls[0];
  assert.ok(
    String(call.args[0]).endsWith("recall-hook.js"),
    `expected recall-hook.js child, got ${call.args[0]}`,
  );
  return call;
};

test("bridges payload.config maxMemories/previewChars to the recall child (stdin + env)", async () => {
  await withStubbedSpawnSync(async (calls) => {
    const result = await handler.before_model_resolve({
      query: "what did we decide about atlas",
      config: { maxMemories: 12, previewChars: 512 },
    });

    assert.equal(result.ok, true);
    const call = recallCallOf(calls);

    const stdinPayload = JSON.parse(call.options.input);
    assert.deepEqual(stdinPayload.config, { maxMemories: 12, previewChars: 512 });
    assert.equal(stdinPayload.query, "what did we decide about atlas");

    assert.equal(call.options.env.MEMORY_CRYSTAL_MAX_MEMORIES, "12");
    assert.equal(call.options.env.MEMORY_CRYSTAL_PREVIEW_CHARS, "512");
  });
});

test("accepts the payload.pluginConfig shape used by other host versions", async () => {
  await withStubbedSpawnSync(async (calls) => {
    const result = await handler.before_model_resolve({
      query: "recall the runbook",
      pluginConfig: { maxMemories: 7, previewChars: 256 },
    });

    assert.equal(result.ok, true);
    const call = recallCallOf(calls);

    const stdinPayload = JSON.parse(call.options.input);
    assert.deepEqual(stdinPayload.config, { maxMemories: 7, previewChars: 256 });

    assert.equal(call.options.env.MEMORY_CRYSTAL_MAX_MEMORIES, "7");
    assert.equal(call.options.env.MEMORY_CRYSTAL_PREVIEW_CHARS, "256");
  });
});

test("does not clobber an explicit MEMORY_CRYSTAL_* env override set by the operator", async () => {
  await withStubbedSpawnSync(async (calls) => {
    // Simulate the operator's explicit override; the helper restores env after.
    process.env.MEMORY_CRYSTAL_MAX_MEMORIES = "3";

    const result = await handler.before_model_resolve({
      query: "recall the runbook",
      config: { maxMemories: 12, previewChars: 512 },
    });

    assert.equal(result.ok, true);
    const call = recallCallOf(calls);

    // Operator env wins for the env bridge; previewChars (unset in env) still bridges.
    assert.equal(call.options.env.MEMORY_CRYSTAL_MAX_MEMORIES, "3");
    assert.equal(call.options.env.MEMORY_CRYSTAL_PREVIEW_CHARS, "512");

    // The stdin payload still carries the plugin-config values verbatim so the
    // child's own resolver can apply its documented env-over-config precedence.
    const stdinPayload = JSON.parse(call.options.input);
    assert.deepEqual(stdinPayload.config, { maxMemories: 12, previewChars: 512 });
  });
});

test("omits recall config entirely when the payload carries none", async () => {
  await withStubbedSpawnSync(async (calls) => {
    const result = await handler.before_model_resolve({ query: "plain recall" });

    assert.equal(result.ok, true);
    const call = recallCallOf(calls);

    const stdinPayload = JSON.parse(call.options.input);
    assert.deepEqual(stdinPayload.config, {});
    assert.equal("MEMORY_CRYSTAL_MAX_MEMORIES" in call.options.env, false);
    assert.equal("MEMORY_CRYSTAL_PREVIEW_CHARS" in call.options.env, false);
  });
});
