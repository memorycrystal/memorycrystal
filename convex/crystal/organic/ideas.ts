/**
 * Organic Ideas — discoveries surfaced by the pulse engine.
 * Ideas are cross-memory connections, patterns, contradictions, insights,
 * and action suggestions that the organic engine identifies autonomously.
 */
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  QueryCtx,
  MutationCtx,
} from "../../_generated/server";
import { stableUserId } from "../auth";

const ideaStatusValidator = v.union(
  v.literal("pending_notification"),
  v.literal("notified"),
  v.literal("read"),
  v.literal("dismissed"),
  v.literal("starred")
);

const dashboardIdeaStatusValidator = v.union(
  v.literal("pending_notification"),
  v.literal("notified"),
  v.literal("read"),
  v.literal("dismissed"),
  v.literal("starred")
);

const ideaTypeValidator = v.union(
  v.literal("connection"),
  v.literal("pattern"),
  v.literal("contradiction_resolved"),
  v.literal("insight"),
  v.literal("action_suggested")
);

const ideaCursorValidator = v.object({
  createdAt: v.number(),
  id: v.id("organicIdeas"),
});

// ── Internal mutations (called from pulse fibers) ──────────────────────────

export const createIdea = internalMutation({
  args: {
    userId: v.string(),
    title: v.string(),
    summary: v.string(),
    ideaType: ideaTypeValidator,
    sourceMemoryIds: v.array(v.id("crystalMemories")),
    sourceEnsembleIds: v.optional(v.array(v.id("organicEnsembles"))),
    confidence: v.float64(),
    pulseId: v.string(),
    fiberId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    for (const memoryId of args.sourceMemoryIds) {
      const memory = await ctx.db.get(memoryId);
      if (!memory || memory.userId !== args.userId) {
        throw new Error("sourceMemoryIds must belong to the idea owner");
      }
    }

    for (const ensembleId of args.sourceEnsembleIds ?? []) {
      const ensemble = await ctx.db.get(ensembleId);
      if (!ensemble || ensemble.userId !== args.userId) {
        throw new Error("sourceEnsembleIds must belong to the idea owner");
      }
    }

    const now = Date.now();
    return ctx.db.insert("organicIdeas", {
      userId: args.userId,
      title: args.title,
      summary: args.summary,
      ideaType: args.ideaType,
      sourceMemoryIds: args.sourceMemoryIds,
      sourceEnsembleIds: args.sourceEnsembleIds,
      confidence: args.confidence,
      status: "pending_notification",
      pulseId: args.pulseId,
      fiberId: args.fiberId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// ── Public queries (dashboard) ─────────────────────────────────────────────

export const getMyIdeas = query({
  args: {
    status: v.optional(ideaStatusValidator),
    ideaType: v.optional(ideaTypeValidator),
    limit: v.optional(v.number()),
    cursor: v.optional(ideaCursorValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { ideas: [], nextCursor: null };
    const userId = stableUserId(identity.subject);
    const limit = Number.isFinite(args.limit) && (args.limit as number) > 0 ? Math.min(20, Math.max(1, Math.floor(args.limit as number))) : 50;

    let q;
    if (args.status && args.ideaType) {
      q = ctx.db
        .query("organicIdeas")
        .withIndex("by_user_type", (idx) =>
          idx
            .eq("userId", userId)
            .eq("ideaType", args.ideaType!)
            .eq("status", args.status!)
        );
    } else if (args.status) {
      q = ctx.db
        .query("organicIdeas")
        .withIndex("by_user_status", (idx) =>
          idx.eq("userId", userId).eq("status", args.status!)
        );
    } else {
      q = ctx.db
        .query("organicIdeas")
        .withIndex("by_user_created", (idx) =>
          idx.eq("userId", userId)
        );
    }

    if (args.cursor) {
      q = q.filter((doc) =>
        doc.or(
          doc.lt(doc.field("createdAt"), args.cursor!.createdAt),
          doc.and(
            doc.eq(doc.field("createdAt"), args.cursor!.createdAt),
            doc.lt(doc.field("_id"), args.cursor!.id)
          )
        )
      );
    }

    const ideas = await q.order("desc").take(limit + 1);
    const hasMore = ideas.length > limit;
    const page = hasMore ? ideas.slice(0, limit) : ideas;
    const nextCursor = hasMore
      ? {
          createdAt: page[page.length - 1].createdAt,
          id: page[page.length - 1]._id,
        }
      : null;

    return { ideas: page, nextCursor };
  },
});

// ── Public query: pending ideas for plugin injection ───────────────────────

export const getPendingIdeas = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);

    return ctx.db
      .query("organicIdeas")
      .withIndex("by_user_status", (idx) =>
        idx.eq("userId", userId).eq("status", "pending_notification")
      )
      .order("desc")
      .take(10);
  },
});

// ── Public mutation: update idea status ────────────────────────────────────

export const setIdeaStarred = mutation({
  args: {
    ideaId: v.id("organicIdeas"),
    starred: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = stableUserId(identity.subject);

    const idea = await ctx.db.get(args.ideaId);
    if (!idea || idea.userId !== userId) {
      throw new Error("Idea not found");
    }

    await ctx.db.patch(args.ideaId, {
      starredAt: args.starred ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
    return { success: true, starred: args.starred };
  },
});

function buildIdeaStatusPatch(
  idea: {
    notifiedAt?: number;
    readAt?: number;
    dismissedAt?: number;
  },
  status: "pending_notification" | "notified" | "read" | "dismissed" | "starred",
  now: number
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    updatedAt: now,
  };

  if (status === "starred") {
    patch.starredAt = now;
    return patch;
  }

  patch.status = status;

  if (status === "pending_notification") {
    patch.notifiedAt = undefined;
    patch.emailDigestSentAt = undefined;
    patch.readAt = undefined;
    patch.dismissedAt = undefined;
    return patch;
  }

  if (status === "notified") {
    patch.notifiedAt = idea.notifiedAt ?? now;
    patch.readAt = undefined;
    patch.dismissedAt = undefined;
    return patch;
  }

  if (status === "read") {
    patch.notifiedAt = idea.notifiedAt ?? now;
    patch.readAt = now;
    patch.dismissedAt = undefined;
    return patch;
  }

  patch.notifiedAt = idea.notifiedAt ?? now;
  patch.readAt = idea.readAt ?? now;
  patch.dismissedAt = now;
  return patch;
}

export const updateIdeaStatus = mutation({
  args: {
    ideaId: v.id("organicIdeas"),
    status: dashboardIdeaStatusValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = stableUserId(identity.subject);

    const idea = await ctx.db.get(args.ideaId);
    if (!idea || idea.userId !== userId) {
      throw new Error("Idea not found");
    }

    const now = Date.now();
    const patch = buildIdeaStatusPatch(idea, args.status, now);

    await ctx.db.patch(args.ideaId, patch);
    return { success: true };
  },
});

// ── Public mutation: batch mark ideas as notified (plugin injection) ───────

export const markIdeasNotified = mutation({
  args: {
    ideaIds: v.array(v.id("organicIdeas")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = stableUserId(identity.subject);

    const now = Date.now();
    let marked = 0;
    for (const ideaId of args.ideaIds) {
      const idea = await ctx.db.get(ideaId);
      if (!idea || idea.userId !== userId) continue;
      if (idea.status !== "pending_notification") continue;

      await ctx.db.patch(ideaId, {
        status: "notified",
        notifiedAt: idea.notifiedAt ?? now,
        emailDigestSentAt: now,
        updatedAt: now,
      });
      marked++;
    }

    return { marked };
  },
});

// ── Internal query: ideas for email digest ─────────────────────────────────

export const getIdeasForEmailDigest = internalQuery({
  args: {
    userId: v.string(),
    windowStart: v.number(),
  },
  handler: async (ctx, args) => {
    const pendingIdeas = await ctx.db
      .query("organicIdeas")
      .withIndex("by_user_status", (idx) =>
        idx.eq("userId", args.userId).eq("status", "pending_notification")
      )
      .take(50);

    const surfacedIdeas = await ctx.db
      .query("organicIdeas")
      .withIndex("by_user_status", (idx) =>
        idx.eq("userId", args.userId).eq("status", "notified")
      )
      .take(50);

    return [...pendingIdeas, ...surfacedIdeas].filter(
      (idea) => idea.createdAt >= args.windowStart && !idea.emailDigestSentAt
    );
  },
});

// ── Internal mutation: batch mark notified (used by email digest) ──────────

export const markIdeasNotifiedInternal = internalMutation({
  args: {
    ideaIds: v.array(v.id("organicIdeas")),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const ideaId of args.ideaIds) {
      const idea = await ctx.db.get(ideaId);
      if (!idea || idea.userId !== args.userId) continue;
      if (idea.status !== "pending_notification" && idea.status !== "notified") continue;

      await ctx.db.patch(ideaId, {
        status: idea.status === "pending_notification" ? "notified" : idea.status,
        notifiedAt: idea.notifiedAt ?? now,
        emailDigestSentAt: now,
        updatedAt: now,
      });
    }
  },
});

// ── Internal variants for HTTP endpoints (API key auth, userId passed in) ──

const VALID_STATUSES = ["pending_notification", "notified", "read", "dismissed", "starred"];
const VALID_IDEA_TYPES = ["connection", "pattern", "contradiction_resolved", "insight", "action_suggested", "skill_suggestion"];

export async function listIdeasForUser(
  ctx: any,
  userId: string,
  status?: string,
  ideaType?: string,
  limit?: number,
  cursor?: { createdAt: number; id: string }
) {
  if (status && !VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Valid: ${VALID_STATUSES.join(", ")}`);
  }
  if (ideaType && !VALID_IDEA_TYPES.includes(ideaType)) {
    throw new Error(`Invalid ideaType: ${ideaType}. Valid: ${VALID_IDEA_TYPES.join(", ")}`);
  }

  const take = Number.isFinite(limit) && (limit as number) > 0 ? Math.min(20, Math.max(1, Math.floor(limit as number))) : 50;

  if (status === "starred") {
    const starredPool = await ctx.db
      .query("organicIdeas")
      .withIndex("by_user_created", (idx: any) => idx.eq("userId", userId))
      .order("desc")
      .take(take * 4);
    const filtered = starredPool.filter((idea: any) => idea.starredAt !== undefined && (!ideaType || idea.ideaType === ideaType));
    return { ideas: filtered.slice(0, take), nextCursor: null };
  }

  let q;
  if (status && ideaType) {
    q = ctx.db
      .query("organicIdeas")
      .withIndex("by_user_type", (idx: any) =>
        idx
          .eq("userId", userId)
          .eq("ideaType", ideaType as any)
          .eq("status", status as any)
      );
  } else if (status) {
    q = ctx.db
      .query("organicIdeas")
      .withIndex("by_user_status", (idx: any) =>
        idx.eq("userId", userId).eq("status", status as any)
      );
  } else {
    q = ctx.db
      .query("organicIdeas")
      .withIndex("by_user_created", (idx: any) => idx.eq("userId", userId));
  }

  if (cursor) {
    q = q.filter((doc: any) =>
      doc.or(
        doc.lt(doc.field("createdAt"), cursor.createdAt),
        doc.and(
          doc.eq(doc.field("createdAt"), cursor.createdAt),
          doc.lt(doc.field("_id"), cursor.id)
        )
      )
    );
  }

  const ideas = await q.order("desc").take(take + 1);
  const hasMore = ideas.length > take;
  const page = hasMore ? ideas.slice(0, take) : ideas;
  const nextCursor = hasMore
    ? {
        createdAt: page[page.length - 1].createdAt,
        id: page[page.length - 1]._id,
      }
    : null;

  return { ideas: page, nextCursor };
}

export const getMyIdeasInternal = internalQuery({
  args: {
    userId: v.string(),
    status: v.optional(v.string()),
    ideaType: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(ideaCursorValidator),
  },
  handler: async (ctx, args) => {
    return listIdeasForUser(
      ctx,
      args.userId,
      args.status ?? undefined,
      args.ideaType ?? undefined,
      args.limit ?? undefined,
      args.cursor ?? undefined
    );
  },
});

export const getPendingIdeasInternal = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicIdeas")
      .withIndex("by_user_status", (idx) =>
        idx.eq("userId", args.userId).eq("status", "pending_notification")
      )
      .order("desc")
      .take(10);
  },
});

export const updateIdeaStatusInternal = internalMutation({
  args: {
    userId: v.string(),
    ideaId: v.id("organicIdeas"),
    status: dashboardIdeaStatusValidator,
  },
  handler: async (ctx, args) => {
    const idea = await ctx.db.get(args.ideaId);
    if (!idea || idea.userId !== args.userId) {
      throw new Error("Idea not found");
    }

    const now = Date.now();
    const patch = buildIdeaStatusPatch(idea, args.status, now);

    await ctx.db.patch(args.ideaId, patch);
    return { success: true };
  },
});

export const updateIdeaStatusesInternal = internalMutation({
  args: {
    userId: v.string(),
    ideaIds: v.array(v.id("organicIdeas")),
    status: v.union(
      v.literal("pending_notification"),
      v.literal("notified"),
      v.literal("read"),
      v.literal("dismissed"),
      v.literal("starred")
    ),
  },
  handler: async (ctx, args) => {
    const ideas = await Promise.all(args.ideaIds.map((ideaId) => ctx.db.get(ideaId)));
    if (ideas.some((idea) => !idea || idea.userId !== args.userId)) {
      throw new Error("Idea not found");
    }

    if (args.status === "notified" && ideas.some((idea) => idea?.status !== "pending_notification")) {
      throw new Error("Idea is not pending notification");
    }

    const now = Date.now();
    for (const [index, ideaId] of args.ideaIds.entries()) {
      const idea = ideas[index]!;
      const patch = buildIdeaStatusPatch(idea, args.status, now);

      await ctx.db.patch(ideaId, patch);
    }

    return { success: true, updated: args.ideaIds.length };
  },
});
