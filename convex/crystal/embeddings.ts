import { internal } from "../_generated/api";

export const OPENROUTER_EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
export const OPENROUTER_GEMINI_EMBEDDING_MODEL = "google/gemini-embedding-2-preview";
export const REQUIRED_EMBEDDING_DIMENSIONS = 3072;

type EmbeddingCtx = Pick<any, "runQuery" | "runMutation">;

type EmbeddingAccounting = {
  userId: string;
  source: string;
  allowSharedFallback?: boolean;
};

type OpenRouterCredential = { apiKey: string | null; source: "personal" | "shared" | null };
type CostAttribution = {
  keySource: "platform" | "user_byok" | "provider_export" | "manual" | "unknown";
  payer: "company" | "user" | "unknown";
};

async function resolveOpenRouterApiKey(ctx: Pick<any, "runQuery">, args: EmbeddingAccounting) {
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

async function recordEmbeddingUsage(
  ctx: Pick<any, "runMutation">,
  args: { userId: string; source: string; itemCount: number; estimatedInputChars: number; attribution: CostAttribution },
) {
  await ctx.runMutation(internal.crystal.geminiGuardrail.recordUsage, {
    userId: args.userId,
    method: args.itemCount > 1 ? "batchEmbedContents" : "embedContent",
    calls: 1,
    itemCount: args.itemCount,
    estimatedInputChars: args.estimatedInputChars,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    source: args.source,
    keySource: args.attribution.keySource,
    payer: args.attribution.payer,
  }).catch(() => null);
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

export async function embedTextWithUserOpenRouter(
  ctx: EmbeddingCtx,
  text: string,
  accounting: EmbeddingAccounting,
): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const credential = await resolveOpenRouterApiKey(ctx, accounting);
  if (!credential.apiKey) return null;
  const attribution = costAttributionForCredential(credential);

  await recordEmbeddingUsage(ctx, {
    userId: accounting.userId,
    source: accounting.source,
    itemCount: 1,
    estimatedInputChars: trimmed.length,
    attribution,
  });

  const response = await fetch(OPENROUTER_EMBEDDINGS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.apiKey}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
      input: trimmed,
      dimensions: REQUIRED_EMBEDDING_DIMENSIONS,
      encoding_format: "float",
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.log(`[${accounting.source}] OpenRouter embedding failed: status=${response.status}`);
    return null;
  }

  return normalizeVector(payload?.data?.[0]?.embedding, accounting.source);
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

  await recordEmbeddingUsage(ctx, {
    userId: accounting.userId,
    source: accounting.source,
    itemCount: inputs.length,
    estimatedInputChars: inputs.reduce((total, item) => total + item.text.length, 0),
    attribution,
  });

  const response = await fetch(OPENROUTER_EMBEDDINGS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.apiKey}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
      input: inputs.map((item) => item.text),
      dimensions: REQUIRED_EMBEDDING_DIMENSIONS,
      encoding_format: "float",
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.log(`[${accounting.source}] OpenRouter batch embedding failed: status=${response.status}`);
    return results;
  }

  const data = Array.isArray(payload?.data) ? payload.data : [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    results[input.index] = normalizeVector(data[index]?.embedding, accounting.source);
  }
  return results;
}
