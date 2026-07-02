import { v } from "convex/values";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { stableUserId } from "./auth";
import { getOpenRouterKeyStatusForUser } from "./providerSettings";

export const DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP = 25;
export const MIN_GRAPH_ENRICHMENT_HOURLY_CAP = 1;
export const MAX_GRAPH_ENRICHMENT_HOURLY_CAP = 250;

function clampCap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP;
  return Math.max(
    MIN_GRAPH_ENRICHMENT_HOURLY_CAP,
    Math.min(MAX_GRAPH_ENRICHMENT_HOURLY_CAP, Math.trunc(value)),
  );
}

async function getSettingsRow(ctx: Pick<QueryCtx | MutationCtx, "db">, userId: string) {
  return ctx.db
    .query("crystalGraphEnrichmentSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

async function resolveEffectiveCap(ctx: Pick<QueryCtx | MutationCtx, "db">, userId: string) {
  const row = await getSettingsRow(ctx, userId);
  const requestedCap = clampCap(row?.hourlySuccessCap ?? DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP);
  const keyStatus = await getOpenRouterKeyStatusForUser(ctx, userId);
  const hasPersonalOpenRouterKey = keyStatus.hasPersonalKey;
  const effectiveCap = hasPersonalOpenRouterKey
    ? requestedCap
    : Math.min(requestedCap, DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP);

  return {
    userId,
    hourlySuccessCap: requestedCap,
    effectiveHourlySuccessCap: effectiveCap,
    defaultHourlySuccessCap: DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP,
    minHourlySuccessCap: MIN_GRAPH_ENRICHMENT_HOURLY_CAP,
    maxHourlySuccessCap: MAX_GRAPH_ENRICHMENT_HOURLY_CAP,
    hasPersonalOpenRouterKey,
    requiresPersonalOpenRouterKey: requestedCap > DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP && !hasPersonalOpenRouterKey,
    updatedAt: row?.updatedAt ?? null,
  };
}

export const getMyGraphEnrichmentSettings = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    return resolveEffectiveCap(ctx, userId);
  },
});

export const setMyGraphEnrichmentHourlyCap = mutation({
  args: { hourlySuccessCap: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    return setGraphEnrichmentHourlyCapForUser(ctx, userId, args.hourlySuccessCap);
  },
});

export async function setGraphEnrichmentHourlyCapForUser(
  ctx: Pick<MutationCtx, "db">,
  userId: string,
  hourlySuccessCap: number,
) {
  const requestedCap = clampCap(hourlySuccessCap);
  const keyStatus = await getOpenRouterKeyStatusForUser(ctx, userId);
  if (requestedCap > DEFAULT_GRAPH_ENRICHMENT_HOURLY_CAP && !keyStatus.hasPersonalKey) {
    throw new Error("Increasing graph enrichment above 25 per hour requires a personal OpenRouter key.");
  }

  const now = Date.now();
  const existing = await getSettingsRow(ctx, userId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      hourlySuccessCap: requestedCap,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("crystalGraphEnrichmentSettings", {
      userId,
      hourlySuccessCap: requestedCap,
      createdAt: now,
      updatedAt: now,
    });
  }

  return resolveEffectiveCap(ctx, userId);
}

export const resolveGraphEnrichmentHourlyCapForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => resolveEffectiveCap(ctx, args.userId),
});
