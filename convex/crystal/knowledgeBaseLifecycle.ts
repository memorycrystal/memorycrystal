import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";

const operation = v.union(v.literal("archive"), v.literal("delete"), v.literal("reindex"), v.literal("recount"));
const PAGE_SIZE = 50;

export const startInternal = internalMutation({
  args: { userId: v.string(), knowledgeBaseId: v.id("knowledgeBases"), operation },
  handler: async (ctx, args) => {
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== args.userId) throw new Error("Knowledge base not found");
    const existing = await ctx.db.query("crystalKnowledgeBaseLifecycleJobs")
      .withIndex("by_user_kb_operation", (q) => q.eq("userId", args.userId).eq("knowledgeBaseId", args.knowledgeBaseId).eq("operation", args.operation))
      .order("desc").first();
    if (existing && ["queued", "running", "paused"].includes(existing.status)) return { jobId: existing._id, created: false };
    const now = Date.now();
    const jobId = await ctx.db.insert("crystalKnowledgeBaseLifecycleJobs", {
      ...args, status: "queued", processedCount: 0, totalChars: 0, createdAt: now, updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, (internal as any).crystal.knowledgeBaseLifecycle.processInternal, { jobId });
    return { jobId, created: true };
  },
});

export const getInternal = internalQuery({
  args: { userId: v.optional(v.string()), jobId: v.id("crystalKnowledgeBaseLifecycleJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || (args.userId && job.userId !== args.userId)) return null;
    return job;
  },
});

export const setStateInternal = internalMutation({
  args: {
    userId: v.string(), jobId: v.id("crystalKnowledgeBaseLifecycleJobs"),
    state: v.union(v.literal("paused"), v.literal("queued"), v.literal("cancelled")),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userId !== args.userId) throw new Error("Knowledge-base lifecycle job not found");
    if (job.status === "completed" || job.status === "cancelled") return { status: job.status };
    await ctx.db.patch(job._id, { status: args.state, updatedAt: Date.now() });
    if (args.state === "queued") await ctx.scheduler.runAfter(0, (internal as any).crystal.knowledgeBaseLifecycle.processInternal, { jobId: job._id });
    return { status: args.state };
  },
});

export const scanPageInternal = internalQuery({
  args: { userId: v.string(), knowledgeBaseId: v.id("knowledgeBases"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("crystalMemories")
      .withIndex("by_knowledge_base", (q) => q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId).eq("archived", false))
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE, maximumBytesRead: 4 * 1024 * 1024 });
    return {
      count: page.page.length,
      totalChars: page.page.reduce((sum, memory) => sum + (memory.content?.length ?? 0), 0),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const resetIndexPageInternal = internalMutation({
  args: { userId: v.string(), knowledgeBaseId: v.id("knowledgeBases"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("crystalMemories")
      .withIndex("by_knowledge_base", (q) => q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId).eq("archived", false))
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE, maximumBytesRead: 4 * 1024 * 1024 });
    for (const memory of page.page) {
      await ctx.db.patch(memory._id, {
        embedding: [], graphEnriched: false, graphEnrichedAt: undefined,
        enrichmentAttempts: 0, enrichmentSkippedReason: undefined,
      });
    }
    return { processed: page.page.length, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const advanceInternal = internalMutation({
  args: {
    jobId: v.id("crystalKnowledgeBaseLifecycleJobs"), status: v.optional(v.union(v.literal("running"), v.literal("completed"), v.literal("failed"))),
    cursor: v.optional(v.string()), processedDelta: v.optional(v.number()), charsDelta: v.optional(v.number()),
    error: v.optional(v.string()), clearCursor: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: args.status ?? job.status,
      cursor: args.clearCursor ? undefined : args.cursor ?? job.cursor,
      processedCount: job.processedCount + Math.max(0, Math.trunc(args.processedDelta ?? 0)),
      totalChars: job.totalChars + Math.max(0, Math.trunc(args.charsDelta ?? 0)),
      lastError: args.error,
      updatedAt: now,
      completedAt: args.status === "completed" ? now : job.completedAt,
    });
    return { ...job, status: args.status ?? job.status };
  },
});

export const patchExactCountInternal = internalMutation({
  args: { userId: v.string(), knowledgeBaseId: v.id("knowledgeBases"), memoryCount: v.number(), totalChars: v.number() },
  handler: async (ctx, args) => {
    const kb = await ctx.db.get(args.knowledgeBaseId);
    if (!kb || kb.userId !== args.userId) throw new Error("Knowledge base not found");
    await ctx.db.patch(kb._id, { memoryCount: args.memoryCount, totalChars: args.totalChars, updatedAt: Date.now() });
  },
});

export const processInternal: any = internalAction({
  args: { jobId: v.id("crystalKnowledgeBaseLifecycleJobs") },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const job: any = await ctx.runQuery((internal as any).crystal.knowledgeBaseLifecycle.getInternal, { jobId: args.jobId });
    if (!job) return { status: "missing" };
    if (["paused", "cancelled", "completed", "failed"].includes(job.status)) return { status: job.status };
    await ctx.runMutation((internal as any).crystal.knowledgeBaseLifecycle.advanceInternal, { jobId: job._id, status: "running" });
    try {
      let done = false;
      let processed = 0;
      let chars = 0;
      let cursor = job.cursor as string | undefined;
      if (job.operation === "archive") {
        const result = await ctx.runMutation(internal.crystal.knowledgeBases.archiveKnowledgeBaseBatchInternal, {
          userId: job.userId, knowledgeBaseId: job.knowledgeBaseId, batch: PAGE_SIZE,
        });
        processed = result.archived;
        done = result.done;
        if (result.dashboardDelta && Object.keys(result.dashboardDelta).length > 0) {
          await ctx.runMutation(internal.crystal.knowledgeBases.applyKnowledgeBaseDashboardTotalsDeltaInternal, { userId: job.userId, delta: result.dashboardDelta });
        }
      } else if (job.operation === "delete") {
        const result = await ctx.runMutation(internal.crystal.knowledgeBases.purgeKnowledgeBaseBatchInternal, {
          userId: job.userId, knowledgeBaseId: job.knowledgeBaseId, batch: PAGE_SIZE,
        });
        processed = result.deleted;
        done = result.done;
        if (result.dashboardDelta && Object.keys(result.dashboardDelta).length > 0) {
          await ctx.runMutation(internal.crystal.knowledgeBases.applyKnowledgeBaseDashboardTotalsDeltaInternal, { userId: job.userId, delta: result.dashboardDelta });
        }
      } else if (job.operation === "recount") {
        const result = await ctx.runQuery((internal as any).crystal.knowledgeBaseLifecycle.scanPageInternal, {
          userId: job.userId, knowledgeBaseId: job.knowledgeBaseId, cursor,
        });
        processed = result.count;
        chars = result.totalChars;
        cursor = result.continueCursor;
        done = result.isDone;
        if (done) {
          await ctx.runMutation((internal as any).crystal.knowledgeBaseLifecycle.patchExactCountInternal, {
            userId: job.userId, knowledgeBaseId: job.knowledgeBaseId,
            memoryCount: job.processedCount + processed, totalChars: job.totalChars + chars,
          });
        }
      } else {
        const result = await ctx.runMutation((internal as any).crystal.knowledgeBaseLifecycle.resetIndexPageInternal, {
          userId: job.userId, knowledgeBaseId: job.knowledgeBaseId, cursor,
        });
        processed = result.processed;
        cursor = result.continueCursor;
        done = result.isDone;
        if (done) {
          await ctx.scheduler.runAfter(0, internal.crystal.knowledgeBases.backfillKBEmbeddings, {
            userId: job.userId, knowledgeBaseId: job.knowledgeBaseId,
          });
          await ctx.scheduler.runAfter(0, internal.crystal.knowledgeBases.backfillKBGraphEnrichment, {
            userId: job.userId, knowledgeBaseId: job.knowledgeBaseId,
          });
        }
      }
      await ctx.runMutation((internal as any).crystal.knowledgeBaseLifecycle.advanceInternal, {
        jobId: job._id, status: done ? "completed" : "running", cursor,
        processedDelta: processed, charsDelta: chars, clearCursor: done,
      });
      if (!done) await ctx.scheduler.runAfter(100, (internal as any).crystal.knowledgeBaseLifecycle.processInternal, { jobId: job._id });
      return { status: done ? "completed" : "running" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation((internal as any).crystal.knowledgeBaseLifecycle.advanceInternal, { jobId: job._id, status: "failed", error: message });
      return { status: "failed" };
    }
  },
});
