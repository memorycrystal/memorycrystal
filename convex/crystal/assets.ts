import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

const GEMINI_EMBEDDING_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2-preview";
const REQUIRED_EMBEDDING_DIMENSIONS = 3072;

function assertGeminiProvider(): void {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "gemini").toLowerCase();
  if (provider !== "gemini") {
    throw new Error(
      `Only Gemini embeddings are supported in production. Got EMBEDDING_PROVIDER="${provider}". ` +
      "Set EMBEDDING_PROVIDER=gemini or remove the variable."
    );
  }
}

function isUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

function buildAssetTextFallback(asset: {
  title?: string;
  transcript?: string;
  summary?: string;
  storageKey: string;
  kind: string;
  mimeType: string;
}): string {
  return [
    asset.title ? `title: ${asset.title}` : "",
    asset.summary ? `summary: ${asset.summary}` : "",
    asset.transcript ? `transcript: ${asset.transcript}` : "",
    `kind: ${asset.kind}`,
    `mimeType: ${asset.mimeType}`,
    `storageKey: ${asset.storageKey}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function requestGeminiEmbeddingForText(apiKey: string, text: string): Promise<number[] | null> {
  const model = process.env.GEMINI_EMBEDDING_MODEL || GEMINI_EMBEDDING_MODEL;
  const response = await fetch(
    `${GEMINI_EMBEDDING_ENDPOINT}/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    }
  );

  const payload = await response.json().catch(() => null);
  const vector = payload?.embedding?.values;
  return response.ok && Array.isArray(vector) ? vector : null;
}

async function requestGeminiEmbeddingForAsset(apiKey: string, asset: {
  storageKey: string;
  mimeType: string;
  title?: string;
  transcript?: string;
  summary?: string;
  kind: string;
}): Promise<number[] | null> {
  const model = process.env.GEMINI_EMBEDDING_MODEL || GEMINI_EMBEDDING_MODEL;

  let parts: any[] | null = null;

  if (asset.storageKey.startsWith("gs://")) {
    parts = [
      {
        file_data: {
          file_uri: asset.storageKey,
          mime_type: asset.mimeType,
        },
      },
    ];
  } else if (isUrl(asset.storageKey)) {
    try {
      const fileResponse = await fetch(asset.storageKey);
      if (fileResponse.ok) {
        const fileBuffer = await fileResponse.arrayBuffer();
        parts = [
          {
            inline_data: {
              mime_type: asset.mimeType,
              data: toBase64(fileBuffer),
            },
          },
        ];
      }
    } catch {
      // fall through to text fallback
    }
  }

  if (!parts) {
    const fallback = buildAssetTextFallback(asset);
    return requestGeminiEmbeddingForText(apiKey, fallback);
  }

  const response = await fetch(
    `${GEMINI_EMBEDDING_ENDPOINT}/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts },
      }),
    }
  );

  const payload = await response.json().catch(() => null);
  const vector = payload?.embedding?.values;
  if (response.ok && Array.isArray(vector)) {
    return vector;
  }

  const fallback = buildAssetTextFallback(asset);
  return requestGeminiEmbeddingForText(apiKey, fallback);
}

function assertEmbeddingDimensions(vector: number[]): void {
  if (vector.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Asset embedding dimension mismatch: got ${vector.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}`
    );
  }
}

async function embedAssetDoc(asset: {
  storageKey: string;
  mimeType: string;
  title?: string;
  transcript?: string;
  summary?: string;
  kind: "image" | "audio" | "video" | "pdf" | "text";
}): Promise<number[] | null> {
  assertGeminiProvider();
  const apiKey = process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const fallbackText = buildAssetTextFallback(asset);
  let vector: number[] | null;

  if (asset.kind === "text") {
    vector = await requestGeminiEmbeddingForText(apiKey, fallbackText);
  } else {
    vector = await requestGeminiEmbeddingForAsset(apiKey, asset);
  }

  if (vector) {
    assertEmbeddingDimensions(vector);
  }
  return vector;
}

export const storeAsset = internalMutation({
  args: {
    userId: v.string(),
    kind: v.union(v.literal("image"), v.literal("audio"), v.literal("video"), v.literal("pdf"), v.literal("text")),
    storageKey: v.string(),
    mimeType: v.string(),
    title: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!args.storageKey.trim()) {
      throw new Error("storageKey is required");
    }
    if (!args.mimeType.trim()) {
      throw new Error("mimeType is required");
    }

    return await ctx.db.insert("crystalAssets", {
      userId: args.userId,
      kind: args.kind,
      storageKey: args.storageKey,
      mimeType: args.mimeType,
      title: args.title,
      transcript: args.transcript,
      summary: args.summary,
      embedded: false,
      channel: args.channel,
      sessionKey: args.sessionKey,
      tags: args.tags,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    });
  },
});

export const getAssetById = internalQuery({
  args: { assetId: v.id("crystalAssets") },
  handler: async (ctx, { assetId }) => ctx.db.get(assetId),
});

export const patchAssetEmbedding = internalMutation({
  args: { assetId: v.id("crystalAssets"), embedding: v.array(v.float64()) },
  handler: async (ctx, { assetId, embedding }) => {
    await ctx.db.patch(assetId, {
      embedding,
      embedded: true,
    });
  },
});

export const listUnembeddedAssets = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("crystalAssets")
      .withIndex("by_embedded", (q) => q.eq("embedded", false))
      .order("asc")
      .take(Math.min(Math.max(limit, 1), 50));
  },
});

export const embedAsset = internalAction({
  args: { assetId: v.id("crystalAssets") },
  handler: async (ctx, { assetId }) => {
    const asset = await ctx.runQuery(internal.crystal.assets.getAssetById, { assetId });
    if (!asset || asset.embedded) {
      return { ok: false, reason: "missing_or_already_embedded" as const };
    }

    const embedding = await embedAssetDoc({
      storageKey: asset.storageKey,
      mimeType: asset.mimeType,
      title: asset.title,
      transcript: asset.transcript,
      summary: asset.summary,
      kind: asset.kind,
    });

    if (!Array.isArray(embedding)) {
      return { ok: false, reason: "embedding_unavailable" as const };
    }

    await ctx.runMutation(internal.crystal.assets.patchAssetEmbedding, {
      assetId,
      embedding,
    });

    return { ok: true };
  },
});

export const assetEmbedder = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 20);
    const assets = await ctx.runQuery(internal.crystal.assets.listUnembeddedAssets, { limit });

    const stats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };

    for (const asset of assets) {
      stats.processed += 1;
      try {
        const result = await ctx.runAction(internal.crystal.assets.embedAsset, { assetId: asset._id });
        if (result?.ok) {
          stats.succeeded += 1;
        } else if (result?.reason === "missing_or_already_embedded") {
          stats.skipped += 1;
        } else {
          stats.failed += 1;
        }
      } catch {
        stats.failed += 1;
      }
    }

    return stats;
  },
});
