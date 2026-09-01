// MC_EMBEDDING_DAILY_TOKEN_CAP_PER_USER — operator-tunable per-user daily embedding input-char cap
// (chars ≈ tokens for English text at ~1:1; Gemini charges per input token).
// Default: 1_000_000 chars/day per user. Set to 0 to disable cap enforcement.
// Env var takes effect immediately on the next Convex deployment without code change.
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { requestOpenRouter, recordMissingOpenRouterKey } from "./providerGateway";

export const OPENROUTER_EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
export const OPENROUTER_GEMINI_EMBEDDING_MODEL = "google/gemini-embedding-2-preview";
export const REQUIRED_EMBEDDING_DIMENSIONS = 3072;

/** Default per-user daily embedding input-char cap (≈ tokens). Overridden by MC_EMBEDDING_DAILY_TOKEN_CAP_PER_USER. */
export const DEFAULT_EMBEDDING_DAILY_CHAR_CAP = 1_000_000;

// Site 7: resolve via admin-settings resolver. 0 means disabled (null = unlimited).
// ctx is typed as any because resolvers.ts uses ctx: any and callers vary in their Pick constraints.
async function getEmbeddingDailyCharCap(_ctx: any): Promise<number | null> {
  const raw = process.env.MC_EMBEDDING_DAILY_TOKEN_CAP_PER_USER;
  const n = raw === undefined ? DEFAULT_EMBEDDING_DAILY_CHAR_CAP : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type EmbeddingCtx = Pick<any, "runQuery" | "runMutation">;

type EmbeddingAccounting = {
  userId: string;
  source: string;
  openRouterCredential?: OpenRouterCredential;
};

export type OpenRouterCredential = {
  apiKey: string | null;
  source: "personal" | "shared" | null;
  keyPrefix?: string | null;
  keyLast4?: string | null;
};
type CostAttribution = {
  keySource: "platform" | "user_byok" | "provider_export" | "manual" | "unknown";
  payer: "company" | "user" | "unknown";
};
export type OpenRouterEmbeddingFailureReason =
  | "empty_input"
  | "missing_openrouter_key"
  | "provider_error"
  | "missing_vector";

export type OpenRouterEmbeddingResult =
  | { ok: true; embedding: number[]; keySource: "personal" | "shared" }
  | { ok: false; reason: OpenRouterEmbeddingFailureReason; status?: number };

async function resolveOpenRouterApiKey(ctx: Pick<any, "runQuery">, args: EmbeddingAccounting) {
  if (args.openRouterCredential && args.openRouterCredential.source !== "shared") {
    return args.openRouterCredential;
  }
  const credential = await ctx.runQuery((internal as any).crystal.providerSettings.resolveOpenRouterKeyForUser, {
    userId: args.userId,
    includeShared: false,
  }) as OpenRouterCredential;
  // ILL-184: never use a platform-owned key for a user-facing embedding.
  // A shared-source credential is treated as missing so the failure is
  // explicit and the alert policy applies.
  return credential.source === "shared" ? { apiKey: null, source: null } : credential;
}

function costAttributionForCredential(credential: OpenRouterCredential): CostAttribution {
  if (credential.source === "personal") return { keySource: "user_byok", payer: "user" };
  if (credential.source === "shared") return { keySource: "platform", payer: "company" };
  return { keySource: "unknown", payer: "unknown" };
}

/**
 * Check embedding cap and record usage atomically via incrementAndCheck.
 * Cap check runs BEFORE the Gemini API call to prevent wasted spend.
 * Throws ConvexError with code "embedding_cap_exceeded" when cap is hit.
 */
async function checkAndRecordEmbeddingUsage(
  ctx: EmbeddingCtx,
  args: { userId: string; source: string; itemCount: number; estimatedInputChars: number; attribution: CostAttribution },
): Promise<void> {
  const dailyLimit = await getEmbeddingDailyCharCap(ctx);
  const result = await ctx.runMutation(internal.crystal.geminiGuardrail.incrementAndCheck, {
    userId: args.userId,
    method: args.itemCount > 1 ? "batchEmbedContents" : "embedContent",
    calls: 1,
    itemCount: args.itemCount,
    estimatedInputChars: args.estimatedInputChars,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    source: args.source,
    keySource: args.attribution.keySource,
    payer: args.attribution.payer,
  });
  if (!result.allowed) {
    throw new ConvexError({
      code: "embedding_cap_exceeded",
      userId: args.userId,
      dailyLimit,
      message: "Daily embedding cap exceeded for this user",
    });
  }
}

function normalizeVector(value: unknown, source: string): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch in ${source}: got ${value.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}`,
    );
  }
  return value as number[];
}

async function requestOpenRouterEmbedding(
  ctx: EmbeddingCtx,
  args: {
    userId: string;
    apiKey: string;
    keyLast4?: string | null;
    model: string;
    input: string | string[];
    source: string;
  },
): Promise<{ ok: true; embeddings: number[][] } | { ok: false; status?: number }> {
  // ILL-184: every user-key OpenRouter request — inference and embedding alike —
  // passes through the providerGateway choke point, which classifies the
  // response, records the outcome per user, and applies the alert policy.
  const result = await requestOpenRouter(ctx, {
    userId: args.userId,
    apiKey: args.apiKey,
    keyLast4: args.keyLast4 ?? null,
    endpoint: OPENROUTER_EMBEDDINGS_ENDPOINT,
    source: args.source,
    body: {
      model: args.model,
      input: args.input,
      encoding_format: "float",
    },
    headers: {
      "HTTP-Referer": process.env.SITE_URL ?? "https://memorycrystal.ai",
      "X-OpenRouter-Title": "Memory Crystal",
    },
  });

  if (!result.ok) {
    return { ok: false, status: result.status };
  }

  const payload = result.payload as any;
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return {
    ok: true,
    embeddings: data
      .map((item: any, index: number) =>
        normalizeVector(item?.embedding, `${args.source}.${args.model}.${index}`),
      )
      .filter(Boolean) as number[][],
  };
}

export async function embedTextWithUserOpenRouter(
  ctx: EmbeddingCtx,
  text: string,
  accounting: EmbeddingAccounting,
): Promise<number[] | null> {
  const result = await embedTextWithUserOpenRouterDetailed(ctx, text, accounting);
  if (result.ok) return result.embedding;
  if (result.reason === "missing_openrouter_key") {
    // Explicit failure (AC1 / requirement 10): never a silent null vector.
    throw new ConvexError({
      code: "missing_openrouter_key",
      userId: accounting.userId,
      message: "OpenRouter API key not set for user",
    });
  }
  return null;
}

export async function embedTextWithUserOpenRouterDetailed(
  ctx: EmbeddingCtx,
  text: string,
  accounting: EmbeddingAccounting,
): Promise<OpenRouterEmbeddingResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty_input" };
  const credential = await resolveOpenRouterApiKey(ctx, accounting);

  if (!credential.apiKey) {
    // Record the no-credential case at the choke point so the alert policy
    // applies (actionable class), then return an explicit failure.
    await recordMissingOpenRouterKey(ctx, {
      userId: accounting.userId,
      keyLast4: null,
    }).catch(() => {});
    return { ok: false, reason: "missing_openrouter_key" };
  }

  const attribution = costAttributionForCredential(credential);
  await checkAndRecordEmbeddingUsage(ctx, {
    userId: accounting.userId,
    source: accounting.source,
    itemCount: 1,
    estimatedInputChars: trimmed.length,
    attribution,
  });

  const result = await requestOpenRouterEmbedding(ctx, {
    userId: accounting.userId,
    apiKey: credential.apiKey,
    keyLast4: credential.keyLast4 ?? null,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    input: trimmed,
    source: accounting.source,
  });
  if (result.ok) {
    const embedding = result.embeddings[0];
    if (embedding) {
      return {
        ok: true,
        embedding,
        keySource: credential.source === "shared" ? "shared" : "personal",
      };
    }
    return { ok: false, reason: "missing_vector" };
  }
  return { ok: false, reason: "provider_error", status: result.status };
}

export async function embedTextsWithUserOpenRouter(
  ctx: EmbeddingCtx,
  texts: string[],
  accounting: EmbeddingAccounting,
): Promise<(number[] | null)[]> {
  const inputs = texts
    .map((text, index) => ({ text: text.trim(), index }))
    .filter((item) => item.text);
  const results = texts.map(() => null as number[] | null);
  if (inputs.length === 0) return results;

  const credential = await resolveOpenRouterApiKey(ctx, accounting);

  if (!credential.apiKey) {
    await recordMissingOpenRouterKey(ctx, {
      userId: accounting.userId,
      keyLast4: null,
    }).catch(() => {});
    throw new ConvexError({
      code: "missing_openrouter_key",
      userId: accounting.userId,
      message: "OpenRouter API key not set for user",
    });
  }

  const attribution = costAttributionForCredential(credential);
  await checkAndRecordEmbeddingUsage(ctx, {
    userId: accounting.userId,
    source: accounting.source,
    itemCount: inputs.length,
    estimatedInputChars: inputs.reduce((total, item) => total + item.text.length, 0),
    attribution,
  });

  const result = await requestOpenRouterEmbedding(ctx, {
    userId: accounting.userId,
    apiKey: credential.apiKey,
    keyLast4: credential.keyLast4 ?? null,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    input: inputs.map((item) => item.text),
    source: accounting.source,
  });
  if (result.ok) {
    for (let index = 0; index < inputs.length; index += 1) {
      results[inputs[index].index] = result.embeddings[index] ?? null;
    }
  }
  return results;
}
