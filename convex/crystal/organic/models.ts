// ── Organic Model Presets ───────────────────────────────────────────────────

export type ModelPreset = {
  key: string;
  label: string;
  provider: "openrouter" | "gemini" | "openai" | "anthropic";
  routerModel: string;
  model: string;
  fallbackModel?: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  maxOutputTokens: number;
  temperature: number;
};

export const MODEL_PRESETS: Record<string, ModelPreset> = {
  potato: {
    key: "potato",
    label: "Potato (GPT-5 Nano)",
    provider: "openrouter",
    routerModel: "openai/gpt-5-nano",
    model: "gpt-5-nano",
    inputCostPer1M: 0.05,
    outputCostPer1M: 0.40,
    maxOutputTokens: 2048,
    temperature: 0.3,
  },
  low: {
    key: "low",
    label: "Low (Gemini 2.0 Flash-Lite)",
    provider: "openrouter",
    routerModel: "google/gemini-2.0-flash-lite-001",
    model: "gemini-2.0-flash-lite",
    inputCostPer1M: 0.08,
    outputCostPer1M: 0.30,
    maxOutputTokens: 2048,
    temperature: 0.3,
  },
  medium: {
    key: "medium",
    label: "Medium (Gemini 2.5 Flash)",
    provider: "openrouter",
    routerModel: "google/gemini-2.5-flash",
    model: "gemini-2.5-flash",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    maxOutputTokens: 2048,
    temperature: 0.3,
  },
  high: {
    key: "high",
    label: "High (GPT-4.1 Mini)",
    provider: "openrouter",
    routerModel: "openai/gpt-4.1-mini",
    model: "gpt-4.1-mini",
    inputCostPer1M: 0.40,
    outputCostPer1M: 1.60,
    maxOutputTokens: 2048,
    temperature: 0.3,
  },
  ultra: {
    key: "ultra",
    label: "Ultra (Gemini 3.1 Pro)",
    provider: "openrouter",
    routerModel: "google/gemini-3.1-pro-preview",
    model: "gemini-3.1-pro-preview",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00,
    maxOutputTokens: 4096,
    temperature: 0.3,
  },
  sonnet: {
    key: "sonnet",
    label: "Sonnet (Claude Sonnet 4.6)",
    provider: "openrouter",
    routerModel: "anthropic/claude-sonnet-4.6",
    model: "claude-sonnet-4-6-20260320",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00,
    maxOutputTokens: 2048,
    temperature: 0.3,
  },
};

export const MODEL_PRESET_KEYS = Object.keys(MODEL_PRESETS);

export const DEFAULT_MODEL_PRESET = "medium";

export function getModelPreset(key?: string | null): ModelPreset {
  if (key && MODEL_PRESETS[key]) return MODEL_PRESETS[key];
  return MODEL_PRESETS[DEFAULT_MODEL_PRESET];
}
