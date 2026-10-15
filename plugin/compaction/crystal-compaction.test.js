// crystal-compaction.test.js — Unit tests for CrystalCompactionEngine
import { test } from "node:test";
import assert from "node:assert/strict";
import { CrystalCompactionEngine, DEFAULT_CONFIG } from "./crystal-compaction.js";

// ── Mock store helpers ─────────────────────────────────────────────────────

function emptyStore() {
  return {
    async getContextItems() { return []; },
    async getContextTokenCount() { return 0; },
    async getMessageById() { return null; },
    async getSummary() { return null; },
    async insertSummary() {},
    async linkSummaryToMessages() {},
    async linkSummaryToParents() {},
    async replaceContextRangeWithSummary() {},
    async getDistinctDepthsInContext() { return []; },
  };
}

/**
 * Store with a configurable token count but no messages.
 */
function tokenCountStore(tokenCount) {
  return {
    ...emptyStore(),
    async getContextTokenCount() { return tokenCount; },
  };
}

/**
 * A no-op summarizeFn stub.
 */
async function noopSummarizeFn(text) {
  return `summary of: ${text.slice(0, 20)}`;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("evaluate() returns {shouldCompact: false} when below threshold", async () => {
  const engine = new CrystalCompactionEngine(tokenCountStore(1000), { contextThreshold: 0.75 });
  const result = await engine.evaluate("sess", 10000, undefined);
  assert.equal(result.shouldCompact, false);
  assert.equal(result.reason, "none");
  assert.equal(result.currentTokens, 1000);
  assert.equal(result.threshold, 7500);
});

test("evaluate() returns {shouldCompact: true, reason: 'threshold'} when above threshold", async () => {
  const engine = new CrystalCompactionEngine(tokenCountStore(8000), { contextThreshold: 0.75 });
  const result = await engine.evaluate("sess", 10000, undefined);
  assert.equal(result.shouldCompact, true);
  assert.equal(result.reason, "threshold");
  assert.equal(result.currentTokens, 8000);
  assert.equal(result.threshold, 7500);
});

test("compact() runs without error on an empty session", async () => {
  const engine = new CrystalCompactionEngine(emptyStore());
  const result = await engine.compact("sess", 10000, noopSummarizeFn, true);
  assert.equal(result.actionTaken, false);
  assert.equal(result.condensed, false);
});

test("compactLeaf() returns {actionTaken: false} when not enough messages to compact", async () => {
  const engine = new CrystalCompactionEngine(emptyStore());
  const result = await engine.compactLeaf("sess", noopSummarizeFn);
  assert.equal(result.actionTaken, false);
  assert.equal(result.condensed, false);
});
