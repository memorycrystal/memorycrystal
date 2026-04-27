import { stableUserId } from "./auth";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import {
  isKnowledgeBaseVisibleToAgent,
  isNonKnowledgeBaseMemoryVisibleInChannel,
  resolveKnowledgeBaseAgentId,
  MANAGEMENT_CHANNEL_SENTINEL,
} from "./knowledgeBases";

export const createSession = mutation({
  args: {
    channel: v.string(),
    startedAt: v.number(),
    lastActiveAt: v.number(),
    messageCount: v.number(),
    memoryCount: v.number(),
    summary: v.optional(v.string()),
    participants: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return ctx.db.insert("crystalSessions", { ...args, userId: stableUserId(identity.subject) });
  },
});

export const createSessionInternal = internalMutation({
  args: {
    userId: v.string(),
    channel: v.string(),
    startedAt: v.number(),
    lastActiveAt: v.number(),
    messageCount: v.number(),
    memoryCount: v.number(),
    summary: v.optional(v.string()),
    participants: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("crystalSessions", args);
  },
});

export const createWakeState = mutation({
  args: {
    sessionId: v.id("crystalSessions"),
    injectedMemoryIds: v.array(v.id("crystalMemories")),
    wakePrompt: v.string(),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return ctx.db.insert("crystalWakeState", { ...args, userId: stableUserId(identity.subject) });
  },
});

export const createWakeStateInternal = internalMutation({
  args: {
    userId: v.string(),
    sessionId: v.id("crystalSessions"),
    injectedMemoryIds: v.array(v.id("crystalMemories")),
    wakePrompt: v.string(),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("crystalWakeState", args);
  },
});

export const getLastSession = query({
  args: { channel: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const channel = args.channel?.trim() || undefined;

    if (channel) {
      const channelSessions = await ctx.db
        .query("crystalSessions")
        .withIndex("by_user_channel", (q) => q.eq("userId", userId).eq("channel", channel))
        .order("desc")
        .take(1);
      return channelSessions[0] ?? null;
    }

    const sessions = await ctx.db
      .query("crystalSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(1);

    return sessions[0] ?? null;
  },
});

export const getActiveMemories = query({
  args: { channel: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const channel = args.channel?.trim() || undefined;
    const fetch = Math.min(Math.max(args.limit, 1), 50);
    const effectiveAgentId = resolveKnowledgeBaseAgentId(undefined, channel);
    // Peer-first fallback: getActiveMemories is called from the wake path
    // which feeds peer-scoped sessions. If a caller forgets to forward
    // `channel`, we fail-closed by passing "" instead of silently upgrading
    // to management visibility. Dashboard queries that legitimately need
    // management-wide visibility should use an explicit callSource-based
    // helper, not this peer-facing endpoint.
    const guardChannel: string | typeof MANAGEMENT_CHANNEL_SENTINEL =
      typeof channel === "string" ? channel : "";
    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", false))
      .take(Math.min(Math.max(fetch * (channel ? 8 : 5), 50), 200));

    const knowledgeBaseIds = Array.from(
      new Set(
        memories
          .map((memory) => memory.knowledgeBaseId)
          .filter((knowledgeBaseId): knowledgeBaseId is NonNullable<typeof knowledgeBaseId> => knowledgeBaseId !== undefined)
      )
    );
    const knowledgeBasesById = new Map(
      (
        await Promise.all(
          knowledgeBaseIds.map(async (knowledgeBaseId) => {
            const knowledgeBase = await ctx.db.get(knowledgeBaseId);
            return knowledgeBase ? [String(knowledgeBase._id), knowledgeBase] as const : null;
          })
        )
      ).filter((entry): entry is readonly [string, any] => entry !== null)
    );

    return memories
      .filter((memory) => {
        if (memory.knowledgeBaseId) {
          const knowledgeBase = knowledgeBasesById.get(String(memory.knowledgeBaseId));
          return Boolean(
            knowledgeBase && isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, guardChannel)
          );
        }
        return isNonKnowledgeBaseMemoryVisibleInChannel(memory.channel, channel);
      })
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, fetch);
  },
});
