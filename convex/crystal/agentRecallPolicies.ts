import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { normalizeAgentStamp } from "./agentStamp";

export function policyAgentKey(agentId: string): string {
  const key = normalizeAgentStamp(agentId)?.toLowerCase();
  if (!key) throw new ConvexError("agentId must normalize to a non-empty stamp");
  return key;
}

function normalizeList(values: string[], stamps: boolean): string[] {
  if (values.length > 20) throw new ConvexError("at most 20 entries are allowed");
  return [...new Set(values.map((value) => {
    if (stamps) return policyAgentKey(value);
    const prefix = value.trim().toLowerCase();
    if (!prefix || prefix.length > 200) throw new ConvexError("channel prefixes must contain 1 to 200 characters");
    return prefix;
  }))];
}

export const getAgentRecallPolicy = internalQuery({
  args: { userId: v.string(), agentId: v.string() },
  handler: (ctx, { userId, agentId }) => ctx.db.query("crystalAgentRecallPolicies")
    .withIndex("by_user_agent", (q) => q.eq("userId", userId).eq("agentKey", policyAgentKey(agentId))).unique(),
});

export const setAgentRecallPolicy = internalMutation({
  args: {
    userId: v.string(), agentId: v.string(), extraStamps: v.optional(v.array(v.string())),
    extraChannelPrefixes: v.optional(v.array(v.string())), includeShared: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const agentKey = policyAgentKey(args.agentId);
    const previous = await ctx.db.query("crystalAgentRecallPolicies")
      .withIndex("by_user_agent", (q) => q.eq("userId", args.userId).eq("agentKey", agentKey)).unique();
    const fields = {
      userId: args.userId, agentKey,
      extraStamps: args.extraStamps === undefined ? previous?.extraStamps ?? [] : normalizeList(args.extraStamps, true),
      extraChannelPrefixes: args.extraChannelPrefixes === undefined ? previous?.extraChannelPrefixes ?? [] : normalizeList(args.extraChannelPrefixes, false),
      includeShared: args.includeShared ?? previous?.includeShared ?? true,
      updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
    };
    if (previous) { await ctx.db.patch(previous._id, fields); return previous._id; }
    return ctx.db.insert("crystalAgentRecallPolicies", { ...fields, createdAt: Date.now() });
  },
});

export const clearAgentRecallPolicy = internalMutation({
  args: { userId: v.string(), agentId: v.string() },
  handler: async (ctx, { userId, agentId }) => {
    const previous = await ctx.db.query("crystalAgentRecallPolicies")
      .withIndex("by_user_agent", (q) => q.eq("userId", userId).eq("agentKey", policyAgentKey(agentId))).unique();
    if (previous) await ctx.db.delete(previous._id);
  },
});
