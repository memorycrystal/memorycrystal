export type UserTier = "free" | "starter" | "pro" | "ultra" | "unlimited";

export const TIER_ORDER: UserTier[] = ["free", "starter", "pro", "ultra", "unlimited"];

/** Verbatim Window (ILL-182 / ADR 0008): how long raw messages stay readable. */
export const TIER_STM_TTL_DAYS: Record<UserTier, number> = {
  free: 1,
  starter: 3,
  pro: 3,
  ultra: 7,
  unlimited: 14,
};

/** Pre-ILL-182 windows. Reverse migration restores these stamps. */
export const PRIOR_STM_TTL_DAYS: Record<UserTier, number> = {
  free: 7,
  starter: 30,
  pro: 30,
  ultra: 90,
  unlimited: 365,
};

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
  /** Non-KB Memory Allowance. Always a real number — a null is a hard error. */
  memories: number;
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
    memories: 1_000, stmMessages: 500, channels: 3, stmTtlDays: TIER_STM_TTL_DAYS.free, sensoryRawTtlDays: 7,
    gemini: { managedGemini: false, dailyCallCap: null, allowByok: false, allowCustomCap: false },
  },
  starter: {
    memories: 10_000, stmMessages: 25_000, channels: null, stmTtlDays: TIER_STM_TTL_DAYS.starter, sensoryRawTtlDays: 14, // legacy alias for pro
    gemini: { managedGemini: true, dailyCallCap: 500, allowByok: false, allowCustomCap: false },
  },
  pro: {
    memories: 10_000, stmMessages: 25_000, channels: null, stmTtlDays: TIER_STM_TTL_DAYS.pro, sensoryRawTtlDays: 14,
    gemini: { managedGemini: true, dailyCallCap: 500, allowByok: false, allowCustomCap: false },
  },
  ultra: {
    memories: 50_000, stmMessages: null, channels: null, stmTtlDays: TIER_STM_TTL_DAYS.ultra, sensoryRawTtlDays: 30,
    gemini: { managedGemini: true, dailyCallCap: null, allowByok: true, allowCustomCap: true },
  },
  unlimited: {
    memories: 50_000, stmMessages: null, channels: null, stmTtlDays: TIER_STM_TTL_DAYS.unlimited, sensoryRawTtlDays: 30,
    gemini: { managedGemini: true, dailyCallCap: null, allowByok: true, allowCustomCap: true },
  },
};

/**
 * ILL-183 — Memory Allowance for Forgetting. Every tier has a real number;
 * a null or unknown tier is a hard error, not a silent skip / UNLIMITED_CAP.
 */
export function getMemoryAllowance(tier: string): number {
  if (!TIER_ORDER.includes(tier as UserTier)) {
    throw new Error(`Memory Allowance is unset for unknown tier "${tier}"`);
  }
  const memories = TIER_LIMITS[tier as UserTier].memories;
  if (memories == null || !Number.isFinite(memories) || memories <= 0) {
    throw new Error(`Memory Allowance is unset for tier "${tier}"`);
  }
  return memories;
}

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
  if (days === 1) return "24 hours";
  if (days === 365) return "1 year";
  return `${days} days`;
};
