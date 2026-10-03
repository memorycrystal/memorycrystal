import { enforceAccountRateLimit } from "./accountRateLimit";
import { stableUserId } from "./auth";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { classifyChannel, loadWorkChannelAllowlist } from "./channelClassifier";
import { type Doc, type Id } from "../_generated/dataModel";
import { type UserTier, TIER_LIMITS, TIER_STM_TTL_DAYS } from "../../shared/tierLimits";
import {
  applyDashboardTotalsDelta,
  getDashboardTotals,
} from "./publicDashboardTotals";
import {
  COST_UNIT_BYTES,
  isCostBreakerEnabled,
  mergeCostBudgetResults,
  type CostBudgetResult,
} from "./recallBudgetPolicy";
import { logError, sha256Hex } from "./crypto";
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
    const result = await ctx.runMutation((internal as any).crystal.costBreaker.debitUserAndGlobal, {
      userId: args.userId,
      surface: "messages",
      estimatedVectorQueryBytes: args.estimatedVectorQueryBytes,
      estimatedTextQueryBytes: args.estimatedTextQueryBytes,
      reason: args.reason,
    });
    return mergeCostBudgetResults(result.user, result.global);
  } catch (error) {
    console.warn("[costBreaker] message search debit failed open", await logError(error, args.userId));
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

/**
 * ILL-320 (audit A04): rows one query transaction reads for the unscoped recent
 * scan. Legacy `crystalMessages` rows (written before 2026-09-07) still carry a
 * 3,072-float embedding, about 40 KB serialized, so a page is capped at 200
 * rows (about 8 MB worst case) to stay inside the 16 MiB per-function read
 * limit. This is also the most rows the base code read per transaction.
 */
export const RECENT_VISIBLE_SCAN_PAGE = 200;
/**
 * ILL-320 (audit A04): most rows the action-side loop reads across pages
 * (5 pages of 200) before it returns what it found.
 */
export const RECENT_VISIBLE_SCAN_BOUND = 1000;

type RecentVisibleRow = Doc<"crystalMessages">;

/** ILL-320 (audit A04): one page of the unscoped recent scan. */
export type RecentVisiblePage = {
  /** The newest visible (global or work) rows in the page, at most `limit`. */
  visibleNewestFirst: RecentVisibleRow[];
  /** Cursor for the next page; pass it back as `cursor`. */
  continueCursor: string;
  /** True when the index range is exhausted. */
  isDone: boolean;
  /** Rows the page read from `by_user_time`, visible or not. */
  read: number;
};

/**
 * ILL-320 (audit A04): the newest `limit` rows of a newest-first page whose
 * channel classifies as `global` or `work`. Shared by the paginated internal
 * query and the single-page public `getRecentMessages`.
 */
const selectVisibleNewestFirst = <T extends { channel?: string }>(
  newestFirst: readonly T[],
  limit: number,
  allowlist: readonly string[],
): T[] => {
  const visible: T[] = [];
  for (const row of newestFirst) {
    if (classifyChannel(row.channel, allowlist) === "private") continue;
    visible.push(row);
    if (visible.length >= limit) break;
  }
  return visible;
};

/** `by_user_time` newest-first, bounded to the `sinceMs`/`beforeMs` range. */
const recentByUserTimeDesc = (
  ctx: any,
  userId: string,
  range: { sinceMs?: number; beforeMs?: number },
) =>
  ctx.db
    .query("crystalMessages")
    .withIndex("by_user_time", (q: any) => {
      let indexed = q.eq("userId", userId as never);
      if (range.sinceMs !== undefined) indexed = indexed.gte("timestamp", range.sinceMs);
      if (range.beforeMs !== undefined) indexed = indexed.lte("timestamp", range.beforeMs);
      return indexed;
    })
    .order("desc");

/**
 * ILL-320 (audit A04): one page of the unscoped recent scan, read in its own
 * query transaction. The page is at most `RECENT_VISIBLE_SCAN_PAGE` rows
 * (`numItems` is clamped), taken with Convex `.paginate()` on `by_user_time`
 * newest-first within `sinceMs`/`beforeMs`. Convex cursors are exact across
 * timestamp ties, so rows that share one millisecond are never skipped or
 * repeated between pages. Each row is classified with `classifyChannel` against
 * `loadWorkChannelAllowlist()`, read here inside the query, and the newest
 * `limit` visible rows of the page are returned. Drive it with
 * `collectRecentVisibleMessages` from an action.
 */
export const getRecentVisibleMessagesPageForUser = internalQuery({
  args: {
    userId: v.string(),
    numItems: v.number(),
    cursor: v.union(v.string(), v.null()),
    limit: v.optional(v.number()),
    sinceMs: v.optional(v.number()),
    beforeMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<RecentVisiblePage> => {
    const numItems = toClampedLimit(
      args.numItems,
      1,
      RECENT_VISIBLE_SCAN_PAGE,
      RECENT_VISIBLE_SCAN_PAGE,
    );
    const limit = toClampedLimit(args.limit, 1, RECENT_VISIBLE_SCAN_PAGE, RECENT_VISIBLE_SCAN_PAGE);
    const allowlist = loadWorkChannelAllowlist();
    // The only .paginate() call in this function (Convex allows one per query).
    const page = await recentByUserTimeDesc(ctx, args.userId, args).paginate({
      numItems,
      cursor: args.cursor,
    });
    return {
      visibleNewestFirst: selectVisibleNewestFirst(page.page as RecentVisibleRow[], limit, allowlist),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      read: page.page.length,
    };
  },
});

/**
 * ILL-320 (audit A04): action-side loop over `getRecentVisibleMessagesPageForUser`
 * for unscoped surfaces (no channel and no sessionKey): the MCP recent-messages
 * route, wake's recent block, `getWakePrompt` and the public `searchMessages`
 * recent path. It pages `by_user_time` newest-first, one query transaction per
 * page of at most `RECENT_VISIBLE_SCAN_PAGE` (200) rows, until `limit` visible
 * rows are collected, the range is exhausted, or `RECENT_VISIBLE_SCAN_BOUND`
 * (1,000) rows have been read, then returns what it found.
 *
 * Returns the newest `limit` visible rows in chronological order (oldest
 * first), the same contract as `getRecentMessagesForUserInternal`, so callers
 * that re-order by `order` keep working unchanged.
 */
export async function collectRecentVisibleMessages(
  ctx: { runQuery: ActionCtx["runQuery"] },
  userId: string,
  options: {
    limit?: number;
    sinceMs?: number;
    beforeMs?: number;
    /** Test hook (rows per page, at most RECENT_VISIBLE_SCAN_PAGE); production callers keep the default. */
    pageSize?: number;
    /** Test hook (total rows read); production callers keep the default. */
    scanBound?: number;
  } = {},
): Promise<RecentVisibleRow[]> {
  const limit = toClampedLimit(options.limit, 1, 200, 20);
  const pageSize = toClampedLimit(
    options.pageSize,
    1,
    RECENT_VISIBLE_SCAN_PAGE,
    RECENT_VISIBLE_SCAN_PAGE,
  );
  const scanBound = Math.max(1, Math.trunc(options.scanBound ?? RECENT_VISIBLE_SCAN_BOUND));
  const newestFirst: RecentVisibleRow[] = [];
  let cursor: string | null = null;
  let read = 0;

  while (newestFirst.length < limit && read < scanBound) {
    const page: RecentVisiblePage = await ctx.runQuery(
      internal.crystal.messages.getRecentVisibleMessagesPageForUser,
      {
        userId,
        numItems: Math.min(pageSize, scanBound - read),
        cursor,
        limit: limit - newestFirst.length,
        sinceMs: options.sinceMs,
        beforeMs: options.beforeMs,
      },
    );
    read += page.read;
    newestFirst.push(...page.visibleNewestFirst);
    if (page.isDone || page.read === 0) break;
    cursor = page.continueCursor;
  }

  return newestFirst.slice(0, limit).reverse();
}

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

/** Raw recall candidates: filtering belongs to the action's refill loop. */
export type RecallMessageCandidate = SearchMessageResult & {
  metadata?: Doc<"crystalMessages">["metadata"];
  /** A row whose identifiers are too long to return: counted as scanned, never visible to anyone. */
  hidden?: true;
};

export type RecallMessagePage = {
  page: RecallMessageCandidate[];
  continueCursor: string;
  isDone: boolean;
};

/**
 * A raw recall page returns every scanned row, visible or not, so what a row weighs on the wire must not depend on
 * what a caller can write into it: with unbounded metadata, channel, sessionKey or turnId, one invisible row decides
 * whether a page fits Convex's 8 MiB return limit, and the page failure is a readable count of invisible rows.
 * The candidate is therefore a bounded projection: content at the write-path cap, metadata reduced to the two project
 * fields, and a row whose identifiers exceed the caps is returned as a stub that is never visible. The worst page is
 * 200 rows of about 30 KB, far below the limit, whatever is stored.
 */
export const RECALL_CANDIDATE_CONTENT_MAX = MAX_CONTENT_LENGTH;
export const RECALL_CANDIDATE_ID_MAX = 512;       // channel and sessionKey
export const RECALL_CANDIDATE_TURN_MAX = 128;     // turnId
export const RECALL_CANDIDATE_PROJECT_MAX = 256;  // metadata.projectId and metadata.repoSlug

/** Only the project identity the action matches on survives; anything else in the metadata stays in the database. */
export function boundedRecallMetadata(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { projectId, repoSlug } = parsed as Record<string, unknown>;
  const kept: Record<string, string> = {};
  if (typeof projectId === "string" && projectId.length <= RECALL_CANDIDATE_PROJECT_MAX) kept.projectId = projectId;
  if (typeof repoSlug === "string" && repoSlug.length <= RECALL_CANDIDATE_PROJECT_MAX) kept.repoSlug = repoSlug;
  return Object.keys(kept).length ? JSON.stringify(kept) : undefined;
}

/** Content at the write-path cap, cut before a surrogate pair rather than inside it (older rows can exceed the cap). */
const boundedRecallContent = (content: string): string => {
  if (content.length <= RECALL_CANDIDATE_CONTENT_MAX) return content;
  const last = content.charCodeAt(RECALL_CANDIDATE_CONTENT_MAX - 1);
  return content.slice(0, last >= 0xd800 && last <= 0xdbff ? RECALL_CANDIDATE_CONTENT_MAX - 1 : RECALL_CANDIDATE_CONTENT_MAX);
};

const identifiersTooLong = (message: Doc<"crystalMessages">): boolean =>
  (message.channel?.length ?? 0) > RECALL_CANDIDATE_ID_MAX ||
  (message.sessionKey?.length ?? 0) > RECALL_CANDIDATE_ID_MAX ||
  (message.turnId?.length ?? 0) > RECALL_CANDIDATE_TURN_MAX;

const recallMessageCandidate = (
  message: Doc<"crystalMessages">,
  score = 0,
): RecallMessageCandidate => {
  if (identifiersTooLong(message)) {
    return { messageId: String(message._id), role: message.role, content: "", timestamp: message.timestamp, score: 0, hidden: true };
  }
  return {
    messageId: String(message._id),
    role: message.role,
    content: boundedRecallContent(message.content),
    channel: message.channel,
    sessionKey: message.sessionKey,
    timestamp: message.timestamp,
    metadata: boundedRecallMetadata(message.metadata),
    turnId: message.turnId,
    turnMessageIndex: message.turnMessageIndex,
    score,
  };
};

/**
 * One bounded read for recall's action-side refill. No eligibility filtering
 * here: the action counts every scanned row, then applies all filters together.
 * Channel/session/time constraints use an index where possible. When both
 * scopes are present the action additionally checks the non-indexed scope.
 * Legacy inline vectors are read but never returned.
 */
export const getRecallRecentMessagesPageForUser = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.union(v.string(), v.null()),
    pageSize: v.number(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
    beforeMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<RecallMessagePage> => {
    const channel = normalizeText(args.channel);
    const sessionKey = normalizeText(args.sessionKey);
    const range = (q: any) => {
      if (args.sinceMs !== undefined) q = q.gte("timestamp", args.sinceMs);
      if (args.beforeMs !== undefined) q = q.lte("timestamp", args.beforeMs);
      return q;
    };
    const query = sessionKey
      ? ctx.db.query("crystalMessages").withIndex("by_session_time", (q) =>
          range(q.eq("userId", args.userId).eq("sessionKey", sessionKey)))
      : channel
        ? ctx.db.query("crystalMessages").withIndex("by_channel_time", (q) =>
            range(q.eq("userId", args.userId).eq("channel", channel)))
        : ctx.db.query("crystalMessages").withIndex("by_user_time", (q) =>
            range(q.eq("userId", args.userId)));
    const page = await query.order("desc").paginate({
      cursor: args.cursor,
      numItems: toClampedLimit(args.pageSize, 1, RECENT_VISIBLE_SCAN_PAGE, RECENT_VISIBLE_SCAN_PAGE),
    });
    return {
      page: page.page.map((message) => recallMessageCandidate(message)),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Merge independently bounded classified lanes before the caller slices a page. */
export function mergeClassifiedMessageMatches<T extends SearchMessageResult>(
  textMatches: readonly T[],
  recentMatches: readonly T[],
  allowlist: readonly string[],
): T[] {
  const matches = new Map<string, T>();
  for (const candidate of [...textMatches, ...recentMatches]) {
    if (classifyChannel(candidate.channel, allowlist) === "private") continue;
    const existing = matches.get(candidate.messageId);
    if (!existing || candidate.score > existing.score ||
        (candidate.score === existing.score && candidate.timestamp > existing.timestamp)) {
      matches.set(candidate.messageId, candidate);
    }
  }
  return [...matches.values()].sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
}

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
      (internal as any).crystal.userProfiles.getUserTier,
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
      expiresAt: now + (ttlMs || DEFAULT_TTL_MS),
      metadata: normalizeText(args.metadata),
      turnId,
      turnMessageIndex,
      contentHash,
      dedupeScopeHash,
    });

    await applyDashboardTotalsDelta(ctx, userId, { totalMessagesDelta: 1 });

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
      (internal as any).crystal.userProfiles.getUserTier,
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
      expiresAt: now + (ttlMs || DEFAULT_TTL_MS),
      metadata: normalizeText(rest.metadata),
      turnId,
      turnMessageIndex,
      contentHash,
      dedupeScopeHash,
    });

    await applyDashboardTotalsDelta(ctx, userId, { totalMessagesDelta: 1 });

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
      (internal as any).crystal.userProfiles.getUserTier,
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
        expiresAt: message.expiresAt,
        metadata: message.metadata,
        turnId: message.turnId,
        turnMessageIndex: message.turnMessageIndex,
        contentHash: message.contentHash,
        dedupeScopeHash: message.dedupeScopeHash,
      });
      insertedCount += 1;
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
          metadata: appendCleanupMetadata(message.metadata, now),
          contentHash,
          dedupeScopeHash,
          dedupeCheckedAt: undefined,
          ltmExtracted: undefined,
          ltmExtractedAt: undefined,
          ltmExtractionSkippedReason: undefined,
        });
        summary.patched += 1;
      }
    }

    return summary;
  },
});

/**
 * Recent messages for the authenticated user, chronological (oldest first).
 * Scoped requests (channel or sessionKey) return the newest `limit` rows of
 * that scope. ILL-320 (audit A04): an unscoped request reads a single page of
 * at most 200 rows from `by_user_time` and returns the newest `limit` rows in
 * it whose channel classifies as `global` or `work`; private channels are
 * always excluded. Because a query runs in one transaction, the page can be
 * short (even empty) when the newest 200 rows are all private. The MCP server
 * fallback (`mcp-server/src/tools/recent.ts`) calls this directly.
 */
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
    // ILL-320 (audit A04): an unscoped request sees only global and work
    // channels, always (an empty allowlist means only channel-less rows and
    // dev-session paths pass). A query cannot span transactions, so this reads
    // one bounded page, the newest RECENT_VISIBLE_SCAN_PAGE (200) rows in the
    // range, and returns the newest `limit` visible rows within it. The page
    // may be short, even empty, when the newest 200 rows are all private;
    // action callers use `collectRecentVisibleMessages` to page further.
    if (!normalizeText(args.channel) && !normalizeText(args.sessionKey)) {
      const limit = toClampedLimit(args.limit, 1, 200, 20);
      const page: RecentVisibleRow[] = await recentByUserTimeDesc(ctx, userId, {
        sinceMs: args.sinceMs,
      }).take(RECENT_VISIBLE_SCAN_PAGE);
      return selectVisibleNewestFirst(page, limit, loadWorkChannelAllowlist()).reverse();
    }
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
    unscopedVisibility: v.optional(v.literal("classified")),
  },
  handler: async (ctx, args) => {
    const { userId, unscopedVisibility, ...rest } = args;
    const rows = await getRecentMessagesForUserInternal(ctx, userId, rest);
    // Classified search needs text only. Legacy vectors can push 200 full
    // rows over Convex's 8 MiB return limit even when their read fits 16 MiB.
    if (unscopedVisibility === "classified" &&
        !normalizeText(args.channel) && !normalizeText(args.sessionKey)) {
      return rows.map(({ embedding: _embedding, ...row }: Doc<"crystalMessages">) => row);
    }
    return rows;
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

type SearchMessagesArgs = {
  userId: string;
  query: string;
  limit?: number;
  channel?: string;
  sessionKey?: string;
  sinceMs?: number;
  unscopedVisibility?: "classified";
};

function addSearchMessageMatch(
  matches: Map<string, SearchMessageResult>,
  message: any,
  query: string,
  scope: { channel?: string; sessionKey?: string; sinceMs?: number },
  requirePositiveScore: boolean,
) {
  if (scope.channel !== undefined && message.channel !== scope.channel) return;
  if (scope.sessionKey !== undefined && message.sessionKey !== scope.sessionKey) return;
  if (scope.sinceMs !== undefined && message.timestamp < scope.sinceMs) return;
  const candidate: SearchMessageResult = {
    messageId: String(message._id), role: message.role, content: message.content,
    channel: message.channel, sessionKey: message.sessionKey, timestamp: message.timestamp,
    score: lexicalMessageScore(query, message.content),
  };
  if (requirePositiveScore && candidate.score <= 0) return;
  const existing = matches.get(candidate.messageId);
  if (!existing || candidate.score > existing.score
    || (candidate.score === existing.score && candidate.timestamp > existing.timestamp)) {
    matches.set(candidate.messageId, candidate);
  }
}

async function collectIndexedMessageMatches(
  ctx: any,
  args: SearchMessagesArgs,
  query: string,
  terms: string[],
  scanLimit: number,
  scope: { channel?: string; sessionKey?: string; sinceMs?: number },
) {
  const resultSets = await Promise.all(terms.map((term) => ctx.db
    .query("crystalMessages")
    .withSearchIndex("search_content", (q: any) => q.search("content", term).eq("userId", args.userId))
    .take(scanLimit)));
  const matches = new Map<string, SearchMessageResult>();
  for (const message of resultSets.flat()) addSearchMessageMatch(matches, message, query, scope, false);
  return matches;
}

async function collectRecentMessageMatches(
  ctx: any,
  args: SearchMessagesArgs,
  query: string,
  limit: number,
  scope: { channel?: string; sessionKey?: string; sinceMs?: number },
  matches: Map<string, SearchMessageResult>,
) {
  // getRecentMessagesForUserInternal clamps this to 200 rows in one
  // transaction; that is the real depth of the recent lane here.
  const recentScanLimit = Math.min(Math.max(limit * 20, 100), 300);
  const recent = await getRecentMessagesForUserInternal(ctx, args.userId, { limit: recentScanLimit, ...scope });
  for (const message of recent) addSearchMessageMatch(matches, message, query, scope, true);
}

// Recall reads raw pages when its eligibility filters are active and filters
// them in its action-side loop. Each call reads at most 200 documents; the
// action owns the per-lane caps.
export const searchMessagePageForRecall = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
    cursor: v.union(v.string(), v.null()),
    pageSize: v.number(),
  },
  handler: async (ctx, args): Promise<RecallMessagePage> => {
    const query = normalizeText(args.query);
    if (!query) return { page: [], continueCursor: "", isDone: true };
    // Unwrap once and paginate exactly once. Do not merge a recent read in
    // this transaction: 400 legacy rows would exceed the 16 MiB read limit.
    const normalizedQuery = unwrapQuotedSearchQuery(query);
    const page = await ctx.db.query("crystalMessages")
      .withSearchIndex("search_content", (q) => q.search("content", normalizedQuery).eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: toClampedLimit(args.pageSize, 1, RECENT_VISIBLE_SCAN_PAGE, RECENT_VISIBLE_SCAN_PAGE) });
    return {
      page: page.page.map((message) => recallMessageCandidate(message, lexicalMessageScore(normalizedQuery, message.content))),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const searchMessagesByTextForUser = internalQuery({
  args: {
    userId: v.string(), query: v.string(), limit: v.optional(v.number()),
    channel: v.optional(v.string()), sessionKey: v.optional(v.string()), sinceMs: v.optional(v.number()),
    // ILL-320 (audit A04): set by the public searchMessages action and by the
    // standalone MCP search (searchMessageMatches) so an unscoped request drops
    // private channels before this query's result cut. Recall instead reads
    // searchMessagePageForRecall and filters in its action-side loop.
    unscopedVisibility: v.optional(v.literal("classified")),
  },
  handler: async (ctx, args): Promise<SearchMessageResult[]> => {
    const query = normalizeText(args.query);
    if (!query) return [];
    const channel = normalizeText(args.channel);
    const sessionKey = normalizeText(args.sessionKey);
    const classifyUnscoped = args.unscopedVisibility === "classified" && !channel && !sessionKey;
    const limit = toClampedLimit(args.limit, 1, classifyUnscoped ? 200 : 100, 10);
    const allowlist = classifyUnscoped ? loadWorkChannelAllowlist() : undefined;
    const normalizedQuery = unwrapQuotedSearchQuery(query);
    const terms = Array.from(new Set([query, normalizedQuery].filter(Boolean)));
    // When classifying, private rows are removed after the scan, so read the
    // full platform-capped 200-row text window to keep pages full. Visible
    // matches outside that window are not reachable from this lane. A quoted or
    // bracketed query tokenizes like its unwrapped text, so only the unwrapped
    // term is scanned: this transaction reads at most 200 text rows. The
    // caller reads the recent lane in a separate transaction. Legacy rows
    // carry 3,072-float embeddings, which count toward Convex's per-transaction
    // read limit.
    const scanTerms = classifyUnscoped ? [normalizedQuery] : terms;
    const scanLimit = classifyUnscoped ? 200 : Math.min(limit * (channel || sessionKey || args.sinceMs !== undefined ? 12 : 8), 200);
    const scope = { channel, sessionKey, sinceMs: args.sinceMs };
    const matches = await collectIndexedMessageMatches(ctx, args, normalizedQuery, scanTerms, scanLimit, scope);
    if (!classifyUnscoped) await collectRecentMessageMatches(ctx, args, normalizedQuery, limit, scope, matches);
    const scoped = filterSearchResultsByChannel(Array.from(matches.values()), channel);
    // Classified calls expose the entire visible text window (up to 200),
    // including the candidates needed for the outer pagination probe.
    const visible = allowlist ? scoped.filter((match) => classifyChannel(match.channel, allowlist) !== "private") : scoped;
    return visible.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp).slice(0, limit);
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
    // Accepted for one compatibility window and intentionally ignored. Raw
    // transcript vectors were retired in v0.9.0.
    embedding: v.optional(v.array(v.float64())),
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
    await enforceAccountRateLimit(ctx, userId);

    const channel = normalizeText(args.channel);
    const sessionKey = normalizeText(args.sessionKey);
    const limit = toClampedLimit(args.limit, 1, 100, 10);
    const textQuery = normalizeText(args.query);
    // ILL-320 (audit A04): an unscoped request sees only global and work
    // channels, with or without an operator allowlist. Text and recent lanes
    // are classified and merged before slicing, so pages stay full.
    const isUnscoped = channel === undefined && sessionKey === undefined;

    if (textQuery) {
      await debitMessageSearchCost(ctx, {
        userId,
        estimatedTextQueryBytes: COST_UNIT_BYTES.textIndexQuery,
        reason: "messages.searchMessages.text",
      });
      if (isUnscoped) {
        // Each lane gets its own transaction: legacy embeddings make 400
        // documents unsafe under Convex's 16 MiB transaction read limit.
        const [textMatches, recent] = await Promise.all([
          ctx.runQuery(internal.crystal.messages.searchMessagesByTextForUser, {
            userId, query: textQuery, limit: 200, sinceMs: args.sinceMs,
            unscopedVisibility: "classified",
          }),
          ctx.runQuery(internal.crystal.messages.getRecentMessagesForUser, {
            userId, limit: 200, sinceMs: args.sinceMs,
            unscopedVisibility: "classified",
          }),
        ]);
        const lexicalQuery = unwrapQuotedSearchQuery(textQuery);
        const recentMatches = (recent as Doc<"crystalMessages">[]).map((message) => ({
          messageId: String(message._id), role: message.role, content: message.content,
          channel: message.channel, sessionKey: message.sessionKey,
          timestamp: message.timestamp,
          score: lexicalMessageScore(lexicalQuery, message.content),
        })).filter((message) => message.score > 0);
        return mergeClassifiedMessageMatches(
          textMatches, recentMatches, loadWorkChannelAllowlist(),
        ).slice(0, limit);
      }
      return await ctx.runQuery(
        internal.crystal.messages.searchMessagesByTextForUser,
        {
          userId, query: textQuery, limit, channel, sessionKey, sinceMs: args.sinceMs,
          ...(isUnscoped ? { unscopedVisibility: "classified" as const } : {}),
        },
      );
    }
    if (isUnscoped) {
      // Paged scan (at most 1,000 rows in pages of 200), one transaction per page.
      return (await collectRecentVisibleMessages(ctx, userId, {
        limit, sinceMs: args.sinceMs,
      })) as unknown as SearchMessageResult[];
    }
    return await ctx.runQuery(internal.crystal.messages.getRecentMessagesForUser, {
      userId, limit, channel, sessionKey, sinceMs: args.sinceMs,
    });
  },
});

export const searchMessagesForUser = internalAction({
  args: {
    userId: v.string(),
    embedding: v.optional(v.array(v.float64())),
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
    const textQuery = normalizeText(args.query);
    if (textQuery && args.textAllowed !== false) {
      if (!args.skipCostBreaker) {
        await debitMessageSearchCost(ctx, {
            userId: args.userId,
            estimatedTextQueryBytes: COST_UNIT_BYTES.textIndexQuery,
            reason: "messages.searchMessagesForUser.text",
          });
      }
      return await ctx.runQuery(internal.crystal.messages.searchMessagesByTextForUser, {
        userId: args.userId, query: textQuery, limit, channel, sessionKey, sinceMs: args.sinceMs,
      });
    }
    return await ctx.runQuery(internal.crystal.messages.getRecentMessagesForUser, {
      userId: args.userId, limit, channel, sessionKey, sinceMs: args.sinceMs,
    });
  },
});
