import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query } from "../_generated/server";
import { stableUserId } from "./auth";

export const frontendJobKind = v.union(
  v.literal("knowledge_import"),
  v.literal("knowledge_archive"),
  v.literal("knowledge_delete"),
  v.literal("reflection_dry_run"),
  v.literal("reflection_cleanup"),
  v.literal("organic_pulse"),
  v.literal("asset_processing"),
);

export const frontendJobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export const createInternal = internalMutation({
  args: {
    userId: v.string(),
    kind: frontendJobKind,
    resourceId: v.string(),
    title: v.string(),
    route: v.optional(v.string()),
    progressTotal: v.optional(v.number()),
    progressLabel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("crystalFrontendJobs")
      .withIndex("by_user_kind_resource_updated", (q) =>
        q.eq("userId", args.userId).eq("kind", args.kind).eq("resourceId", args.resourceId),
      )
      .order("desc")
      .first();
    if (existing && ACTIVE_STATUSES.has(existing.status)) {
      return { jobId: existing._id, created: false };
    }

    const now = Date.now();
    const jobId = await ctx.db.insert("crystalFrontendJobs", {
      ...args,
      title: args.title.trim().slice(0, 160),
      status: "queued",
      progressCurrent: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { jobId, created: true };
  },
});

export const updateInternal = internalMutation({
  args: {
    jobId: v.id("crystalFrontendJobs"),
    userId: v.optional(v.string()),
    status: v.optional(frontendJobStatus),
    progressCurrent: v.optional(v.number()),
    progressTotal: v.optional(v.number()),
    progressLabel: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || (args.userId && job.userId !== args.userId)) return null;
    const now = Date.now();
    const nextStatus = args.status ?? job.status;
    if (TERMINAL_STATUSES.has(job.status) && ACTIVE_STATUSES.has(nextStatus)) {
      return { jobId: job._id, status: job.status };
    }
    await ctx.db.patch(job._id, {
      status: nextStatus,
      progressCurrent: args.progressCurrent ?? job.progressCurrent,
      progressTotal: args.progressTotal ?? job.progressTotal,
      progressLabel: args.progressLabel ?? job.progressLabel,
      error: args.error !== undefined ? args.error.slice(0, 1000) : job.error,
      startedAt:
        nextStatus === "running" && job.startedAt === undefined ? now : job.startedAt,
      completedAt:
        ["completed", "failed", "cancelled"].includes(nextStatus)
          ? job.completedAt ?? now
          : job.completedAt,
      updatedAt: now,
    });
    return { jobId: job._id, status: nextStatus };
  },
});

export const listMyRecent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);
    const [undismissed, queued, running] = await Promise.all([
      ctx.db
        .query("crystalFrontendJobs")
        .withIndex("by_user_dismissed_updated", (q) =>
          q.eq("userId", userId).eq("dismissedAt", undefined),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("crystalFrontendJobs")
        .withIndex("by_user_status_updated", (q) =>
          q.eq("userId", userId).eq("status", "queued"),
        )
        .order("desc")
        .take(10),
      ctx.db
        .query("crystalFrontendJobs")
        .withIndex("by_user_status_updated", (q) =>
          q.eq("userId", userId).eq("status", "running"),
        )
        .order("desc")
        .take(10),
    ]);
    return Array.from(
      new Map([...undismissed, ...queued, ...running].map((job) => [String(job._id), job])).values(),
    ).sort((left, right) => right.updatedAt - left.updatedAt);
  },
});

export const dismissMyJob = mutation({
  args: { jobId: v.id("crystalFrontendJobs") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== userId) throw new Error("Job not found");
    await ctx.db.patch(job._id, { dismissedAt: Date.now() });
    return { dismissed: true };
  },
});

export const restoreMyJob = mutation({
  args: { jobId: v.id("crystalFrontendJobs") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== userId) throw new Error("Job not found");
    await ctx.db.patch(job._id, { dismissedAt: undefined, updatedAt: Date.now() });
    return { restored: true, jobId: job._id as Id<"crystalFrontendJobs"> };
  },
});
