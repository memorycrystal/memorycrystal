import { v } from "convex/values";
import { internalQuery, mutation, query, QueryCtx, MutationCtx } from "../_generated/server";
import { stableUserId } from "./auth";
import { resolveOpenRouterAdminOverride } from "./adminSettings/resolvers";
import { canPerformWriteActions, normalizeRoles } from "./permissions";

const OPENROUTER_PROVIDER = "openrouter" as const;

export function validateOpenRouterApiKey(apiKey: string) {
  const trimmed = apiKey.trim();
  if (!trimmed || !trimmed.startsWith("sk-or-")) {
    throw new Error("Invalid OpenRouter API key. Keys must start with 'sk-or-'.");
  }
  return trimmed;
}

function keyPrefix(apiKey: string) {
  return `${apiKey.slice(0, 8)}...`;
}

function keyLast4(apiKey: string) {
  return apiKey.slice(-4);
}

async function getProviderSetting(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  userId: string,
  provider: typeof OPENROUTER_PROVIDER,
) {
  return ctx.db
    .query("userProviderSettings")
    .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("provider", provider))
    .first();
}

async function getLegacyOpenRouterKey(ctx: Pick<QueryCtx | MutationCtx, "db">, userId: string) {
  const tickState = await ctx.db
    .query("organicTickState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return tickState?.openrouterApiKey
    ? { apiKey: tickState.openrouterApiKey, tickStateId: tickState._id }
    : null;
}

async function clearLegacyOpenRouterKey(ctx: Pick<MutationCtx, "db">, userId: string) {
  const legacy = await getLegacyOpenRouterKey(ctx, userId);
  if (!legacy) return;
  await ctx.db.patch(legacy.tickStateId, {
    openrouterApiKey: undefined,
    updatedAt: Date.now(),
  });
}

export async function getOpenRouterKeyStatusForUser(ctx: Pick<QueryCtx | MutationCtx, "db">, userId: string) {
  const setting = await getProviderSetting(ctx, userId, OPENROUTER_PROVIDER);
  if (setting) {
    return {
      hasKey: true,
      hasPersonalKey: true,
      keyPrefix: setting.keyPrefix,
      keyLast4: setting.keyLast4 ?? keyLast4(setting.apiKey),
      source: "personal" as const,
    };
  }

  const legacy = await getLegacyOpenRouterKey(ctx, userId);
  if (legacy) {
    return {
      hasKey: true,
      hasPersonalKey: true,
      keyPrefix: keyPrefix(legacy.apiKey),
      keyLast4: keyLast4(legacy.apiKey),
      source: "personal" as const,
    };
  }

  const adminKey = (await resolveOpenRouterAdminOverride(ctx)) ?? process.env.OPENROUTER_API_KEY;
  if (adminKey) {
    return {
      hasKey: true,
      hasPersonalKey: false,
      keyPrefix: null,
      keyLast4: null,
      source: "shared" as const,
    };
  }

  return {
    hasKey: false,
    hasPersonalKey: false,
    keyPrefix: null,
    keyLast4: null,
    source: null,
  };
}

export async function setOpenRouterApiKeyForUser(ctx: Pick<MutationCtx, "db">, userId: string, rawApiKey: string) {
  const apiKey = validateOpenRouterApiKey(rawApiKey);
  const now = Date.now();
  const prefix = keyPrefix(apiKey);
  const last4 = keyLast4(apiKey);

  const existing = await getProviderSetting(ctx, userId, OPENROUTER_PROVIDER);
  if (existing) {
    await ctx.db.patch(existing._id, {
      apiKey,
      keyPrefix: prefix,
      keyLast4: last4,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("userProviderSettings", {
      userId,
      provider: OPENROUTER_PROVIDER,
      apiKey,
      keyPrefix: prefix,
      keyLast4: last4,
      createdAt: now,
      updatedAt: now,
    });
  }

  await clearLegacyOpenRouterKey(ctx, userId);

  return { success: true, keyPrefix: prefix, keyLast4: last4, source: "personal" as const };
}

export async function removeOpenRouterApiKeyForUser(ctx: Pick<MutationCtx, "db">, userId: string) {
  const existing = await getProviderSetting(ctx, userId, OPENROUTER_PROVIDER);
  if (existing) {
    await ctx.db.delete(existing._id);
  }
  await clearLegacyOpenRouterKey(ctx, userId);

  return { success: true };
}

export const getMyOpenRouterKeyStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);

    return getOpenRouterKeyStatusForUser(ctx, userId);
  },
});

export const getOpenRouterKeyStatusForUserAdmin = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const viewerId = stableUserId(identity.subject);
    const profiles = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", viewerId))
      .collect();
    const latestProfile = profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (!canPerformWriteActions(normalizeRoles((latestProfile as any)?.roles))) {
      throw new Error("Forbidden: provider diagnostics require manager or admin role");
    }
    const status = await getOpenRouterKeyStatusForUser(ctx, args.userId);
    return {
      userId: args.userId,
      hasPersonalKey: status.hasPersonalKey,
      keyPrefix: status.hasPersonalKey ? status.keyPrefix : null,
      keyLast4: status.hasPersonalKey ? status.keyLast4 : null,
      source: status.source,
    };
  },
});

export const setMyOpenRouterApiKey = mutation({
  args: { apiKey: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    return setOpenRouterApiKeyForUser(ctx, userId, args.apiKey);
  },
});

export const removeMyOpenRouterApiKey = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    return removeOpenRouterApiKeyForUser(ctx, userId);
  },
});

export const resolveOpenRouterKeyForUser = internalQuery({
  args: {
    userId: v.string(),
    includeShared: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const setting = await getProviderSetting(ctx, args.userId, OPENROUTER_PROVIDER);
    if (setting) {
      return {
        apiKey: setting.apiKey,
        keyPrefix: setting.keyPrefix,
        keyLast4: setting.keyLast4 ?? keyLast4(setting.apiKey),
        source: "personal" as const,
      };
    }

    const legacy = await getLegacyOpenRouterKey(ctx, args.userId);
    if (legacy) {
      return {
        apiKey: legacy.apiKey,
        keyPrefix: keyPrefix(legacy.apiKey),
        keyLast4: keyLast4(legacy.apiKey),
        source: "personal" as const,
      };
    }

    const adminOverride = args.includeShared
      ? await resolveOpenRouterAdminOverride(ctx)
      : null;
    if (adminOverride) {
      return {
        apiKey: adminOverride,
        keyPrefix: null,
        keyLast4: null,
        source: "shared" as const,
      };
    }

    if (args.includeShared && process.env.OPENROUTER_API_KEY) {
      return {
        apiKey: process.env.OPENROUTER_API_KEY,
        keyPrefix: null,
        keyLast4: null,
        source: "shared" as const,
      };
    }

    return {
      apiKey: null,
      keyPrefix: null,
      keyLast4: null,
      source: null,
    };
  },
});
