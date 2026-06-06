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
 * _global bucket policy (M6 defence-in-depth):
 *   When userId is missing/falsy, production mode throws ConvexError({code:"missing_user_id_for_guardrail"})
 *   to prevent cross-tenant aggregation into the _global bucket.
 *   Development mode logs a warning and continues with _global attribution.
 *
 * Usage from actions:
 *   const result = await ctx.runMutation(internal.crystal.geminiGuardrail.incrementAndCheck, {
 *     userId: "...", calls: 1,
 *   });
 *   if (!result.allowed) { // skip work }
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { TIER_LIMITS, type UserTier } from "../../shared/tierLimits";

const GLOBAL_BUCKET = "_global";
type GeminiMethod = "generateContent" | "embedContent" | "batchEmbedContents";
type KeySource = "platform" | "user_byok" | "provider_export" | "manual" | "unknown";
type Payer = "company" | "user" | "unknown";

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function normalizeUserId(raw: unknown): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : GLOBAL_BUCKET;
}

/**
 * Guard against missing userId falling into the _global bucket.
 * In production: throws ConvexError to prevent cross-tenant leak.
 * In development: logs a warning and continues (allows local testing without userId).
 */
function assertUserIdPresent(raw: unknown, callerName: string): void {
  if (typeof raw === "string" && raw.trim()) return;
  if (process.env.NODE_ENV === "production") {
    throw new ConvexError({
      code: "missing_user_id_for_guardrail",
      caller: callerName,
      message: `userId is required for guardrail in production; got ${JSON.stringify(raw)}`,
    });
  }
  console.warn(
    `[geminiGuardrail] ${callerName}: missing userId — attributing to _global (dev only). This would throw in production.`,
  );
}

function getGlobalCap(): number | null {
  const raw = process.env.GEMINI_DAILY_CALL_CAP;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function methodPatch(method: GeminiMethod, calls: number, itemCount: number) {
  switch (method) {
    case "generateContent":
      return { generateContentCalls: calls };
    case "embedContent":
      return { embedContentCalls: calls };
    case "batchEmbedContents":
      return { batchEmbedContentsCalls: calls, batchEmbedContentItems: itemCount };
  }
}

function normalizeKeySource(value: KeySource | undefined): KeySource {
  return value ?? "unknown";
}

function normalizePayer(value: Payer | undefined): Payer {
  return value ?? "unknown";
}

async function upsertUsage(
  ctx: any,
  args: {
    userId?: string;
    method: GeminiMethod;
    calls: number;
    itemCount: number;
    estimatedInputChars: number;
    model?: string;
    source?: string;
    keySource?: KeySource;
    payer?: Payer;
  }
): Promise<number> {
  const dateKey = todayUTC();
  const bucketUserId = normalizeUserId(args.userId);
  const keySource = normalizeKeySource(args.keySource);
  const payer = normalizePayer(args.payer);
  const usageRows = await ctx.db
    .query("crystalGeminiDailyUsage")
    .withIndex("by_user_date", (q: any) =>
      q.eq("userId", bucketUserId).eq("dateKey", dateKey)
    )
    .collect();
  const existing = usageRows.find((row: any) =>
    normalizeKeySource(row.keySource) === keySource && normalizePayer(row.payer) === payer
  );
  const methodCounts = methodPatch(args.method, args.calls, args.itemCount);
  const newCount = (existing?.callCount ?? 0) + args.calls;

  if (existing) {
    await ctx.db.patch(existing._id, {
      callCount: newCount,
      generateContentCalls: (existing.generateContentCalls ?? 0) + (methodCounts.generateContentCalls ?? 0),
      embedContentCalls: (existing.embedContentCalls ?? 0) + (methodCounts.embedContentCalls ?? 0),
      batchEmbedContentsCalls: (existing.batchEmbedContentsCalls ?? 0) + (methodCounts.batchEmbedContentsCalls ?? 0),
      batchEmbedContentItems: (existing.batchEmbedContentItems ?? 0) + (methodCounts.batchEmbedContentItems ?? 0),
      estimatedInputChars: (existing.estimatedInputChars ?? 0) + args.estimatedInputChars,
      lastMethod: args.method,
      lastModel: args.model,
      lastSource: args.source,
      keySource,
      payer,
      lastUpdatedAt: Date.now(),
    });
  } else {
    await ctx.db.insert("crystalGeminiDailyUsage", {
      userId: bucketUserId,
      dateKey,
      callCount: newCount,
      generateContentCalls: methodCounts.generateContentCalls ?? 0,
      embedContentCalls: methodCounts.embedContentCalls ?? 0,
      batchEmbedContentsCalls: methodCounts.batchEmbedContentsCalls ?? 0,
      batchEmbedContentItems: methodCounts.batchEmbedContentItems ?? 0,
      estimatedInputChars: args.estimatedInputChars,
      lastMethod: args.method,
      lastModel: args.model,
      lastSource: args.source,
      keySource,
      payer,
      lastUpdatedAt: Date.now(),
    });
  }

  return usageRows
    .filter((row: any) => row._id !== existing?._id)
    .reduce((sum: number, row: any) => sum + (row.callCount ?? 0), newCount);
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
    method: v.optional(v.union(v.literal("generateContent"), v.literal("embedContent"), v.literal("batchEmbedContents"))),
    model: v.optional(v.string()),
    source: v.optional(v.string()),
    estimatedInputChars: v.optional(v.number()),
    itemCount: v.optional(v.number()),
    keySource: v.optional(v.union(v.literal("platform"), v.literal("user_byok"), v.literal("provider_export"), v.literal("manual"), v.literal("unknown"))),
    payer: v.optional(v.union(v.literal("company"), v.literal("user"), v.literal("unknown"))),
  },
  handler: async (ctx, args): Promise<{ allowed: boolean; callCount: number; cap: number | null }> => {
    assertUserIdPresent(args.userId, "incrementAndCheck");
    const increment = Math.max(args.calls ?? 1, 1);
    const method = args.method ?? "generateContent";
    const itemCount = Math.max(args.itemCount ?? increment, 0);
    const estimatedInputChars = Math.max(Math.trunc(args.estimatedInputChars ?? 0), 0);
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

    const existingRows = await ctx.db
      .query("crystalGeminiDailyUsage")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", bucketUserId).eq("dateKey", dateKey)
      )
      .collect();

    const currentCount = existingRows.reduce((sum, row) => sum + (row.callCount ?? 0), 0);

    if (cap !== null && currentCount >= cap) {
      return { allowed: false, callCount: currentCount, cap };
    }

    const newCount = await upsertUsage(ctx, {
      userId: args.userId,
      method,
      calls: increment,
      itemCount,
      estimatedInputChars,
      model: args.model,
      source: args.source,
      keySource: args.keySource,
      payer: args.payer,
    });

    return { allowed: true, callCount: newCount, cap };
  },
});

/**
 * Read-only check of the current daily usage (for dashboards / diagnostics).
 */
export const getDailyUsage = internalQuery({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{
    dateKey: string;
    callCount: number;
    generateContentCalls: number;
    embedContentCalls: number;
    batchEmbedContentsCalls: number;
    batchEmbedContentItems: number;
    estimatedInputChars: number;
    lastMethod?: GeminiMethod;
    lastModel?: string;
    lastSource?: string;
    keySource?: KeySource;
    payer?: Payer;
    cap: number | null;
    tier: UserTier;
  }> => {
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

    const existingRows = await ctx.db
      .query("crystalGeminiDailyUsage")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", bucketUserId).eq("dateKey", dateKey)
      )
      .collect();
    const latest = existingRows.reduce((current: any | null, row: any) =>
      !current || (row.lastUpdatedAt ?? 0) > (current.lastUpdatedAt ?? 0) ? row : current,
      null,
    );

    return {
      dateKey,
      callCount: existingRows.reduce((sum, row) => sum + (row.callCount ?? 0), 0),
      generateContentCalls: existingRows.reduce((sum, row) => sum + (row.generateContentCalls ?? 0), 0),
      embedContentCalls: existingRows.reduce((sum, row) => sum + (row.embedContentCalls ?? 0), 0),
      batchEmbedContentsCalls: existingRows.reduce((sum, row) => sum + (row.batchEmbedContentsCalls ?? 0), 0),
      batchEmbedContentItems: existingRows.reduce((sum, row) => sum + (row.batchEmbedContentItems ?? 0), 0),
      estimatedInputChars: existingRows.reduce((sum, row) => sum + (row.estimatedInputChars ?? 0), 0),
      lastMethod: latest?.lastMethod as GeminiMethod | undefined,
      lastModel: latest?.lastModel,
      lastSource: latest?.lastSource,
      keySource: existingRows.length === 1 ? existingRows[0].keySource as KeySource | undefined : "unknown",
      payer: existingRows.length === 1 ? existingRows[0].payer as Payer | undefined : "unknown",
      cap,
      tier,
    };
  },
});

export const recordUsage = internalMutation({
  args: {
    userId: v.optional(v.string()),
    method: v.union(v.literal("generateContent"), v.literal("embedContent"), v.literal("batchEmbedContents")),
    calls: v.optional(v.number()),
    itemCount: v.optional(v.number()),
    estimatedInputChars: v.optional(v.number()),
    model: v.optional(v.string()),
    source: v.optional(v.string()),
    keySource: v.optional(v.union(v.literal("platform"), v.literal("user_byok"), v.literal("provider_export"), v.literal("manual"), v.literal("unknown"))),
    payer: v.optional(v.union(v.literal("company"), v.literal("user"), v.literal("unknown"))),
  },
  handler: async (ctx, args): Promise<{ callCount: number }> => {
    assertUserIdPresent(args.userId, "recordUsage");
    const callCount = await upsertUsage(ctx, {
      userId: args.userId,
      method: args.method,
      calls: Math.max(args.calls ?? 1, 1),
      itemCount: Math.max(args.itemCount ?? args.calls ?? 1, 0),
      estimatedInputChars: Math.max(Math.trunc(args.estimatedInputChars ?? 0), 0),
      model: args.model,
      source: args.source,
      keySource: args.keySource,
      payer: args.payer,
    });
    return { callCount };
  },
});
