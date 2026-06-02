/**
 * M3 precision/recall A/B eval — discoverability anchor.
 *
 * Live A/B eval lives at scripts/eval-graph-extraction.mjs (run manually with GEMINI_API_KEY).
 *
 * Last run: 2026-05-03
 *   candidate  : gemini-2.5-flash-lite (proxy for gemini-2.0-flash via direct Gemini API)
 *   baseline   : gemini-2.5-flash
 *   fixtures   : 20
 *   result     : precision=0.903 / recall=0.903 — GATE FAILED (precision < 0.95 threshold)
 *   raw output : convex/crystal/__tests__/fixtures/eval-results/graph-extraction-2026-05-03.json
 *
 * Note: gemini-2.0-flash returns HTTP 404 on new Google AI Studio API keys.
 * Production routes via OpenRouter where the model is available. Re-run with an
 * OpenRouter key (update MODELS[0] in the script) to get an authoritative result.
 *
 * Acceptance criteria (per plan §9 #8):
 *   precision: ≥95% of expected entities extracted by the candidate model
 *   recall:    ≥90% of expected entities extracted by the candidate model
 */

// Live A/B eval lives at scripts/eval-graph-extraction.mjs (run manually with GEMINI_API_KEY).
// This file is a discoverability anchor only — the real eval is the standalone Node script.
//
// To re-run the eval:
//   GEMINI_API_KEY=<key> node scripts/eval-graph-extraction.mjs
//
// Results land at:
//   convex/crystal/__tests__/fixtures/eval-results/graph-extraction-2026-05-03.json
//
// Last result (2026-05-03): P=0.903 R=0.903 on gemini-2.5-flash-lite (proxy for gemini-2.0-flash).
// Gate (§9 #8): FAILED — precision 0.903 < 0.95. Recall passes. Operator decision required.
// See followups doc F5 for full analysis and next steps.

import { describe, it } from "vitest";

// Skipped — live eval requires outbound fetch to Gemini which is not available in convex-test sandbox.
describe.skip("M3 graph extraction A/B: gemini-2.0-flash vs gemini-2.5-flash", () => {
  it("live eval — run scripts/eval-graph-extraction.mjs with GEMINI_API_KEY instead", () => {
    // Intentionally empty. This suite exists only so `vitest --reporter=verbose` lists
    // the eval as a known-skipped item rather than being invisible in CI output.
  });
});
