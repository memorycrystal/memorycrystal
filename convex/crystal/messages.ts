import { stableUserId } from "./auth";
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { type UserTier, TIER_LIMITS } from "../../shared/tierLimits";
import {
  applyDashboardTotalsDelta,
  getDashboardTotals,
} from "./dashboardTotals";

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_CONTENT_LENGTH = 8000; // truncate very long messages

const TIER_TTL_DAYS: Record<UserTier, number> = {
  free: TIER_LIMITS.free.stmTtlDays ?? 30,
  starter: TIER_LIMITS.starter.stmTtlDays ?? 60,
  pro: TIER_LIMITS.pro.stmTtlDays ?? 90,
  ultra: TIER_LIMITS.ultra.stmTtlDays ?? 365,
  unlimited: TIER_LIMITS.unlimited.stmTtlDays ?? 365,
};

const MESSAGE_LIMITS: Record<UserTier, number | null> = {
  free: TIER_LIMITS.free.stmMessages,
  starter: TIER_LIMITS.starter.stmMessages,
  pro: TIER_LIMITS.pro.stmMessages,
  ultra: TIER_LIMITS.ultra.stmMessages,
  unlimited: TIER_LIMITS.unlimited.stmMessages,
};

const roleEnum = v.union(v.literal("user"), v.literal("assistant"), v.literal("system"));

const truncateContent = (content: string): string =>
  content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;

const normalizeText = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
};

const toClampedLimit = (value: number | undefined, min: number, max: number, fallback: number): number => {
  const requested = Number.isFinite(value ?? NaN) ? (value as number) : fallback;
  return Math.min(Math.max(Math.floor(requested), min), max);
};

const normalizeTurnMessageIndex = (value?: number): number | undefined => {
  if (!Number.isFinite(value ?? NaN)) return undefined;
  return Math.max(0, Math.floor(value as number));
};

const getRecentMessagesForUserInternal = async (
  ctx: any,
  userId: string,
  args: {
    limit?: number;
    channel?: string;
    sessionKey?: string;
    sinceMs?: number;
  }
) => {
  const requestedLimit = toClampedLimit(args.limit, 1, 200, 20);
  const channel = normalizeText(args.channel);
  const sessionKey = normalizeText(args.sessionKey);
  const sinceMs = args.sinceMs;

  const baseQuery = channel
    ? ctx.db.query("crystalMessages").withIndex("by_channel_time", (q: any) => {
        let query = q.eq("userId", userId as never).eq("channel", channel as never);
        if (sinceMs !== undefined) {
          query = query.gte("timestamp", sinceMs);
        }
        return query;
      })
    : sessionKey
      ? ctx.db.query("crystalMessages").withIndex("by_session_time", (q: any) => {
          let query = q.eq("userId", userId as never).eq("sessionKey", sessionKey as never);
          if (sinceMs !== undefined) {
            query = query.gte("timestamp", sinceMs);
          }
          return query;
        })
      : ctx.db.query("crystalMessages").withIndex("by_user_time", (q: any) => {
          let query = q.eq("userId", userId as never);
          if (sinceMs !== undefined) {
            query = query.gte("timestamp", sinceMs);
          }
          return query;
        });

  const scopedQuery = baseQuery;

  const recent = await scopedQuery
    .order("desc")
    .take(requestedLimit);

  return recent.reverse();
};

const enqueueMessageEmbedding = async (ctx: any, messageId: any) => {
  await ctx.scheduler.runAfter(0, internal.crystal.stmEmbedder.embedMessage, {
    messageId,
  });
};

const getSessionMessagesForUserInternal = async (
  ctx: any,
  userId: string,
  args: {
    sessionKey: string;
    sinceMs?: number;
  }
) => {
  const sessionKey = normalizeText(args.sessionKey);
  if (!sessionKey) {
    return [];
  }

  const sinceMs = args.sinceMs;
  const query = ctx.db.query("crystalMessages").withIndex("by_session_time", (q: any) => {
    let indexed = q.eq("userId", userId as never).eq("sessionKey", sessionKey as never);
    if (sinceMs !== undefined) {
      indexed = indexed.gte("timestamp", sinceMs);
    }
    return indexed;
  });

  return await query.order("asc").collect();
};

export type SearchMessageResult = {
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  channel?: string;
  sessionKey?: string;
  turnId?: string;
  turnMessageIndex?: number;
  timestamp: number;
  score: number;
};

const SEARCH_QUERY_WRAPPER_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
];

export const unwrapQuotedSearchQuery = (value: string): string => {
  const trimmed = value.trim();

  for (const [open, close] of SEARCH_QUERY_WRAPPER_PAIRS) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length > open.length + close.length) {
      const inner = trimmed.slice(open.length, trimmed.length - close.length).trim();
      if (inner.length > 0) {
        return inner;
      }
    }
  }

  return trimmed;
};

const tokenizeSearchQuery = (value: string): string[] =>
  unwrapQuotedSearchQuery(value)
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);

export const lexicalMessageScore = (query: string, content: string): number => {
  const normalizedQuery = unwrapQuotedSearchQuery(query).toLowerCase();
  const haystack = content.toLowerCase();
  const words = tokenizeSearchQuery(normalizedQuery);
  const exactPhraseBonus = normalizedQuery.length >= 2 && haystack.includes(normalizedQuery) ? 5 : 0;
  const prefixBonus = normalizedQuery.length >= 2 && haystack.startsWith(normalizedQuery) ? 1 : 0;
  const wordMatches = words.reduce((count, word) => count + (haystack.includes(word) ? 1 : 0), 0);

  if (exactPhraseBonus === 0 && wordMatches === 0) {
    return 0;
  }

  return exactPhraseBonus + prefixBonus + wordMatches / Math.max(words.length, 1);
};

export const logMessage = mutation({
  args: {
    role: roleEnum,
    content: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    metadata: v.optional(v.string()),
    turnId: v.optional(v.string()),
    turnMessageIndex: v.optional(v.number()),
    ttlDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const now = Date.now();
    const userId = stableUserId(identity.subject);
    const tier = (await ctx.runQuery(internal.crystal.userProfiles.getUserTier, {
      userId,
    })) as UserTier;
    const limit = MESSAGE_LIMITS[tier];
    if (limit !== null) {
      const existingCount = await ctx.runQuery(internal.crystal.messages.getMessageCount, { userId });
      if (existingCount >= limit) {
        throw new Error("Storage limit reached. Upgrade at https://memorycrystal.ai/dashboard/settings");
      }
    }

    // ttlDays semantics: an explicit 0 (or anything non-positive) falls back to the
    // tier default so callers cannot accidentally set expiresAt = now (which made
    // messages vanish on the very next expire pass). Use the tier default as the
    // floor — the retention contract is tier-based, not caller-controlled.
    const requestedTtlDays = args.ttlDays;
    const effectiveTtlDays =
      typeof requestedTtlDays === "number" && Number.isFinite(requestedTtlDays) && requestedTtlDays > 0
        ? requestedTtlDays
        : TIER_TTL_DAYS[tier];
    const ttlMs = effectiveTtlDays * 24 * 60 * 60 * 1000;

    const messageId = await ctx.db.insert("crystalMessages", {
      userId,
      role: args.role,
      content: truncateContent(args.content),
      channel: normalizeText(args.channel),
      sessionKey: normalizeText(args.sessionKey),
      timestamp: now,
      embedding: undefined,
      embedded: false,
      expiresAt: now + (ttlMs || DEFAULT_TTL_MS),
      metadata: normalizeText(args.metadata),
      turnId: normalizeText(args.turnId),
      turnMessageIndex: normalizeTurnMessageIndex(args.turnMessageIndex),
    });

    await applyDashboardTotalsDelta(
      ctx,
      userId,
      { totalMessagesDelta: 1 }
    );

    await enqueueMessageEmbedding(ctx, messageId);

    return messageId;
  },
});

// Internal version for server-side logging (MCP/cron) where userId is known
export const logMessageInternal = internalMutation({
  args: {
    userId: v.string(),
    role: roleEnum,
    content: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    metadata: v.optional(v.string()),
    turnId: v.optional(v.string()),
    turnMessageIndex: v.optional(v.number()),
    ttlDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, ...rest } = args;
    const now = Date.now();
    const tier = (await ctx.runQuery(internal.crystal.userProfiles.getUserTier, {
      userId,
    })) as UserTier;
    const limit = MESSAGE_LIMITS[tier];
    if (limit !== null) {
      const existingCount = await ctx.runQuery(internal.crystal.messages.getMessageCount, { userId });
      if (existingCount >= limit) {
        throw new Error("Storage limit reached. Upgrade at https://memorycrystal.ai/dashboard/settings");
      }
    }

    // See note in logMessage — explicit 0 falls back to the tier default.
    const requestedTtlDays = rest.ttlDays;
    const effectiveTtlDays =
      typeof requestedTtlDays === "number" && Number.isFinite(requestedTtlDays) && requestedTtlDays > 0
        ? requestedTtlDays
        : TIER_TTL_DAYS[tier];
    const ttlMs = effectiveTtlDays * 24 * 60 * 60 * 1000;

    const messageId = await ctx.db.insert("crystalMessages", {
      userId,
      role: rest.role,
      content: truncateContent(rest.content),
      channel: normalizeText(rest.channel),
      sessionKey: normalizeText(rest.sessionKey),
      timestamp: now,
      embedding: undefined,
      embedded: false,
      expiresAt: now + (ttlMs || DEFAULT_TTL_MS),
      metadata: normalizeText(rest.metadata),
      turnId: normalizeText(rest.turnId),
      turnMessageIndex: normalizeTurnMessageIndex(rest.turnMessageIndex),
    });

    await applyDashboardTotalsDelta(
      ctx,
      userId,
      { totalMessagesDelta: 1 }
    );

    await enqueueMessageEmbedding(ctx, messageId);

    return messageId;
  },
});

export const updateMessageEmbedding = internalMutation({
  args: {
    messageId: v.id("crystalMessages"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    // updateMessageEmbedding is called by the embedder background job — no user auth needed,
    // but we verify the record exists before patching.
    const existing = await ctx.db.get(args.messageId);
    if (!existing) throw new Error("Message not found");
    await ctx.db.patch(args.messageId, {
      embedded: true,
      embedding: args.embedding,
    });

    return args.messageId;
  },
});

export const getRecentMessages = query({
  args: {
    limit: v.optional(v.number()),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    return getRecentMessagesForUserInternal(ctx, userId, args);
  },
});

export const getSessionMessages = query({
  args: {
    sessionKey: v.string(),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    return getSessionMessagesForUserInternal(ctx, userId, args);
  },
});

export const getSessionMessagesForUser = internalQuery({
  args: {
    userId: v.string(),
    sessionKey: v.string(),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, ...rest } = args;
    return getSessionMessagesForUserInternal(ctx, userId, rest);
  },
});

export const getRecentMessagesForUser = internalQuery({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, ...rest } = args;
    return getRecentMessagesForUserInternal(ctx, userId, rest);
  },
});

// Internal version for background jobs (no auth context)
export const getMessageCount = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const totals = await getDashboardTotals(ctx, userId);
    return totals.totalMessages;
  },
});

export const searchMessagesByTextForUser = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    channel: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchMessageResult[]> => {
    const query = normalizeText(args.query);
    if (!query) return [];

    const limit = toClampedLimit(args.limit, 1, 100, 10);
    const channel = normalizeText(args.channel);
    const normalizedQuery = unwrapQuotedSearchQuery(query);
    const searchTerms = Array.from(new Set([query, normalizedQuery].filter((term) => term.length > 0)));
    const scanLimit = Math.min(limit * (channel !== undefined || args.sinceMs !== undefined ? 12 : 8), 200);

    const resultSets = await Promise.all(
      searchTerms.map((term) =>
        ctx.db
          .query("crystalMessages")
          .withSearchIndex("search_content", (q) => q.search("content", term).eq("userId", args.userId))
          .take(scanLimit)
      )
    );

    const matches = new Map<string, SearchMessageResult>();

    for (const message of resultSets.flat()) {
      if (channel !== undefined && message.channel !== channel) continue;
      if (args.sinceMs !== undefined && message.timestamp < args.sinceMs) continue;

      const lexicalScore = lexicalMessageScore(normalizedQuery, message.content);
      const candidate: SearchMessageResult = {
        messageId: String(message._id),
        role: message.role,
        content: message.content,
        channel: message.channel,
        sessionKey: message.sessionKey,
        timestamp: message.timestamp,
        score: lexicalScore,
      };
      const existing = matches.get(candidate.messageId);

      if (
        !existing ||
        candidate.score > existing.score ||
        (candidate.score === existing.score && candidate.timestamp > existing.timestamp)
      ) {
        matches.set(candidate.messageId, candidate);
      }
    }

    return Array.from(matches.values())
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, limit);
  },
});

export const getUnembeddedMessages = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = toClampedLimit(args.limit, 1, 100, 50);

    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_embedded", (q) => q.eq("embedded", false))
      .order("asc")
      .take(requestedLimit);
  },
});

// Public version requires auth
export const getUnembeddedMessagesForUser = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const requestedLimit = toClampedLimit(args.limit, 1, 100, 50);

    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_embedded", (q) => q.eq("embedded", false))
      .filter((q) => q.eq(q.field("userId"), userId))
      .order("asc")
      .take(requestedLimit);
  },
});

export const getMessage = query({
  args: { messageId: v.id("crystalMessages") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const message = await ctx.db.get(args.messageId);
    if (!message || message.userId !== stableUserId(identity.subject)) return null;
    return message;
  },
});

// Internal version for background jobs (embedder, etc.)
export const getMessageInternal = internalQuery({
  args: { messageId: v.id("crystalMessages") },
  handler: async (ctx, args) => ctx.db.get(args.messageId),
});

const EXPIRE_MESSAGES_BATCH = 200;

export const expireOldMessages = internalMutation({
  args: {},
  handler: async (ctx, _args) => {
    const now = Date.now();
    const expiredMessages = await ctx.db
      .query("crystalMessages")
      .withIndex("by_expires", (q) => q.lte("expiresAt", now))
      .take(EXPIRE_MESSAGES_BATCH);

    let deleted = 0;
    for (const message of expiredMessages) {
      await ctx.db.delete(message._id);
      if (message.userId) {
        await applyDashboardTotalsDelta(ctx, message.userId, {
          totalMessagesDelta: -1,
        });
      }
      deleted += 1;
    }

    // If the batch was full, more expired rows remain. Self-schedule a continuation so
    // tier-based retention (Free 7d / Pro 30d / Ultra 90d) converges on every run —
    // without this the daily cron would only delete 200 rows/day regardless of backlog.
    if (deleted === EXPIRE_MESSAGES_BATCH) {
      await ctx.scheduler.runAfter(0, internal.crystal.messages.expireOldMessages, {});
    }

    return { deleted };
  },
});

export const searchMessages = action({
  args: {
    embedding: v.array(v.float64()),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
    channel: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchMessageResult[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const channel = normalizeText(args.channel);
    const limit = toClampedLimit(args.limit, 1, 100, 10);
    const searchLimit = Math.min(limit * (channel !== undefined || args.sinceMs !== undefined ? 4 : 1), 100);

    // Use channel in vector filter when available (index supports it as filterField)
    const vectorResults = (await ctx.vectorSearch("crystalMessages", "by_embedding", {
      vector: args.embedding,
      limit: searchLimit,
      filter: (q: any) =>
        channel !== undefined
          ? q.and(q.eq("userId", userId), q.eq("channel", channel))
          : q.eq("userId", userId),
    })) as Array<{ _id: string; _score: number }>;

    const messages: Array<SearchMessageResult | null> = await Promise.all(
      vectorResults.map(async (result) => {
        const message = await ctx.runQuery(internal.crystal.messages.getMessageInternal, { messageId: result._id as any });
        if (!message) return null;
        // Keep the ownership check as a defensive guard against stale indexes.
        if (message.userId !== userId) return null;
        if (channel !== undefined && message.channel !== channel) return null;
        // Apply sinceMs filter post-fetch (not a valid vector filterField)
        if (args.sinceMs !== undefined && message.timestamp < args.sinceMs) return null;
        return {
          messageId: result._id,
          role: message.role,
          content: message.content,
          channel: message.channel,
          sessionKey: message.sessionKey,
          turnId: message.turnId,
          turnMessageIndex: message.turnMessageIndex,
          timestamp: message.timestamp,
          score: result._score ?? 0,
        };
      })
    );

    const vectorHits = messages
      .filter((entry): entry is SearchMessageResult => entry !== null)
      .slice(0, limit);

    // Text-search fallback: if vector results are sparse (e.g. freshly ingested
    // messages not yet embedded) and a query string was provided, supplement with
    // BM25 text search results.
    const textQuery = normalizeText(args.query);
    if (vectorHits.length < limit && textQuery) {
      const textResults = await ctx.runQuery(
        internal.crystal.messages.searchMessagesByTextForUser,
        {
          userId,
          query: textQuery,
          limit: limit - vectorHits.length,
          channel,
          sinceMs: args.sinceMs,
        },
      );
      const seenIds = new Set(vectorHits.map((h) => h.messageId));
      for (const tr of textResults) {
        if (!seenIds.has(tr.messageId)) {
          vectorHits.push(tr);
          seenIds.add(tr.messageId);
          if (vectorHits.length >= limit) break;
        }
      }
    }

    return vectorHits;
  },
});

export const searchMessagesForUser = internalAction({
  args: {
    userId: v.string(),
    embedding: v.array(v.float64()),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
    channel: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchMessageResult[]> => {
    const channel = normalizeText(args.channel);
    const limit = toClampedLimit(args.limit, 1, 100, 10);
    const searchLimit = Math.min(limit * (channel !== undefined || args.sinceMs !== undefined ? 4 : 1), 100);

    const vectorResults = (await ctx.vectorSearch("crystalMessages", "by_embedding", {
      vector: args.embedding,
      limit: searchLimit,
      filter: (q: any) =>
        channel !== undefined
          ? q.and(q.eq("userId", args.userId), q.eq("channel", channel))
          : q.eq("userId", args.userId),
    })) as Array<{ _id: string; _score: number }>;

    const messages: Array<SearchMessageResult | null> = await Promise.all(
      vectorResults.map(async (result) => {
        const message = await ctx.runQuery(internal.crystal.messages.getMessageInternal, { messageId: result._id as any });
        if (!message) return null;
        if (message.userId !== args.userId) return null;
        if (channel !== undefined && message.channel !== channel) return null;
        if (args.sinceMs !== undefined && message.timestamp < args.sinceMs) return null;

        return {
          messageId: result._id,
          role: message.role,
          content: message.content,
          channel: message.channel,
          sessionKey: message.sessionKey,
          turnId: message.turnId,
          turnMessageIndex: message.turnMessageIndex,
          timestamp: message.timestamp,
          score: result._score ?? 0,
        };
      })
    );

    const vectorHits = messages
      .filter((entry): entry is SearchMessageResult => entry !== null)
      .slice(0, limit);

    const textQuery = normalizeText(args.query);
    if (vectorHits.length < limit && textQuery) {
      const textResults = await ctx.runQuery(
        internal.crystal.messages.searchMessagesByTextForUser,
        {
          userId: args.userId,
          query: textQuery,
          limit: limit - vectorHits.length,
          channel,
          sinceMs: args.sinceMs,
        },
      );
      const seenIds = new Set(vectorHits.map((h) => h.messageId));
      for (const tr of textResults) {
        if (!seenIds.has(tr.messageId)) {
          vectorHits.push(tr);
          seenIds.add(tr.messageId);
          if (vectorHits.length >= limit) break;
        }
      }
    }

    return vectorHits;
  },
});
