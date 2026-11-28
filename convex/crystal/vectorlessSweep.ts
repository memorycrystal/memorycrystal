/** Operator-only recovery; all writes remain in the existing embedMemory path. */
import { ConvexError, v } from "convex/values";
import { internalAction, internalQuery, type QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { sha256Hex } from "./crypto";
import { getMemoryEffectiveText } from "./memoryText";

export const PAGE_SIZE = 10;
export const MAXIMUM_BYTES_READ = 512 * 1024;
// Legacy-size planning bound: 10 * (40 KiB memory + TWO 50 KiB sides).
export const EMBED_DELAY_MS = 100;
type Classification = "covered" | "vectorless" | "inline_only" | "duplicate_side" | "archived_or_inactive" | "empty_text";
async function classify(ctx: QueryCtx, row: Doc<"crystalMemories"> | null): Promise<Classification> {
  if (!row || row.archived === true || row.embeddingSource === "none") return "archived_or_inactive";
  // Same bounded lookup as getMemoryVector; duplicates are counted, not thrown.
  const sides = await ctx.db.query("crystalMemoryEmbeddings")
    .withIndex("by_memoryId", q => q.eq("memoryId", row._id)).take(2);
  if (sides.length > 1) return "duplicate_side";
  if (!getMemoryEffectiveText(row).trim()) return "empty_text";
  if (sides.length) return "covered";
  if (row.embedding?.length) return "inline_only";
  return "vectorless";
}
export const candidatePage = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    createdAfter: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, createdAfter }) => {
    const page = await ctx.db.query("crystalMemories").paginate({ cursor, numItems: PAGE_SIZE, maximumBytesRead: MAXIMUM_BYTES_READ });
    const items = [];
    for (const row of page.page) {
      if (createdAfter !== undefined && row._creationTime < createdAfter) continue;
      items.push({ memoryId: row._id, userId: row.userId, _creationTime: row._creationTime, classification: await classify(ctx, row) });
    }
    return { items, nextCursor: page.isDone ? null : page.continueCursor, done: page.isDone };
  },
});
export const recheck = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, { memoryId }) => classify(ctx, await ctx.db.get(memoryId)),
});
export const hasSide = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, { memoryId }) => (await ctx.db.query("crystalMemoryEmbeddings").withIndex("by_memoryId", q => q.eq("memoryId", memoryId)).take(2)).length > 0,
});
export const hasPersonalKey = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<boolean> => {
    const credential: { apiKey: string | null; source: "personal" | "shared" | null } = await ctx.runQuery(internal.crystal.providerSettings.resolveOpenRouterKeyForUser, {
      userId,
      includeShared: false,
    });
    return Boolean(credential.apiKey) && credential.source !== "shared";
  },
});
function bounded(value: number | undefined, fallback: number, max: number, min = 1) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error("invalid_budget");
  return n;
}
export type SweepResult = {
  counts: Record<string, number>; ages: Record<string, number>;
  nextCursor: string | null; resumeSkip: number; done: boolean;
  stoppedReason: "done" | "batch_limit" | "page_budget" | "embed_budget";
};
export const sweep = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())), skipRows: v.optional(v.number()), batchLimit: v.optional(v.number()),
    maxEmbeds: v.optional(v.number()), maxPages: v.optional(v.number()), dryRun: v.optional(v.boolean()),
    ownerHashes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<SweepResult> => {
    if (args.ownerHashes !== undefined && (
      args.ownerHashes.length < 1 || args.ownerHashes.length > 20 ||
      args.ownerHashes.some(ownerHash => !/^[0-9a-f]{12}$/.test(ownerHash))
    )) throw new Error("invalid_owner_scope");
    const ownerScope = args.ownerHashes === undefined ? undefined : new Set(args.ownerHashes);
    const batchLimit = bounded(args.batchLimit, 25, 100);
    const maxPages = bounded(args.maxPages, 50, 500);
    const maxEmbeds = bounded(args.maxEmbeds, 25, Number.MAX_SAFE_INTEGER, 0);
    const skipRows = bounded(args.skipRows, 0, PAGE_SIZE, 0);
    const dryRun = args.dryRun ?? true;
    const counts: Record<string, number> = { scanned: 0, pages: 0, attempted: 0, skipped_owner: 0 };
    const ages: Record<string, number> = { under_day: 0, day_to_week: 0, week_to_month: 0, over_month: 0 };
    const users = new Map<string, { skip?: string; failures: number }>();
    const ownerHashes = new Map<string, string>();
    const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
    let cursor = args.cursor ?? null;
    const result = (reason: SweepResult["stoppedReason"], nextCursor = cursor, resumeSkip = 0): SweepResult => ({ counts, ages, nextCursor, resumeSkip, done: reason === "done", stoppedReason: reason });
    const now = Date.now();
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await ctx.runQuery(internal.crystal.vectorlessSweep.candidatePage, { cursor });
      bump("pages");
      for (let itemIndex = pageIndex === 0 ? skipRows : 0; itemIndex < page.items.length; itemIndex++) {
        const item = page.items[itemIndex];
        bump("scanned"); bump(item.classification);
        if (item.classification !== "vectorless") continue;
        const days = (now - item._creationTime) / 86_400_000;
        const ageBucket = days < 1 ? "under_day" : days < 7 ? "day_to_week" : days < 30 ? "week_to_month" : "over_month";
        ages[ageBucket]++;
        if (ownerScope) {
          let ownerHash = ownerHashes.get(item.userId);
          if (!ownerHash) {
            ownerHash = (await sha256Hex(item.userId)).slice(0, 12);
            ownerHashes.set(item.userId, ownerHash);
          }
          if (!ownerScope.has(ownerHash)) { bump("skipped_owner"); continue; }
        }
        let user = users.get(item.userId);
        if (!user) {
          const hasKey = await ctx.runQuery(internal.crystal.vectorlessSweep.hasPersonalKey, { userId: item.userId });
          user = { failures: 0, ...(hasKey ? {} : { skip: "skipped_no_credential" }) };
          users.set(item.userId, user);
        }
        if (user.skip) { bump(user.skip); continue; }
        if (dryRun) continue;
        if (counts.attempted && counts.attempted < maxEmbeds) await new Promise(resolve => setTimeout(resolve, EMBED_DELAY_MS));
        if (await ctx.runQuery(internal.crystal.vectorlessSweep.recheck, { memoryId: item.memoryId }) !== "vectorless") { bump("state_changed"); user.failures = 0; continue; }
        // Skips and changed rows need no allowance. If the next actual attempt
        // would exceed it, resume this page at the still-unprocessed row.
        if (counts.attempted >= maxEmbeds) {
          // The current row is still unprocessed. Exclude its observation from
          // this invocation so a resumed invocation counts it exactly once.
          counts.scanned--;
          counts.vectorless--;
          ages[ageBucket]--;
          return result("embed_budget", cursor, itemIndex);
        }
        bump("attempted");
        let outcome: string;
        try {
          const embedded = await ctx.runAction(internal.crystal.mcp.embedMemory, { memoryId: item.memoryId });
          if (embedded?.embedded === true) outcome = "embedded";
          else if (embedded?.nearDupMergedInto) outcome = "near_dup_merged";
          else if (embedded?.reason === "embedding_cap_exceeded") outcome = "cap_exceeded";
          else if (embedded?.embedded === false) outcome = "state_changed";
          else outcome = await ctx.runQuery(internal.crystal.vectorlessSweep.hasSide, { memoryId: item.memoryId }) ? "embedded_elsewhere" : "no_vector";
        } catch (error) {
          let data = error instanceof ConvexError ? error.data : null;
          // Nested Convex actions can serialize ConvexError.data as JSON.
          if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
          outcome = (data as any)?.code === "missing_openrouter_key" ? "no_credential" : "error";
        }
        bump(outcome);
        if (outcome === "cap_exceeded") user.skip = "skipped_cap";
        else if (outcome === "no_credential") user.skip = "skipped_no_credential";
        if (outcome === "no_vector" || outcome === "error") user.failures++;
        else user.failures = 0;
        if (user.failures >= 2) user.skip = "skipped_failures";
      }
      cursor = page.nextCursor;
      if (page.done) return result("done");
      if (!dryRun && counts.attempted >= maxEmbeds) return result("embed_budget", cursor, 0);
      if ((dryRun ? counts.vectorless ?? 0 : counts.attempted) >= batchLimit) return result("batch_limit");
    }
    return result("page_budget");
  },
});
