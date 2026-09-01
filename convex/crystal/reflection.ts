import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { type Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requestOpenRouter, recordMissingOpenRouterKey } from "./providerGateway";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_HOURS = 24;
const REFLECTION_MODEL = "openai/gpt-4o-mini";
const GPT_4O_MINI_INPUT_USD_PER_1M = 0.15;
const GPT_4O_MINI_OUTPUT_USD_PER_1M = 0.60;
const DEFAULT_REFLECTION_OUTPUT_TOKENS = 500;

type CostKeySource = "platform" | "user_byok" | "provider_export" | "manual" | "unknown";
type CostPayer = "company" | "user" | "unknown";
type OpenRouterCredentialSource = "personal" | "shared" | null;
type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

type LowSalienceReviewResult = {
  promoted: number;
  decayed: number;
};

async function resolveUserOpenRouterKey(ctx: Pick<any, "runQuery">, userId: string) {
  return ctx.runQuery((internal as any).crystal.providerSettings.resolveOpenRouterKeyForUser, {
    userId,
    includeShared: false,
  }) as Promise<{ apiKey: string | null; keyPrefix: string | null; keyLast4: string | null; source: "personal" | "shared" | null }>;
}

function tokenEstimateFromChars(chars: number): number {
  return Math.ceil(Math.max(chars, 0) / 4);
}

function roundUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

function estimateGpt4oMiniCost(inputTokens: number, outputTokens: number): number {
  return roundUsd((inputTokens / 1_000_000) * GPT_4O_MINI_INPUT_USD_PER_1M
    + (outputTokens / 1_000_000) * GPT_4O_MINI_OUTPUT_USD_PER_1M);
}

function usageFromPayload(payload: any, prompt: string, fallbackOutputTokens = DEFAULT_REFLECTION_OUTPUT_TOKENS): ModelUsage {
  const inputTokens = Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens);
  const outputTokens = Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens);
  const estimatedInputTokens = Number.isFinite(inputTokens) && inputTokens > 0
    ? inputTokens
    : tokenEstimateFromChars(prompt.length);
  const estimatedOutputTokens = Number.isFinite(outputTokens) && outputTokens > 0
    ? outputTokens
    : fallbackOutputTokens;
  return {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    estimatedCostUsd: estimateGpt4oMiniCost(estimatedInputTokens, estimatedOutputTokens),
  };
}

function costAttributionForOpenRouter(source: OpenRouterCredentialSource): { keySource: CostKeySource; payer: CostPayer } {
  if (source === "personal") return { keySource: "user_byok", payer: "user" };
  if (source === "shared") return { keySource: "platform", payer: "company" };
  return { keySource: "unknown", payer: "unknown" };
}

const buildLowSalienceReviewPrompt = (memories: {
  title: string;
  content: string;
}[]): string => {
  const memoryContext = memories
    .map((memory, index) => `${index}. ${memory.title}\n${memory.content.slice(0, 200)}`)
    .join("\n\n");

  return `You are a memory curator. Review these low-salience sensory memories and decide which (if any) deserve promotion to episodic memory for longer retention.\n\nMemories:\n${memoryContext}\n\nFor each memory, respond with ONLY valid JSON:\n{\n  "promote": [\n    { "index": 0, "reason": "contains important decision", "newSalienceScore": 0.72 }\n  ],\n  "decay": [0, 1, 2]\n}\n\n\"promote\" = indexes to upgrade to episodic store with updated salience\n\"decay\" = indexes that are pure noise and can be archived\nOnly promote if genuinely valuable. When in doubt, leave it as-is (return empty arrays).`;
};

// ── Internal query: fetch recent sensory + episodic memories ──────────────────

export const patchSourceMemorySummary = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    summary: v.string(),
    summarySource: v.union(
      v.literal("baseline_reflection"),
      v.literal("organic_pulse"),
      v.literal("backfill"),
      v.literal("manual"),
      v.literal("imported")
    ),
    summaryModel: v.optional(v.string()),
    summaryCostUsd: v.optional(v.float64()),
    reflectionRunId: v.optional(v.id("crystalReflectionRuns")),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (!memory || memory.archived || memory.knowledgeBaseId) return null;
    const summary = args.summary.trim();
    if (!summary) return null;
    await ctx.db.patch(args.memoryId, {
      summary,
      recallText: summary,
      summaryCreatedAt: Date.now(),
      summarySource: args.summarySource,
      summaryModel: args.summaryModel,
      summaryCostUsd: args.summaryCostUsd,
      rawRetentionState: memory.rawContentWipedAt ? "wiped" : "summarized",
      reflectionRunId: args.reflectionRunId,
    });
    return { ok: true };
  },
});

// ── Low-salience LLM review for sensory archival/promotions ────────────────

export const reviewLowSalienceMemories = internalAction({
  args: {
    userId: v.string(),
    windowHours: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<LowSalienceReviewResult & { usage?: ModelUsage; keySource?: CostKeySource; payer?: CostPayer }> => {
    const windowHours = Math.min(Math.max(args.windowHours ?? DEFAULT_WINDOW_HOURS, 0.5), 72);
    const windowMs = windowHours * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    const openrouterCredential = await resolveUserOpenRouterKey(ctx, args.userId);
    const attribution = costAttributionForOpenRouter(openrouterCredential.source);
    if (!openrouterCredential.apiKey) {
      // ILL-184: route the silent skip through the choke point so the alert
      // policy applies (missing_openrouter_key is actionable).
      await recordMissingOpenRouterKey(ctx, {
        userId: args.userId,
        keyLast4: openrouterCredential.keyLast4 ?? null,
      }).catch(() => {});
      console.log(`[reviewLowSalienceMemories] user ${args.userId}: OpenRouter API key not set`);
      return { promoted: 0, decayed: 0 };
    }

    const lowSalienceMemories = (
      (await ctx.runQuery(internal.crystal.salience.getLowSalienceMemoriesForPromotion, {
        userId: args.userId,
        store: "sensory",
        limit: 50,
        maxSalienceScore: 0.45,
      })) as Array<{
        _id: string;
        title: string;
        content: string;
        createdAt: number;
        strength: number;
        salienceScore?: number;
      }>
    ).filter((memory) => memory.createdAt >= cutoff);

    if (lowSalienceMemories.length === 0) {
      return { promoted: 0, decayed: 0 };
    }

    const prompt = buildLowSalienceReviewPrompt(
      lowSalienceMemories.map((memory) => ({
        title: memory.title,
        content: memory.content,
      }))
    );

    let responsePayload: unknown;

    try {
      const gatewayResult = await requestOpenRouter(ctx, {
        userId: args.userId,
        apiKey: openrouterCredential.apiKey as string,
        keyLast4: openrouterCredential.keyLast4 ?? null,
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        source: "reflection.reviewLowSalienceMemories",
        body: {
          model: REFLECTION_MODEL,
          temperature: 0.1,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        },
      });

      if (!gatewayResult.ok) {
        console.log(
          `[reviewLowSalienceMemories] user ${args.userId}: OpenRouter API error ${gatewayResult.status}: ${gatewayResult.errorMessage ?? "unknown"}`,
        );
        return { promoted: 0, decayed: 0 };
      }

      const payload = gatewayResult.payload as any;
      const usage = usageFromPayload(payload, prompt, 220);
      const rawContent = payload?.choices?.[0]?.message?.content ?? "";
      if (!rawContent?.trim()) {
        console.log(`[reviewLowSalienceMemories] user ${args.userId}: Empty model response`);
        return { promoted: 0, decayed: 0 };
      }

      const cleaned = rawContent
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      responsePayload = JSON.parse(cleaned) as unknown;
      (responsePayload as any).__usage = usage;
    } catch (err) {
      console.log(`[reviewLowSalienceMemories] user ${args.userId}: Failed to call or parse OpenRouter response`, err);
      return { promoted: 0, decayed: 0 };
    }

    const rawPromote = Array.isArray((responsePayload as any)?.promote) ? (responsePayload as any).promote : [];
    const rawDecay = Array.isArray((responsePayload as any)?.decay) ? (responsePayload as any).decay : [];

    let promoted = 0;
    let decayed = 0;

    const usedPromote = new Set<number>();
    const usedDecay = new Set<number>();

    const now = Date.now();

    for (const raw of rawDecay) {
      const index = Number((raw as any)?.index);
      if (!Number.isInteger(index) || index < 0 || index >= lowSalienceMemories.length) continue;
      if (usedPromote.has(index)) continue;
      usedDecay.add(index);

      const memory = lowSalienceMemories[index];
      try {
        await ctx.runMutation(internal.crystal.salience.decayLowSalienceMemory, {
          userId: args.userId,
          memoryId: memory._id as Id<"crystalMemories">,
          archivedAt: now,
        });
        decayed += 1;
      } catch (err) {
        console.log(`[reviewLowSalienceMemories] user ${args.userId}: failed decay memory ${memory._id}`, err);
      }
    }

    for (const raw of rawPromote) {
      const index = Number((raw as any)?.index);
      if (!Number.isInteger(index) || index < 0 || index >= lowSalienceMemories.length) continue;
      if (usedDecay.has(index)) continue;
      usedPromote.add(index);

      const memory = lowSalienceMemories[index];
      const newSalienceScore = Number((raw as any)?.newSalienceScore);
      const sanitizedSalience = Number.isFinite(newSalienceScore)
        ? clampScore(newSalienceScore)
        : clampScore(memory.salienceScore ?? 0.45);
      const boostedStrength = clampScore((memory.strength ?? 0.8) + 0.1);

      try {
        await ctx.runMutation(internal.crystal.salience.promoteLowSalienceMemory, {
          userId: args.userId,
          memoryId: memory._id as Id<"crystalMemories">,
          salienceScore: sanitizedSalience,
          strength: boostedStrength,
        });
        promoted += 1;
      } catch (err) {
        console.log(`[reviewLowSalienceMemories] user ${args.userId}: failed promote memory ${memory._id}`, err);
      }
    }

    return {
      promoted,
      decayed,
      usage: (responsePayload as any)?.__usage,
      keySource: attribution.keySource,
      payer: attribution.payer,
    };
  },
});

const clampScore = (value: number) => Math.min(Math.max(value, 0), 1);
