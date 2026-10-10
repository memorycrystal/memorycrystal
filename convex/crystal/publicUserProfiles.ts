import type { UserTier } from "../../shared/tierLimits";
export function deriveTier(_profile: unknown): UserTier {
  return "pro";
}
