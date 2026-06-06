import { internalQuery } from "../../_generated/server";
import { v } from "convex/values";
import type { UserTier } from "../../../shared/tierLimits";

// Monthly Organic tick budget per tier, calibrated to ~20% of plan price.
// Ultra: $79/mo * 20% = $15.80/mo budget. With Phase-2 disabled + Phase-1 capped,
// worst-case cost/tick is bounded; start at ~60 ticks/mo (≈2/day at the 12h floor) and
// TUNE once per-tick vector-search telemetry (phase1VectorSearches) is observed in prod.
export const ORGANIC_MONTHLY_TICK_BUDGET: Record<UserTier, number | null> = {
  free: 0,
  starter: 0,
  pro: 0,
  ultra: 60,
  unlimited: null, // unlimited
};

export function getOrganicMonthlyTickBudget(tier: UserTier): number | null {
  // NOTE: must NOT use `?? 0` — that would turn `unlimited`'s `null` ("no cap")
  // into `0` and silently block unlimited-tier users. Only an unknown tier → 0.
  const budget = ORGANIC_MONTHLY_TICK_BUDGET[tier];
  return budget === undefined ? 0 : budget;
}

/** First millisecond (UTC) of the calendar month containing `now`. */
function startOfUtcMonthMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

// Internal query: how many organic ticks has this user run this UTC month, and is another allowed?
export const checkOrganicMonthlyBudget = internalQuery({
  args: { userId: v.string(), tier: v.string() },
  handler: async (ctx, args) => {
    const cap = getOrganicMonthlyTickBudget(args.tier as UserTier);
    if (cap === null) return { allowed: true, used: 0, cap: null };
    const monthStart = startOfUtcMonthMs(Date.now());
    const runs = await ctx.db
      .query("organicTickRuns")
      .withIndex("by_user_started", (q) =>
        q.eq("userId", args.userId).gte("startedAt", monthStart)
      )
      .collect();
    const used = runs.length;
    return { allowed: used < cap, used, cap };
  },
});
