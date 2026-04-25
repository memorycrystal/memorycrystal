import { type ModelPreset, getModelPreset } from "./models";

export const MIN_TICK_INTERVAL_MS = 60 * 60 * 1000;
export const MAX_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1000;

/** Legacy sub-hour pulse tiers are shown as disabled in the dashboard. */
export const DISABLED_FAST_PULSE_INTERVAL_TIERS_MS = [
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
];

/** Allowed pulse interval tiers (ms). */
export const PULSE_INTERVAL_TIERS_MS = [
  60 * 60 * 1000,       // 1h
  2 * 60 * 60 * 1000,   // 2h
  4 * 60 * 60 * 1000,   // 4h
  8 * 60 * 60 * 1000,   // 8h
  12 * 60 * 60 * 1000,  // 12h
  24 * 60 * 60 * 1000,  // 24h
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
  if (!Number.isFinite(value)) {
    return DEFAULT_TICK_INTERVAL_MS;
  }

  const rounded = Math.round(value);
  return Math.min(MAX_TICK_INTERVAL_MS, Math.max(MIN_TICK_INTERVAL_MS, rounded));
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
  return {
    daily: Math.max(1, Math.floor((24 * 60 * 60 * 1000) / intervalMs)),
    weekly: Math.max(1, Math.floor((7 * 24 * 60 * 60 * 1000) / intervalMs)),
    monthly: Math.max(1, Math.floor((30 * 24 * 60 * 60 * 1000) / intervalMs)),
  };
}

export function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}
