// ── Shared Organic Memory utilities ─────────────────────────────────────────

import type { GenericDocument, GenericVectorIndexConfig, VectorFilterBuilder } from "convex/server";
import type { ModelPreset } from "./models";

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

async function callOpenRouterProvider(prompt: string, preset: ModelPreset, apiKey: string): Promise<string> {
  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://memorycrystal.ai",
        "X-Title": "Memory Crystal",
      },
      body: JSON.stringify({
        model: preset.routerModel,
        messages: [{ role: "user", content: prompt }],
        temperature: preset.temperature,
        max_tokens: preset.maxOutputTokens,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[organic] OpenRouter ${preset.routerModel} returned ${res.status}: ${errText}`);
      return "";
    }

    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? "";
    return typeof text === "string" ? text.trim() : "";
  } catch (err) {
    console.error(`[organic] OpenRouter ${preset.routerModel} network/parse error:`, err);
    return "";
  }
}

// ── Direct provider fallbacks (used when OPENROUTER_API_KEY is not set) ──────

async function callGeminiProviderDirect(prompt: string, preset: ModelPreset, apiKey: string): Promise<string> {
  const geminiApiBase = "https://generativelanguage.googleapis.com/v1beta/models";
  const models = [preset.model];
  if (preset.fallbackModel) models.push(preset.fallbackModel);

  for (const model of models) {
    try {
      const url = `${geminiApiBase}/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: preset.temperature,
            maxOutputTokens: preset.maxOutputTokens,
            responseMimeType: "application/json",
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[organic] Gemini ${model} returned ${res.status}: ${errText}`);
        continue;
      }

      const json = await res.json();
      const text = extractGeminiResponseText(json);
      if (!text) {
        console.error(`[organic] Gemini ${model} returned empty text`);
        continue;
      }

      return text;
    } catch (err) {
      console.error(`[organic] Gemini ${model} network/parse error:`, err);
      continue;
    }
  }

  return "";
}

async function callOpenAIProviderDirect(prompt: string, preset: ModelPreset, apiKey: string): Promise<string> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: preset.model,
        messages: [{ role: "user", content: prompt }],
        temperature: preset.temperature,
        max_tokens: preset.maxOutputTokens,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[organic] OpenAI ${preset.model} returned ${res.status}: ${errText}`);
      return "";
    }

    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? "";
    return typeof text === "string" ? text.trim() : "";
  } catch (err) {
    console.error(`[organic] OpenAI ${preset.model} network/parse error:`, err);
    return "";
  }
}

async function callAnthropicProviderDirect(prompt: string, preset: ModelPreset, apiKey: string): Promise<string> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: preset.model,
        max_tokens: preset.maxOutputTokens,
        temperature: preset.temperature,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[organic] Anthropic ${preset.model} returned ${res.status}: ${errText}`);
      return "";
    }

    const json = await res.json();
    const content = json?.content;
    if (Array.isArray(content) && content.length > 0) {
      const textBlock = content.find((b: any) => b.type === "text");
      return typeof textBlock?.text === "string" ? textBlock.text.trim() : "";
    }
    return "";
  } catch (err) {
    console.error(`[organic] Anthropic ${preset.model} network/parse error:`, err);
    return "";
  }
}

/**
 * Infer the original provider from a routerModel string (e.g., "google/gemini-2.5-flash" → "gemini").
 */
function inferDirectProvider(preset: ModelPreset): "gemini" | "openai" | "anthropic" | null {
  const rm = preset.routerModel;
  if (rm.startsWith("google/")) return "gemini";
  if (rm.startsWith("openai/")) return "openai";
  if (rm.startsWith("anthropic/")) return "anthropic";
  return null;
}

/**
 * Unified model caller. Uses OpenRouter when OPENROUTER_API_KEY is set,
 * falls back to direct provider APIs otherwise.
 */
export async function callOrganicModel(prompt: string, preset: ModelPreset, apiKeyOverride?: string): Promise<string> {
  const openRouterKey = apiKeyOverride ?? process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    return callOpenRouterProvider(prompt, preset, openRouterKey);
  }

  // Fallback to direct provider calls
  const directProvider = inferDirectProvider(preset);
  switch (directProvider) {
    case "gemini": {
      const apiKey = process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY not set (OPENROUTER_API_KEY also not set)");
      return callGeminiProviderDirect(prompt, preset, apiKey);
    }
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set (OPENROUTER_API_KEY also not set)");
      return callOpenAIProviderDirect(prompt, preset, apiKey);
    }
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set (OPENROUTER_API_KEY also not set)");
      return callAnthropicProviderDirect(prompt, preset, apiKey);
    }
    default:
      throw new Error(`Unknown provider for routerModel: ${preset.routerModel}`);
  }
}

const REQUIRED_EMBEDDING_DIMENSIONS = 3072;

/**
 * Generate an embedding vector for text using Gemini (sole production provider).
 * Works in Convex action context (makes HTTP calls).
 */
export async function embedText(text: string): Promise<number[] | null> {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "gemini").toLowerCase();
  if (provider !== "gemini") {
    throw new Error(
      `Only Gemini embeddings are supported in production. Got EMBEDDING_PROVIDER="${provider}".`
    );
  }

  const apiKey = process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2-preview";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    },
  );
  if (!response.ok) return null;
  const payload = await response.json() as { embedding?: { values?: number[] } };
  const vector = payload.embedding?.values ?? null;

  if (vector && vector.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch in organic/utils: got ${vector.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}`
    );
  }
  return vector;
}
