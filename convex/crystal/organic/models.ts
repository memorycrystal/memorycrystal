// ── Organic Model Presets ───────────────────────────────────────────────────

export type ModelPresetTier = "potato" | "low" | "medium" | "high" | "ultra";

export type ModelPresetOption = {
  key: string;
  label: string;
  shortLabel: string;
  description: string;
  badge?: string;
  provider: ModelPreset["provider"];
  tier: ModelPresetTier;
  inputCostPer1M: number;
  outputCostPer1M: number;
  pricingLastVerifiedAt: string;
};

export type ModelPresetTierGroup = {
  key: ModelPresetTier;
  label: string;
  presets: ModelPresetOption[];
};

export type ModelPreset = {
  key: string;
  label: string;
  tier: ModelPresetTier;
  shortLabel: string;
  description: string;
  badge?: string;
  provider: "openrouter" | "gemini" | "openai" | "anthropic";
  routerModel: string;
  model: string;
  fallbackModel?: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  maxOutputTokens: number;
  temperature: number;
  pricingLastVerifiedAt: string;
};

export const MODEL_PRESET_TIER_ORDER: ModelPresetTier[] = ["potato", "low", "medium", "high", "ultra"];

export const MODEL_PRESET_TIER_LABELS: Record<ModelPresetTier, string> = {
  potato: "Potato",
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

export const MODEL_PRESETS: Record<string, ModelPreset> = {
  potato: {
    key: "potato",
    label: "Potato (GPT-5 Nano)",
    tier: "potato",
    shortLabel: "GPT-5 Nano",
    description: "Cheapest baseline for lightweight Organic pulses.",
    provider: "openrouter",
    routerModel: "openai/gpt-5-nano",
    model: "gpt-5-nano",
    inputCostPer1M: 0.05,
    outputCostPer1M: 0.40,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  low: {
    key: "low",
    label: "Low (Gemini 2.0 Flash-Lite)",
    tier: "low",
    shortLabel: "Gemini 2.0 Flash-Lite",
    description: "Fast low-cost Google baseline.",
    provider: "openrouter",
    routerModel: "google/gemini-2.0-flash-lite-001",
    model: "gemini-2.0-flash-lite",
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.30,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  "qwen3-coder-30b": {
    key: "qwen3-coder-30b",
    label: "Low (Qwen3 Coder 30B)",
    tier: "low",
    shortLabel: "Qwen3 Coder 30B",
    description: "Cheap agentic/tool-oriented model for procedural extraction.",
    badge: "cheap",
    provider: "openrouter",
    routerModel: "qwen/qwen3-coder-30b-a3b-instruct",
    model: "qwen3-coder-30b-a3b-instruct",
    inputCostPer1M: 0.07,
    outputCostPer1M: 0.27,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  "qwen3-30b-instruct": {
    key: "qwen3-30b-instruct",
    label: "Low (Qwen3 30B Instruct)",
    tier: "low",
    shortLabel: "Qwen3 30B Instruct",
    description: "Cheap general instruction model for clustering and summaries.",
    badge: "cheap",
    provider: "openrouter",
    routerModel: "qwen/qwen3-30b-a3b-instruct-2507",
    model: "qwen3-30b-a3b-instruct-2507",
    inputCostPer1M: 0.09,
    outputCostPer1M: 0.30,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  medium: {
    key: "medium",
    label: "Medium (Gemini 2.5 Flash)",
    tier: "medium",
    shortLabel: "Gemini 2.5 Flash",
    description: "Balanced default for Organic Memory quality and cost.",
    provider: "openrouter",
    routerModel: "google/gemini-2.5-flash",
    model: "gemini-2.5-flash",
    inputCostPer1M: 0.30,
    outputCostPer1M: 2.50,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  "deepseek-v3-1": {
    key: "deepseek-v3-1",
    label: "Medium (DeepSeek V3.1)",
    tier: "medium",
    shortLabel: "DeepSeek V3.1",
    description: "Budget reasoning option for tougher pulse analysis.",
    provider: "openrouter",
    routerModel: "deepseek/deepseek-chat-v3.1",
    model: "deepseek-chat-v3.1",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.75,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  "glm-4-5-air": {
    key: "glm-4-5-air",
    label: "Medium (GLM 4.5 Air)",
    tier: "medium",
    shortLabel: "GLM 4.5 Air",
    description: "Cost-effective GLM agentic model.",
    provider: "openrouter",
    routerModel: "z-ai/glm-4.5-air",
    model: "glm-4.5-air",
    inputCostPer1M: 0.13,
    outputCostPer1M: 0.85,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  high: {
    key: "high",
    label: "High (GPT-4.1 Mini)",
    tier: "high",
    shortLabel: "GPT-4.1 Mini",
    description: "Stronger OpenAI option below Ultra pricing.",
    provider: "openrouter",
    routerModel: "openai/gpt-4.1-mini",
    model: "gpt-4.1-mini",
    inputCostPer1M: 0.40,
    outputCostPer1M: 1.60,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  "minimax-m2": {
    key: "minimax-m2",
    label: "High (MiniMax M2)",
    tier: "high",
    shortLabel: "MiniMax M2",
    description: "Strong agentic benchmark signal at moderate cost.",
    provider: "openrouter",
    routerModel: "minimax/minimax-m2",
    model: "minimax-m2",
    inputCostPer1M: 0.255,
    outputCostPer1M: 1.00,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  "glm-5": {
    key: "glm-5",
    label: "High (GLM 5)",
    tier: "high",
    shortLabel: "GLM 5",
    description: "Stronger GLM agentic model below Sonnet-class pricing.",
    provider: "openrouter",
    routerModel: "z-ai/glm-5",
    model: "glm-5",
    inputCostPer1M: 0.60,
    outputCostPer1M: 1.92,
    maxOutputTokens: 4096,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  ultra: {
    key: "ultra",
    label: "Ultra (Gemini 3.1 Pro)",
    tier: "ultra",
    shortLabel: "Gemini 3.1 Pro",
    description: "Highest-quality Gemini option for demanding pulses.",
    provider: "openrouter",
    routerModel: "google/gemini-3.1-pro-preview",
    model: "gemini-3.1-pro-preview",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00,
    maxOutputTokens: 4096,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  sonnet: {
    key: "sonnet",
    label: "Sonnet (Claude Sonnet 4.6)",
    tier: "ultra",
    shortLabel: "Claude Sonnet 4.6",
    description: "Premium Sonnet-class option for highest quality.",
    provider: "openrouter",
    routerModel: "anthropic/claude-sonnet-4.6",
    model: "claude-sonnet-4-6-20260320",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00,
    maxOutputTokens: 2048,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
  "glm-5-1": {
    key: "glm-5-1",
    label: "Ultra (GLM 5.1)",
    tier: "ultra",
    shortLabel: "GLM 5.1",
    description: "Sonnet-class GLM option for long-horizon agentic work.",
    badge: "new",
    provider: "openrouter",
    routerModel: "z-ai/glm-5.1",
    model: "glm-5.1",
    inputCostPer1M: 1.05,
    outputCostPer1M: 3.50,
    maxOutputTokens: 4096,
    temperature: 0.3,
    pricingLastVerifiedAt: "2026-05-07",
  },
};

export const MODEL_PRESET_KEYS = Object.keys(MODEL_PRESETS);

export const DEFAULT_MODEL_PRESET = "medium";

export function getModelPreset(key?: string | null): ModelPreset {
  if (key && MODEL_PRESETS[key]) return MODEL_PRESETS[key];
  return MODEL_PRESETS[DEFAULT_MODEL_PRESET];
}

export function listModelPresetOptions(): ModelPresetOption[] {
  return Object.values(MODEL_PRESETS).map((preset) => ({
    key: preset.key,
    label: preset.label,
    shortLabel: preset.shortLabel,
    description: preset.description,
    badge: preset.badge,
    provider: preset.provider,
    tier: preset.tier,
    inputCostPer1M: preset.inputCostPer1M,
    outputCostPer1M: preset.outputCostPer1M,
    pricingLastVerifiedAt: preset.pricingLastVerifiedAt,
  }));
}

export function getModelPresetTiers(): ModelPresetTierGroup[] {
  const options = listModelPresetOptions();
  return MODEL_PRESET_TIER_ORDER.map((tier) => ({
    key: tier,
    label: MODEL_PRESET_TIER_LABELS[tier],
    presets: options.filter((preset) => preset.tier === tier),
  }));
}
