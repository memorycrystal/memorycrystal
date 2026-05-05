import { v } from "convex/values";
import { internalQuery, mutation, query, QueryCtx, MutationCtx } from "../_generated/server";
import { stableUserId } from "./auth";
import { resolveOpenRouterAdminOverride } from "./adminSettings/resolvers";

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
      source: "personal" as const,
    };
  }

  const legacy = await getLegacyOpenRouterKey(ctx, userId);
  if (legacy) {
    return {
      hasKey: true,
      hasPersonalKey: true,
      keyPrefix: keyPrefix(legacy.apiKey),
      source: "personal" as const,
    };
  }

  const adminKey = (await resolveOpenRouterAdminOverride(ctx)) ?? process.env.OPENROUTER_API_KEY;
  if (adminKey) {
    return {
      hasKey: true,
      hasPersonalKey: false,
      keyPrefix: null,
      source: "shared" as const,
    };
  }

  return {
    hasKey: false,
    hasPersonalKey: false,
    keyPrefix: null,
    source: null,
  };
}

export async function setOpenRouterApiKeyForUser(ctx: Pick<MutationCtx, "db">, userId: string, rawApiKey: string) {
  const apiKey = validateOpenRouterApiKey(rawApiKey);
  const now = Date.now();
  const prefix = keyPrefix(apiKey);

  const existing = await getProviderSetting(ctx, userId, OPENROUTER_PROVIDER);
  if (existing) {
    await ctx.db.patch(existing._id, {
      apiKey,
      keyPrefix: prefix,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("userProviderSettings", {
      userId,
      provider: OPENROUTER_PROVIDER,
      apiKey,
      keyPrefix: prefix,
      createdAt: now,
      updatedAt: now,
    });
  }

  await clearLegacyOpenRouterKey(ctx, userId);

  return { success: true, keyPrefix: prefix, source: "personal" as const };
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
        source: "personal" as const,
      };
    }

    const legacy = await getLegacyOpenRouterKey(ctx, args.userId);
    if (legacy) {
      return {
        apiKey: legacy.apiKey,
        keyPrefix: keyPrefix(legacy.apiKey),
        source: "personal" as const,
      };
    }

    if (args.includeShared && process.env.OPENROUTER_API_KEY) {
      return {
        apiKey: process.env.OPENROUTER_API_KEY,
        keyPrefix: null,
        source: "shared" as const,
      };
    }

    return {
      apiKey: null,
      keyPrefix: null,
      source: null,
    };
  },
});
