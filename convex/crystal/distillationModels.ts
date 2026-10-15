import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { stableUserId } from "./auth";

export const DEFAULT_DISTILLATION_MODEL = "openai/gpt-5.6-luna";
export const DEFAULT_MODEL = {
  modelId: DEFAULT_DISTILLATION_MODEL,
  name: "OpenAI: GPT-5.6 Luna",
  contextLength: 1_050_000,
  inputUsdPerMillion: 0.2,
  outputUsdPerMillion: 1.2,
  reasoningNone: true,
  reasoningMinimal: false,
};
export const modelValidator = v.object({
  modelId: v.string(),
  name: v.string(),
  contextLength: v.number(),
  inputUsdPerMillion: v.number(),
  outputUsdPerMillion: v.number(),
  reasoningNone: v.boolean(),
  reasoningMinimal: v.boolean(),
});
export type DistillationModel = typeof DEFAULT_MODEL;
const CACHE_MS = 24 * 60 * 60 * 1000;

export const claimCatalogRefresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const jobName = "openrouter-model-catalog-refresh";
    const old = await ctx.db
      .query("crystalJobCursors")
      .withIndex("by_job", (q) => q.eq("jobName", jobName))
      .unique();
    const now = Date.now();
    if (old && now - old.updatedAt < 60_000) return false;
    if (old) await ctx.db.patch(old._id, { updatedAt: now });
    else await ctx.db.insert("crystalJobCursors", { jobName, updatedAt: now });
    return true;
  },
});

export function compatibleModels(data: unknown): DistillationModel[] {
  if (!Array.isArray(data)) throw new Error("Invalid OpenRouter model catalog");
  return data.flatMap((model) => {
    if (!model || typeof model !== "object") return [];
    const input = Number(model.pricing?.prompt) * 1e6;
    const output = Number(model.pricing?.completion) * 1e6;
    if (
      typeof model.id !== "string" ||
      model.id.includes(":") ||
      !model.architecture?.input_modalities?.includes("text") ||
      !model.architecture?.output_modalities?.includes("text") ||
      !model.supported_parameters?.includes("structured_outputs") ||
      !Number.isFinite(model.context_length) ||
      model.context_length < 65_536 ||
      !Number.isFinite(input) ||
      !Number.isFinite(output) ||
      input < 0 ||
      output < 0
    )
      return [];
    return [
      {
        modelId: model.id,
        name: String(model.name ?? model.id),
        contextLength: model.context_length,
        inputUsdPerMillion: input,
        outputUsdPerMillion: output,
        reasoningNone:
          model.reasoning?.supported_efforts?.includes("none") === true,
        reasoningMinimal:
          model.reasoning?.supported_efforts?.includes("minimal") === true,
      },
    ];
  });
}

export const cached = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("crystalDistillationModels").take(1000),
});
export const saveCatalog = internalMutation({
  args: { models: v.array(modelValidator) },
  handler: async (ctx, { models }) => {
    if (models.length > 1000 || !models.length)
      throw new Error("Invalid catalog size");
    const updatedAt = Date.now();
    const selected = new Set(models.map((model) => model.modelId));
    const previous = await ctx.db.query("crystalDistillationModels").take(1000);
    for (const row of previous)
      if (!selected.has(row.modelId)) await ctx.db.delete(row._id);
    for (const model of models) {
      const old = await ctx.db
        .query("crystalDistillationModels")
        .withIndex("by_model", (q) => q.eq("modelId", model.modelId))
        .unique();
      if (old) await ctx.db.patch(old._id, { ...model, updatedAt });
      else
        await ctx.db.insert("crystalDistillationModels", {
          ...model,
          updatedAt,
        });
    }
  },
});

// A settings-page read, never part of the extraction loop. Provider discovery
// needs no tenant credential and never sends conversational data.
export const listModels = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<Array<DistillationModel & { updatedAt: number }>> => {
    if (!(await ctx.auth.getUserIdentity())) throw new Error("Unauthenticated");
    const rows = await ctx.runQuery(
      internal.crystal.distillationModels.cached,
      {},
    );
    if (
      rows.length &&
      Date.now() - Math.max(...rows.map((row) => row.updatedAt)) < CACHE_MS
    )
      return rows;
    if (
      !(await ctx.runMutation(
        internal.crystal.distillationModels.claimCatalogRefresh,
        {},
      ))
    ) {
      throw new Error(
        "Catalog refresh in progress or recently failed; retry in a minute",
      );
    }
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        "OpenRouter catalog unavailable; existing model selection is unchanged",
      );
    const body = await response.json();
    const models = compatibleModels(body.data);
    await ctx.runMutation(internal.crystal.distillationModels.saveCatalog, {
      models,
    });
    return models.map((model) => ({ ...model, updatedAt: Date.now() }));
  },
});

export const setMyModel = action({
  args: { modelId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const models: Array<DistillationModel & { updatedAt: number }> =
      await ctx.runAction(api.crystal.distillationModels.listModels, {});
    if (!models.some((model) => model.modelId === args.modelId))
      throw new Error(
        "Model unavailable or incompatible with structured extraction",
      );
    await ctx.runMutation(internal.crystal.distillationModels.saveSelection, {
      userId: stableUserId(identity.subject),
      modelId: args.modelId,
    });
  },
});
export const saveSelection = internalMutation({
  args: { userId: v.string(), modelId: v.string() },
  handler: async (ctx, args) => {
    const setting = await ctx.db
      .query("userProviderSettings")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", "openrouter"),
      )
      .first();
    if (!setting)
      throw new Error(
        "Add your own OpenRouter key before choosing a distillation model",
      );
    await ctx.db.patch(setting._id, {
      distillationModelId: args.modelId,
      updatedAt: Date.now(),
    });
  },
});

export const getForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const setting = await ctx.db
      .query("userProviderSettings")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", "openrouter"),
      )
      .first();
    const modelId = setting?.distillationModelId ?? DEFAULT_DISTILLATION_MODEL;
    const model = await ctx.db
      .query("crystalDistillationModels")
      .withIndex("by_model", (q) => q.eq("modelId", modelId))
      .unique();
    if (!model && modelId !== DEFAULT_DISTILLATION_MODEL)
      throw new Error(
        "Selected distillation model unavailable; no automatic fallback",
      );
    return model ?? DEFAULT_MODEL;
  },
});
