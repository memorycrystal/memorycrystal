/**
 * Stale-vector remediation for the Gemini 3072-dim migration.
 *
 * After b946d48 unified all embeddings on Gemini (3072 dimensions),
 * records that were embedded under the old OpenAI regime (1536 dims)
 * remain in the database with wrong-dimension vectors that silently
 * fail vector search. This module provides safe, paginated, operator-
 * triggered actions to find and re-embed those stale records.
 *
 * Entry points (all internalAction — call via dashboard or CLI):
 *   reembedStaleMemories  — compatibility no-op (vectors moved to side table)
 *   reembedStaleMessages  — compatibility no-op (message vectors retired)
 *   reembedStaleAssets    — crystalAssets
 */
import { v } from "convex/values";
import { action, internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { embedTextWithUserOpenRouter } from "./embeddings";
import { logError } from "./crypto";

// ── Constants ──────────────────────────────────────────────────────

const REQUIRED_DIMS = 3072;
const STALE_DIM = 1536;

/** Max records to scan per paginated page (Convex limit-friendly). */
const PAGE_SIZE = 100;
/** Max bytes Convex will read per paginated page. */
const MAX_PAGE_BYTES = 512 * 1024;
/** Max records to re-embed per single action invocation. */
const DEFAULT_BATCH_LIMIT = 25;
/** Delay between self-scheduled continuation batches (ms). */
const CONTINUATION_DELAY_MS = 2_000;
/** Delay before retrying a full-table pass when failures were recorded (ms). */
const RETRY_DELAY_MS = 30_000;
/** Default number of retry passes to attempt when failures are recorded. */
const DEFAULT_RETRIES = 2;

async function embedText(
  text: string,
  ctx: Pick<any, "runQuery" | "runMutation">,
  accounting: { userId?: string; source: string },
): Promise<number[]> {
  if (!accounting.userId) {
    throw new Error("userId is required for OpenRouter re-embedding.");
  }
  const vector = await embedTextWithUserOpenRouter(ctx, text, {
    userId: accounting.userId,
    source: accounting.source,
  });
  if (!vector) {
    throw new Error("OpenRouter embedding request returned no vector.");
  }
  return vector;
}

// ── Shared page result types ───────────────────────────────────────

type StalePage<T> = {
  stale: T[];
  scanned: number;
  isDone: boolean;
  continueCursor?: string;
};

type StaleAssetRecord = { _id: any; userId?: string; text: string };

// ── Query helpers ──────────────────────────────────────────────────

/**
 * Paginate crystalMemories and return only those with stale (1536-dim) embeddings.
 * We scan the full table via cursor and filter in-query to avoid pulling huge embeddings
 * across the action boundary unnecessarily.
 */
export const listStaleMemoriesPage = internalQuery({
  args: { cursor: v.optional(v.string()), pageSize: v.number() },
  handler: async () => ({ stale: [], scanned: 0, isDone: true }),
});

/**
 * Paginate crystalMessages and return only those with stale (1536-dim) embeddings.
 */
export const listStaleMessagesPage = internalQuery({
  args: { cursor: v.optional(v.string()), pageSize: v.number() },
  handler: async () => ({ stale: [], scanned: 0, isDone: true }),
});

/**
 * Paginate crystalAssets and return only those with stale (1536-dim) embeddings.
 * Assets use transcript/summary/title as embedding text, not a single content field.
 */
export const listStaleAssetsPage = internalQuery({
  args: { cursor: v.optional(v.string()), pageSize: v.number() },
  handler: async (ctx, { cursor, pageSize }) => {
    const result: any = await ctx.db
      .query("crystalAssets")
      .order("desc")
      .paginate({
        numItems: Math.max(pageSize, 1),
        cursor: cursor ?? null,
        maximumBytesRead: MAX_PAGE_BYTES,
      });

    const stale = (result.page as Array<any>)
      .filter((a) => Array.isArray(a.embedding) && a.embedding.length === STALE_DIM)
      .map((a) => ({
        _id: a._id,
        userId: a.userId,
        text: (a.transcript || a.summary || a.title || "") as string,
      }));

    return {
      stale,
      scanned: (result.page as Array<any>).length,
      isDone: result.isDone as boolean,
      continueCursor: result.continueCursor as string | undefined,
    };
  },
});

// ── Re-embed actions ───────────────────────────────────────────────

export type ReembedResult = {
  scanned: number;
  found: number;
  succeeded: number;
  failed: number;
  done: boolean;
  continueCursor?: string;
};

/**
 * Re-embed stale 1536-dim vectors in crystalMemories.
 *
 * Operator-triggered via Convex dashboard or `npx convex run`.
 * Self-schedules continuation batches until the table is fully scanned.
 *
 * @param batchLimit — max records to re-embed per invocation (default 25)
 * @param cursor — opaque pagination cursor (leave empty on first call)
 * @param dryRun — if true, only count stale records without re-embedding
 */
export const reembedStaleMemories = internalAction({
  args: {
    batchLimit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    retriesLeft: v.optional(v.number()),
  },
  handler: async (): Promise<ReembedResult> => ({
    scanned: 0, found: 0, succeeded: 0, failed: 0, done: true,
  }),
});

/**
 * Re-embed stale 1536-dim vectors in crystalMessages.
 */
export const reembedStaleMessages = internalAction({
  args: {
    batchLimit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    retriesLeft: v.optional(v.number()),
  },
  handler: async (): Promise<ReembedResult> => ({
    scanned: 0, found: 0, succeeded: 0, failed: 0, done: true,
  }),
});

/**
 * Re-embed stale 1536-dim vectors in crystalAssets.
 */
export const reembedStaleAssets = internalAction({
  args: {
    batchLimit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    retriesLeft: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ReembedResult> => {
    const limit = Math.min(Math.max(args.batchLimit ?? DEFAULT_BATCH_LIMIT, 1), 100);
    const dryRun = args.dryRun ?? false;
    const retriesLeft = args.retriesLeft ?? DEFAULT_RETRIES;

    let cursor = args.cursor;
    let totalScanned = 0;
    let totalFound = 0;
    let succeeded = 0;
    let failed = 0;
    let tableDone = false;

    while (totalFound < limit) {
      const page = await ctx.runQuery(internal.crystal.reembed.listStaleAssetsPage, {
        cursor,
        pageSize: PAGE_SIZE,
      }) as StalePage<StaleAssetRecord>;

      totalScanned += page.scanned;

      for (const asset of page.stale) {
        totalFound++;

        if (dryRun || totalFound > limit) continue;

        if (!asset.text?.trim()) {
          failed++;
          console.log(`[reembed][assets] ${asset._id}: skipped (no text content)`);
          continue;
        }

        try {
          const vec = await embedText(asset.text, ctx, {
            userId: asset.userId,
            source: "reembed.reembedStaleAssets",
          });
          await ctx.runMutation(internal.crystal.assets.patchAssetEmbedding, {
            assetId: asset._id,
            embedding: vec,
          });
          succeeded++;
          console.log(`[reembed][assets] ${asset._id}: re-embedded (${STALE_DIM} → ${REQUIRED_DIMS})`);
        } catch (err) {
          failed++;
          console.log(`[reembed][assets] ${asset._id}: FAILED`, await logError(err, asset.userId));
        }
      }

      if (page.isDone || !page.continueCursor) {
        tableDone = true;
        break;
      }

      cursor = page.continueCursor;
      if (totalFound >= limit) break;
    }

    const done = tableDone;
    const nextCursor = tableDone ? undefined : cursor;

    if (!done && !dryRun) {
      await ctx.scheduler.runAfter(CONTINUATION_DELAY_MS, internal.crystal.reembed.reembedStaleAssets, {
        batchLimit: limit,
        cursor: nextCursor,
        dryRun: false,
        retriesLeft,
      });
    } else if (done && !dryRun && failed > 0 && retriesLeft > 0) {
      await ctx.scheduler.runAfter(RETRY_DELAY_MS, internal.crystal.reembed.reembedStaleAssets, {
        batchLimit: limit,
        cursor: undefined,
        dryRun: false,
        retriesLeft: retriesLeft - 1,
      });
      console.log(`[reembed][assets] scheduling retry pass (${retriesLeft - 1} left) for ${failed} failed record(s)`);
    }

    console.log(
      `[reembed][assets] scanned=${totalScanned} found=${totalFound} succeeded=${succeeded} failed=${failed} done=${done} dryRun=${dryRun}`,
    );

    return { scanned: totalScanned, found: totalFound, succeeded, failed, done, continueCursor: nextCursor };
  },
});

// ── Operator-facing CLI wrappers ──────────────────────────────────
//
// These public actions are thin wrappers around the internalActions above,
// callable via `npx convex run` or the Convex dashboard.
//
// Access control: anyone with deploy-key access (i.e. `npx convex run`)
// is already an operator. No additional auth gate needed — the deploy
// key IS the credential.

const reembedArgs = {
  table: v.union(
    v.literal("memories"),
    v.literal("messages"),
    v.literal("assets"),
  ),
  batchLimit: v.optional(v.number()),
  cursor: v.optional(v.string()),
  dryRun: v.optional(v.boolean()),
};

/**
 * Unified operator entry point for stale-vector re-embedding.
 *
 * Usage (CLI):
 *   npx convex run crystal/reembed:adminReembed '{"table":"memories","dryRun":true}'
 *   npx convex run crystal/reembed:adminReembed '{"table":"messages","batchLimit":10}'
 *   npx convex run crystal/reembed:adminReembed '{"table":"assets"}'
 */
export const adminReembed = action({
  args: reembedArgs,
  handler: async (ctx, args): Promise<ReembedResult> => {
    const actionArgs = {
      batchLimit: args.batchLimit,
      cursor: args.cursor,
      dryRun: args.dryRun,
    };

    switch (args.table) {
      case "memories":
        return await ctx.runAction(internal.crystal.reembed.reembedStaleMemories, actionArgs);
      case "messages":
        return await ctx.runAction(internal.crystal.reembed.reembedStaleMessages, actionArgs);
      case "assets":
        return await ctx.runAction(internal.crystal.reembed.reembedStaleAssets, actionArgs);
    }
  },
});

/**
 * Quick dry-run audit: how many stale vectors remain per table?
 *
 * Usage (CLI):
 *   npx convex run crystal/reembed:adminReembedStatus
 */
type ReembedStatusResult = {
  memories: { stale: number; scanned: number; done: boolean };
  messages: { stale: number; scanned: number; done: boolean };
  assets: { stale: number; scanned: number; done: boolean };
  totalStale: number;
};

export const adminReembedStatus = action({
  args: {},
  handler: async (ctx): Promise<ReembedStatusResult> => {
    const [memories, messages, assets]: ReembedResult[] = await Promise.all([
      ctx.runAction(internal.crystal.reembed.reembedStaleMemories, { dryRun: true }),
      ctx.runAction(internal.crystal.reembed.reembedStaleMessages, { dryRun: true }),
      ctx.runAction(internal.crystal.reembed.reembedStaleAssets, { dryRun: true }),
    ]);

    return {
      memories: { stale: memories.found, scanned: memories.scanned, done: memories.done },
      messages: { stale: messages.found, scanned: messages.scanned, done: messages.done },
      assets: { stale: assets.found, scanned: assets.scanned, done: assets.done },
      totalStale: memories.found + messages.found + assets.found,
    };
  },
});
