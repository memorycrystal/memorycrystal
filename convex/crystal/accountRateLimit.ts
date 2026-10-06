import { ConvexError } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

/** JWT public entrypoints only. Internal/cron actions do not call this guard. */
export async function enforceAccountRateLimit(ctx: ActionCtx, userId: string): Promise<void> {
  const result = await ctx.runMutation(internal.crystal.mcp.checkKeyAndAccountRateLimit, { userId });
  if (!result.allowed) {
    throw new ConvexError({ code: "rate_limited", scope: "account", retryAfterSec: result.retryAfterSec });
  }
}
