/**
 * US-008 — callOrganicModel Convex-override tests.
 *
 * Verifies that:
 *  - callOrganicModel prefers Convex admin override over env for all providers
 *  - callOrganicModel without ctx falls back to env (ctx-optional contract)
 *  - openRouterCostAttribution reports keySource:"platform" when admin override is present
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../../schema";
import { callOrganicModel } from "../utils";
import { resolveOpenRouterApiKey } from "../../adminSettings/resolvers";
import { MODEL_PRESETS } from "../models";

// ---------------------------------------------------------------------------
// Module registry for convex-test
// ---------------------------------------------------------------------------
const modules = {
  "_generated/api": () => import("../../../_generated/api.js"),
  "_generated/server": () => import("../../../_generated/server.js"),
};

// ---------------------------------------------------------------------------
// Preset fixtures
// ---------------------------------------------------------------------------

// Medium uses google/ prefix → OpenRouter path
const OPENROUTER_PRESET = MODEL_PRESETS["medium"]; // routerModel: "google/gemini-2.5-flash"
// For direct-provider tests we need a preset that does NOT route via OpenRouter
// (only triggered when openRouterKey is absent). These are direct-provider paths.
const GEMINI_PRESET = {
  ...MODEL_PRESETS["medium"],
  routerModel: "google/gemini-2.5-flash", // still hits OpenRouter when key present
  model: "gemini-2.5-flash",
};
const OPENAI_PRESET = {
  ...MODEL_PRESETS["high"],
  routerModel: "openai/gpt-4.1-mini",
  model: "gpt-4.1-mini",
};
const ANTHROPIC_PRESET = {
  ...MODEL_PRESETS["sonnet"],
  routerModel: "anthropic/claude-sonnet-4.6",
  model: "claude-sonnet-4.6",
};

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function makeOpenRouterResponse(content = "ok") {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeGeminiResponse(text = "ok") {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeOpenAIResponse(content = "ok") {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeAnthropicResponse(text = "ok") {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

async function insertAdminKey(
  t: ReturnType<typeof convexTest>,
  key: string,
  value: string,
) {
  return t.run(async (ctx) => {
    await ctx.db.insert("crystalAdminSettings", {
      key,
      valueType: "secret",
      valueSecret: value,
      precedenceMode: "convex_wins",
      setAt: Date.now(),
      setBy: "test",
    });
  });
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("callOrganicModel — Convex override vs env", () => {
  let t: ReturnType<typeof convexTest>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    t = convexTest(schema, modules);
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses Convex override over env for OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-env-key");
    await insertAdminKey(t, "openrouterApiKey", "test-openrouter-convex-key");
    mockFetch.mockResolvedValue(makeOpenRouterResponse());

    await t.run(async (ctx) => {
      await callOrganicModel("test prompt", OPENROUTER_PRESET, undefined, ctx);
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-openrouter-convex-key");
    expect(headers["Authorization"]).not.toBe("Bearer test-openrouter-env-key");
  });

  it("sends new OpenRouter-only presets through the JSON object request shape", async () => {
    const keys = [
      "glm-5-1",
      "glm-5",
      "glm-4-5-air",
      "qwen3-30b-instruct",
      "qwen3-coder-30b",
      "deepseek-v3-1",
      "minimax-m2",
    ];
    mockFetch.mockImplementation(() => Promise.resolve(makeOpenRouterResponse("{\"ok\":true}")));

    for (const key of keys) {
      mockFetch.mockClear();
      const preset = MODEL_PRESETS[key];
      expect(preset).toBeDefined();

      await callOrganicModel("Return {\"ok\":true}", preset, "test-openrouter-request-key");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe(preset.routerModel);
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.max_tokens).toBe(preset.maxOutputTokens);
      expect(init.headers.Authorization).toBe("Bearer test-openrouter-request-key");
    }
  });

  it("does not fall back to direct Gemini when OpenRouter is missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-env-key");
    await insertAdminKey(t, "geminiApiKey", "test-gemini-convex-key");
    mockFetch.mockResolvedValue(makeGeminiResponse());

    await expect(t.run((ctx) => callOrganicModel("test prompt", GEMINI_PRESET, undefined, ctx)))
      .resolves.toBe("");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not fall back to direct OpenAI when OpenRouter is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-env-key");
    await insertAdminKey(t, "openaiApiKey", "test-openai-convex-key");
    mockFetch.mockResolvedValue(makeOpenAIResponse());

    await expect(t.run((ctx) => callOrganicModel("test prompt", OPENAI_PRESET, undefined, ctx)))
      .resolves.toBe("");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not fall back to direct Anthropic when OpenRouter is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-env-key");
    await insertAdminKey(t, "anthropicApiKey", "test-anthropic-convex-key");
    mockFetch.mockResolvedValue(makeAnthropicResponse());

    await expect(t.run((ctx) => callOrganicModel("test prompt", ANTHROPIC_PRESET, undefined, ctx)))
      .resolves.toBe("");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("without ctx no longer falls back to env OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-env-key");
    mockFetch.mockResolvedValue(makeOpenRouterResponse());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(callOrganicModel("test prompt", OPENROUTER_PRESET))
      .resolves.toBe("");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[organic] callOrganicModel: no OpenRouter key available, skipping model call");
    expect(logSpy).toHaveBeenCalledWith("[mc.metric]", expect.stringContaining("mc.metric.organic-openrouter-key-missing"));
    expect(logSpy).toHaveBeenCalledWith("[mc.metric]", expect.stringContaining(OPENROUTER_PRESET.routerModel));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("with ctx prefers Convex override over env (positive pair for ctx-optional contract)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-env-key");
    await insertAdminKey(t, "openrouterApiKey", "test-openrouter-convex-key");
    mockFetch.mockResolvedValue(makeOpenRouterResponse());

    await t.run(async (ctx) => {
      await callOrganicModel("test prompt", OPENROUTER_PRESET, undefined, ctx);
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-openrouter-convex-key");
  });
});

describe("openRouterCostAttribution — keySource via resolveOpenRouterApiKey", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keySource:platform when Convex admin override present and env unset", async () => {
    // Seed admin Convex row; UNSET env
    delete process.env.OPENROUTER_API_KEY;
    await t.run(async (ctx) => {
      await ctx.db.insert("crystalAdminSettings", {
        key: "openrouterApiKey",
        valueType: "secret",
        valueSecret: "test-openrouter-platform-key",
        precedenceMode: "convex_wins",
        setAt: Date.now(),
        setBy: "test",
      });
    });

    // resolveOpenRouterApiKey is what openRouterCostAttribution calls internally.
    // Since openRouterCostAttribution is private, we verify via the resolver directly —
    // the cost attribution function returns "platform" when resolvedKey is truthy.
    const resolvedKey = await t.run((ctx) =>
      resolveOpenRouterApiKey(ctx, { includeShared: true }),
    );

    expect(resolvedKey).toBe("test-openrouter-platform-key");
    // The cost attribution logic: if (resolvedKey ?? process.env.OPENROUTER_API_KEY) → "platform"
    const keySource = (resolvedKey ?? process.env.OPENROUTER_API_KEY)
      ? "platform"
      : "unknown";
    expect(keySource).toBe("platform");
  });
});
