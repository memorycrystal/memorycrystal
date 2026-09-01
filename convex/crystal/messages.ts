import { stableUserId } from "./auth";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { type Id } from "../_generated/dataModel";
import { type UserTier, TIER_LIMITS, TIER_STM_TTL_DAYS } from "../../shared/tierLimits";
import {
  applyDashboardTotalsDelta,
  getDashboardTotals,
} from "./dashboardTotals";
import {
  isCostBreakerEnabled,
  mergeCostBudgetResults,
  resolveTieredVectorReachPolicy,
  type CostBudgetResult,
} from "./recallBudgetPolicy";
import { sha256Hex } from "./crypto";
import {
  buildMessageDedupeScopeInput,
  buildMessageHashInput,
  normalizeContentForHash,
} from "./contentHash";
import {
  UNSCOPED_CHANNEL_ALARM_USER_ID,
  UNSCOPED_CHANNEL_SKIP_REASON,
  UNSCOPED_CHANNEL_TELEMETRY_KIND,
  buildUnscopedChannelAlarmPayload,
  resolveWriteChannel,
  unscopedChannelAlarmExpiresAt,
} from "./channelScope";

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_CONTENT_LENGTH = 8000; // truncate very long messages
const ESTIMATED_MESSAGE_VECTOR_QUERY_BYTES = 480 * 1024 * 1024;
const ESTIMATED_MESSAGE_TEXT_QUERY_BYTES = 60 * 1024 * 1024;
const RECALLED_CONTEXT_OPEN = "<recalled_context>";
const RECALLED_CONTEXT_TAG_RE = /<\/?recalled_context>/g;
const CLEANUP_METADATA_PREFIX = "recalled_context_cleanup:";
const TIER_TTL_DAYS: Record<UserTier, number> = {
  free: TIER_STM_TTL_DAYS.free,
  starter: TIER_STM_TTL_DAYS.starter,
  pro: TIER_STM_TTL_DAYS.pro,
  ultra: TIER_STM_TTL_DAYS.ultra,
  unlimited: TIER_STM_TTL_DAYS.unlimited,
};

const MESSAGE_LIMITS: Record<UserTier, number | null> = {
  free: TIER_LIMITS.free.stmMessages,
  starter: TIER_LIMITS.starter.stmMessages,
  pro: TIER_LIMITS.pro.stmMessages,
  ultra: TIER_LIMITS.ultra.stmMessages,
  unlimited: TIER_LIMITS.unlimited.stmMessages,
};

const roleEnum = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("system"),
);

const truncateContent = (content: string): string =>
  content.length > MAX_CONTENT_LENGTH
    ? content.slice(0, MAX_CONTENT_LENGTH)
    : content;

export const normalizeMessageContentForHash = normalizeContentForHash;

const findLeadingRecalledContextBoundary = (
  value: string,
): { starts: boolean; end: number } => {
  const start = value.search(/\S/);
  if (start < 0) return { starts: false, end: -1 };
  if (!value.startsWith(RECALLED_CONTEXT_OPEN, start))
    return { starts: false, end: -1 };

  RECALLED_CONTEXT_TAG_RE.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = RECALLED_CONTEXT_TAG_RE.exec(value)) !== null) {
    if (match[0] === RECALLED_CONTEXT_OPEN) {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0)
        return { starts: true, end: RECALLED_CONTEXT_TAG_RE.lastIndex };
      if (depth < 0) return { starts: true, end: -1 };
    }
  }

  return { starts: true, end: -1 };
};

export const sanitizeUserMessageContent = (
  input: string,
): {
  content: string;
  stripped: boolean;
  strippedChars: number;
  hadTrailingPrompt: boolean;
  malformed: boolean;
} => {
  let content = String(input ?? "");
  let stripped = false;
  let strippedChars = 0;

  while (true) {
    const boundary = findLeadingRecalledContextBoundary(content);
    if (!boundary.starts) break;
    if (boundary.end < 0) {
      return {
        content: "",
        stripped,
        strippedChars,
        hadTrailingPrompt: false,
        malformed: true,
      };
    }
    stripped = true;
    strippedChars += boundary.end;
    content = content.slice(boundary.end).replace(/^\s+/, "");
  }

  return {
    content,
    stripped,
    strippedChars,
    hadTrailingPrompt: stripped && content.trim().length > 0,
    malformed: false,
  };
};

const normalizeLogMessageContent = (
  role: "user" | "assistant" | "system",
  rawContent: string,
): { content: string; skipped?: boolean; reason?: string } => {
  if (role !== "user") return { content: rawContent };
  const sanitized = sanitizeUserMessageContent(rawContent);
  if (sanitized.malformed || !sanitized.content.trim()) {
    return {
      content: "",
      skipped: true,
      reason: sanitized.malformed
        ? "malformed_synthetic_context"
        : "synthetic_context_only",
    };
  }
  return { content: sanitized.content };
};

const normalizeText = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
};

const resolveStoredChannel = (input: {
  channel?: string;
  sessionKey?: string;
  metadata?: string;
}): string | undefined => resolveWriteChannel({
  channel: normalizeText(input.channel),
  sessionKey: normalizeText(input.sessionKey),
  metadata: normalizeText(input.metadata),
}).channel;

const filterSearchResultsByChannel = <T extends { channel?: string }>(
  results: T[],
  channel?: string,
): T[] => {
  if (channel === undefined) return results;
  return results.filter((result) => result.channel === channel);
};

const toClampedLimit = (
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number => {
  const requested = Number.isFinite(value ?? NaN)
    ? (value as number)
    : fallback;
  return Math.min(Math.max(Math.floor(requested), min), max);
};

const normalizeTurnMessageIndex = (value?: number): number | undefined => {
  if (!Number.isFinite(value ?? NaN)) return undefined;
  return Math.max(0, Math.floor(value as number));
};

function shouldScheduleMessageBackgroundWork() {
  return !(
    typeof process !== "undefined" &&
    process.env.MC_DISABLE_MESSAGE_EMBED_SCHEDULE
  );
}

async function debitMessageSearchCost(
  ctx: any,
  args: {
    userId: string;
    estimatedVectorQueryBytes?: number;
    estimatedTextQueryBytes?: number;
    reason: string;
  },
): Promise<CostBudgetResult | null> {
  if (!isCostBreakerEnabled()) return null;
  try {
    const [userBudget, globalBudget] = await Promise.all([
      ctx.runMutation((internal as any).crystal.costBreaker.debitAndCheck, {
        scope: "user",
        scopeId: args.userId,
        surface: "messages",
        estimatedVectorQueryBytes: args.estimatedVectorQueryBytes,
        estimatedTextQueryBytes: args.estimatedTextQueryBytes,
        reason: args.reason,
      }),
      ctx.runMutation((internal as any).crystal.costBreaker.debitAndCheck, {
        scope: "global",
        scopeId: "global",
        surface: "messages",
        estimatedVectorQueryBytes: args.estimatedVectorQueryBytes,
        estimatedTextQueryBytes: args.estimatedTextQueryBytes,
        reason: args.reason,
      }),
    ]);
    return mergeCostBudgetResults(userBudget, globalBudget);
  } catch (error) {
    console.warn("[costBreaker] message search debit failed open", error);
    return null;
  }
}

const isSameMessageScope = (
  left: {
    role: string;
    channel?: string;
    sessionKey?: string;
    turnId?: string;
    turnMessageIndex?: number;
    timestamp?: number;
  },
  right: {
    role: string;
    channel?: string;
    sessionKey?: string;
    turnId?: string;
    turnMessageIndex?: number;
    timestamp?: number;
  },
) => {
  if (
    left.role !== right.role ||
    (left.channel ?? "") !== (right.channel ?? "") ||
    (left.sessionKey ?? "") !== (right.sessionKey ?? "")
  ) {
    return false;
  }

  if (left.turnId || right.turnId) {
    return (
      (left.turnId ?? "") === (right.turnId ?? "") &&
      (left.turnMessageIndex ?? -1) === (right.turnMessageIndex ?? -1)
    );
  }

  if (
    left.sessionKey &&
    right.sessionKey &&
    left.turnMessageIndex !== undefined &&
    right.turnMessageIndex !== undefined
  ) {
    return left.turnMessageIndex === right.turnMessageIndex;
  }

  if (left.timestamp !== undefined && right.timestamp !== undefined) {
    return Math.abs(left.timestamp - right.timestamp) <= 5_000;
  }

  return false;
};

async function findDuplicateMessage(
  ctx: any,
  args: {
    userId: string;
    role: "user" | "assistant" | "system";
    contentHash: string;
    channel?: string;
    sessionKey?: string;
    turnId?: string;
    turnMessageIndex?: number;
    timestamp?: number;
  },
) {
  const timestamp = args.timestamp ?? Date.now();
  const hasDurableTurnScope = Boolean(
    args.sessionKey && args.turnMessageIndex !== undefined,
  );
  const candidates = await ctx.db
    .query("crystalMessages")
    .withIndex("by_message_dedupe_time", (q: any) => {
      const scoped = q
        .eq("userId", args.userId)
        .eq("contentHash", args.contentHash)
        .eq("role", args.role)
        .eq("channel", args.channel)
        .eq("sessionKey", args.sessionKey)
        .eq("turnId", args.turnId)
        .eq("turnMessageIndex", args.turnMessageIndex);
      return hasDurableTurnScope
        ? scoped
        : scoped.gte("timestamp", timestamp - 5_000);
    })
    .take(50);

  return candidates.find(
    (candidate: any) =>
      candidate.timestamp <= timestamp &&
      isSameMessageScope(candidate, { ...args, timestamp }),
  );
}

async function findCleanupDuplicateMessage(
  ctx: any,
  args: {
    userId: string;
    role: "user" | "assistant" | "system";
    contentHash: string;
    channel?: string;
    sessionKey?: string;
    turnId?: string;
    turnMessageIndex?: number;
    excludeId: unknown;
  },
) {
  const candidates = await ctx.db
    .query("crystalMessages")
    .withIndex("by_message_dedupe_time", (q: any) =>
      q
        .eq("userId", args.userId)
        .eq("contentHash", args.contentHash)
        .eq("role", args.role)
        .eq("channel", args.channel)
        .eq("sessionKey", args.sessionKey)
        .eq("turnId", args.turnId)
        .eq("turnMessageIndex", args.turnMessageIndex),
    )
    .take(100);

  return candidates.find((candidate: any) => candidate._id !== args.excludeId);
}

const getRecentMessagesForUserInternal = async (
  ctx: any,
  userId: string,
  args: {
    limit?: number;
    channel?: string;
    sessionKey?: string;
    sinceMs?: number;
    beforeMs?: number;
  },
) => {
  const requestedLimit = toClampedLimit(args.limit, 1, 200, 20);
  const channel = normalizeText(args.channel);
  const sessionKey = normalizeText(args.sessionKey);

  const sinceMs = args.sinceMs;
  const beforeMs = args.beforeMs;
  // Bound the timestamp range on the index itself so a historical window
  // (e.g. "last month") is enumerated correctly instead of returning only the
  // newest rows and post-filtering them all away. by_channel_time /
  // by_session_time / by_user_time are all keyed (…, timestamp).
  const applyTimeRange = (q: any) => {
    let query = q;
    if (sinceMs !== undefined) query = query.gte("timestamp", sinceMs);
    if (beforeMs !== undefined) query = query.lte("timestamp", beforeMs);
    return query;
  };

  const baseQuery = channel
    ? ctx.db.query("crystalMessages").withIndex("by_channel_time", (q: any) =>
        applyTimeRange(q.eq("userId", userId as never).eq("channel", channel as never)),
      )
    : sessionKey
      ? ctx.db
          .query("crystalMessages")
          .withIndex("by_session_time", (q: any) =>
            applyTimeRange(q.eq("userId", userId as never).eq("sessionKey", sessionKey as never)),
          )
      : ctx.db.query("crystalMessages").withIndex("by_user_time", (q: any) =>
          applyTimeRange(q.eq("userId", userId as never)),
        );

  const scopedQuery = baseQuery;

  const recent = await scopedQuery.order("desc").take(requestedLimit);

  return recent.reverse();
};

const enqueueMessageEmbedding = async (ctx: any, messageId: any) => {
  if (!shouldScheduleMessageBackgroundWork()) return;
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
  },
) => {
  const sessionKey = normalizeText(args.sessionKey);
  if (!sessionKey) {
    return [];
  }

  const sinceMs = args.sinceMs;
  const query = ctx.db
    .query("crystalMessages")
    .withIndex("by_session_time", (q: any) => {
      let indexed = q
        .eq("userId", userId as never)
        .eq("sessionKey", sessionKey as never);
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

type MessageSearchProjection = {
  _id: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  channel?: string;
  sessionKey?: string;
  turnId?: string;
  turnMessageIndex?: number;
  timestamp: number;
};

const SEARCH_QUERY_WRAPPER_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
];

export const unwrapQuotedSearchQuery = (value: string): string => {
  const trimmed = value.trim();

  for (const [open, close] of SEARCH_QUERY_WRAPPER_PAIRS) {
    if (
      trimmed.startsWith(open) &&
      trimmed.endsWith(close) &&
      trimmed.length > open.length + close.length
    ) {
      const inner = trimmed
        .slice(open.length, trimmed.length - close.length)
        .trim();
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
  const exactPhraseBonus =
    normalizedQuery.length >= 2 && haystack.includes(normalizedQuery) ? 5 : 0;
  const prefixBonus =
    normalizedQuery.length >= 2 && haystack.startsWith(normalizedQuery) ? 1 : 0;
  const wordMatches = words.reduce(
    (count, word) => count + (haystack.includes(word) ? 1 : 0),
    0,
  );

  if (exactPhraseBonus === 0 && wordMatches === 0) {
    return 0;
  }

  return (
    exactPhraseBonus + prefixBonus + wordMatches / Math.max(words.length, 1)
  );
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
    const tier = (await ctx.runQuery(
      internal.crystal.userProfiles.getUserTier,
      {
        userId,
      },
    )) as UserTier;
    const limit = MESSAGE_LIMITS[tier];
    if (limit !== null) {
      const existingCount = await ctx.runQuery(
        internal.crystal.messages.getMessageCount,
        { userId },
      );
      if (existingCount >= limit) {
        throw new Error(
          "Storage limit reached. Upgrade at https://memorycrystal.ai/dashboard/settings",
        );
      }
    }

    // ttlDays semantics: an explicit 0 (or anything non-positive) falls back to the
    // tier default so callers cannot accidentally set expiresAt = now (which made
    // messages vanish on the very next expire pass). Use the tier default as the
    // floor — the retention contract is tier-based, not caller-controlled.
    const requestedTtlDays = args.ttlDays;
    const effectiveTtlDays =
      typeof requestedTtlDays === "number" &&
      Number.isFinite(requestedTtlDays) &&
      requestedTtlDays > 0
        ? requestedTtlDays
        : TIER_TTL_DAYS[tier];
    const ttlMs = effectiveTtlDays * 24 * 60 * 60 * 1000;
    const normalizedContent = normalizeLogMessageContent(
      args.role,
      args.content,
    );
    if (normalizedContent.skipped) return null;
    const content = truncateContent(normalizedContent.content);
    const sessionKey = normalizeText(args.sessionKey);
    const channel = resolveStoredChannel({
      channel: args.channel,
      sessionKey,
      metadata: args.metadata,
    });
    const turnId = normalizeText(args.turnId);
    const turnMessageIndex = normalizeTurnMessageIndex(args.turnMessageIndex);
    const contentHash = await sha256Hex(
      buildMessageHashInput({ role: args.role, content }),
    );
    const dedupeScopeHash = await sha256Hex(
      buildMessageDedupeScopeInput({
        userId,
        role: args.role,
        contentHash,
        channel,
        sessionKey,
        turnId,
        turnMessageIndex,
      }),
    );

    const duplicate = await findDuplicateMessage(ctx, {
      userId,
      role: args.role,
      contentHash,
      channel,
      sessionKey,
      turnId,
      turnMessageIndex,
      timestamp: now,
    });

    if (duplicate) {
      return duplicate._id;
    }

    const messageId = await ctx.db.insert("crystalMessages", {
      userId,
      role: args.role,
      content,
      channel,
      sessionKey,
      timestamp: now,
      embedding: undefined,
      embedded: false,
      expiresAt: now + (ttlMs || DEFAULT_TTL_MS),
      metadata: normalizeText(args.metadata),
      turnId,
      turnMessageIndex,
      contentHash,
      dedupeScopeHash,
    });

    await applyDashboardTotalsDelta(ctx, userId, { totalMessagesDelta: 1 });

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
    const tier = (await ctx.runQuery(
      internal.crystal.userProfiles.getUserTier,
      {
        userId,
      },
    )) as UserTier;
    const limit = MESSAGE_LIMITS[tier];
    if (limit !== null) {
      const existingCount = await ctx.runQuery(
        internal.crystal.messages.getMessageCount,
        { userId },
      );
      if (existingCount >= limit) {
        throw new Error(
          "Storage limit reached. Upgrade at https://memorycrystal.ai/dashboard/settings",
        );
      }
    }

    // See note in logMessage — explicit 0 falls back to the tier default.
    const requestedTtlDays = rest.ttlDays;
    const effectiveTtlDays =
      typeof requestedTtlDays === "number" &&
      Number.isFinite(requestedTtlDays) &&
      requestedTtlDays > 0
        ? requestedTtlDays
        : TIER_TTL_DAYS[tier];
    const ttlMs = effectiveTtlDays * 24 * 60 * 60 * 1000;
    const normalizedContent = normalizeLogMessageContent(
      rest.role,
      rest.content,
    );
    if (normalizedContent.skipped) return null;
    const content = truncateContent(normalizedContent.content);
    const sessionKey = normalizeText(rest.sessionKey);
    const channel = resolveStoredChannel({
      channel: rest.channel,
      sessionKey,
      metadata: rest.metadata,
    });
    const turnId = normalizeText(rest.turnId);
    const turnMessageIndex = normalizeTurnMessageIndex(rest.turnMessageIndex);
    const contentHash = await sha256Hex(
      buildMessageHashInput({ role: rest.role, content }),
    );
    const dedupeScopeHash = await sha256Hex(
      buildMessageDedupeScopeInput({
        userId,
        role: rest.role,
        contentHash,
        channel,
        sessionKey,
        turnId,
        turnMessageIndex,
      }),
    );

    const duplicate = await findDuplicateMessage(ctx, {
      userId,
      role: rest.role,
      contentHash,
      channel,
      sessionKey,
      turnId,
      turnMessageIndex,
      timestamp: now,
    });

    if (duplicate) {
      return duplicate._id;
    }

    const messageId = await ctx.db.insert("crystalMessages", {
      userId,
      role: rest.role,
      content,
      channel,
      sessionKey,
      timestamp: now,
      embedding: undefined,
      embedded: false,
      expiresAt: now + (ttlMs || DEFAULT_TTL_MS),
      metadata: normalizeText(rest.metadata),
      turnId,
      turnMessageIndex,
      contentHash,
      dedupeScopeHash,
    });

    await applyDashboardTotalsDelta(ctx, userId, { totalMessagesDelta: 1 });

    await enqueueMessageEmbedding(ctx, messageId);

    return messageId;
  },
});

const prepareTurnMessage = async (
  ctx: any,
  args: {
    userId: string;
    role: "user" | "assistant";
    content: string;
    channel?: string;
    sessionKey?: string;
    metadata?: string;
    turnId?: string;
    turnMessageIndex: number;
    now: number;
    ttlMs: number;
  },
) => {
  const normalizedContent = normalizeLogMessageContent(args.role, args.content);
  if (normalizedContent.skipped) {
    return {
      role: args.role,
      skipped: true,
      reason: normalizedContent.reason ?? "synthetic_context_only",
    };
  }

  const content = truncateContent(normalizedContent.content);
  const sessionKey = normalizeText(args.sessionKey);
  const channel = resolveStoredChannel({
    channel: args.channel,
    sessionKey,
    metadata: args.metadata,
  });
  const turnId = normalizeText(args.turnId);
  const turnMessageIndex =
    normalizeTurnMessageIndex(args.turnMessageIndex) ?? args.turnMessageIndex;
  const contentHash = await sha256Hex(
    buildMessageHashInput({ role: args.role, content }),
  );
  const dedupeScopeHash = await sha256Hex(
    buildMessageDedupeScopeInput({
      userId: args.userId,
      role: args.role,
      contentHash,
      channel,
      sessionKey,
      turnId,
      turnMessageIndex,
    }),
  );

  const duplicate = await findDuplicateMessage(ctx, {
    userId: args.userId,
    role: args.role,
    contentHash,
    channel,
    sessionKey,
    turnId,
    turnMessageIndex,
    timestamp: args.now,
  });

  if (duplicate) {
    return {
      role: args.role,
      id: duplicate._id,
      inserted: false,
    };
  }

  return {
    role: args.role,
    content,
    channel,
    sessionKey,
    turnId,
    turnMessageIndex,
    metadata: normalizeText(args.metadata),
    expiresAt: args.now + (args.ttlMs || DEFAULT_TTL_MS),
    contentHash,
    dedupeScopeHash,
    inserted: true,
  };
};

// Internal atomic turn logger for lifecycle integrations. It validates/dedupes
// both sides before inserting, so normal quota or validation failures do not
// leave a one-sided turn.
export const logTurnInternal = internalMutation({
  args: {
    userId: v.string(),
    sessionKey: v.string(),
    channel: v.string(),
    userMessage: v.optional(v.string()),
    assistantMessage: v.string(),
    metadata: v.optional(v.string()),
    turnId: v.optional(v.string()),
    ttlDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const tier = (await ctx.runQuery(
      internal.crystal.userProfiles.getUserTier,
      {
        userId: args.userId,
      },
    )) as UserTier;
    const limit = MESSAGE_LIMITS[tier];
    const requestedTtlDays = args.ttlDays;
    const effectiveTtlDays =
      typeof requestedTtlDays === "number" &&
      Number.isFinite(requestedTtlDays) &&
      requestedTtlDays > 0
        ? requestedTtlDays
        : TIER_TTL_DAYS[tier];
    const ttlMs = effectiveTtlDays * 24 * 60 * 60 * 1000;

    const prepared = [];
    if (args.userMessage !== undefined) {
      prepared.push(
        await prepareTurnMessage(ctx, {
          userId: args.userId,
          role: "user",
          content: args.userMessage,
          channel: args.channel,
          sessionKey: args.sessionKey,
          metadata: args.metadata,
          turnId: args.turnId,
          turnMessageIndex: 0,
          now,
          ttlMs,
        }),
      );
    }
    prepared.push(
      await prepareTurnMessage(ctx, {
        userId: args.userId,
        role: "assistant",
        content: args.assistantMessage,
        channel: args.channel,
        sessionKey: args.sessionKey,
        metadata: args.metadata,
        turnId: args.turnId,
        turnMessageIndex: 1,
        now,
        ttlMs,
      }),
    );

    const required = prepared.filter(
      (message: any) => !message.skipped && message.inserted,
    ).length;
    if (limit !== null && required > 0) {
      const currentCount = await ctx.runQuery(
        internal.crystal.messages.getMessageCount,
        { userId: args.userId },
      );
      const available = Math.max(limit - currentCount, 0);
      if (required > available) {
        return {
          ok: false,
          error:
            "Storage limit reached. Upgrade at https://memorycrystal.ai/dashboard/settings",
          limit,
          required,
          available,
        };
      }
    }

    let insertedCount = 0;
    const messages = [];
    for (const message of prepared as any[]) {
      if (message.skipped || !message.inserted) {
        messages.push(message);
        continue;
      }
      const id = await ctx.db.insert("crystalMessages", {
        userId: args.userId,
        role: message.role,
        content: message.content,
        channel: message.channel,
        sessionKey: message.sessionKey,
        timestamp: now,
        embedding: undefined,
        embedded: false,
        expiresAt: message.expiresAt,
        metadata: message.metadata,
        turnId: message.turnId,
        turnMessageIndex: message.turnMessageIndex,
        contentHash: message.contentHash,
        dedupeScopeHash: message.dedupeScopeHash,
      });
      insertedCount += 1;
      await enqueueMessageEmbedding(ctx, id);
      messages.push({
        role: message.role,
        id,
        inserted: true,
      });
    }

    if (insertedCount > 0) {
      await applyDashboardTotalsDelta(ctx, args.userId, {
        totalMessagesDelta: insertedCount,
      });
    }

    return {
      ok: true,
      turnId: normalizeText(args.turnId),
      sessionKey: normalizeText(args.sessionKey),
      channel: resolveStoredChannel({
        channel: args.channel,
        sessionKey: args.sessionKey,
        metadata: args.metadata,
      }),
      messages,
    };
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

export const patchMessageContentHash = internalMutation({
  args: {
    messageId: v.id("crystalMessages"),
    contentHash: v.string(),
    dedupeScopeHash: v.string(),
    dedupeCheckedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.messageId);
    if (!existing) throw new Error("Message not found");
    await ctx.db.patch(args.messageId, {
      contentHash: args.contentHash,
      dedupeScopeHash: args.dedupeScopeHash,
      dedupeCheckedAt: args.dedupeCheckedAt,
    });
    return args.messageId;
  },
});

export const markMessageDedupeChecked = internalMutation({
  args: {
    messageId: v.id("crystalMessages"),
    dedupeCheckedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.messageId);
    if (!existing) return null;
    await ctx.db.patch(args.messageId, {
      dedupeCheckedAt: args.dedupeCheckedAt,
    });
    return args.messageId;
  },
});

export const markMessagesLtmExtracted = internalMutation({
  args: {
    messageIds: v.array(v.id("crystalMessages")),
    extractedAt: v.number(),
    skippedReason: v.optional(v.string()),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    let updated = 0;
    const alarmChannels: string[] = [];
    for (const messageId of args.messageIds) {
      const existing = await ctx.db.get(messageId);
      if (!existing) continue;
      await ctx.db.patch(messageId, {
        ltmExtractedAt: args.extractedAt,
        ltmExtracted: true,
        ltmExtractionSkippedReason: args.skippedReason,
      });
      updated += 1;
      if (args.skippedReason === UNSCOPED_CHANNEL_SKIP_REASON) {
        alarmChannels.push(existing.channel ?? "");
      }
    }
    if (args.skippedReason === UNSCOPED_CHANNEL_SKIP_REASON && updated > 0) {
      const now = args.extractedAt;
      const payload = buildUnscopedChannelAlarmPayload({
        count: updated,
        channels: alarmChannels,
      });
      console.error(`[crystal] unscoped_channel skip count=${updated}`);
      await ctx.db.insert("crystalTelemetry", {
        userId: UNSCOPED_CHANNEL_ALARM_USER_ID,
        kind: UNSCOPED_CHANNEL_TELEMETRY_KIND,
        payload,
        createdAt: now,
        expiresAt: unscopedChannelAlarmExpiresAt(now),
      });
    }
    return { updated };
  },
});

export const listUnscopedChannelAlarms = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(v.object({
    _id: v.id("crystalTelemetry"),
    createdAt: v.number(),
    payload: v.string(),
  })),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
    const rows = await ctx.db
      .query("crystalTelemetry")
      .withIndex("by_user_kind_time", (q) =>
        q.eq("userId", UNSCOPED_CHANNEL_ALARM_USER_ID).eq("kind", UNSCOPED_CHANNEL_TELEMETRY_KIND),
      )
      .order("desc")
      .take(limit);
    return rows.map((row) => ({
      _id: row._id,
      createdAt: row.createdAt,
      payload: row.payload,
    }));
  },
});

async function deleteDistilledMessageRows(
  ctx: Pick<MutationCtx, "db">,
  messageIds: Array<Id<"crystalMessages">>,
  _retiredAt: number,
): Promise<{ deleted: number; blocked: number }> {
  let deleted = 0;
  let blocked = 0;
  for (const messageId of messageIds) {
    const message = await ctx.db.get(messageId);
    if (!message) continue;
    // Fail-closed: ltmExtractedAt unset is undeletable. No force flag —
    // the pre-ILL-182 force path had no remaining callers after retry/
    // capsule machinery was deleted.
    if (message.ltmExtractedAt === undefined) {
      blocked += 1;
      continue;
    }
    // Hard-delete directly: retiredAt was a tombstone field on a row we delete
    // in this same transaction, so patching it was a wasted write on the exact
    // hot path this cost fix targets. retiredAt is retained for callers/telemetry.
    await ctx.db.delete(messageId);
    if (message.userId) {
      await applyDashboardTotalsDelta(ctx, message.userId, {
        totalMessagesDelta: -1,
      });
    }
    deleted += 1;
  }
  return { deleted, blocked };
}

export const deleteRetiredMessages = internalMutation({
  args: {
    messageIds: v.array(v.id("crystalMessages")),
    retiredAt: v.number(),
  },
  returns: v.object({
    deleted: v.number(),
    blocked: v.number(),
  }),
  handler: async (ctx, args) => {
    return await deleteDistilledMessageRows(ctx, args.messageIds, args.retiredAt);
  },
});

export const deleteDuplicateMessage = internalMutation({
  args: {
    messageId: v.id("crystalMessages"),
    duplicateOfMessageId: v.id("crystalMessages"),
  },
  handler: async (ctx, args) => {
    const duplicate = await ctx.db.get(args.messageId);
    const canonical = await ctx.db.get(args.duplicateOfMessageId);
    if (!duplicate || !canonical) return { deleted: false };
    if (duplicate.userId !== canonical.userId)
      throw new Error("Duplicate message user mismatch");
    await ctx.db.delete(args.messageId);
    await applyDashboardTotalsDelta(ctx, duplicate.userId, {
      totalMessagesDelta: -1,
    });
    return { deleted: true };
  },
});

const cleanupApplyMode = v.union(v.literal("dry-run"), v.literal("apply"));

const appendCleanupMetadata = (
  metadata: string | undefined,
  timestamp: number,
): string => {
  const marker = `${CLEANUP_METADATA_PREFIX}${timestamp}`;
  const normalized = normalizeText(metadata);
  if (!normalized) return marker;
  if (normalized.includes(CLEANUP_METADATA_PREFIX)) return normalized;
  return `${normalized}; ${marker}`;
};

const findMessagesForRecalledContextCleanup = async (
  ctx: any,
  args: {
    userId: string;
    channel?: string;
    sessionKey?: string;
    sinceMs?: number;
    beforeMs?: number;
    limit?: number;
  },
) => {
  const limit = toClampedLimit(args.limit, 1, 200, 100);
  const channel = normalizeText(args.channel);
  const sessionKey = normalizeText(args.sessionKey);

  if (channel && sessionKey) {
    throw new Error(
      "Cleanup scope is ambiguous: provide channel or sessionKey, not both",
    );
  }

  const applyTimestampBounds = (query: any) => {
    let bounded = query;
    if (args.sinceMs !== undefined)
      bounded = bounded.gte("timestamp", args.sinceMs);
    if (args.beforeMs !== undefined)
      bounded = bounded.lte("timestamp", args.beforeMs);
    return bounded;
  };

  if (channel) {
    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_channel_time", (q: any) =>
        applyTimestampBounds(
          q.eq("userId", args.userId as never).eq("channel", channel as never),
        ),
      )
      .order("desc")
      .take(limit);
  }

  if (sessionKey) {
    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_session_time", (q: any) =>
        applyTimestampBounds(
          q
            .eq("userId", args.userId as never)
            .eq("sessionKey", sessionKey as never),
        ),
      )
      .order("desc")
      .take(limit);
  }

  return await ctx.db
    .query("crystalMessages")
    .withIndex("by_user_time", (q: any) =>
      applyTimestampBounds(q.eq("userId", args.userId as never)),
    )
    .order("desc")
    .take(limit);
};

export const cleanupRecalledContextMessages = internalMutation({
  args: {
    userId: v.string(),
    applyMode: cleanupApplyMode,
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
    beforeMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await findMessagesForRecalledContextCleanup(ctx, args);
    const summary = {
      applyMode: args.applyMode,
      scanned: rows.length,
      candidates: 0,
      wouldPatch: 0,
      patched: 0,
      wouldDelete: 0,
      deleted: 0,
      wouldMergeDelete: 0,
      mergedDeleted: 0,
      malformed: 0,
      samples: [] as Array<{
        messageId: string;
        action: "patch" | "delete" | "merge-delete";
        channel?: string;
        sessionKey?: string;
        originalLength: number;
        cleanedLength: number;
      }>,
    };

    for (const message of rows) {
      if (message.role !== "user") continue;
      const sanitized = sanitizeUserMessageContent(message.content);
      if (!sanitized.stripped && !sanitized.malformed) continue;
      summary.candidates += 1;

      const cleanedContent = truncateContent(sanitized.content);
      const cleanedLength = cleanedContent.trim().length;
      if (sanitized.malformed || cleanedLength === 0) {
        if (sanitized.malformed) summary.malformed += 1;
        summary.wouldDelete += 1;
        if (summary.samples.length < 10) {
          summary.samples.push({
            messageId: String(message._id),
            action: "delete",
            channel: message.channel,
            sessionKey: message.sessionKey,
            originalLength: message.content.length,
            cleanedLength,
          });
        }
        if (args.applyMode === "apply") {
          await ctx.db.delete(message._id);
          await applyDashboardTotalsDelta(ctx, message.userId, {
            totalMessagesDelta: -1,
          });
          summary.deleted += 1;
        }
        continue;
      }

      const contentHash = await sha256Hex(
        buildMessageHashInput({ role: message.role, content: cleanedContent }),
      );
      const dedupeScopeHash = await sha256Hex(
        buildMessageDedupeScopeInput({
          userId: message.userId,
          role: message.role,
          contentHash,
          channel: message.channel,
          sessionKey: message.sessionKey,
          turnId: message.turnId,
          turnMessageIndex: message.turnMessageIndex,
        }),
      );
      const duplicate = await findCleanupDuplicateMessage(ctx, {
        userId: message.userId,
        role: message.role,
        contentHash,
        channel: message.channel,
        sessionKey: message.sessionKey,
        turnId: message.turnId,
        turnMessageIndex: message.turnMessageIndex,
        excludeId: message._id,
      });

      if (duplicate && duplicate._id !== message._id) {
        summary.wouldMergeDelete += 1;
        if (summary.samples.length < 10) {
          summary.samples.push({
            messageId: String(message._id),
            action: "merge-delete",
            channel: message.channel,
            sessionKey: message.sessionKey,
            originalLength: message.content.length,
            cleanedLength,
          });
        }
        if (args.applyMode === "apply") {
          await ctx.db.delete(message._id);
          await applyDashboardTotalsDelta(ctx, message.userId, {
            totalMessagesDelta: -1,
          });
          summary.mergedDeleted += 1;
        }
        continue;
      }

      summary.wouldPatch += 1;
      if (summary.samples.length < 10) {
        summary.samples.push({
          messageId: String(message._id),
          action: "patch",
          channel: message.channel,
          sessionKey: message.sessionKey,
          originalLength: message.content.length,
          cleanedLength,
        });
      }
      if (args.applyMode === "apply") {
        await ctx.db.patch(message._id, {
          content: cleanedContent,
          embedding: undefined,
          embedded: false,
          metadata: appendCleanupMetadata(message.metadata, now),
          contentHash,
          dedupeScopeHash,
          dedupeCheckedAt: undefined,
          ltmExtracted: undefined,
          ltmExtractedAt: undefined,
          ltmExtractionSkippedReason: undefined,
        });
        await enqueueMessageEmbedding(ctx, message._id);
        summary.patched += 1;
      }
    }

    return summary;
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
    beforeMs: v.optional(v.number()),
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
    sessionKey: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchMessageResult[]> => {
    const query = normalizeText(args.query);
    if (!query) return [];

    const limit = toClampedLimit(args.limit, 1, 100, 10);
    const channel = normalizeText(args.channel);
    const sessionKey = normalizeText(args.sessionKey);
    const normalizedQuery = unwrapQuotedSearchQuery(query);
    const searchTerms = Array.from(
      new Set([query, normalizedQuery].filter((term) => term.length > 0)),
    );
    const scanLimit = Math.min(
      limit *
        (channel !== undefined ||
        sessionKey !== undefined ||
        args.sinceMs !== undefined
          ? 12
          : 8),
      200,
    );

    const resultSets = await Promise.all(
      searchTerms.map((term) =>
        ctx.db
          .query("crystalMessages")
          .withSearchIndex("search_content", (q) =>
            q.search("content", term).eq("userId", args.userId),
          )
          .take(scanLimit),
      ),
    );

    const matches = new Map<string, SearchMessageResult>();

    for (const message of resultSets.flat()) {
      if (channel !== undefined && message.channel !== channel) continue;
      if (sessionKey !== undefined && message.sessionKey !== sessionKey)
        continue;
      if (args.sinceMs !== undefined && message.timestamp < args.sinceMs)
        continue;

      const lexicalScore = lexicalMessageScore(
        normalizedQuery,
        message.content,
      );
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
        (candidate.score === existing.score &&
          candidate.timestamp > existing.timestamp)
      ) {
        matches.set(candidate.messageId, candidate);
      }
    }

    const recentScanLimit = Math.min(Math.max(limit * 20, 100), 300);
    const recentCandidates = await getRecentMessagesForUserInternal(ctx, args.userId, {
      limit: recentScanLimit,
      channel,
      sessionKey,
      sinceMs: args.sinceMs,
    });

    for (const message of recentCandidates) {
      if (channel !== undefined && message.channel !== channel) continue;
      if (sessionKey !== undefined && message.sessionKey !== sessionKey)
        continue;
      if (args.sinceMs !== undefined && message.timestamp < args.sinceMs)
        continue;

      const lexicalScore = lexicalMessageScore(
        normalizedQuery,
        message.content,
      );
      if (lexicalScore <= 0) continue;

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
        (candidate.score === existing.score &&
          candidate.timestamp > existing.timestamp)
      ) {
        matches.set(candidate.messageId, candidate);
      }
    }

    return filterSearchResultsByChannel(Array.from(matches.values()), channel)
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, limit);
  },
});

export const getUnembeddedMessages = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = toClampedLimit(args.limit, 1, 1000, 50);

    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_embedded", (q) => q.eq("embedded", false))
      .order("asc")
      .take(requestedLimit);
  },
});

export const getUnembeddedMessagesForUserInternal = internalQuery({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = toClampedLimit(args.limit, 1, 1000, 100);

    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_embedded_time", (q) =>
        q.eq("userId", args.userId).eq("embedded", false),
      )
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
    if (!message || message.userId !== stableUserId(identity.subject))
      return null;
    return message;
  },
});

// Internal version for background jobs (embedder, etc.)
export const getMessageInternal = internalQuery({
  args: { messageId: v.id("crystalMessages") },
  handler: async (ctx, args) => ctx.db.get(args.messageId),
});

export const getMessagesByIdsForSearch = internalQuery({
  args: { messageIds: v.array(v.id("crystalMessages")) },
  handler: async (ctx, args): Promise<MessageSearchProjection[]> => {
    const uniqueIds = Array.from(new Set(args.messageIds.map(String)));
    const docs = await Promise.all(
      uniqueIds.map((messageId) => ctx.db.get(messageId as any)),
    );
    return docs.flatMap((message) => {
      const projected = message as MessageSearchProjection | null;
      if (!projected) return [];
      return [
        {
          _id: String(projected._id),
          userId: projected.userId,
          role: projected.role,
          content: projected.content,
          channel: projected.channel,
          sessionKey: projected.sessionKey,
          turnId: projected.turnId,
          turnMessageIndex: projected.turnMessageIndex,
          timestamp: projected.timestamp,
        },
      ];
    });
  },
});

function shapeVectorMessageResults(
  vectorResults: Array<{ _id: string; _score: number }>,
  messages: MessageSearchProjection[],
  args: {
    userId: string;
    limit: number;
    channel?: string;
    sessionKey?: string;
    sinceMs?: number;
  },
): SearchMessageResult[] {
  const messagesById = new Map(
    messages.map((message) => [String(message._id), message]),
  );
  const shaped: SearchMessageResult[] = [];
  for (const result of vectorResults) {
    const message = messagesById.get(String(result._id));
    if (!message) continue;
    if (message.userId !== args.userId) continue;
    if (args.channel !== undefined && message.channel !== args.channel)
      continue;
    if (args.sessionKey !== undefined && message.sessionKey !== args.sessionKey)
      continue;
    if (args.sinceMs !== undefined && message.timestamp < args.sinceMs)
      continue;
    shaped.push({
      messageId: String(result._id),
      role: message.role,
      content: message.content,
      channel: message.channel,
      sessionKey: message.sessionKey,
      turnId: message.turnId,
      turnMessageIndex: message.turnMessageIndex,
      timestamp: message.timestamp,
      score: result._score ?? 0,
    });
    if (shaped.length >= args.limit) break;
  }
  return shaped;
}

const EXPIRE_MESSAGES_BATCH = 200;

// Background self-scheduling is skipped under test so continuations don't
// write outside the harness transaction.
function shouldScheduleRetirementWork() {
  return !(
    typeof process !== "undefined" &&
    (process.env.VITEST || process.env.NODE_ENV === "test")
  );
}

export const expireOldMessages = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    blocked: v.number(),
  }),
  handler: async (ctx, _args) => {
    const now = Date.now();
    // Fail-closed SEEK: only distilled expired rows. The ltmExtractedAt
    // predicate lives on the query (not a post-read TypeScript filter) so
    // removing it is a product regression — undistilled messages must stay
    // readable at any age. by_distilled_expires excludes unset ltmExtracted
    // from the index range, so this cannot scan undistilled expired rows.
    const expiredDistilled = await ctx.db
      .query("crystalMessages")
      .withIndex("by_distilled_expires", (q) =>
        q.eq("ltmExtracted", true).lte("expiresAt", now),
      )
      .filter((q) => q.neq(q.field("ltmExtractedAt"), undefined))
      .take(EXPIRE_MESSAGES_BATCH);

    const deletion = await deleteDistilledMessageRows(
      ctx,
      expiredDistilled.map((message) => message._id),
      now,
    );

    if (expiredDistilled.length === EXPIRE_MESSAGES_BATCH && shouldScheduleRetirementWork()) {
      await ctx.scheduler.runAfter(0, internal.crystal.messages.expireOldMessages, {});
    }

    return deletion;
  },
});

export const searchMessages = action({
  args: {
    embedding: v.array(v.float64()),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchMessageResult[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const channel = normalizeText(args.channel);
    const sessionKey = normalizeText(args.sessionKey);
    const limit = toClampedLimit(args.limit, 1, 100, 10);
    const vectorTake = Math.min(
      limit *
        (channel !== undefined ||
        sessionKey !== undefined ||
        args.sinceMs !== undefined
          ? 16
          : 1),
      256,
    );

    const messageBudget = await debitMessageSearchCost(ctx, {
      userId,
      estimatedVectorQueryBytes: ESTIMATED_MESSAGE_VECTOR_QUERY_BYTES,
      reason: "messages.searchMessages.vector",
    });
    const userTier = await ctx.runQuery(
      (internal as any).crystal.userProfiles.getUserTier,
      { userId },
    ) as UserTier;
    const vectorPolicy = resolveTieredVectorReachPolicy({
      tier: userTier,
      normalVectorDepth: vectorTake,
      vectorBudget: messageBudget,
      indexedFallbackAllowedOnDegradation: true,
    });
    const vectorResults = !vectorPolicy.vectorAllowed
      ? []
      : ((await ctx.vectorSearch("crystalMessages", "by_embedding", {
          vector: args.embedding,
          limit: vectorPolicy.vectorDepth,
          filter: (q) => q.eq("userId", userId),
        })) as Array<{ _id: string; _score: number }>);

    const hydratedMessages =
      vectorResults.length > 0
        ? await ctx.runQuery(
            internal.crystal.messages.getMessagesByIdsForSearch,
            {
              messageIds: vectorResults.map((result) => result._id as any),
            },
          )
        : [];

    const vectorHits = shapeVectorMessageResults(
      vectorResults,
      hydratedMessages,
      {
        userId,
        limit,
        channel,
        sessionKey,
        sinceMs: args.sinceMs,
      },
    );

    // Text-search fallback: if vector results are sparse (e.g. freshly ingested
    // messages not yet embedded) and a query string was provided, supplement with
    // BM25 text search results.
    const textQuery = normalizeText(args.query);
    if (vectorHits.length < limit && textQuery) {
      const textBudget = await debitMessageSearchCost(ctx, {
        userId,
        estimatedTextQueryBytes: ESTIMATED_MESSAGE_TEXT_QUERY_BYTES,
        reason: "messages.searchMessages.text",
      });
      const textPolicy = resolveTieredVectorReachPolicy({
        tier: userTier,
        normalVectorDepth: vectorTake,
        vectorBudget: messageBudget,
        textBudget,
        indexedFallbackAllowedOnDegradation: true,
      });
      const textResults = !textPolicy.textAllowed
        ? []
        : await ctx.runQuery(
            internal.crystal.messages.searchMessagesByTextForUser,
            {
              userId,
              query: textQuery,
              limit: limit - vectorHits.length,
              channel,
              sessionKey,
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

    return filterSearchResultsByChannel(vectorHits, channel);
  },
});

export const searchMessagesForUser = internalAction({
  args: {
    userId: v.string(),
    embedding: v.array(v.float64()),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
    skipCostBreaker: v.optional(v.boolean()),
    vectorDepth: v.optional(v.number()),
    textAllowed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SearchMessageResult[]> => {
    const channel = normalizeText(args.channel);
    const sessionKey = normalizeText(args.sessionKey);
    const limit = toClampedLimit(args.limit, 1, 100, 10);
    const vectorTake = Math.min(
      limit *
        (channel !== undefined ||
        sessionKey !== undefined ||
        args.sinceMs !== undefined
          ? 16
          : 1),
      256,
    );

    const userTier = args.skipCostBreaker
      ? null
      : await ctx.runQuery((internal as any).crystal.userProfiles.getUserTier, {
          userId: args.userId,
        }) as UserTier;
    const messageBudget = args.skipCostBreaker
      ? null
      : await debitMessageSearchCost(ctx, {
          userId: args.userId,
          estimatedVectorQueryBytes: ESTIMATED_MESSAGE_VECTOR_QUERY_BYTES,
          reason: "messages.searchMessagesForUser.vector",
        });
    const vectorPolicy = userTier
      ? resolveTieredVectorReachPolicy({
          tier: userTier,
          normalVectorDepth: vectorTake,
          vectorBudget: messageBudget,
          indexedFallbackAllowedOnDegradation: true,
        })
      : null;
    const vectorDepth = Math.max(
      0,
      Math.min(
        vectorTake,
        Math.floor(args.vectorDepth ?? vectorPolicy?.vectorDepth ?? vectorTake),
      ),
    );
    const vectorAllowed =
      args.skipCostBreaker ? vectorDepth > 0 : vectorPolicy?.vectorAllowed !== false;
    const vectorResults = !vectorAllowed
      ? []
      : ((await ctx.vectorSearch("crystalMessages", "by_embedding", {
          vector: args.embedding,
          limit: vectorDepth,
          filter: (q) => q.eq("userId", args.userId),
        })) as Array<{ _id: string; _score: number }>);

    const hydratedMessages =
      vectorResults.length > 0
        ? await ctx.runQuery(
            internal.crystal.messages.getMessagesByIdsForSearch,
            {
              messageIds: vectorResults.map((result) => result._id as any),
            },
          )
        : [];

    const vectorHits = shapeVectorMessageResults(
      vectorResults,
      hydratedMessages,
      {
        userId: args.userId,
        limit,
        channel,
        sessionKey,
        sinceMs: args.sinceMs,
      },
    );

    const textQuery = normalizeText(args.query);
    if (vectorHits.length < limit && textQuery) {
      const textBudget = args.skipCostBreaker
        ? null
        : await debitMessageSearchCost(ctx, {
            userId: args.userId,
            estimatedTextQueryBytes: ESTIMATED_MESSAGE_TEXT_QUERY_BYTES,
            reason: "messages.searchMessagesForUser.text",
          });
      const textPolicy = userTier
        ? resolveTieredVectorReachPolicy({
            tier: userTier,
            normalVectorDepth: vectorTake,
            vectorBudget: messageBudget,
            textBudget,
            indexedFallbackAllowedOnDegradation: true,
          })
        : null;
      const canSearchText =
        args.textAllowed !== false &&
        (args.skipCostBreaker || textPolicy?.textAllowed !== false);
      const textResults = !canSearchText
        ? []
        : await ctx.runQuery(
            internal.crystal.messages.searchMessagesByTextForUser,
            {
              userId: args.userId,
              query: textQuery,
              limit: limit - vectorHits.length,
              channel,
              sessionKey,
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

    return filterSearchResultsByChannel(vectorHits, channel);
  },
});
