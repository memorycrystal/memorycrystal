// crystal-summarizer.test.js — Unit tests for crystal-summarizer.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, formatTimestamp, createSummarizer } from "./crystal-summarizer.js";

// ── estimateTokens ─────────────────────────────────────────────────────────

test("estimateTokens('') returns 0", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens('hello world') returns 3", () => {
  // 'hello world' is 11 chars => Math.ceil(11/4) = 3
  assert.equal(estimateTokens("hello world"), 3);
});

// ── formatTimestamp ────────────────────────────────────────────────────────

test("formatTimestamp returns correct UTC string", () => {
  const date = new Date("2026-01-01T00:00:00Z");
  const result = formatTimestamp(date, "UTC");
  assert.equal(result, "2026-01-01 00:00 UTC");
});

// ── createSummarizer ───────────────────────────────────────────────────────

test("createSummarizer returns a function", () => {
  const summarize = createSummarizer({ apiKey: "test-key" });
  assert.equal(typeof summarize, "function");
});

test("fallback truncation: 3000-token input falls back to truncated string with [Truncated] marker", async () => {
  // Build a string of ~3000 tokens (12000 chars)
  const bigText = "a".repeat(12000);

  // Patch globalThis.fetch to simulate OpenAI failure
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Simulated network failure");
  };

  try {
    const summarize = createSummarizer({ apiKey: "fake-key", model: "gpt-4o-mini" });
    const result = await summarize(bigText, false, {});

    // Must contain the truncation marker
    assert.ok(result.includes("[Truncated"), `Expected [Truncated marker, got: ${result.slice(0, 120)}`);
    // Must be under 600 chars (512 tokens * 4 chars + marker overhead)
    assert.ok(result.length < 2200, `Expected result < 2200 chars, got ${result.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
