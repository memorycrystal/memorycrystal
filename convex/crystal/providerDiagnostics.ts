import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { OPENROUTER_EMBEDDINGS_ENDPOINT, OPENROUTER_GEMINI_EMBEDDING_MODEL } from "./embeddings";
import { requestOpenRouter } from "./providerGateway";

function redactError(payload: any): string | null {
  const message = payload?.error?.message;
  return typeof message === "string" ? message.slice(0, 240) : null;
}

export const inspectUnembeddedMessageKeyCoverage: any = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async () => {
    // Raw-message embeddings were retired in v0.9.0. Preserve the internal
    // diagnostic contract for old runbooks without scanning message content.
    return { inspected: 0, users: [], retired: true };
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
