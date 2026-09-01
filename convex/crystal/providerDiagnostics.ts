import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { OPENROUTER_EMBEDDINGS_ENDPOINT, OPENROUTER_GEMINI_EMBEDDING_MODEL } from "./embeddings";
import { requestOpenRouter } from "./providerGateway";

function redactError(payload: any): string | null {
  const message = payload?.error?.message;
  return typeof message === "string" ? message.slice(0, 240) : null;
}

async function getProviderSetting(ctx: any, userId: string) {
  return await ctx.db
    .query("userProviderSettings")
    .withIndex("by_user_provider", (q: any) => q.eq("userId", userId).eq("provider", "openrouter"))
    .first();
}

async function getLegacyOpenRouterKeyPrefix(ctx: any, userId: string) {
  const tickState = await ctx.db
    .query("organicTickState")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .first();
  const key = tickState?.openrouterApiKey;
  return typeof key === "string" && key ? `${key.slice(0, 8)}...` : null;
}

export const inspectUnembeddedMessageKeyCoverage: any = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 1000, 1), 1000);
    const messages = await ctx.db
      .query("crystalMessages")
      .withIndex("by_embedded", (q: any) => q.eq("embedded", false))
      .take(limit);

    const byUser = new Map<string, { count: number; latestTimestamp: number; oldestTimestamp: number }>();
    for (const message of messages as any[]) {
      const existing = byUser.get(message.userId) ?? {
        count: 0,
        latestTimestamp: Number.NEGATIVE_INFINITY,
        oldestTimestamp: Number.POSITIVE_INFINITY,
      };
      existing.count += 1;
      existing.latestTimestamp = Math.max(existing.latestTimestamp, message.timestamp ?? 0);
      existing.oldestTimestamp = Math.min(existing.oldestTimestamp, message.timestamp ?? 0);
      byUser.set(message.userId, existing);
    }

    const users = [];
    for (const [userId, stats] of byUser.entries()) {
      const setting = await getProviderSetting(ctx, userId);
      const legacyKeyPrefix = setting ? null : await getLegacyOpenRouterKeyPrefix(ctx, userId);
      users.push({
        userId,
        unembeddedCount: stats.count,
        oldestTimestamp: stats.oldestTimestamp,
        latestTimestamp: stats.latestTimestamp,
        providerKeySource: setting ? "userProviderSettings" : legacyKeyPrefix ? "organicTickState" : null,
        keyPrefix: setting?.keyPrefix ?? legacyKeyPrefix,
        providerSettingUpdatedAt: setting?.updatedAt ?? null,
      });
    }

    users.sort((a, b) => b.unembeddedCount - a.unembeddedCount);
    return { inspected: messages.length, users };
  },
});

export const probeOpenRouterEmbeddingForUser: any = internalAction({
  args: {
    userId: v.string(),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const credential: any = await ctx.runQuery(internal.crystal.providerSettings.resolveOpenRouterKeyForUser, {
      userId: args.userId,
      includeShared: false,
    });
    if (!credential?.apiKey) {
      return {
        userId: args.userId,
        source: credential?.source ?? null,
        keyPrefix: credential?.keyPrefix ?? null,
        probes: [],
        error: "missing_openrouter_key",
      };
    }

    const input = args.text?.trim() || "Memory Crystal embedding diagnostic.";
    const baseBody = {
      model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
      input,
      encoding_format: "float",
    };
    const variants = [
      { name: "default", body: baseBody },
      {
        name: "order_google_ai_studio",
        body: {
          ...baseBody,
          provider: { order: ["google-ai-studio"], allow_fallbacks: true },
        },
      },
      {
        name: "only_google_ai_studio",
        body: {
          ...baseBody,
          provider: { only: ["google-ai-studio"], allow_fallbacks: false },
        },
      },
      {
        name: "allow_data_collection",
        body: {
          ...baseBody,
          provider: { data_collection: "allow", allow_fallbacks: true },
        },
      },
      {
        name: "google_ai_studio_allow_data_collection",
        body: {
          ...baseBody,
          provider: { only: ["google-ai-studio"], allow_fallbacks: false, data_collection: "allow" },
        },
      },
    ];

    const probes = [];
    for (const variant of variants) {
      // ILL-184: probes pass through the single choke point so no direct fetch
      // path exists, but opt out of outcome recording: these probes
      // intentionally induce failures (provider-restricted variants) that
      // must not fire user alert emails.
      const result = await requestOpenRouter(ctx, {
        userId: args.userId,
        apiKey: credential.apiKey,
        keyLast4: credential.keyLast4 ?? null,
        endpoint: OPENROUTER_EMBEDDINGS_ENDPOINT,
        source: "providerDiagnostics.probeOpenRouterEmbeddingForUser",
        body: variant.body,
        headers: {
          "HTTP-Referer": process.env.SITE_URL ?? "https://memorycrystal.ai",
          "X-OpenRouter-Title": "Memory Crystal",
        },
        recordOutcome: false,
      });
      const payload = result.ok ? (result.payload as any) : null;
      probes.push({
        name: variant.name,
        status: result.status,
        ok: result.ok,
        error: result.ok ? null : redactError(payload ?? { error: { message: result.errorMessage } }),
        vectorLength: Array.isArray(payload?.data?.[0]?.embedding) ? payload.data[0].embedding.length : null,
      });
    }

    return {
      userId: args.userId,
      source: credential.source,
      keyPrefix: credential.keyPrefix,
      probes,
    };
  },
});
