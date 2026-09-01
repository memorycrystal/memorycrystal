// ── Shared Organic Memory utilities ─────────────────────────────────────────

import type { GenericDocument, GenericVectorIndexConfig, VectorFilterBuilder } from "convex/server";
import { internal } from "../../_generated/api";
import type { ModelPreset } from "./models";
import { embedTextWithUserOpenRouter } from "../embeddings";
import { resolveOpenRouterApiKey } from "../adminSettings/resolvers";
import { requestOpenRouter } from "../providerGateway";
import { metric } from "../metrics";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

type GeminiResponsePart = {
  text?: string;
};

type GeminiCandidate = {
  content?: {
    parts?: GeminiResponsePart[];
  };
  output_text?: string;
};

type GeminiResponsePayload = {
  candidates?: GeminiCandidate[];
  text?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) {
    return [];
  }

  const maxLength = embeddings.reduce((longest, embedding) => Math.max(longest, embedding.length), 0);
  const compatible = embeddings.filter((embedding) => embedding.length === maxLength);
  if (compatible.length === 0 || maxLength === 0) {
    return [];
  }

  const result = new Array(maxLength).fill(0);
  for (const embedding of compatible) {
    for (let index = 0; index < maxLength; index++) {
      result[index] += embedding[index] ?? 0;
    }
  }

  return result.map((value) => value / compatible.length);
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function vectorSearchUserFilter(userId: string) {
  return <
    Document extends GenericDocument & { userId: string },
    VectorIndexConfig extends GenericVectorIndexConfig,
  >(
    filterBuilder: VectorFilterBuilder<Document, VectorIndexConfig>
  ) => filterBuilder.eq("userId" as never, userId as never);
}

export function extractGeminiResponseText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  const response = payload as GeminiResponsePayload;
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const candidateText = candidates
    .flatMap((candidate) => {
      const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
      const textParts = parts
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean);
      if (textParts.length > 0) {
        return textParts;
      }
      return typeof candidate.output_text === "string" ? [candidate.output_text] : [];
    })
    .join("\n")
    .trim();

  if (candidateText) {
    return candidateText;
  }

  return typeof response.text === "string" ? response.text.trim() : "";
}

function stripCodeFence(raw: string): string {
  const fenced = raw.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : raw;
}

function findBalancedJson(raw: string): string | null {
  for (let start = 0; start < raw.length; start++) {
    const opening = raw[start];
    if (opening !== "{" && opening !== "[") {
      continue;
    }

    const stack = [opening];
    let inString = false;
    let escaping = false;

    for (let i = start + 1; i < raw.length; i++) {
      const char = raw[i];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (char === "\\") {
          escaping = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "[";
        if (stack[stack.length - 1] !== expected) {
          break;
        }
        stack.pop();
        if (stack.length === 0) {
          return raw.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

export function parseGeminiJson<T>(raw: string): T | null {
  const trimmed = stripCodeFence(raw.trim());
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const balanced = findBalancedJson(trimmed);
  if (balanced && balanced !== trimmed) {
    candidates.push(balanced);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return null;
}

// ── OpenRouter caller ────────────────────────────────────────────────────────

async function callOpenRouterProvider(
  ctx: Pick<any, "runMutation">,
  userId: string,
  keyLast4: string | null,
  prompt: string,
  preset: ModelPreset,
  apiKey: string,
): Promise<string> {
  try {
    // ILL-184: every user-key OpenRouter request — inference and embedding
    // alike — passes through the providerGateway choke point, which classifies
    // the response, records the outcome per user, and applies the alert policy.
    const result = await requestOpenRouter(ctx, {
      userId,
      apiKey,
      keyLast4,
      endpoint: OPENROUTER_API_URL,
      source: "organic.callOpenRouterProvider",
      body: {
        model: preset.routerModel,
        messages: [{ role: "user", content: prompt }],
        temperature: preset.temperature,
        max_tokens: preset.maxOutputTokens,
        response_format: { type: "json_object" },
      },
      headers: {
        "HTTP-Referer": "https://memorycrystal.ai",
        "X-Title": "Memory Crystal",
      },
    });

    if (!result.ok) {
      console.error(
        `[organic] OpenRouter ${preset.routerModel} returned ${result.status}: ${result.errorMessage ?? "unknown"}`,
      );
      return "";
    }

    const payload = result.payload as any;
    const text = payload?.choices?.[0]?.message?.content ?? "";
    return typeof text === "string" ? text.trim() : "";
  } catch (err) {
    console.error(`[organic] OpenRouter ${preset.routerModel} network/parse error:`, err);
    return "";
  }
}

/**
 * Unified model caller. User/context work must route through OpenRouter only.
 * ctx + userId are required: a user-key request without user attribution cannot
 * be recorded at the choke point, so it is refused rather than made silently.
 */
export async function callOrganicModel(
  prompt: string,
  preset: ModelPreset,
  options: { ctx?: any; userId?: string; apiKeyOverride?: string; keyLast4?: string | null } = {},
): Promise<string> {
  const { ctx, userId, apiKeyOverride, keyLast4 } = options;
  const openRouterKey = apiKeyOverride ?? (ctx ? await resolveOpenRouterApiKey(ctx, { includeShared: false }) : null);
  if (openRouterKey && ctx && userId) {
    return callOpenRouterProvider(ctx, userId, keyLast4 ?? openRouterKey.slice(-4), prompt, preset, openRouterKey);
  }
  console.warn("[organic] callOrganicModel: no OpenRouter key available, skipping model call");
  metric("mc.metric.organic-openrouter-key-missing", { model: preset.routerModel });
  return "";
}

const REQUIRED_EMBEDDING_DIMENSIONS = 3072;

export async function embedText(
  text: string,
  accounting?: { ctx?: Pick<any, "runMutation" | "runQuery">; userId?: string; source?: string },
): Promise<number[] | null> {
  if (!accounting?.ctx || !accounting.userId) return null;
  try {
    return await embedTextWithUserOpenRouter(accounting.ctx, text, {
      userId: accounting.userId,
      source: accounting.source ?? "organic.embedText",
    });
  } catch (error: any) {
    // ILL-184: explicit missing-openrouter-key failure (recorded at the choke
    // point); organic features stay best-effort and skip embedding.
    if (error?.data?.code === "missing_openrouter_key") return null;
    throw error;
  }
}
