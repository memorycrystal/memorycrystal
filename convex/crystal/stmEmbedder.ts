import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

const GEMINI_EMBEDDING_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2-preview";
const REQUIRED_EMBEDDING_DIMENSIONS = 3072;

type EmbedMessageStatus = "embedded" | "already_embedded" | "missing" | "skipped" | "failed";

type MessageForEmbedding = {
  _id: any;
  content: string;
  embedded?: boolean;
};

const assertGeminiProvider = (): void => {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "gemini").toLowerCase();
  if (provider !== "gemini") {
    throw new Error(
      `Only Gemini embeddings are supported in production. Got EMBEDDING_PROVIDER="${provider}". ` +
      "Set EMBEDDING_PROVIDER=gemini or remove the variable."
    );
  }
};

export const requestEmbedding = async (content: string): Promise<number[] | null> => {
  assertGeminiProvider();
  const apiKey = process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("CRYSTAL_API_KEY (or GEMINI_API_KEY) is required for embedding generation");
  }

  const model = process.env.GEMINI_EMBEDDING_MODEL || GEMINI_EMBEDDING_MODEL;
  const response = await fetch(
    `${GEMINI_EMBEDDING_ENDPOINT}/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: content }] },
      }),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new Error(`Gemini embedding request failed: ${response.status}`);
  }

  const vector = payload.embedding?.values;
  if (!Array.isArray(vector)) {
    return null;
  }

  if (vector.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: got ${vector.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}`
    );
  }

  return vector;
};

const embedMessageRecord = async (
  ctx: any,
  message: MessageForEmbedding,
): Promise<EmbedMessageStatus> => {
  if (message.embedded) {
    return "already_embedded";
  }

  if (!message.content?.trim()) {
    return "skipped";
  }

  if (!(process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY)) {
    return "skipped";
  }

  try {
    const embedding = await requestEmbedding(message.content);
    if (!embedding) {
      return "skipped";
    }

    await ctx.runMutation(internal.crystal.messages.updateMessageEmbedding, {
      messageId: message._id,
      embedding,
    });
    return "embedded";
  } catch {
    return "failed";
  }
};

export const embedMessage = internalAction({
  args: { messageId: v.id("crystalMessages") },
  handler: async (ctx, { messageId }): Promise<{ status: EmbedMessageStatus }> => {
    const message = await ctx.runQuery(internal.crystal.messages.getMessageInternal, { messageId });

    if (!message) {
      return { status: "missing" };
    }

    return {
      status: await embedMessageRecord(ctx, message),
    };
  },
});

export const embedUnprocessedMessages = action({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ processed: number; succeeded: number; failed: number; skipped: number }> => {
    const limit = Math.min(args.limit ?? 50, 100);
    const stats = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };

    const messages = await ctx.runQuery(internal.crystal.messages.getUnembeddedMessages, { limit });

    for (const message of messages) {
      stats.processed += 1;
      const status = await embedMessageRecord(ctx, message);

      if (status === "embedded") {
        stats.succeeded += 1;
        continue;
      }

      if (status === "failed") {
        stats.failed += 1;
        continue;
      }

      stats.skipped += 1;
    }

    return stats;
  },
});
