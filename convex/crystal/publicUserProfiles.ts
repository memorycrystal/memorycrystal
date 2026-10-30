import type { UserTier } from "../../shared/tierLimits";
export function deriveTier(_profile: unknown): UserTier {
  return "pro";
}

export async function resolveUserTierFromDb(_db: unknown, _userId: string): Promise<UserTier> {
  return "pro";
}
