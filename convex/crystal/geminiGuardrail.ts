/**
 * Tier-aware Gemini API daily call guardrail.
 *
 * Tracks total Gemini API calls per user per UTC day and enforces tier-based caps.
 *
 * Tier behaviour:
 *   Free     — no managed Gemini; all calls denied unless BYOK (future)
 *   Pro      — managed cap from TIER_LIMITS (default 500/day)
 *   Ultra    — managed + BYOK; user may set a custom daily cap
 *   Unlimited — unlimited managed access
 *
 * Legacy fallback:
 *   GEMINI_DAILY_CALL_CAP env var still works as a global override (lowest wins).
 *
 * Usage from actions:
 *   const result = await ctx.runMutation(internal.crystal.geminiGuardrail.incrementAndCheck, {
 *     userId: "...", calls: 1,
 *   });
 *   if (!result.allowed) { // skip work }
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { TIER_LIMITS, type UserTier } from "../../shared/tierLimits";

const GLOBAL_BUCKET = "_global";

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function normalizeUserId(raw: unknown): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : GLOBAL_BUCKET;
}

function getGlobalCap(): number | null {
  const raw = process.env.GEMINI_DAILY_CALL_CAP;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the effective daily cap for a given tier.
 * Returns null (unlimited) only for Ultra/Unlimited tiers when no global override is set.
 */
function effectiveCap(tier: UserTier, userCustomCap?: number | null): number | null {
  const globalCap = getGlobalCap();
  const tierConfig = TIER_LIMITS[tier]?.gemini;

  if (!tierConfig?.managedGemini) {
    // Free tier — deny all managed calls (cap = 0)
    return 0;
  }

  const tierCap = tierConfig.dailyCallCap;

  // Ultra/Unlimited users may set a custom cap
  const customCap = tierConfig.allowCustomCap && userCustomCap != null && userCustomCap > 0
    ? userCustomCap
    : null;

  // Take the most restrictive non-null cap
  const caps = [globalCap, tierCap, customCap].filter((c): c is number => c !== null);
  return caps.length > 0 ? Math.min(...caps) : null;
}

/**
 * Atomically increment the daily call counter and check against the tier-aware cap.
 * Returns { allowed, callCount, cap }.
 */
export const incrementAndCheck = internalMutation({
  args: {
    userId: v.optional(v.string()),
    calls: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ allowed: boolean; callCount: number; cap: number | null }> => {
    const increment = Math.max(args.calls ?? 1, 1);
    const dateKey = todayUTC();

    const bucketUserId = normalizeUserId(args.userId);
    const hasRealUser = bucketUserId !== GLOBAL_BUCKET;

    let cap = getGlobalCap();
    if (hasRealUser) {
      const tier = await ctx.runQuery(internal.crystal.userProfiles.getUserTier, { userId: bucketUserId }) as UserTier;
      // Check for user-set custom Gemini cap (stored in organicTickState)
      const tickState = await ctx.db
        .query("organicTickState")
        .withIndex("by_user", (q) => q.eq("userId", bucketUserId))
        .first();
      const userCustomCap = (tickState as any)?.geminiDailyCap ?? null;
      cap = effectiveCap(tier, userCustomCap);
    }

    // Denied immediately if cap is zero (Free tier)
    if (cap === 0) {
      return { allowed: false, callCount: 0, cap };
    }

    const existing = await ctx.db
      .query("crystalGeminiDailyUsage")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", bucketUserId).eq("dateKey", dateKey)
      )
      .first();

    const currentCount = existing?.callCount ?? 0;

    if (cap !== null && currentCount >= cap) {
      return { allowed: false, callCount: currentCount, cap };
    }

    const newCount = currentCount + increment;

    if (existing) {
      await ctx.db.patch(existing._id, { callCount: newCount, lastUpdatedAt: Date.now() });
    } else {
      await ctx.db.insert("crystalGeminiDailyUsage", {
        userId: bucketUserId,
        dateKey,
        callCount: newCount,
        lastUpdatedAt: Date.now(),
      });
    }

    return { allowed: true, callCount: newCount, cap };
  },
});

/**
 * Read-only check of the current daily usage (for dashboards / diagnostics).
 */
export const getDailyUsage = internalQuery({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ dateKey: string; callCount: number; cap: number | null; tier: UserTier }> => {
    const dateKey = todayUTC();

    let tier: UserTier = "free";
    let cap = getGlobalCap();
    const bucketUserId = normalizeUserId(args.userId);
    const hasRealUser = bucketUserId !== GLOBAL_BUCKET;
    if (hasRealUser) {
      tier = await ctx.runQuery(internal.crystal.userProfiles.getUserTier, { userId: bucketUserId }) as UserTier;
      const tickState = await ctx.db
        .query("organicTickState")
        .withIndex("by_user", (q) => q.eq("userId", bucketUserId))
        .first();
      const userCustomCap = (tickState as any)?.geminiDailyCap ?? null;
      cap = effectiveCap(tier, userCustomCap);
    }

    const existing = await ctx.db
      .query("crystalGeminiDailyUsage")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", bucketUserId).eq("dateKey", dateKey)
      )
      .first();

    return { dateKey, callCount: existing?.callCount ?? 0, cap, tier };
  },
});
