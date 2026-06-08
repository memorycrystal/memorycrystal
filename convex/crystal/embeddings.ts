// MC_EMBEDDING_DAILY_TOKEN_CAP_PER_USER — operator-tunable per-user daily embedding input-char cap
// (chars ≈ tokens for English text at ~1:1; Gemini charges per input token).
// Default: 1_000_000 chars/day per user. Set to 0 to disable cap enforcement.
// Env var takes effect immediately on the next Convex deployment without code change.
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";

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
  allowSharedFallback?: boolean;
  openRouterCredential?: OpenRouterCredential;
};

export type OpenRouterCredential = { apiKey: string | null; source: "personal" | "shared" | null };
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
  if (
    args.openRouterCredential &&
    (args.openRouterCredential.source !== "shared" || args.allowSharedFallback === true)
  ) {
    return args.openRouterCredential;
  }
  const credential = await ctx.runQuery((internal as any).crystal.providerSettings.resolveOpenRouterKeyForUser, {
    userId: args.userId,
    includeShared: args.allowSharedFallback === true,
  }) as OpenRouterCredential;
  return credential;
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

async function requestOpenRouterEmbedding(args: {
  apiKey: string;
  model: string;
  input: string | string[];
  source: string;
}): Promise<{ ok: true; embeddings: number[][] } | { ok: false; status?: number }> {
  const response = await fetch(OPENROUTER_EMBEDDINGS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
      "HTTP-Referer": process.env.SITE_URL ?? "https://memorycrystal.ai",
      "X-OpenRouter-Title": "Memory Crystal",
    },
    body: JSON.stringify({
      model: args.model,
      input: args.input,
      encoding_format: "float",
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = typeof payload?.error?.message === "string" ? payload.error.message.slice(0, 160) : "unknown";
    console.log(`[${args.source}] OpenRouter embedding failed: model=${args.model} status=${response.status} error=${errorMessage}`);
    return { ok: false, status: response.status };
  }

  const data = Array.isArray(payload?.data) ? payload.data : [];
  return {
    ok: true,
    embeddings: data.map((item: any, index: number) => normalizeVector(item?.embedding, `${args.source}.${args.model}.${index}`)).filter(Boolean) as number[][],
  };
}

export async function embedTextWithUserOpenRouter(
  ctx: EmbeddingCtx,
  text: string,
  accounting: EmbeddingAccounting,
): Promise<number[] | null> {
  const result = await embedTextWithUserOpenRouterDetailed(ctx, text, accounting);
  return result.ok ? result.embedding : null;
}

export async function embedTextWithUserOpenRouterDetailed(
  ctx: EmbeddingCtx,
  text: string,
  accounting: EmbeddingAccounting,
): Promise<OpenRouterEmbeddingResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty_input" };
  const credential = await resolveOpenRouterApiKey(ctx, accounting);
  if (!credential.apiKey) return { ok: false, reason: "missing_openrouter_key" };
  const attribution = costAttributionForCredential(credential);

  await checkAndRecordEmbeddingUsage(ctx, {
    userId: accounting.userId,
    source: accounting.source,
    itemCount: 1,
    estimatedInputChars: trimmed.length,
    attribution,
  });

  const result = await requestOpenRouterEmbedding({
    apiKey: credential.apiKey,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    input: trimmed,
    source: accounting.source,
  });
  if (!result.ok) return { ok: false, reason: "provider_error", status: result.status };
  const embedding = result.embeddings[0];
  if (!embedding) return { ok: false, reason: "missing_vector" };
  return { ok: true, embedding, keySource: credential.source === "shared" ? "shared" : "personal" };
}

export async function embedTextsWithUserOpenRouter(
  ctx: EmbeddingCtx,
  texts: string[],
  accounting: EmbeddingAccounting,
): Promise<(number[] | null)[]> {
  const inputs = texts.map((text, index) => ({ text: text.trim(), index })).filter((item) => item.text);
  const results = texts.map(() => null as number[] | null);
  if (inputs.length === 0) return results;

  const credential = await resolveOpenRouterApiKey(ctx, accounting);
  if (!credential.apiKey) return results;
  const attribution = costAttributionForCredential(credential);

  await checkAndRecordEmbeddingUsage(ctx, {
    userId: accounting.userId,
    source: accounting.source,
    itemCount: inputs.length,
    estimatedInputChars: inputs.reduce((total, item) => total + item.text.length, 0),
    attribution,
  });

  const result = await requestOpenRouterEmbedding({
    apiKey: credential.apiKey,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    input: inputs.map((item) => item.text),
    source: accounting.source,
  });
  if (!result.ok) return results;
  for (let index = 0; index < inputs.length; index += 1) {
    results[inputs[index].index] = result.embeddings[index] ?? null;
  }
  return results;
}
