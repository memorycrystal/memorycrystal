import { describe, expect, it } from "vitest";
import {
  DEFAULT_TICK_INTERVAL_MS,
  MAX_TICK_INTERVAL_MS,
  MIN_TICK_INTERVAL_MS,
  clampTickIntervalMs,
  estimateUsdFromTokens,
  estimateTokensFromText,
  summarizeRunSpend,
} from "../organic/spend";

describe("organic spend helpers", () => {
  it("clamps tick intervals to the supported range", () => {
    expect(MIN_TICK_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(clampTickIntervalMs(0)).toBe(MIN_TICK_INTERVAL_MS);
    expect(clampTickIntervalMs(30_000)).toBe(MIN_TICK_INTERVAL_MS);
    expect(clampTickIntervalMs(DEFAULT_TICK_INTERVAL_MS)).toBe(DEFAULT_TICK_INTERVAL_MS);
    expect(clampTickIntervalMs(30 * 60 * 60 * 1000)).toBe(MAX_TICK_INTERVAL_MS);
    // Negative values get the default
    expect(clampTickIntervalMs(-1)).toBe(DEFAULT_TICK_INTERVAL_MS);
    // NaN gets the default
    expect(clampTickIntervalMs(NaN)).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it("estimates tokens from text length conservatively", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText("abcd")).toBe(1);
    expect(estimateTokensFromText("a".repeat(401))).toBe(101);
  });

  it("estimates usd from input and output tokens", () => {
    const spend = estimateUsdFromTokens({
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(spend).toBeGreaterThan(0);
    expect(spend).toBeCloseTo(0.00055, 8);
  });

  it("summarizes per-run telemetry for cost reporting", () => {
    const summary = summarizeRunSpend([
      { estimatedInputTokens: 1_000, estimatedOutputTokens: 500, estimatedCostUsd: 0.00055 },
      { estimatedInputTokens: 2_000, estimatedOutputTokens: 250, estimatedCostUsd: 0.000725 },
    ]);

    expect(summary).toEqual({
      estimatedInputTokens: 3_000,
      estimatedOutputTokens: 750,
      estimatedCostUsd: 0.001275,
    });
  });
});
