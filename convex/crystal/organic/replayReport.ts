import { v } from "convex/values";
import { mutation, query } from "../../_generated/server";
import { stableUserId } from "../auth";
import { defaultRecallRankingWeights, type RecallRankingWeights } from "../recallRanking";

const MIN_WEIGHT = 0.02;
const MAX_WEIGHT = 0.5;
const WEIGHT_KEYS = [
  "vectorWeight",
  "strengthWeight",
  "freshnessWeight",
  "accessWeight",
  "salienceWeight",
  "continuityWeight",
  "textMatchWeight",
  "knowledgeBaseWeight",
] as const;

const weightsValidator = v.object({
  vectorWeight: v.float64(),
  strengthWeight: v.float64(),
  freshnessWeight: v.float64(),
  accessWeight: v.float64(),
  salienceWeight: v.float64(),
  continuityWeight: v.float64(),
  textMatchWeight: v.float64(),
  knowledgeBaseWeight: v.optional(v.float64()),
});

/**
 * Normalize weights to sum to 1.0 while preserving ratios.
 */
function normalizeWeights(raw: Record<string, number>): RecallRankingWeights {
  const sum = WEIGHT_KEYS.reduce((acc, k) => acc + (raw[k] ?? 0), 0);
  if (sum === 0) return { ...defaultRecallRankingWeights };
  const result = {} as Record<string, number>;
  for (const k of WEIGHT_KEYS) {
    result[k] = (raw[k] ?? 0) / sum;
  }
  return result as unknown as RecallRankingWeights;
}

// ── Queries ──────────────────────────────────────────────────────────

export const getMyReplayReports = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);
    const limit = Math.min(args.limit ?? 10, 50);

    const reports = await ctx.db
      .query("organicReplayReports")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);

    return reports.map((report, index) => {
      const previous = reports[index + 1] ?? null;
      const weekOverWeekDelta = previous
        ? report.compositeScore - previous.compositeScore
        : undefined;
      return { ...report, weekOverWeekDelta };
    });
  },
});

export const getMyPolicyHistory = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);

    return ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_generation", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
  },
});

// ── Mutations ────────────────────────────────────────────────────────

export const setMyPolicyLock = mutation({
  args: { locked: v.boolean() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = stableUserId(identity.subject);

    const active = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
      .first();

    const now = Date.now();

    if (active) {
      await ctx.db.patch(active._id, { locked: args.locked, updatedAt: now });
      return { locked: args.locked, generation: active.generation };
    }

    // No active policy — create one from defaults with locked=true
    const defaults = defaultRecallRankingWeights;
    await ctx.db.insert("organicRecallPolicies", {
      userId,
      ...defaults,
      generation: 1,
      status: "active",
      locked: args.locked,
      createdAt: now,
      updatedAt: now,
    });
    return { locked: args.locked, generation: 1 };
  },
});

export const setMyPolicyWeights = mutation({
  args: { weights: weightsValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = stableUserId(identity.subject);

    // Validate bounds
    for (const key of WEIGHT_KEYS) {
      const val = (args.weights as Record<string, number | undefined>)[key];
      if (val == null) continue;
      if (val < MIN_WEIGHT || val > MAX_WEIGHT) {
        throw new Error(
          `Weight "${key}" must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}, got ${val}`,
        );
      }
    }

    const normalized = normalizeWeights(args.weights as unknown as Record<string, number>);
    const now = Date.now();
    const lastPolicy = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_generation", (q) => q.eq("userId", userId))
      .order("desc")
      .first();

    if (lastPolicy && now - lastPolicy.createdAt < 10_000) {
      throw new Error("Rate limited — please wait before updating weights again");
    }

    const active = await ctx.db
      .query("organicRecallPolicies")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
      .first();

    const nextGeneration = active ? active.generation + 1 : 1;

    if (active) {
      // Demote current active
      await ctx.db.patch(active._id, { status: "superseded", updatedAt: now });
    }

    await ctx.db.insert("organicRecallPolicies", {
      userId,
      ...normalized,
      generation: nextGeneration,
      status: "active",
      locked: true,
      createdAt: now,
      updatedAt: now,
    });

    return { generation: nextGeneration, weights: normalized };
  },
});
