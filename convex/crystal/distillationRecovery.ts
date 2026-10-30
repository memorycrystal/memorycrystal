/** One-time operator workflow: estimate every page, obtain approval, then requeue.
 * No cron invokes these functions. Estimation never calls an inference provider.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { isProactiveDistillationChannelEligible } from "./ltmExtraction";
import { DEFAULT_DISTILLATION_MODEL } from "./distillationModels";

export function needsHistoricalRecovery(
  message: Doc<"crystalMessages">,
  cutoff: number,
): boolean {
  return (
    message.timestamp <= cutoff &&
    message.role !== "system" &&
    Boolean(message.content.trim()) &&
    isProactiveDistillationChannelEligible(message.channel) &&
    message.ltmExtractedAt !== undefined &&
    (message.ltmExtractionVersion ?? 0) < 2 &&
    (!message.ltmExtractionSkippedReason ||
      ["no_durable_memory", "provider_outcome_unknown"].includes(
        message.ltmExtractionSkippedReason,
      ))
  );
}

export const estimatePage = internalQuery({
  args: {
    userId: v.string(),
    cutoff: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_time", (q) =>
        q.eq("userId", args.userId).lte("timestamp", args.cutoff),
      )
      .paginate({
        cursor: args.cursor,
        numItems: 20,
        maximumBytesRead: 1_000_000,
      });
    const messages = page.page.filter((message) =>
      needsHistoricalRecovery(message, args.cutoff),
    );
    // Conservative token allowance: UTF-8 bytes, plus prompt/digest overhead
    // and maximum output per chunk. This is an estimate, not a billing cap.
    let inputTokens = 0;
    let outputTokens = 0;
    let requests = 0;
    for (const message of messages) {
      const chunks = Math.ceil(message.content.length / 7999);
      requests += chunks;
      inputTokens +=
        new TextEncoder().encode(message.content).length + chunks * 8000;
      outputTokens += chunks * 8192;
    }
    return {
      messageIds: messages.map((message) => message._id),
      inputTokens,
      outputTokens,
      requests,
      scanned: page.page.length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const requeueApprovedPage = internalMutation({
  args: {
    userId: v.string(),
    cutoff: v.number(),
    messageIds: v.array(v.id("crystalMessages")),
    approvalReference: v.string(),
    expectedModelId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.approvalReference.trim() || args.messageIds.length > 20)
      throw new Error("Approval reference and bounded page required");
    const provider = await ctx.db
      .query("userProviderSettings")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", "openrouter"),
      )
      .first();
    if (!provider) throw new Error("Tenant OpenRouter key required");
    if (
      (provider.distillationModelId ?? DEFAULT_DISTILLATION_MODEL) !==
      args.expectedModelId
    )
      throw new Error("Model changed; estimate again");
    let reset = 0;
    for (const id of new Set(args.messageIds)) {
      const message = await ctx.db.get(id);
      if (
        !message ||
        message.userId !== args.userId ||
        !needsHistoricalRecovery(message, args.cutoff)
      )
        continue;
      if (
        message.ltmExtractionClaim &&
        message.ltmExtractionClaim.leaseUntil > Date.now()
      )
        throw new Error("Message currently claimed");
      await ctx.db.patch(id, {
        ltmExtracted: undefined,
        ltmExtractedAt: undefined,
        ltmExtractionSkippedReason: undefined,
        ltmExtractionOffset: undefined,
        ltmExtractionBlocked: undefined,
        ltmExtractionRetryAt: undefined,
        ltmExtractionClaim: undefined,
      });
      reset++;
    }
    if (reset)
      await ctx.scheduler.runAfter(
        0,
        internal.crystal.distillationQueue.enqueue,
        { userId: args.userId, cutoff: args.cutoff },
      );
    return { reset, approvalReference: args.approvalReference };
  },
});
