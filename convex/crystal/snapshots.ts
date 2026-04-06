import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { stableUserId } from "./auth";

const VALID_ROLES = new Set(["user", "assistant", "system"]);

const normalizeRequiredString = (value: string, field: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConvexError(`${field} is required`);
  }
  return trimmed;
};

export const createSnapshot = internalMutation({
  args: {
    userId: v.string(),
    sessionKey: v.optional(v.string()),
    channel: v.optional(v.string()),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        timestamp: v.optional(v.number()),
      })
    ),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.messages.length === 0) {
      throw new ConvexError("messages array must not be empty");
    }
    if (args.messages.length > 10_000) {
      throw new ConvexError("messages array must not exceed 10000 items");
    }

    const sessionKey = normalizeRequiredString(args.sessionKey ?? "", "sessionKey");
    const channel = normalizeRequiredString(args.channel ?? "", "channel");
    const reason = normalizeRequiredString(args.reason, "reason");

    const messages = args.messages.map((message, index) => {
      if (!VALID_ROLES.has(message.role)) {
        throw new ConvexError(`invalid message role at index ${index}`);
      }
      if (typeof message.content !== "string" || message.content.trim().length === 0) {
        throw new ConvexError(`message content must be a non-empty string at index ${index}`);
      }
      return {
        ...message,
        role: message.role as "user" | "assistant" | "system",
      };
    });

    const messageCount = messages.length;
    const totalTokens = Math.ceil(
      messages.reduce((sum, m) => sum + m.content.length, 0) / 4
    );

    const id = await ctx.db.insert("crystalSnapshots", {
      userId: args.userId,
      sessionKey,
      channel,
      messages,
      messageCount,
      totalTokens,
      reason,
      createdAt: Date.now(),
    });

    return { id, messageCount, totalTokens };
  },
});

export const getSnapshot = internalQuery({
  args: { snapshotId: v.id("crystalSnapshots"), userId: v.string() },
  handler: async (ctx, { snapshotId, userId }) => {
    const snapshot = await ctx.db.get(snapshotId);
    if (!snapshot) return null;
    if (snapshot.userId !== userId) throw new ConvexError("unauthorized");
    return snapshot;
  },
});

export const listSnapshots = query({
  args: {
    sessionKey: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("unauthenticated");
    const userId = stableUserId(identity.subject);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const sessionKey = args.sessionKey?.trim() || undefined;

    let q;
    if (sessionKey) {
      q = ctx.db
        .query("crystalSnapshots")
        .withIndex("by_session", (q) =>
          q.eq("userId", userId).eq("sessionKey", sessionKey)
        )
        .order("desc");
    } else {
      q = ctx.db
        .query("crystalSnapshots")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .order("desc");
    }

    return await q.take(limit);
  },
});
