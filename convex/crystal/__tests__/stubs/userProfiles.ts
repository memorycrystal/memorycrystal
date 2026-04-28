import { internalMutation, internalQuery } from "../../../_generated/server";
import { v } from "convex/values";

const userIds = new Set<string>();

export const getUserTier = internalQuery({
  args: { userId: v.string() },
  handler: async (_ctx, args) => {
    userIds.add(args.userId);
    return "starter" as const;
  },
});

export const listAllUserIds = internalQuery({
  args: {},
  handler: async () => Array.from(userIds),
});

export const upsertSubscriptionByUserInternal = internalMutation({
  args: {
    userId: v.string(),
    polarSubscriptionId: v.optional(v.string()),
    polarCustomerId: v.optional(v.string()),
    subscriptionStatus: v.union(
      v.literal("active"),
      v.literal("inactive"),
      v.literal("cancelled"),
      v.literal("trialing")
    ),
    plan: v.optional(v.string()),
    trialEndsAt: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    userIds.add(args.userId);
    return { profileId: args.userId };
  },
});
