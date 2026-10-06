import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";

export function maxActiveApiKeys(): number {
  const raw = process.env.MC_MAX_ACTIVE_API_KEYS;
  const value = raw?.trim() ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : 150;
}

/** Same transaction as mint/reactivation: the index range is in the OCC read set. */
export async function hasActiveApiKeySlot(ctx: Pick<MutationCtx, "db">, userId: string, overlap = 0, additionalKeys = 1): Promise<boolean> {
  if (additionalKeys === 0) return true;
  const limit = maxActiveApiKeys() + overlap;
  const active = await ctx.db.query("crystalApiKeys")
    .withIndex("by_user_active", q => q.eq("userId", userId).eq("active", true))
    .take(limit);
  return active.length + additionalKeys <= limit;
}

export async function assertActiveApiKeySlot(ctx: Pick<MutationCtx, "db">, userId: string, overlap = 0, additionalKeys = 1): Promise<void> {
  if (!await hasActiveApiKeySlot(ctx, userId, overlap, additionalKeys)) throw new ConvexError({ code: "api_key_limit" });
}
