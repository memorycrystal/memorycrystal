export type UserTier = "free" | "starter" | "pro" | "ultra" | "unlimited";

export const TIER_ORDER: UserTier[] = ["free", "starter", "pro", "ultra", "unlimited"];

export type GeminiTierConfig = {
  /** Whether the platform provides managed Gemini API access for this tier. */
  managedGemini: boolean;
  /** Platform-enforced daily Gemini call cap (null = unlimited). Only applies when managedGemini=true. */
  dailyCallCap: number | null;
  /** Whether the user can supply their own Gemini API key (BYOK). */
  allowByok: boolean;
  /** Whether the user can set a custom daily cap (Ultra only). */
  allowCustomCap: boolean;
};

export type TierLimits = {
  memories: number | null;
  stmMessages: number | null;
  channels: number | null;
  stmTtlDays: number | null;
  sensoryRawTtlDays: number | null;
  gemini: GeminiTierConfig;
};

export type CheckpointTierLimits = {
  retainedCheckpoints: number;
  memorySnapshotEntries: number;
};

export const TIER_LIMITS: Record<UserTier, TierLimits> = {
  free: {
    memories: 500, stmMessages: 500, channels: 3, stmTtlDays: 7, sensoryRawTtlDays: 7,
    gemini: { managedGemini: false, dailyCallCap: null, allowByok: false, allowCustomCap: false },
  },
  starter: {
    memories: 25_000, stmMessages: 25_000, channels: null, stmTtlDays: 30, sensoryRawTtlDays: 14, // legacy alias for pro
    gemini: { managedGemini: true, dailyCallCap: 500, allowByok: false, allowCustomCap: false },
  },
  pro: {
    memories: 25_000, stmMessages: 25_000, channels: null, stmTtlDays: 30, sensoryRawTtlDays: 14,
    gemini: { managedGemini: true, dailyCallCap: 500, allowByok: false, allowCustomCap: false },
  },
  ultra: {
    memories: null, stmMessages: null, channels: null, stmTtlDays: 90, sensoryRawTtlDays: 30,
    gemini: { managedGemini: true, dailyCallCap: null, allowByok: true, allowCustomCap: true },
  },
  unlimited: {
    memories: null, stmMessages: null, channels: null, stmTtlDays: 365, sensoryRawTtlDays: 30,
    gemini: { managedGemini: true, dailyCallCap: null, allowByok: true, allowCustomCap: true },
  },
};

export const CHECKPOINT_LIMITS: Record<UserTier, CheckpointTierLimits> = {
  free: { retainedCheckpoints: 1, memorySnapshotEntries: 50 },
  starter: { retainedCheckpoints: 5, memorySnapshotEntries: 200 },
  pro: { retainedCheckpoints: 5, memorySnapshotEntries: 200 },
  ultra: { retainedCheckpoints: 10, memorySnapshotEntries: 500 },
  unlimited: { retainedCheckpoints: 20, memorySnapshotEntries: 1000 },
};

export const formatLimit = (value: number | null): string =>
  value === null ? "Unlimited" : value.toLocaleString();

export const formatTtlDays = (days: number | null): string => {
  if (days === null) return "Unlimited";
  if (days === 365) return "1 year";
  return `${days} days`;
};
