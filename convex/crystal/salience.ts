import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { type Id } from "../_generated/dataModel";
import {
  applyDashboardTotalsDelta,
  buildMemoryTransitionDelta,
} from "./dashboardTotals";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const categoryBonusByCategory: Record<string, number> = {
  decision: 0.2,
  lesson: 0.18,
  goal: 0.15,
  person: 0.12,
  rule: 0.12,
  skill: 0.14,
  workflow: 0.1,
  fact: 0.08,
  event: 0.05,
  conversation: 0.0,
};

const storeBonusByStore: Record<string, number> = {
  semantic: 0.15,
  procedural: 0.12,
  episodic: 0.08,
  prospective: 0.1,
  sensory: 0.0,
};

export const scoreSalience = ({ title, content, store, category, tags }: {
  title: string;
  content: string;
  store: string;
  category: string;
  tags: string[];
}): number => {
  const base = 0.3;

  const trimmedContent = typeof content === "string" ? content.trim() : "";
  const wordCount = trimmedContent ? trimmedContent.split(/\s+/).length : 0;
  const lengthBonus = Math.min(wordCount / 200, 0.15);

  const combinedText = `${title ?? ""} ${trimmedContent}`.toLowerCase();
  const decisionBonus = /decided|decision|chose|agreed|confirmed|going with/i.test(combinedText) ? 0.15 : 0;
  const lessonBonus = /learned|lesson|mistake|should have|next time|always|never|pattern/i.test(combinedText) ? 0.12 : 0;
  const goalBonus = /goal|target|milestone|deadline|must|need to|plan to|will build/i.test(combinedText) ? 0.12 : 0;

  const categoryBonus = categoryBonusByCategory[category] ?? 0;
  const storeBonus = storeBonusByStore[store] ?? 0;

  const entityMatches = (trimmedContent.match(/\b[A-Z][a-z]+\b/g) || []).length;
  const entityBonus = Math.min(entityMatches / 20, 0.08);

  const tagBonus = Math.min((tags ?? []).length * 0.02, 0.08);

  const total =
    base + lengthBonus + decisionBonus + lessonBonus + goalBonus + categoryBonus + storeBonus + entityBonus + tagBonus;

  return clamp01(total);
};

export const computeAndStoreSalience = internalMutation({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, { memoryId }: { memoryId: Id<"crystalMemories"> }) => {
    const memory = await ctx.db.get(memoryId);
    if (!memory) {
      return { salienceScore: 0 };
    }

    const salienceScore = scoreSalience({
      title: memory.title,
      content: memory.content,
      store: memory.store,
      category: memory.category,
      tags: memory.tags ?? [],
    });

    await ctx.db.patch(memoryId, { salienceScore });
    return { salienceScore };
  },
});

export const getLowSalienceMemoriesForPromotion = internalQuery({
  args: {
    userId: v.string(),
    store: v.string(),
    limit: v.number(),
    maxSalienceScore: v.float64(),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 200);
    const fetchLimit = limit * 4;

    const candidates = await ctx.db
      .query("crystalMemories")
      .withIndex("by_salience", (q) =>
        q.eq("userId", args.userId).lte("salienceScore", args.maxSalienceScore)
      )
      .filter((q) => q.eq(q.field("archived"), false))
      .filter((q) => q.eq(q.field("store"), args.store))
      .take(fetchLimit);

    return candidates
      .filter((memory) => {
        if (memory.salienceScore === undefined) return false;
        return true;
      })
      .slice(0, limit);
  },
});

export const promoteLowSalienceMemory = internalMutation({
  args: {
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    salienceScore: v.float64(),
    strength: v.float64(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.userId !== args.userId) {
      return;
    }

    const previousStore = existing.store;

    const updates: Record<string, unknown> = {
      store: "episodic",
      salienceScore: clamp01(args.salienceScore),
      strength: clamp01(args.strength),
    };

    if (previousStore !== "episodic") {
      await applyDashboardTotalsDelta(
        ctx,
        existing.userId,
        buildMemoryTransitionDelta({
          oldArchived: false,
          oldStore: previousStore,
          newArchived: false,
          newStore: "episodic",
        })
      );
    }

    await ctx.db.patch(args.memoryId, updates);
  },
});

export const decayLowSalienceMemory = internalMutation({
  args: {
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    archivedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.memoryId);
    if (!existing || existing.userId !== args.userId || existing.archived) {
      return;
    }

    await applyDashboardTotalsDelta(
      ctx,
      existing.userId,
      buildMemoryTransitionDelta({
        oldArchived: false,
        oldStore: existing.store,
        newArchived: true,
        newStore: existing.store,
      })
    );

    await ctx.db.patch(args.memoryId, {
      archived: true,
      archivedAt: args.archivedAt ?? Date.now(),
    });
  },
});
