import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { embedTextWithUserOpenRouter } from "./embeddings";

type EmbedMessageStatus = "embedded" | "already_embedded" | "missing" | "skipped" | "failed";

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
  return embedTextWithUserOpenRouter(ctx, content, accounting);
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
  if (!message.userId) {
    return "skipped";
  }

  try {
    const embedding = await requestEmbedding(message.content, ctx, {
      userId: message.userId,
      source: "stmEmbedder.embedMessageRecord",
    });
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
