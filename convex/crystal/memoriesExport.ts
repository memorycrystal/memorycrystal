// API-key-authenticated, paginated memory export — GET /api/memories.
//
// Unblocks migration / GDPR flows: an operator with a valid API key can page
// through every non-archived memory scoped to that key's user, with optional
// store/category/date filters. Reuses the existing API-key auth + rate-limit
// helpers (httpAuth.ts, mcp.getApiKeyRecord) so it enforces the same contract
// as the other /api/mcp routes.

import { httpAction, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { sha256Hex } from "./crypto";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!auth) return null;
  const [scheme, token] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

const STORE_VALUES = new Set(["sensory", "episodic", "semantic", "procedural", "prospective"]);
const CATEGORY_VALUES = new Set([
  "decision", "lesson", "person", "rule", "event", "fact", "goal", "skill", "workflow", "conversation",
]);

function clampPageSize(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGE_SIZE);
}

function parseOptionalNumber(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Paginated read of a user's non-archived memories, newest first, with optional
 * store/category/date filters. Uses the by_user_created index for a stable,
 * cursor-based scan.
 */
export const listMemoriesForExport = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.union(v.string(), v.null()),
    pageSize: v.number(),
    store: v.optional(v.string()),
    category: v.optional(v.string()),
    createdAfter: v.optional(v.number()),
    createdBefore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Index is [userId, createdAt, archived]: eq userId, then range on
    // createdAt. `archived` follows the range field so it must be a post-filter,
    // not an index eq.
    let query = ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) => {
        let range = q.eq("userId", args.userId);
        if (args.createdAfter !== undefined) {
          range = range.gte("createdAt", args.createdAfter) as typeof range;
        }
        if (args.createdBefore !== undefined) {
          range = range.lte("createdAt", args.createdBefore) as typeof range;
        }
        return range;
      })
      .order("desc")
      .filter((q) => q.eq(q.field("archived"), false));

    if (args.store) {
      query = query.filter((q) => q.eq(q.field("store"), args.store));
    }
    if (args.category) {
      query = query.filter((q) => q.eq(q.field("category"), args.category));
    }

    const page = await query.paginate({
      numItems: args.pageSize,
      cursor: args.cursor,
    });

    return {
      memories: page.page.map((memory) => ({
        id: String(memory._id),
        title: memory.title,
        content: memory.content,
        recallText: memory.recallText,
        chunkKind: memory.chunkKind ?? "content",
        store: memory.store,
        category: memory.category,
        tags: memory.tags ?? [],
        channel: memory.channel,
        source: memory.source,
        strength: memory.strength,
        confidence: memory.confidence,
        archived: memory.archived,
        createdAt: memory.createdAt,
        lastAccessedAt: memory.lastAccessedAt,
      })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const memoriesExport = httpAction(async (ctx, request) => {
  const rawKey = extractBearerToken(request);
  if (!rawKey) return json({ error: "Unauthorized" }, 401);

  const keyHash = await sha256Hex(rawKey);
  const keyRecord = await ctx.runQuery(internal.crystal.mcp.getApiKeyRecord, { keyHash });
  if (!keyRecord || !keyRecord.active || typeof keyRecord.userId !== "string") {
    return json({ error: "Unauthorized" }, 401);
  }
  if (keyRecord.expiresAt && keyRecord.expiresAt < Date.now()) {
    return json({ error: "Unauthorized" }, 401);
  }

  const rateLimit = await ctx.runMutation(internal.crystal.mcp.checkAndIncrementRateLimit, {
    key: `memories-export:${keyHash}`,
  });
  if (!rateLimit.allowed) {
    return json({ error: "Rate limit exceeded. Max 60 requests/minute." }, 429);
  }
  ctx.runMutation(internal.crystal.apiKeys.touchLastUsedAt, { keyHash }).catch(() => {});

  const params = new URL(request.url).searchParams;
  const pageSize = clampPageSize(params.get("pageSize") ?? params.get("limit"));
  const cursor = params.get("cursor");
  const storeRaw = params.get("store")?.trim() || undefined;
  const categoryRaw = params.get("category")?.trim() || undefined;

  if (storeRaw && !STORE_VALUES.has(storeRaw)) {
    return json({ error: `Invalid store: ${storeRaw}` }, 400);
  }
  if (categoryRaw && !CATEGORY_VALUES.has(categoryRaw)) {
    return json({ error: `Invalid category: ${categoryRaw}` }, 400);
  }

  const createdAfter = parseOptionalNumber(params.get("createdAfter") ?? params.get("since"));
  const createdBefore = parseOptionalNumber(params.get("createdBefore") ?? params.get("until"));

  const result = await ctx.runQuery(internal.crystal.memoriesExport.listMemoriesForExport, {
    userId: keyRecord.userId,
    cursor: cursor ?? null,
    pageSize,
    store: storeRaw,
    category: categoryRaw,
    createdAfter,
    createdBefore,
  });

  return json({
    memories: result.memories,
    pagination: {
      pageSize,
      cursor: result.isDone ? null : result.cursor,
      isDone: result.isDone,
    },
  });
});
