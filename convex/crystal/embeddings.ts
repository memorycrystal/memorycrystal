// MC_EMBEDDING_DAILY_TOKEN_CAP_PER_USER — operator-tunable per-user daily embedding input-char cap
// (chars ≈ tokens for English text at ~1:1; Gemini charges per input token).
// Default: 1_000_000 chars/day per user. Set to 0 to disable cap enforcement.
// Env var takes effect immediately on the next Convex deployment without code change.
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { finalizeEmbeddingInput } from "./embeddingInput";
import { requestOpenRouter, recordMissingOpenRouterKey } from "./providerGateway";
import { awaitEnqueue, settleBeforeReturn } from "./requestEnqueues";

export const OPENROUTER_EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
export const OPENROUTER_GEMINI_EMBEDDING_MODEL = "google/gemini-embedding-2-preview";
export const REQUIRED_EMBEDDING_DIMENSIONS = 3072;
const EMBED_TEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const EMBED_TEXT_CACHE_MAX = 256;

/**
 * Recall's query embedding sends one identical request when the first has not answered in this many ms. Production
 * embed latency (Oct 2026): p50 316 ms, p75 about 400 ms, p95 1,506 ms, max 1,948 ms. Three in four answers arrive
 * by about 400 ms and the slow ones take 1.5-2 s, so 600 ms hedges only the slow tail: fewer than a quarter of calls
 * and at least the slowest 5 %. A hedged call answers in about 600 + 316 ms instead of 1.5 s or more.
 */
export const RECALL_EMBED_HEDGE_DELAY_MS = 600;

type EmbedTextCacheEntry = { expiresAt: number; value: number[] };
const embedTextCache = new Map<string, EmbedTextCacheEntry>();

export function clearEmbedTextCache(): void {
  embedTextCache.clear();
}

type EmbedTextOptions = {
  /** Race a second identical request when the provider is slow; recall's query embedding only. */
  hedge?: boolean;
  /** Runs as the hedge's second request is sent, for a caller that accounts each request it causes. */
  onHedgeSent?: () => void;
};

/** Shared user-attributed embedding helper used by recall writes and repair. */
export async function embedText(
  text: string,
  ctx: Pick<ActionCtx, "runMutation" | "runQuery" | "scheduler">,
  accounting: { userId?: string; source: string },
  options?: EmbedTextOptions,
): Promise<number[] | null> {
  if (!accounting.userId) return null;
  const cacheKey = `${OPENROUTER_GEMINI_EMBEDDING_MODEL}:personal:${accounting.userId}:${text}`;
  const entry = embedTextCache.get(cacheKey);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  if (entry) embedTextCache.delete(cacheKey);

  const vector = await embedTextWithUserOpenRouter(ctx, text, {
    userId: accounting.userId,
    source: accounting.source,
  }, options);
  if (!vector) return null;
  if (embedTextCache.size >= EMBED_TEXT_CACHE_MAX) {
    const oldestKey = embedTextCache.keys().next().value;
    if (oldestKey) embedTextCache.delete(oldestKey);
  }
  embedTextCache.set(cacheKey, {
    expiresAt: Date.now() + EMBED_TEXT_CACHE_TTL_MS,
    value: vector,
  });
  return vector;
}

type EmbedTextDetailedOptions = EmbedTextOptions & { quietMissingKey?: boolean };

/**
 * Same choke point as embedText, but keeps the provider failure detail.
 * embedText's signature stays unchanged; callers that need a status opt in here.
 */
export async function embedTextDetailed(
  text: string,
  ctx: Pick<ActionCtx, "runMutation" | "runQuery" | "scheduler">,
  accounting: { userId?: string; source: string },
  options?: EmbedTextDetailedOptions,
): Promise<OpenRouterEmbeddingResult> {
  if (!accounting.userId) return { ok: false, reason: "provider_error" };

  const cacheKey = `${OPENROUTER_GEMINI_EMBEDDING_MODEL}:personal:${accounting.userId}:${text}`;
  const entry = embedTextCache.get(cacheKey);
  if (entry && entry.expiresAt > Date.now()) {
    return { ok: true, embedding: entry.value, keySource: "personal" };
  }
  if (entry) embedTextCache.delete(cacheKey);

  const result = await embedTextWithUserOpenRouterDetailed(ctx, text, {
    userId: accounting.userId,
    source: accounting.source,
  }, options);

  if (result.ok) {
    if (embedTextCache.size >= EMBED_TEXT_CACHE_MAX) {
      const oldestKey = embedTextCache.keys().next().value;
      if (oldestKey) embedTextCache.delete(oldestKey);
    }
    embedTextCache.set(cacheKey, {
      expiresAt: Date.now() + EMBED_TEXT_CACHE_TTL_MS,
      value: result.embedding,
    });
  }

  return result;
}

/** Default per-user daily embedding input-char cap (≈ tokens). Overridden by MC_EMBEDDING_DAILY_TOKEN_CAP_PER_USER. */
export const DEFAULT_EMBEDDING_DAILY_CHAR_CAP = 1_000_000;

async function getEmbeddingDailyCharCap(_ctx: any): Promise<number | null> {
  const raw = process.env.MC_EMBEDDING_DAILY_TOKEN_CAP_PER_USER;
  const parsed = raw?.trim() ? Number(raw) : DEFAULT_EMBEDDING_DAILY_CHAR_CAP;
  const cap = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EMBEDDING_DAILY_CHAR_CAP;
  return cap === 0 ? null : cap;
}

type EmbeddingCtx = Pick<any, "runQuery" | "runMutation" | "scheduler">;

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

export function userFacingCredential(credential: OpenRouterCredential): OpenRouterCredential {
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

export function embeddingUsage(args: { userId: string; source: string; itemCount: number; estimatedInputChars: number }, credential: OpenRouterCredential) {
  const attribution = costAttributionForCredential(credential);
  return {
    userId: args.userId,
    method: args.itemCount > 1 ? "batchEmbedContents" as const : "embedContent" as const,
    calls: 1,
    itemCount: args.itemCount,
    estimatedInputChars: args.estimatedInputChars,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    source: args.source,
    keySource: attribution.keySource,
    payer: attribution.payer,
  };
}

/**
 * Resolve the key and check the embedding cap before the provider call, so a
 * capped user spends nothing. A credential passed by the caller skips the key
 * lookup. Returns a credential without an apiKey when the user has none.
 * Throws ConvexError with code "embedding_cap_exceeded" when cap is hit.
 */
async function admitEmbedding(
  ctx: EmbeddingCtx,
  accounting: EmbeddingAccounting,
  args: { itemCount: number; estimatedInputChars: number },
): Promise<OpenRouterCredential> {
  const usage = { userId: accounting.userId, source: accounting.source, ...args };
  let credential: OpenRouterCredential;
  let allowed: boolean;
  if (accounting.openRouterCredential && accounting.openRouterCredential.source !== "shared") {
    credential = accounting.openRouterCredential;
    if (!credential.apiKey) return credential;
    allowed = (await ctx.runMutation(internal.crystal.geminiGuardrail.incrementAndCheck, embeddingUsage(usage, credential))).allowed;
  } else {
    ({ credential, allowed } = await ctx.runMutation(internal.crystal.geminiGuardrail.resolveKeyAndIncrementAndCheck, usage));
    if (!credential.apiKey) return credential;
  }
  if (!allowed) {
    const dailyLimit = await getEmbeddingDailyCharCap(ctx);
    throw new ConvexError({
      code: "embedding_cap_exceeded",
      userId: accounting.userId,
      dailyLimit,
      message: "Daily embedding cap exceeded for this user",
    });
  }
  return credential;
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

type EmbeddingRequest = {
  userId: string;
  apiKey: string;
  keyLast4?: string | null;
  model: string;
  input: string | string[];
  source: string;
  signal?: AbortSignal;
};

type EmbeddingResponse = { ok: true; embeddings: number[][] } | { ok: false; status?: number };

async function requestOpenRouterEmbedding(
  ctx: EmbeddingCtx,
  args: EmbeddingRequest,
): Promise<EmbeddingResponse> {
  // ILL-184: every user-key OpenRouter request — inference and embedding alike —
  // passes through the providerGateway choke point, which classifies the
  // response, records the outcome per user, and applies the alert policy.
  const result = await requestOpenRouter(ctx, {
    userId: args.userId,
    apiKey: args.apiKey,
    keyLast4: args.keyLast4 ?? null,
    endpoint: OPENROUTER_EMBEDDINGS_ENDPOINT,
    source: args.source,
    signal: args.signal,
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

/** A hedge counted against the daily cap; `release` takes the count back when the hedge is not sent. */
type HedgeAdmission = { release: () => Promise<void> };

/**
 * Counts a hedge request against the daily cap before it is sent. A refused or failed admission sends no hedge; the
 * first request still answers.
 */
async function admitHedge(
  ctx: EmbeddingCtx,
  accounting: EmbeddingAccounting,
  credential: OpenRouterCredential,
  estimatedInputChars: number,
): Promise<HedgeAdmission | null> {
  const usage = embeddingUsage({ userId: accounting.userId, source: accounting.source, itemCount: 1, estimatedInputChars }, credential);
  const check: { allowed: boolean; countedOn?: string } | null = await ctx
    .runMutation(internal.crystal.geminiGuardrail.incrementAndCheck, usage)
    .catch(() => {
      console.warn("[embeddings] hedge_admission_failures=1");
      return null;
    });
  if (!check?.allowed) return null;
  const countedOn = check.countedOn;
  return {
    release: async () => {
      if (!countedOn) return;
      await ctx.runMutation(internal.crystal.geminiGuardrail.releaseUsage, {
        userId: usage.userId,
        dateKey: countedOn,
        method: usage.method,
        calls: usage.calls,
        itemCount: usage.itemCount,
        estimatedInputChars: usage.estimatedInputChars,
        keySource: usage.keySource,
        payer: usage.payer,
      }).catch(() => {
        console.warn("[embeddings] hedge_release_failures=1");
      });
    },
  };
}

type SettledAttempt = { attempt: EmbeddingAttempt; outcome: PromiseSettledResult<EmbeddingResponse> };
type EmbeddingAttempt = { controller: AbortController; inFlight: boolean; settled: Promise<SettledAttempt> };

function sendEmbeddingAttempt(ctx: EmbeddingCtx, args: EmbeddingRequest): EmbeddingAttempt {
  const controller = new AbortController();
  // An aborted request records nothing, but one that answered before its abort records its outcome after the race
  // returns; the draining request waits for it.
  const request = settleBeforeReturn(ctx, requestOpenRouterEmbedding(ctx, { ...args, signal: controller.signal }));
  const settle = (outcome: PromiseSettledResult<EmbeddingResponse>): SettledAttempt => {
    attempt.inFlight = false;
    return { attempt, outcome };
  };
  const attempt: EmbeddingAttempt = {
    controller,
    inFlight: true,
    settled: request.then(
      (value) => settle({ status: "fulfilled", value }),
      (reason: unknown) => settle({ status: "rejected", reason }),
    ),
  };
  return attempt;
}

/** A vector, a malformed vector or a 4xx other than 408 and 429 answers the race; the other request cannot do better. */
function endsRace(outcome: PromiseSettledResult<EmbeddingResponse>): boolean {
  if (outcome.status === "rejected" || outcome.value.ok) return true;
  const status = outcome.value.status ?? 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Sends the request and, when it has not answered within RECALL_EMBED_HEDGE_DELAY_MS, one identical request that
 * `admit` counts before it is sent and `onSent` hears about as it is sent. The first answer that ends the race wins
 * and the other request is aborted. A transient failure waits for the other request while one is in flight, so a
 * failure before the delay returns at once.
 */
async function requestHedgedOpenRouterEmbedding(
  ctx: EmbeddingCtx,
  args: EmbeddingRequest,
  admit: () => Promise<HedgeAdmission | null>,
  onSent?: () => void,
): Promise<EmbeddingResponse> {
  let racing = [sendEmbeddingAttempt(ctx, args)];
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  let hedgeDue: Promise<"hedge"> | null = new Promise((resolve) => {
    hedgeTimer = setTimeout(() => resolve("hedge"), RECALL_EMBED_HEDGE_DELAY_MS);
  });
  try {
    for (;;) {
      const next = await Promise.race([...racing.map((attempt) => attempt.settled), ...(hedgeDue ? [hedgeDue] : [])]);
      if (next === "hedge") {
        hedgeDue = null;
        const admission = await admit();
        if (admission && racing[0].inFlight) {
          racing.push(sendEmbeddingAttempt(ctx, args));
          onSent?.();
        } else if (admission) {
          // The first request answered during admission; the hedge stays unsent and its count is taken back.
          await awaitEnqueue(ctx, admission.release());
        }
        continue;
      }
      racing = racing.filter((attempt) => attempt !== next.attempt);
      if (racing.length > 0 && !endsRace(next.outcome)) continue;
      if (next.outcome.status === "rejected") throw next.outcome.reason;
      return next.outcome.value;
    }
  } finally {
    clearTimeout(hedgeTimer);
    for (const attempt of racing) attempt.controller.abort();
  }
}

export async function embedTextWithUserOpenRouter(
  ctx: EmbeddingCtx,
  text: string,
  accounting: EmbeddingAccounting,
  options?: EmbedTextOptions,
): Promise<number[] | null> {
  const result = await embedTextWithUserOpenRouterDetailed(ctx, text, accounting, options);
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
  options?: EmbedTextDetailedOptions,
): Promise<OpenRouterEmbeddingResult> {
  const trimmed = finalizeEmbeddingInput(text);
  if (!trimmed) return { ok: false, reason: "empty_input" };
  const credential = await admitEmbedding(ctx, accounting, { itemCount: 1, estimatedInputChars: trimmed.length });

  if (!credential.apiKey) {
    // Record the no-credential case at the choke point so the alert policy
    // applies (actionable class), then return an explicit failure.
    // Retries pass quietMissingKey so a key that disappears after the
    // pre-check does not record a failure or send an alert.
    if (!options?.quietMissingKey) {
      await recordMissingOpenRouterKey(ctx, {
        userId: accounting.userId,
        keyLast4: null,
        source: accounting.source,
        endpointKind: "embeddings",
        model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
      }).catch(() => {});
    }
    return { ok: false, reason: "missing_openrouter_key" };
  }

  const request: EmbeddingRequest = {
    userId: accounting.userId,
    apiKey: credential.apiKey,
    keyLast4: credential.keyLast4 ?? null,
    model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    input: trimmed,
    source: accounting.source,
  };
  const result = options?.hedge
    ? await requestHedgedOpenRouterEmbedding(
      ctx,
      request,
      () => admitHedge(ctx, accounting, credential, trimmed.length),
      options.onHedgeSent,
    )
    : await requestOpenRouterEmbedding(ctx, request);
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
    .map((text, index) => ({ text: finalizeEmbeddingInput(text), index }))
    .filter((item) => item.text);
  const results = texts.map(() => null as number[] | null);
  if (inputs.length === 0) return results;

  const credential = await admitEmbedding(ctx, accounting, {
    itemCount: inputs.length,
    estimatedInputChars: inputs.reduce((total, item) => total + item.text.length, 0),
  });

  if (!credential.apiKey) {
    await recordMissingOpenRouterKey(ctx, {
      userId: accounting.userId,
      keyLast4: null,
      source: accounting.source,
      endpointKind: "embeddings",
      model: OPENROUTER_GEMINI_EMBEDDING_MODEL,
    }).catch(() => {});
    throw new ConvexError({
      code: "missing_openrouter_key",
      userId: accounting.userId,
      message: "OpenRouter API key not set for user",
    });
  }

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
