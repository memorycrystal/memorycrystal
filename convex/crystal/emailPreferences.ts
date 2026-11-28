import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { stableUserId } from "./auth";

const sourceValidator = v.union(v.literal("link"), v.literal("one_click"), v.literal("settings"));

async function getOrCreate(ctx: MutationCtx, userId: string) {
  const existing = await ctx.db.query("crystalEmailPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const unsubscribeToken = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const id = await ctx.db.insert("crystalEmailPreferences", { userId, unsubscribeToken, updatedAt: Date.now() });
  return (await ctx.db.get(id))!;
}

async function setOptOut(ctx: MutationCtx, userId: string, optedOut: boolean, source: "link" | "one_click" | "settings") {
  const preferences = await getOrCreate(ctx, userId);
  await ctx.db.patch(preferences._id, {
    engagementOptOutAt: optedOut ? preferences.engagementOptOutAt ?? Date.now() : undefined,
    engagementOptOutSource: optedOut
      ? preferences.engagementOptOutAt === undefined ? source : preferences.engagementOptOutSource
      : undefined,
    updatedAt: Date.now(),
  });
}

export const getOrCreateUnsubscribeToken = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => (await getOrCreate(ctx, userId)).unsubscribeToken,
});

export const isEngagementOptedOut = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const preferences = await ctx.db.query("crystalEmailPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    return preferences?.engagementOptOutAt !== undefined;
  },
});

export const setEngagementOptOut = internalMutation({
  args: { userId: v.string(), optedOut: v.boolean(), source: sourceValidator },
  handler: async (ctx, { userId, optedOut, source }) => setOptOut(ctx, userId, optedOut, source),
});

export const unsubscribeByToken = internalMutation({
  args: { token: v.string(), source: sourceValidator },
  handler: async (ctx, { token, source }) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const preferences = await ctx.db.query("crystalEmailPreferences")
      .withIndex("by_token", (q) => q.eq("unsubscribeToken", token)).unique();
    if (preferences) await setOptOut(ctx, preferences.userId, true, source);
  },
});

export const getMyPreferences = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const preferences = await ctx.db.query("crystalEmailPreferences")
      .withIndex("by_user", (q) => q.eq("userId", stableUserId(identity.subject))).unique();
    return { engagementOptOutAt: preferences?.engagementOptOutAt };
  },
});

export const setMyEngagementOptOut = mutation({
  args: { optedOut: v.boolean() },
  handler: async (ctx, { optedOut }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    await setOptOut(ctx, stableUserId(identity.subject), optedOut, "settings");
  },
});
