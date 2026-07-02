import { TIER_LIMITS, type UserTier } from "../../shared/tierLimits";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveSensoryRawTtlDays(
  tier: UserTier,
  override?: number | null
): number {
  if (Number.isFinite(override) && (override ?? 0) > 0) {
    return Math.max(1, Math.floor(override as number));
  }
  return TIER_LIMITS[tier].sensoryRawTtlDays ?? 30;
}

export function rawContentExpiresAt(createdAt: number, ttlDays: number): number {
  return createdAt + ttlDays * DAY_MS;
}

export function isPaidOrganicTier(tier: UserTier): boolean {
  return tier === "starter" || tier === "pro" || tier === "ultra" || tier === "unlimited";
}

/** Organic features (pulse engine, ensembles, brain) are restricted to ultra/unlimited during cost containment. */
export function isOrganicEligibleTier(tier: UserTier): boolean {
  return tier === "ultra" || tier === "unlimited";
}
