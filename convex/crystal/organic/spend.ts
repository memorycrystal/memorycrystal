import { type ModelPreset, getModelPreset } from "./models";

export const MIN_TICK_INTERVAL_MS = 0;
export const MAX_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1000;

/** Allowed pulse interval tiers (ms). 0 = Live (back-to-back). */
export const PULSE_INTERVAL_TIERS_MS = [
  0,        // Live (back-to-back)
  1000,     // 1s
  3000,     // 3s
  5000,     // 5s
  10000,    // 10s
  20000,    // 20s
  30000,    // 30s
  60000,    // 1m
  180000,   // 3m
  300000,   // 5m
  600000,   // 10m
  1200000,  // 20m
  1800000,  // 30m
  3600000,  // 60m
];

const GEMINI_FLASH_INPUT_COST_PER_1M = 0.1;
const GEMINI_FLASH_OUTPUT_COST_PER_1M = 0.9;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export type EstimatedSpend = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
};

export function clampTickIntervalMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_TICK_INTERVAL_MS;
  }

  const rounded = Math.round(value);
  return Math.min(MAX_TICK_INTERVAL_MS, rounded);
}

/** Snap a value to the nearest allowed tier, or return it clamped if no exact match. */
export function snapToTier(value: number): number {
  if (PULSE_INTERVAL_TIERS_MS.includes(value)) return value;
  return clampTickIntervalMs(value);
}

export function estimateTokensFromText(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function estimateUsdFromTokens({
  inputTokens,
  outputTokens,
}: {
  inputTokens: number;
  outputTokens: number;
}): number {
  const inputCost = (inputTokens / 1_000_000) * GEMINI_FLASH_INPUT_COST_PER_1M;
  const outputCost = (outputTokens / 1_000_000) * GEMINI_FLASH_OUTPUT_COST_PER_1M;
  return inputCost + outputCost;
}

export function estimateModelSpend(prompt: string, responseText: string, preset: ModelPreset): EstimatedSpend {
  const estimatedInputTokens = estimateTokensFromText(prompt);
  const estimatedOutputTokens = estimateTokensFromText(responseText);
  const inputCost = (estimatedInputTokens / 1_000_000) * preset.inputCostPer1M;
  const outputCost = (estimatedOutputTokens / 1_000_000) * preset.outputCostPer1M;

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd: inputCost + outputCost,
  };
}

/** @deprecated Use estimateModelSpend with a ModelPreset instead. */
export function estimateGeminiSpend(prompt: string, responseText: string): EstimatedSpend {
  const estimatedInputTokens = estimateTokensFromText(prompt);
  const estimatedOutputTokens = estimateTokensFromText(responseText);

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd: estimateUsdFromTokens({
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
    }),
  };
}

export function summarizeRunSpend(items: EstimatedSpend[]): EstimatedSpend {
  return items.reduce<EstimatedSpend>(
    (totals, item) => ({
      estimatedInputTokens: totals.estimatedInputTokens + item.estimatedInputTokens,
      estimatedOutputTokens: totals.estimatedOutputTokens + item.estimatedOutputTokens,
      estimatedCostUsd: totals.estimatedCostUsd + item.estimatedCostUsd,
    }),
    {
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
    }
  );
}

export function estimateRunsPerPeriod(tickIntervalMs: number) {
  const intervalMs = clampTickIntervalMs(tickIntervalMs);
  // Live mode (0ms) uses a floor estimate: assume ~10s effective interval
  // (network + processing time) for spend estimation purposes
  const effectiveMs = intervalMs === 0 ? 10_000 : intervalMs;
  return {
    daily: Math.max(1, Math.floor((24 * 60 * 60 * 1000) / effectiveMs)),
    weekly: Math.max(1, Math.floor((7 * 24 * 60 * 60 * 1000) / effectiveMs)),
    monthly: Math.max(1, Math.floor((30 * 24 * 60 * 60 * 1000) / effectiveMs)),
  };
}

export function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}
