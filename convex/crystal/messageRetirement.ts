import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  CAPSULE_WORTHY_SKIP_REASONS,
  UNSCOPED_CHANNEL_RESIDUAL_POLICY,
  UNSCOPED_CHANNEL_SKIP_REASON,
  isCapsuleWorthySkipReason,
} from "./channelScope";

export const TERMINAL_SKIP_REASONS = new Set([
  "low_signal",
  "no_durable_memory",
  "blocked_by_content_scanner",
  UNSCOPED_CHANNEL_SKIP_REASON,
]);

export {
  CAPSULE_WORTHY_SKIP_REASONS,
  UNSCOPED_CHANNEL_RESIDUAL_POLICY,
  isCapsuleWorthySkipReason,
};

type RetiredMessage = {
  _id: Id<"crystalMessages">;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  channel?: string;
  sessionKey?: string;
  timestamp: number;
  contentHash?: string;
  ltmExtractedAt?: number;
  ltmExtractionSkippedReason?: string;
};

export function isTerminallyProcessed(message: Pick<RetiredMessage, "ltmExtractedAt" | "ltmExtractionSkippedReason">) {
  return Boolean(message.ltmExtractedAt || (
    message.ltmExtractionSkippedReason &&
    TERMINAL_SKIP_REASONS.has(message.ltmExtractionSkippedReason)
  ));
}

export const getMessagesByIds = internalQuery({
  args: {
    messageIds: v.array(v.id("crystalMessages")),
  },
  handler: async (ctx, args) => {
    const messages = await Promise.all(args.messageIds.map((id) => ctx.db.get(id)));
    return messages.filter(Boolean) as RetiredMessage[];
  },
});

export const retireExpiredMessageWindow = internalAction({
  args: {
    messageIds: v.array(v.id("crystalMessages")),
  },
  returns: v.object({
    deleted: v.number(),
    blocked: v.number(),
  }),
  handler: async (ctx, args) => {
    const messages = (await ctx.runQuery(internal.crystal.messageRetirement.getMessagesByIds, {
      messageIds: args.messageIds,
    })) as RetiredMessage[];
    if (messages.length === 0) return { deleted: 0, blocked: 0 };

    const distilledIds = messages
      .filter((message) => message.ltmExtractedAt !== undefined)
      .map((message) => message._id);
    const skippedUndistilled = messages.length - distilledIds.length;
    if (distilledIds.length === 0) {
      return { deleted: 0, blocked: skippedUndistilled };
    }

    const deletion = await ctx.runMutation(internal.crystal.messages.deleteRetiredMessages, {
      messageIds: distilledIds,
      retiredAt: Date.now(),
    }) as { deleted: number; blocked: number };

    return {
      deleted: deletion.deleted,
      blocked: deletion.blocked + skippedUndistilled,
    };
  },
});
