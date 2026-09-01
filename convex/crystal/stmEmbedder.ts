import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { embedTextWithUserOpenRouter, embedTextWithUserOpenRouterDetailed } from "./embeddings";

type EmbedMessageStatus = "embedded" | "already_embedded" | "missing" | "skipped" | "failed";
type EmbedMessageReason =
  | "already_embedded"
  | "missing"
  | "empty_content"
  | "missing_user_id"
  | "missing_openrouter_key"
  | "provider_error"
  | "missing_vector"
  | "empty_input"
  | "embedding_cap_exceeded"
  | "exception";
type EmbedMessageResult = { status: EmbedMessageStatus; reason?: EmbedMessageReason };

type MessageForEmbedding = {
  _id: any;
  userId?: string;
  content: string;
  embedded?: boolean;
};

export const requestEmbedding = async (
  content: string,
  ctx: Pick<any, "runMutation" | "runQuery">,
  accounting: { userId: string; source: string },
): Promise<number[] | null> => {
  try {
    return await embedTextWithUserOpenRouter(ctx, content, accounting);
  } catch (error: any) {
    // ILL-184: explicit missing-openrouter-key failure (already recorded at the
    // choke point); seeding helpers treat it as "no embedding available".
    if (error?.data?.code === "missing_openrouter_key") return null;
    throw error;
  }
};

const embedMessageRecord = async (
  ctx: any,
  message: MessageForEmbedding,
): Promise<EmbedMessageResult> => {
  if (message.embedded) {
    return { status: "already_embedded", reason: "already_embedded" };
  }

  if (!message.content?.trim()) {
    return { status: "skipped", reason: "empty_content" };
  }
  if (!message.userId) {
    return { status: "skipped", reason: "missing_user_id" };
  }

  try {
    const result = await embedTextWithUserOpenRouterDetailed(ctx, message.content, {
      userId: message.userId,
      source: "stmEmbedder.embedMessageRecord",
    });
    if (!result.ok) {
      return { status: "skipped", reason: result.reason };
    }

    await ctx.runMutation(internal.crystal.messages.updateMessageEmbedding, {
      messageId: message._id,
      embedding: result.embedding,
    });
    return { status: "embedded" };
  } catch (error) {
    const data = (error as { data?: { code?: unknown } })?.data;
    if (data?.code === "embedding_cap_exceeded") {
      return { status: "failed", reason: "embedding_cap_exceeded" };
    }
    return { status: "failed", reason: "exception" };
  }
};

export const embedMessage = internalAction({
  args: { messageId: v.id("crystalMessages") },
  handler: async (ctx, { messageId }): Promise<{ status: EmbedMessageStatus }> => {
    const message = await ctx.runQuery(internal.crystal.messages.getMessageInternal, { messageId });

    if (!message) {
      return { status: "missing" };
    }

    return await embedMessageRecord(ctx, message);
  },
});

export const embedUnprocessedMessages = action({
  args: { limit: v.optional(v.number()), scanLimit: v.optional(v.number()), userId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    skipped: number;
    reasons: Record<string, number>;
  }> => {
    const limit = Math.min(args.limit ?? 50, 100);
    const scanLimit = Math.min(Math.max(args.scanLimit ?? Math.max(limit * 10, 100), limit), 1000);
    const stats = { processed: 0, succeeded: 0, failed: 0, skipped: 0, reasons: {} as Record<string, number> };

    const messages = args.userId
      ? await ctx.runQuery(internal.crystal.messages.getUnembeddedMessagesForUserInternal, {
          userId: args.userId,
          limit: scanLimit,
        })
      : await ctx.runQuery(internal.crystal.messages.getUnembeddedMessages, { limit: scanLimit });

    for (const message of messages) {
      stats.processed += 1;
      const result = await embedMessageRecord(ctx, message);
      if (result.reason) {
        stats.reasons[result.reason] = (stats.reasons[result.reason] ?? 0) + 1;
      }

      if (result.status === "embedded") {
        stats.succeeded += 1;
        if (stats.succeeded >= limit) break;
        continue;
      }

      if (result.status === "failed") {
        stats.failed += 1;
        continue;
      }

      stats.skipped += 1;
    }

    return stats;
  },
});
