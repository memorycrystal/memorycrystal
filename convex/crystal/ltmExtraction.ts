import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
  buildStrengthDelta,
} from "./dashboardTotals";
import { scanMemoryContent, type ScanResult } from "./contentScanner";
import { sha256Hex } from "./crypto";
import {
  buildMemoryHashInput,
  buildMessageDedupeScopeInput,
  buildMessageHashInput,
  normalizeMemoryContentForHash,
} from "./contentHash";
import { stableUserId } from "./auth";
import { canPerformWriteActions, normalizeRoles } from "./permissions";
import { shouldEnrich } from "./organic/enrichmentEligibility";
import { classifyChunkKind, compressRecallText } from "./recallCompression";
import { patchMemoryAndSyncCleanupProjection } from "./cleanupProjection";
export { isProactiveDistillationChannelEligible } from "./channelScope";
import { buildDistillationPrompt, deriveDistillationProfile } from "./distillationProfiles";
import { requestOpenRouter, recordMissingOpenRouterKey } from "./providerGateway";

const EXTRACTION_MODEL = "openai/gpt-4o-mini";
// Shared with reflectionCycle.ts and backlogDrain.ts so the mid-loop
// no-credential guard can never drift out of sync with the reason the engine
// actually produces (ILL-181 audit F3).
export const MISSING_USER_OPENROUTER_KEY_REASON = "OPENROUTER_API_KEY not set for user";
const DEFAULT_MESSAGES_PER_USER = 60;
const DEFAULT_USERS_PER_RUN = 20;
const CRON_ROTATION_MS = 15 * 60 * 1000;
const MAX_MESSAGES_PER_USER = 200;
const MAX_USERS_PER_RUN = 100;
// Page size for iterating crystalUserProfiles inside a single catchup run.
const USER_ID_PAGE_SIZE = 200;
// Distillation min-age. Must stay ≤ 20h so a free-tier 24h Verbatim Window
// is eligible at least 4h before T+24h (ILL-182). The Reflection Cycle
// passes an explicit beforeTimestamp; catch-up/on-demand use this default.
export const EXTRACTION_SETTLE_MS = 2 * 60 * 1000;
const TURN_GAP_MS = 15 * 60 * 1000;
const MAX_WINDOW_MESSAGES = 12;
const MAX_WINDOW_CHARS = 8_000;
const ON_DEMAND_MAX_MESSAGES = 12;
const ON_DEMAND_MAX_MEMORIES_PER_TURN = 2;
// On-demand non-turn (session-keyed) window cap. parseExtractedMemories slices
// model output to 6, but on-demand callers (retirement drain, catchup, turn
// endpoint, MCP) keep this at 3 so a session-keyed drain cannot silently double
// its LTM yield and embedding spend outside the nightly job.
const ON_DEMAND_MAX_MEMORIES_PER_WINDOW = 3;
// Nightly Reflection Cycle cap: the cycle distils whole conversation windows,
// so it uses the full parseExtractedMemories ceiling (6) for every window type.
const REFLECTION_CYCLE_MAX_MEMORIES_PER_WINDOW = 6;
const ON_DEMAND_COOLDOWN_MS = 60 * 1000;
const ON_DEMAND_HOURLY_CAP = 20;
const LTM_TELEMETRY_KIND = "ltm_extraction";
const GPT_4O_MINI_INPUT_USD_PER_1M = 0.15;
const GPT_4O_MINI_OUTPUT_USD_PER_1M = 0.60;

type Role = "user" | "assistant" | "system";
type ExtractionContext = "on_demand" | "reflection_cycle";
type MemoryStore = "episodic" | "semantic" | "procedural" | "prospective";
type MemoryCategory = "decision" | "lesson" | "person" | "rule" | "event" | "fact" | "goal" | "skill" | "workflow" | "conversation";

type MessageRecord = {
  _id: Id<"crystalMessages">;
  userId: string;
  role: Role;
  content: string;
  channel?: string;
  sessionKey?: string;
  turnId?: string;
  turnMessageIndex?: number;
  timestamp: number;
  contentHash?: string;
  dedupeScopeHash?: string;
  dedupeCheckedAt?: number;
  ltmExtractedAt?: number;
  ltmExtractionSkippedReason?: string;
  retirementQueuedAt?: number;
  retiredAt?: number;
};

type ExtractedMemory = {
  title: string;
  content: string;
  store: MemoryStore;
  category: MemoryCategory;
  tags: string[];
  confidence: number;
  strength: number;
};

type ExtractionWindow = {
  key: string;
  channel?: string;
  sessionKey?: string;
  messageIds: Id<"crystalMessages">[];
  startedAt: number;
  endedAt: number;
  text: string;
};

type OpenRouterCredential = { apiKey: string | null; source: "personal" | "shared" | null; keyPrefix?: string | null; keyLast4?: string | null };
type ExtractionUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};
type ExtractionCallResult = {
  memories: ExtractedMemory[];
  usage: ExtractionUsage;
};

const STORE_VALUES = new Set<MemoryStore>(["episodic", "semantic", "procedural", "prospective"]);
const CATEGORY_VALUES = new Set<MemoryCategory>([
  "decision",
  "lesson",
  "person",
  "rule",
  "event",
  "fact",
  "goal",
  "skill",
  "workflow",
  "conversation",
]);

const clamp01 = (value: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;

const clampInt = (value: number | undefined, min: number, max: number, fallback: number) => {
  const raw = Number.isFinite(value ?? NaN) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(raw, min), max);
};

function tokenEstimateFromChars(chars: number): number {
  return Math.ceil(Math.max(chars, 0) / 4);
}

function estimateExtractionCostUsd(inputTokens: number, outputTokens: number): number {
  const value = (inputTokens / 1_000_000) * GPT_4O_MINI_INPUT_USD_PER_1M
    + (outputTokens / 1_000_000) * GPT_4O_MINI_OUTPUT_USD_PER_1M;
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0;
}

function usageFromExtractionPayload(payload: any, prompt: string): ExtractionUsage {
  const inputTokens = Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens);
  const outputTokens = Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens);
  const estimatedInputTokens = Number.isFinite(inputTokens) && inputTokens > 0
    ? inputTokens
    : tokenEstimateFromChars(prompt.length);
  const estimatedOutputTokens = Number.isFinite(outputTokens) && outputTokens > 0
    ? outputTokens
    : 220;
  return {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    estimatedCostUsd: estimateExtractionCostUsd(estimatedInputTokens, estimatedOutputTokens),
  };
}

const normalizeText = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function shouldScheduleLtmBackgroundWork() {
  return !(
    typeof process !== "undefined" &&
    (process.env.VITEST || process.env.NODE_ENV === "test")
  );
}

const normalizeTags = (tags: unknown): string[] =>
  Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag).trim().toLowerCase())
        .filter((tag) => tag.length > 0)
    )
  ).slice(0, 12);

const normalizeExtractedMemory = (candidate: any): ExtractedMemory | null => {
  const title = normalizeText(String(candidate?.title ?? ""));
  const content = normalizeText(String(candidate?.content ?? ""));
  const store = String(candidate?.store ?? "semantic") as MemoryStore;
  const category = String(candidate?.category ?? "fact") as MemoryCategory;
  if (!title || !content) return null;
  if (!STORE_VALUES.has(store) || !CATEGORY_VALUES.has(category)) return null;
  return {
    title: title.slice(0, 200),
    content: content.slice(0, 4_000),
    store,
    category,
    tags: normalizeTags(candidate?.tags),
    confidence: clamp01(Number(candidate?.confidence), 0.75),
    strength: clamp01(Number(candidate?.importance ?? candidate?.strength), 0.75),
  };
};

export function parseExtractedMemories(raw: string): ExtractedMemory[] {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  const candidates = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.memories) ? parsed.memories : [];
  return candidates
    .map((candidate: any) => normalizeExtractedMemory(candidate))
    .filter((memory: ExtractedMemory | null): memory is ExtractedMemory => memory !== null)
    .slice(0, 6);
}

function memoryCapForWindow(window: ExtractionWindow, context: ExtractionContext) {
  if (context === "reflection_cycle") return REFLECTION_CYCLE_MAX_MEMORIES_PER_WINDOW;
  return window.key.startsWith("turn:") ? ON_DEMAND_MAX_MEMORIES_PER_TURN : ON_DEMAND_MAX_MEMORIES_PER_WINDOW;
}

function ltmScopeKey(args: { userId: string; channel?: string; sessionKey?: string }) {
  return [args.userId, args.channel ?? "", args.sessionKey ?? ""].join("|");
}

export function buildExtractionRunId(
  args: { userId: string; channel?: string; sessionKey?: string },
  now = Date.now(),
) {
  return ["ltm", now, args.userId, args.channel ?? "", args.sessionKey ?? ""].join(":");
}

function parseTelemetryPayload(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const formatMessageForPrompt = (message: MessageRecord) => {
  const iso = new Date(message.timestamp).toISOString();
  const content = message.content.length > 1_200 ? `${message.content.slice(0, 1_200).trim()}…` : message.content;
  return `[${iso}] ${message.role}: ${content}`;
};

const makeWindow = (key: string, messages: MessageRecord[]): ExtractionWindow => {
  const ordered = [...messages].sort(
    (a, b) =>
      (a.turnMessageIndex ?? Number.MAX_SAFE_INTEGER) - (b.turnMessageIndex ?? Number.MAX_SAFE_INTEGER) ||
      a.timestamp - b.timestamp
  );
  return {
    key,
    channel: ordered[0]?.channel,
    sessionKey: ordered[0]?.sessionKey,
    messageIds: ordered.map((message) => message._id),
    startedAt: ordered[0]?.timestamp ?? 0,
    endedAt: ordered[ordered.length - 1]?.timestamp ?? 0,
    text: ordered.map(formatMessageForPrompt).join("\n\n").slice(0, MAX_WINDOW_CHARS),
  };
};

export function groupMessagesForExtraction(messages: MessageRecord[]): ExtractionWindow[] {
  const candidates = [...messages]
    .filter((message) => message.role !== "system" && normalizeText(message.content))
    .sort((a, b) => a.timestamp - b.timestamp);

  const turnGroups = new Map<string, MessageRecord[]>();
  const ungrouped: MessageRecord[] = [];
  for (const message of candidates) {
    if (message.turnId) {
      const key = `turn:${message.sessionKey ?? ""}:${message.turnId}`;
      turnGroups.set(key, [...(turnGroups.get(key) ?? []), message]);
    } else {
      ungrouped.push(message);
    }
  }

  const windows: ExtractionWindow[] = [];
  for (const [key, group] of turnGroups) {
    windows.push(makeWindow(key, group));
  }

  let current: MessageRecord[] = [];
  let currentKey = "";
  const flush = () => {
    if (current.length > 0) {
      windows.push(makeWindow(currentKey || `window:${windows.length}`, current));
      current = [];
      currentKey = "";
    }
  };

  for (const message of ungrouped) {
    const scope = `${message.sessionKey ?? ""}|${message.channel ?? ""}`;
    const last = current[current.length - 1];
    const currentScope = last ? `${last.sessionKey ?? ""}|${last.channel ?? ""}` : scope;
    const wouldExceedChars = current.reduce((sum, item) => sum + item.content.length, 0) + message.content.length > MAX_WINDOW_CHARS;
    if (
      current.length > 0 &&
      (scope !== currentScope ||
        message.timestamp - (last?.timestamp ?? 0) > TURN_GAP_MS ||
        current.length >= MAX_WINDOW_MESSAGES ||
        wouldExceedChars)
    ) {
      flush();
    }
    if (current.length === 0) currentKey = `session:${scope}:${message.timestamp}`;
    current.push(message);
  }
  flush();

  return windows.sort((a, b) => a.startedAt - b.startedAt);
}

type RecentExtractionDigest = { title: string; content: string };

// General-profile delegate into the single prompt module. All prompt text and
// the profile -> prompt mapping live in ./distillationProfiles.
export const buildExtractionPrompt = (
  window: ExtractionWindow,
  recentDigests: RecentExtractionDigest[] = [],
) => buildDistillationPrompt(window, "general", recentDigests);

async function resolveUserOpenRouterCredential(ctx: any, userId: string): Promise<OpenRouterCredential> {
  return await ctx.runQuery((internal as any).crystal.providerSettings.resolveOpenRouterKeyForUser, {
    userId,
    includeShared: false,
  }) as OpenRouterCredential;
}

async function extractWindowMemories(
  ctx: Pick<any, "runMutation">,
  userId: string,
  window: ExtractionWindow,
  credential: { apiKey: string | null; keyLast4?: string | null },
  recentDigests: RecentExtractionDigest[] = [],
): Promise<ExtractionCallResult> {
  // Channel-derived distillation profile: codex/mission-control windows use the
  // engineering profile, peer-coach/telegram keep the relational rules, and
  // everything else uses the general prompt.
  const prompt = buildDistillationPrompt(window, deriveDistillationProfile(window.channel), recentDigests);
  const gatewayResult = await requestOpenRouter(ctx, {
    userId,
    apiKey: credential.apiKey as string,
    keyLast4: credential.keyLast4 ?? null,
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    source: "ltmExtraction.extractWindowMemories",
    body: {
      model: EXTRACTION_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    },
    headers: {
      "HTTP-Referer": "https://memorycrystal.ai",
      "X-Title": "Memory Crystal",
    },
  });

  if (!gatewayResult.ok) {
    throw new Error(
      `OpenRouter extraction failed: ${gatewayResult.status} ${gatewayResult.errorMessage ?? "unknown"}`,
    );
  }
  const payload = gatewayResult.payload as any;
  const usage = usageFromExtractionPayload(payload, prompt);
  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) return { memories: [], usage };
  return { memories: parseExtractedMemories(raw), usage };
}

export const getRecentExtractionDigests = internalQuery({
  args: {
    userId: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    beforeCreatedAt: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<RecentExtractionDigest[]> => {
    if (!args.sessionKey) return [];
    const limit = clampInt(args.limit, 1, 12, 8);
    const rows = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_channel_extraction_session_created", (q) =>
        q
          .eq("userId", args.userId)
          .eq("channel", args.channel)
          .eq("extractionSessionKey", args.sessionKey)
          .eq("archived", false)
          .lt("createdAt", args.beforeCreatedAt)
      )
      .order("desc")
      .take(limit);
    return rows.map((row) => ({ title: row.title, content: row.content }));
  },
});

export const getLtmCandidateMessages = internalQuery({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit, 1, MAX_MESSAGES_PER_USER, DEFAULT_MESSAGES_PER_USER);
    const beforeTimestamp = args.beforeTimestamp ?? Date.now() - EXTRACTION_SETTLE_MS;
    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_ltm_extracted_time", (q) =>
        q.eq("userId", args.userId).eq("ltmExtractedAt", undefined).lte("timestamp", beforeTimestamp)
      )
      .filter((q) => q.neq(q.field("role"), "system"))
      .order("asc")
      .take(limit);
  },
});

export const getOnDemandLtmCandidateMessages = internalQuery({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit, 1, ON_DEMAND_MAX_MESSAGES, ON_DEMAND_MAX_MESSAGES);
    const beforeTimestamp = args.beforeTimestamp ?? Date.now() - EXTRACTION_SETTLE_MS;
    const query = args.sessionKey
      ? ctx.db
          .query("crystalMessages")
          .withIndex("by_session_time", (q) =>
            q.eq("userId", args.userId).eq("sessionKey", args.sessionKey).lte("timestamp", beforeTimestamp)
          )
      : args.channel
        ? ctx.db
            .query("crystalMessages")
            .withIndex("by_channel_time", (q) =>
              q.eq("userId", args.userId).eq("channel", args.channel).lte("timestamp", beforeTimestamp)
            )
        : ctx.db
            .query("crystalMessages")
            .withIndex("by_user_time", (q) => q.eq("userId", args.userId).lte("timestamp", beforeTimestamp));

    const messages = await query.order("desc").take(limit * 2);
    return messages
      .filter((message) => message.ltmExtractedAt === undefined)
      .filter((message) => message.role !== "system")
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);
  },
});

export const getExactLtmCandidateMessages = internalQuery({
  args: {
    userId: v.string(),
    messageIds: v.array(v.id("crystalMessages")),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const messages = await Promise.all(args.messageIds.map((messageId) => ctx.db.get(messageId)));
    return messages
      .filter((message): message is NonNullable<typeof message> => Boolean(message))
      .filter((message) => message.userId === args.userId)
      .filter((message) => args.channel === undefined || message.channel === args.channel)
      .filter((message) => args.sessionKey === undefined || message.sessionKey === args.sessionKey)
      .filter((message) => message.ltmExtractedAt === undefined)
      .filter((message) => message.role !== "system")
      .sort((a, b) => a.timestamp - b.timestamp);
  },
});

export const getLtmSkippedMessagesForReset = internalQuery({
  args: {
    userId: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    startTimestamp: v.optional(v.number()),
    endTimestamp: v.optional(v.number()),
    reasons: v.array(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.reasons.length === 0) return [];
    const limit = clampInt(args.limit, 1, MAX_MESSAGES_PER_USER, DEFAULT_MESSAGES_PER_USER);
    const lowerBound = args.startTimestamp ?? 0;
    const upperBound = args.endTimestamp ?? Number.MAX_SAFE_INTEGER;
    const reasonSet = new Set(args.reasons);
    const query = args.sessionKey
      ? ctx.db
          .query("crystalMessages")
          .withIndex("by_session_time", (q) =>
            q.eq("userId", args.userId).eq("sessionKey", args.sessionKey).gte("timestamp", lowerBound)
          )
      : args.channel
        ? ctx.db
            .query("crystalMessages")
            .withIndex("by_channel_time", (q) =>
              q.eq("userId", args.userId).eq("channel", args.channel).gte("timestamp", lowerBound)
            )
        : ctx.db
            .query("crystalMessages")
            .withIndex("by_user_time", (q) => q.eq("userId", args.userId).gte("timestamp", lowerBound));

    const candidates = await query.order("asc").take(limit * 4);
    return candidates
      .filter((message) => message.timestamp <= upperBound)
      .filter((message) => args.channel === undefined || message.channel === args.channel)
      .filter((message) => args.sessionKey === undefined || message.sessionKey === args.sessionKey)
      .filter((message) => message.ltmExtractionSkippedReason && reasonSet.has(message.ltmExtractionSkippedReason))
      .slice(0, limit)
      .map((message) => ({
        _id: message._id,
        timestamp: message.timestamp,
        channel: message.channel,
        sessionKey: message.sessionKey,
        reason: message.ltmExtractionSkippedReason,
        contentPreview: message.content.slice(0, 160),
      }));
  },
});

export const clearMessagesLtmExtractionState = internalMutation({
  args: {
    messageIds: v.array(v.id("crystalMessages")),
  },
  handler: async (ctx, args) => {
    let updated = 0;
    for (const messageId of args.messageIds) {
      const message = await ctx.db.get(messageId);
      if (!message) continue;
      await ctx.db.patch(messageId, {
        ltmExtracted: undefined,
        ltmExtractedAt: undefined,
        ltmExtractionSkippedReason: undefined,
      });
      updated += 1;
    }
    return { updated };
  },
});

export const getLtmMaintenanceViewerAccess = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const latestProfile = profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    const roles = normalizeRoles((latestProfile as any)?.roles);
    return { allowed: canPerformWriteActions(roles), roles };
  },
});

export const resetLtmSkippedMessages = action({
  args: {
    userId: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    startTimestamp: v.optional(v.number()),
    endTimestamp: v.optional(v.number()),
    reasons: v.array(v.string()),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const viewerId = stableUserId(identity.subject);
    const access = await ctx.runQuery((internal as any).crystal.ltmExtraction.getLtmMaintenanceViewerAccess, {
      userId: viewerId,
    }) as { allowed: boolean };
    if (!access.allowed) {
      throw new Error("Forbidden: LTM reset requires manager or admin role");
    }
    if (args.reasons.length === 0) {
      throw new Error("resetLtmSkippedMessages requires at least one skipped reason");
    }
    const { dryRun: _dryRun, ...queryArgs } = args;
    const candidates = await ctx.runQuery((internal as any).crystal.ltmExtraction.getLtmSkippedMessagesForReset, queryArgs) as Array<{
      _id: Id<"crystalMessages">;
      timestamp: number;
      channel?: string;
      sessionKey?: string;
      reason?: string;
      contentPreview: string;
    }>;
    const dryRun = _dryRun !== false;
    if (!dryRun && candidates.length > 0) {
      await ctx.runMutation((internal as any).crystal.ltmExtraction.clearMessagesLtmExtractionState, {
        messageIds: candidates.map((message) => message._id),
      });
    }
    return {
      userId: args.userId,
      matched: candidates.length,
      reset: dryRun ? 0 : candidates.length,
      dryRun,
      reasons: args.reasons,
      samples: candidates.slice(0, 10).map((message) => ({
        messageId: String(message._id),
        timestamp: message.timestamp,
        channel: message.channel,
        sessionKey: message.sessionKey,
        reason: message.reason,
        contentPreview: message.contentPreview,
      })),
    };
  },
});

export const getRecentOnDemandLtmTelemetry = internalQuery({
  args: {
    userId: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    since: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const scopeKey = ltmScopeKey(args);
    const limit = clampInt(args.limit, 1, 200, 100);
    const rows = await ctx.db
      .query("crystalTelemetry")
      .withIndex("by_user_kind_time", (q) =>
        q.eq("userId", args.userId).eq("kind", LTM_TELEMETRY_KIND).gte("createdAt", args.since)
      )
      .order("desc")
      .take(limit);

    return rows
      .map((row) => ({ ...row, parsedPayload: parseTelemetryPayload(row.payload) }))
      .filter((row) => row.parsedPayload.scopeKey === scopeKey);
  },
});

type LtmTelemetryStatus =
  | "attempted"
  | "inserted"
  | "deduped"
  | "skipped_no_durable_memory"
  | "skipped_blocked_content"
  | "skipped_rate_limited"
  | "skipped_cap"
  | "error";

type LtmTelemetryPhase =
  | "extract"
  | "content_scan"
  | "insert"
  | "mark_messages";

type LtmTelemetryError = {
  phase: LtmTelemetryPhase;
  errorName?: string;
  errorMessage?: string;
  threatId?: string;
  windowKey?: string;
  messageCount?: number;
};

type OnDemandLtmExtractionResult = {
  scanned: number;
  windows: number;
  inserted: number;
  wouldInsert?: number;
  deduped: number;
  skipped: number;
  blockedContentSkipped: number;
  discardedMessages: number;
  errors: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  reason?: string;
  dryRun: boolean;
};

function errorTelemetry(error: unknown, phase: LtmTelemetryPhase, window?: ExtractionWindow): LtmTelemetryError {
  const err = error as { name?: unknown; message?: unknown; threatId?: unknown };
  return {
    phase,
    errorName: typeof err?.name === "string" ? err.name.slice(0, 80) : "Error",
    errorMessage: typeof err?.message === "string" ? err.message.slice(0, 500) : String(error).slice(0, 500),
    threatId: typeof err?.threatId === "string" ? err.threatId.slice(0, 80) : undefined,
    windowKey: window?.key,
    messageCount: window?.messageIds.length,
  };
}

function blockedContentTelemetry(scan: Exclude<ScanResult, { allowed: true }>, window: ExtractionWindow): LtmTelemetryError {
  return {
    phase: "content_scan",
    errorName: "ContentScannerBlocked",
    errorMessage: scan.reason.slice(0, 500),
    threatId: scan.threatId,
    windowKey: window.key,
    messageCount: window.messageIds.length,
  };
}

function scanExtractedMemory(memory: ExtractedMemory): ScanResult {
  const titleScanResult = scanMemoryContent(memory.title);
  if (!titleScanResult.allowed) return titleScanResult;
  return scanMemoryContent(memory.content);
}

async function markWindowExtracted(ctx: any, window: ExtractionWindow, skippedReason?: string) {
  await ctx.runMutation(internal.crystal.messages.markMessagesLtmExtracted, {
    messageIds: window.messageIds,
    extractedAt: Date.now(),
    skippedReason,
  });
}

async function recordLtmTelemetry(ctx: any, args: {
  userId: string;
  channel?: string;
  sessionKey?: string;
  status: LtmTelemetryStatus;
  scanned?: number;
  windows?: number;
  inserted?: number;
  deduped?: number;
  skipped?: number;
  errors?: number;
  runId?: string;
  exactHits?: number;
  nearHits?: number;
  misses?: number;
  nearChecksPending?: number;
  reflectionRunId?: Id<"crystalReflectionRuns">;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCostUsd?: number;
  reason?: string;
  error?: LtmTelemetryError;
}) {
  const now = Date.now();
  await ctx.runMutation((internal as any).crystal.ltmExtraction.insertLtmExtractionTelemetry, {
    userId: args.userId,
    kind: LTM_TELEMETRY_KIND,
    channel: args.channel,
    sessionKey: args.sessionKey,
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    payload: JSON.stringify({
      scopeKey: ltmScopeKey(args),
      status: args.status,
      scanned: args.scanned ?? 0,
      windows: args.windows ?? 0,
      inserted: args.inserted ?? 0,
      deduped: args.deduped ?? 0,
      runId: args.runId,
      exactHits: args.exactHits ?? 0,
      nearHits: args.nearHits ?? 0,
      misses: args.misses ?? 0,
      nearChecksPending: args.nearChecksPending ?? 0,
      reflectionRunId: args.reflectionRunId ? String(args.reflectionRunId) : undefined,
      estimatedInputTokens: args.estimatedInputTokens ?? 0,
      estimatedOutputTokens: args.estimatedOutputTokens ?? 0,
      estimatedCostUsd: args.estimatedCostUsd ?? 0,
      skipped: args.skipped ?? 0,
      errors: args.errors ?? 0,
      reason: args.reason,
      phase: args.error?.phase,
      errorName: args.error?.errorName,
      errorMessage: args.error?.errorMessage,
      threatId: args.error?.threatId,
      windowKey: args.error?.windowKey,
      messageCount: args.error?.messageCount,
    }),
  }).catch(() => {});
}

export const insertLtmExtractionTelemetry = internalMutation({
  args: {
    userId: v.string(),
    kind: v.string(),
    sessionKey: v.optional(v.string()),
    channel: v.optional(v.string()),
    payload: v.string(),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("crystalTelemetry", args);
  },
});

async function checkOnDemandLtmThrottle(ctx: any, args: { userId: string; channel?: string; sessionKey?: string }) {
  const capacity = await ctx.runQuery((internal as any).crystal.capacityPolicy.getForUser, {
    userId: args.userId,
  }) as { productQuotaExempt?: boolean } | null;
  if (capacity?.productQuotaExempt) {
    return { allowed: true, reason: "" };
  }
  const now = Date.now();
  const recent = await ctx.runQuery((internal as any).crystal.ltmExtraction.getRecentOnDemandLtmTelemetry, {
    ...args,
    since: now - 60 * 60 * 1000,
    limit: 200,
  }) as Array<{ createdAt: number; parsedPayload: Record<string, unknown> }>;
  const attempts = recent.filter((row) =>
    row.parsedPayload.status === "attempted" ||
    row.parsedPayload.status === "inserted" ||
    row.parsedPayload.status === "deduped" ||
    row.parsedPayload.status === "skipped_no_durable_memory"
  );
  const latestAttempt = attempts.sort((a, b) => b.createdAt - a.createdAt)[0];
  if (latestAttempt && now - latestAttempt.createdAt < ON_DEMAND_COOLDOWN_MS) {
    return { allowed: false, reason: "cooldown" };
  }
  if (attempts.length >= ON_DEMAND_HOURLY_CAP) {
    return { allowed: false, reason: "hourly_cap" };
  }
  return { allowed: true, reason: "" };
}

export const getMessagesForContentHashBackfill = internalQuery({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit, 1, 1_000, 500);
    const missingContentHash = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_content_hash_time", (q) =>
        q.eq("userId", args.userId).eq("contentHash", undefined)
      )
      .order("asc")
      .take(limit);
    if (missingContentHash.length >= limit) return missingContentHash;

    const seen = new Set(missingContentHash.map((message) => String(message._id)));
    const missingScopeHash = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_dedupe_scope_hash_time", (q) =>
        q.eq("userId", args.userId).eq("dedupeScopeHash", undefined)
      )
      .order("asc")
      .take(limit);

    for (const message of missingScopeHash) seen.add(String(message._id));

    const unchecked = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_dedupe_checked_time", (q) =>
        q.eq("userId", args.userId).eq("dedupeCheckedAt", undefined)
      )
      .order("asc")
      .take(limit);

    return [
      ...missingContentHash,
      ...missingScopeHash.filter((message) => !missingContentHash.some((existing) => String(existing._id) === String(message._id))),
      ...unchecked.filter((message) => !seen.has(String(message._id))),
    ]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, limit);
  },
});

export const findCanonicalDuplicateMessage = internalQuery({
  args: {
    userId: v.string(),
    messageId: v.id("crystalMessages"),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    contentHash: v.string(),
    dedupeScopeHash: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    turnId: v.optional(v.string()),
    turnMessageIndex: v.optional(v.number()),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("crystalMessages")
      .withIndex("by_message_dedupe_time", (q) =>
        q
          .eq("userId", args.userId)
          .eq("contentHash", args.contentHash)
          .eq("role", args.role)
          .eq("channel", args.channel)
          .eq("sessionKey", args.sessionKey)
          .eq("turnId", args.turnId)
          .eq("turnMessageIndex", args.turnMessageIndex)
          .gte("timestamp", args.timestamp - 5_000)
      )
      .order("asc")
      .take(50);

    return candidates
      .filter((candidate) => String(candidate._id) !== String(args.messageId))
      .filter((candidate) => candidate.role === args.role)
      .filter((candidate) => (candidate.channel ?? "") === (args.channel ?? ""))
      .filter((candidate) => (candidate.sessionKey ?? "") === (args.sessionKey ?? ""))
      .filter((candidate) => {
        if (candidate.turnId || args.turnId) {
          return (
            (candidate.turnId ?? "") === (args.turnId ?? "") &&
            (candidate.turnMessageIndex ?? -1) === (args.turnMessageIndex ?? -1)
          );
        }
        return candidate.timestamp <= args.timestamp && Math.abs(candidate.timestamp - args.timestamp) <= 5_000;
      })
      .sort((a, b) => a.timestamp - b.timestamp)
      .at(0) ?? null;
  },
});

export const insertExtractedMemory = internalMutation({
  args: {
    userId: v.string(),
    title: v.string(),
    content: v.string(),
    store: v.union(v.literal("episodic"), v.literal("semantic"), v.literal("procedural"), v.literal("prospective")),
    category: v.union(
      v.literal("decision"),
      v.literal("lesson"),
      v.literal("person"),
      v.literal("rule"),
      v.literal("event"),
      v.literal("fact"),
      v.literal("goal"),
      v.literal("skill"),
      v.literal("workflow"),
      v.literal("conversation")
    ),
    tags: v.array(v.string()),
    confidence: v.number(),
    strength: v.number(),
    contentHash: v.string(),
    sourceMessageIds: v.array(v.id("crystalMessages")),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    extractionRunId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const titleScanResult = scanMemoryContent(args.title);
    if (!titleScanResult.allowed) {
      throw new Error(`Memory blocked: ${titleScanResult.reason} [${titleScanResult.threatId}]`);
    }
    const scanResult = scanMemoryContent(args.content);
    if (!scanResult.allowed) {
      throw new Error(`Memory blocked: ${scanResult.reason} [${scanResult.threatId}]`);
    }

    const existing = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_content_hash_channel", (q) =>
        q
          .eq("userId", args.userId)
          .eq("contentHash", args.contentHash)
          .eq("channel", args.channel)
          .eq("archived", false)
      )
      .first();

    const now = Date.now();
    if (existing) {
      const mergedSourceIds = Array.from(
        new Set([...(existing.sourceMessageIds ?? []), ...args.sourceMessageIds].map(String))
      ).map((id) => id as Id<"crystalMessages">);
      const mergedTags = normalizeTags([...(existing.tags ?? []), ...args.tags]);
      const oldStrength = existing.strength ?? 0;
      const newStrength = Math.max(oldStrength, args.strength);
      await patchMemoryAndSyncCleanupProjection(ctx, existing, {
        lastAccessedAt: now,
        strength: newStrength,
        confidence: Math.max(existing.confidence ?? 0, args.confidence),
        tags: mergedTags,
        sourceMessageIds: mergedSourceIds,
        extractionSessionKey: args.sessionKey,
        extractionRunId: args.extractionRunId,
      }, now);
      // M7 — track totalStrength delta when strength is patched.
      if (newStrength !== oldStrength) {
        await applyDashboardTotalsDelta(
          ctx,
          args.userId,
          buildStrengthDelta(oldStrength, newStrength),
        );
      }
      return { id: existing._id, inserted: false };
    }

    const normalizedTags = normalizeTags([...args.tags, "auto-extracted", "ltm-backfill"]);
    // Always populate a compact telegraphic recallText alongside the full
    // content; the read side picks recallText when MEMORY_CRYSTAL_COMPACT_RECALL
    // is on. Tag config-header/source-mirror chunks so recall can drop them.
    const recallText = compressRecallText(args.content);
    const chunkKind = classifyChunkKind({
      content: args.content,
      title: args.title,
      tags: normalizedTags,
      source: "conversation",
    });

    const memoryId = await ctx.db.insert("crystalMemories", {
      userId: args.userId,
      title: args.title,
      content: args.content,
      recallText,
      chunkKind,
      store: args.store,
      category: args.category,
      tags: normalizedTags,
      channel: args.channel,
      source: "conversation",
      strength: args.strength,
      confidence: args.confidence,
      valence: 0,
      arousal: 0.25,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      archived: false,
      embedding: [],
      contentHash: args.contentHash,
      sourceMessageIds: args.sourceMessageIds,
      extractionSessionKey: args.sessionKey,
      extractionRunId: args.extractionRunId,
    });

    await applyDashboardTotalsDelta(
      ctx,
      args.userId,
      buildMemoryCreateDelta({
        store: args.store,
        archived: false,
        title: args.title,
        memoryId,
        createdAt: now,
        strength: args.strength ?? 1,
      })
    );

    if (shouldScheduleLtmBackgroundWork()) {
      await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, { memoryId });
      await ctx.scheduler.runAfter(50, internal.crystal.salience.computeAndStoreSalience, { memoryId });
      const eligibility = shouldEnrich({ store: args.store });
      if (!eligibility.ok) {
        await ctx.runMutation(
          internal.crystal.observability.functionCallMetrics.recordCall,
          { name: "enrichMemoryGraph_skip", userId: args.userId, tier: args.store },
        ).catch(() => null);
      } else {
        await ctx.scheduler.runAfter(100, internal.crystal.graphEnrich.enrichMemoryGraph, {
          memoryId,
          userId: args.userId,
        });
      }
    }

    return { id: memoryId, inserted: true };
  },
});

export const backfillMessageContentHashes = internalAction({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.runQuery((internal as any).crystal.ltmExtraction.getMessagesForContentHashBackfill, {
      userId: args.userId,
      limit: args.limit,
    }) as MessageRecord[];

    let hashed = 0;
    let duplicatesDeleted = 0;
    let duplicatesFound = 0;

    for (const message of [...messages].sort((a, b) => a.timestamp - b.timestamp)) {
      const contentHash = message.contentHash ?? await sha256Hex(buildMessageHashInput({
        role: message.role,
        content: message.content,
      }));
      const dedupeScopeHash = message.dedupeScopeHash ?? await sha256Hex(buildMessageDedupeScopeInput({
        userId: message.userId,
        role: message.role,
        contentHash,
        channel: message.channel,
        sessionKey: message.sessionKey,
        turnId: message.turnId,
        turnMessageIndex: message.turnMessageIndex,
      }));

      if ((!message.contentHash || !message.dedupeScopeHash) && !args.dryRun) {
        await ctx.runMutation(internal.crystal.messages.patchMessageContentHash, {
          messageId: message._id,
          contentHash,
          dedupeScopeHash,
        });
      }
      if (!message.contentHash) hashed += 1;

      const canonical = await ctx.runQuery((internal as any).crystal.ltmExtraction.findCanonicalDuplicateMessage, {
        userId: message.userId,
        messageId: message._id,
        role: message.role,
        contentHash,
        dedupeScopeHash,
        channel: message.channel,
        sessionKey: message.sessionKey,
        turnId: message.turnId,
        turnMessageIndex: message.turnMessageIndex,
        timestamp: message.timestamp,
      }) as MessageRecord | null;

      if (!canonical) {
        if (!args.dryRun && !message.dedupeCheckedAt) {
          await ctx.runMutation(internal.crystal.messages.markMessageDedupeChecked, {
            messageId: message._id,
            dedupeCheckedAt: Date.now(),
          });
        }
        continue;
      }

      duplicatesFound += 1;
      if (!args.dryRun) {
        const result = await ctx.runMutation(internal.crystal.messages.deleteDuplicateMessage, {
          messageId: message._id,
          duplicateOfMessageId: canonical._id,
        }) as { deleted: boolean };
        if (result.deleted) duplicatesDeleted += 1;
      }
    }

    return {
      scanned: messages.length,
      hashed,
      duplicatesFound,
      duplicatesDeleted: args.dryRun ? 0 : duplicatesDeleted,
      dryRun: args.dryRun ?? false,
    };
  },
});

export const runLtmExtractionForUser = internalAction({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    mockMemories: v.optional(v.array(v.object({
      title: v.string(),
      content: v.string(),
      store: v.union(v.literal("episodic"), v.literal("semantic"), v.literal("procedural"), v.literal("prospective")),
      category: v.union(
        v.literal("decision"),
        v.literal("lesson"),
        v.literal("person"),
        v.literal("rule"),
        v.literal("event"),
        v.literal("fact"),
        v.literal("goal"),
        v.literal("skill"),
        v.literal("workflow"),
        v.literal("conversation")
      ),
      tags: v.array(v.string()),
      confidence: v.number(),
      strength: v.number(),
    }))),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.runQuery((internal as any).crystal.ltmExtraction.getLtmCandidateMessages, {
      userId: args.userId,
      limit: args.limit,
    }) as MessageRecord[];
    const windows = groupMessagesForExtraction(messages);
    const extractionRunId = buildExtractionRunId({ userId: args.userId });
    const openRouterCredential = await resolveUserOpenRouterCredential(ctx, args.userId);

    if (!args.mockMemories && !openRouterCredential.apiKey) {
      // ILL-184: route the silent skip through the choke point so the alert
      // policy applies (missing_openrouter_key is actionable).
      await recordMissingOpenRouterKey(ctx, {
        userId: args.userId,
        keyLast4: openRouterCredential.keyLast4 ?? null,
      }).catch(() => {});
      return { scanned: messages.length, windows: windows.length, inserted: 0, deduped: 0, skipped: windows.length, reason: MISSING_USER_OPENROUTER_KEY_REASON };
    }

    let inserted = 0;
    let deduped = 0;
    let skipped = 0;
    let errors = 0;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;

    for (const window of windows) {
      try {
        const recentDigests = await ctx.runQuery(
          (internal as any).crystal.ltmExtraction.getRecentExtractionDigests,
          {
            userId: args.userId,
            channel: window.channel,
            sessionKey: window.sessionKey,
            beforeCreatedAt: Date.now() + 1,
            limit: 8,
          },
        ) as RecentExtractionDigest[];
        const extractionCall: ExtractionCallResult = args.mockMemories
          ? {
              memories: args.mockMemories,
              usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            }
          : await extractWindowMemories(
              ctx,
              args.userId,
              window,
              openRouterCredential,
              recentDigests,
            );
        estimatedInputTokens += extractionCall.usage.inputTokens;
        estimatedOutputTokens += extractionCall.usage.outputTokens;
        estimatedCostUsd += extractionCall.usage.estimatedCostUsd;
        const extracted = extractionCall.memories.slice(0, memoryCapForWindow(window, "on_demand"));
        if (extracted.length === 0) {
          skipped += 1;
          if (!args.dryRun) {
            await ctx.runMutation(internal.crystal.messages.markMessagesLtmExtracted, {
              messageIds: window.messageIds,
              extractedAt: Date.now(),
              skippedReason: "no_durable_memory",
            });
          }
          continue;
        }

        for (const memory of extracted) {
          const contentHash = await sha256Hex(buildMemoryHashInput(memory));
          if (args.dryRun) {
            inserted += 1;
            continue;
          }
          const result = await ctx.runMutation((internal as any).crystal.ltmExtraction.insertExtractedMemory, {
            ...memory,
            userId: args.userId,
            contentHash,
            sourceMessageIds: window.messageIds,
            channel: window.channel,
            sessionKey: window.sessionKey,
            extractionRunId,
          }) as { inserted: boolean };
          if (result.inserted) inserted += 1;
          else deduped += 1;
        }

        if (!args.dryRun) {
          await ctx.runMutation(internal.crystal.messages.markMessagesLtmExtracted, {
            messageIds: window.messageIds,
            extractedAt: Date.now(),
          });
        }
      } catch (error) {
        errors += 1;
        console.log(`[ltm-extraction] user ${args.userId}: failed window ${window.key}`, error);
      }
    }

    return {
      scanned: messages.length,
      windows: windows.length,
      inserted: args.dryRun ? 0 : inserted,
      wouldInsert: args.dryRun ? inserted : undefined,
      deduped,
      skipped,
      errors,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      dryRun: args.dryRun ?? false,
    };
  },
});

export const runOnDemandLtmExtraction = internalAction({
  args: {
    userId: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    messageIds: v.optional(v.array(v.id("crystalMessages"))),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    bypassThrottle: v.optional(v.boolean()),
    reflectionRunId: v.optional(v.id("crystalReflectionRuns")),
    context: v.optional(v.union(v.literal("on_demand"), v.literal("reflection_cycle"))),
    mockMemories: v.optional(v.array(v.object({
      title: v.string(),
      content: v.string(),
      store: v.union(v.literal("episodic"), v.literal("semantic"), v.literal("procedural"), v.literal("prospective")),
      category: v.union(
        v.literal("decision"),
        v.literal("lesson"),
        v.literal("person"),
        v.literal("rule"),
        v.literal("event"),
        v.literal("fact"),
        v.literal("goal"),
        v.literal("skill"),
        v.literal("workflow"),
        v.literal("conversation")
      ),
      tags: v.array(v.string()),
      confidence: v.number(),
      strength: v.number(),
    }))),
  },
  handler: async (ctx, args): Promise<OnDemandLtmExtractionResult> => {
    const context = args.context ?? "on_demand";
    const extractionRunId = buildExtractionRunId(args);
    const openRouterCredential = await resolveUserOpenRouterCredential(ctx, args.userId);
    const throttleScope = { userId: args.userId, channel: args.channel, sessionKey: args.sessionKey };
    if (!args.bypassThrottle && openRouterCredential.source !== "personal") {
      const throttle = await checkOnDemandLtmThrottle(ctx, throttleScope);
      if (!throttle.allowed) {
        const status = throttle.reason === "hourly_cap" ? "skipped_cap" : "skipped_rate_limited";
        await recordLtmTelemetry(ctx, {
          ...args,
          status,
          runId: extractionRunId,
          reason: throttle.reason,
        });
        return {
          scanned: 0,
          windows: 0,
          inserted: 0,
          deduped: 0,
          skipped: 1,
          blockedContentSkipped: 0,
          discardedMessages: 0,
          errors: 0,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCostUsd: 0,
          reason: throttle.reason,
          dryRun: args.dryRun ?? false,
        };
      }
    }
    if (!args.dryRun) {
      await recordLtmTelemetry(ctx, { ...args, status: "attempted", runId: extractionRunId });
    }

    const messages: MessageRecord[] = args.messageIds && args.messageIds.length > 0
      ? await ctx.runQuery((internal as any).crystal.ltmExtraction.getExactLtmCandidateMessages, {
          userId: args.userId,
          channel: args.channel,
          sessionKey: args.sessionKey,
          messageIds: args.messageIds,
        }) as MessageRecord[]
      : await ctx.runQuery((internal as any).crystal.ltmExtraction.getOnDemandLtmCandidateMessages, {
          userId: args.userId,
          channel: args.channel,
          sessionKey: args.sessionKey,
          limit: args.limit,
        }) as MessageRecord[];
    const windows = args.messageIds && args.messageIds.length > 0
      ? groupMessagesForExtraction(messages)
      : groupMessagesForExtraction(messages).slice(-1);
    let inserted = 0;
    let deduped = 0;
    let skipped = 0;
    let noDurableSkipped = 0;
    let blockedContentSkipped = 0;
    let discardedMessages = 0;
    let errors = 0;
    let lastError: LtmTelemetryError | undefined;
    let nonTerminalReason: string | undefined;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;

    for (const window of windows) {
      let phase: LtmTelemetryPhase = "extract";
      try {
        if (!args.mockMemories && !openRouterCredential.apiKey) {
          // ILL-184: route the silent skip through the choke point so the
          // alert policy applies (missing_openrouter_key is actionable).
          await recordMissingOpenRouterKey(ctx, {
            userId: args.userId,
            keyLast4: openRouterCredential.keyLast4 ?? null,
          }).catch(() => {});
          skipped += 1;
          nonTerminalReason = MISSING_USER_OPENROUTER_KEY_REASON;
          continue;
        }

        phase = "extract";
        const recentDigests = await ctx.runQuery(
          (internal as any).crystal.ltmExtraction.getRecentExtractionDigests,
          {
            userId: args.userId,
            channel: window.channel,
            sessionKey: window.sessionKey,
            beforeCreatedAt: Date.now() + 1,
            limit: 8,
          },
        ) as RecentExtractionDigest[];
        const extractionCall: ExtractionCallResult = args.mockMemories
          ? {
              memories: args.mockMemories,
              usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            }
          : await extractWindowMemories(
              ctx,
              args.userId,
              window,
              openRouterCredential,
              recentDigests,
            );
        estimatedInputTokens += extractionCall.usage.inputTokens;
        estimatedOutputTokens += extractionCall.usage.outputTokens;
        estimatedCostUsd += extractionCall.usage.estimatedCostUsd;
        const extracted = extractionCall.memories.slice(0, memoryCapForWindow(window, context));
        if (extracted.length === 0) {
          skipped += 1;
          noDurableSkipped += 1;
          discardedMessages += window.messageIds.length;
          if (!args.dryRun) {
            phase = "mark_messages";
            await markWindowExtracted(ctx, window, "no_durable_memory");
          }
          continue;
        }

        const safeMemories: ExtractedMemory[] = [];
        for (const memory of extracted) {
          phase = "content_scan";
          const scan = scanExtractedMemory(memory);
          if (!scan.allowed) {
            blockedContentSkipped += 1;
            lastError = blockedContentTelemetry(scan, window);
            continue;
          }
          safeMemories.push(memory);
        }

        if (safeMemories.length === 0) {
          skipped += 1;
          discardedMessages += window.messageIds.length;
          if (!args.dryRun) {
            phase = "mark_messages";
            await markWindowExtracted(ctx, window, "blocked_by_content_scanner");
          }
          continue;
        }

        for (const memory of safeMemories) {
          const contentHash = await sha256Hex(buildMemoryHashInput(memory));
          if (args.dryRun) {
            inserted += 1;
            continue;
          }
          phase = "insert";
          const result = await ctx.runMutation((internal as any).crystal.ltmExtraction.insertExtractedMemory, {
            ...memory,
            userId: args.userId,
            tags: normalizeTags([...memory.tags, "ltm-on-demand"]),
            contentHash,
            sourceMessageIds: window.messageIds,
            channel: window.channel,
            sessionKey: window.sessionKey,
            extractionRunId,
          }) as { inserted: boolean };
          if (result.inserted) inserted += 1;
          else deduped += 1;
        }

        if (!args.dryRun) {
          phase = "mark_messages";
          await markWindowExtracted(ctx, window);
        }
      } catch (error) {
        errors += 1;
        lastError = errorTelemetry(error, phase, window);
        console.log(`[ltm-on-demand] user ${args.userId}: failed window ${window.key}`, error);
      }
    }

    if (!args.dryRun) {
      const status = inserted > 0
        ? "inserted"
        : deduped > 0
          ? "deduped"
          : errors > 0
            ? "error"
            : blockedContentSkipped > 0
              ? "skipped_blocked_content"
              : "skipped_no_durable_memory";
      await recordLtmTelemetry(ctx, {
        ...args,
        status,
        scanned: messages.length,
        windows: windows.length,
        inserted,
        deduped,
        runId: extractionRunId,
        exactHits: deduped,
        nearHits: 0,
        misses: 0,
        nearChecksPending: inserted,
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
        skipped,
        errors,
        reason: nonTerminalReason,
        error: lastError,
      });
    }

    return {
      scanned: messages.length,
      windows: windows.length,
      inserted: args.dryRun ? 0 : inserted,
      wouldInsert: args.dryRun ? inserted : undefined,
      deduped,
      skipped,
      blockedContentSkipped,
      discardedMessages,
      errors,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      reason: nonTerminalReason,
      dryRun: args.dryRun ?? false,
    };
  },
});

export const getReflectionCycleCandidates = internalQuery({
  args: {
    userId: v.string(),
    beforeTimestamp: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<MessageRecord[]> => {
    const limit = clampInt(args.limit, 1, MAX_MESSAGES_PER_USER, MAX_MESSAGES_PER_USER);
    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_ltm_extracted_time", (q) =>
        q
          .eq("userId", args.userId)
          .eq("ltmExtractedAt", undefined)
          .lte("timestamp", args.beforeTimestamp)
      )
      .filter((q) => q.neq(q.field("role"), "system"))
      .order("asc")
      .take(limit) as MessageRecord[];
  },
});

export const runLtmExtractionCatchup = internalAction({
  args: {
    userId: v.optional(v.string()),
    usersLimit: v.optional(v.number()),
    messagesPerUser: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const usersLimit = clampInt(args.usersLimit, 1, MAX_USERS_PER_RUN, DEFAULT_USERS_PER_RUN);
    const messagesPerUser = clampInt(args.messagesPerUser, 1, MAX_MESSAGES_PER_USER, DEFAULT_MESSAGES_PER_USER);
    // In-tick pagination over all user ids. This action is on-demand (no cron
    // registration) and applies its own CRON_ROTATION_MS time-bucket rotation
    // over the full id list, so every invocation must still see every user id
    // for the start-index math to stay stable. Reads the same rows as the old
    // listAllUserIds .collect() — no read-cost win, just bounded page queries.
    const allUserIds: string[] = [];
    if (args.userId) {
      allUserIds.push(args.userId);
    } else {
      let cursor: string | undefined;
      let isDone = false;
      while (!isDone) {
        const page = await ctx.runQuery(internal.crystal.userProfiles.listUserIdsPage, {
          cursor,
          numItems: USER_ID_PAGE_SIZE,
        }) as { userIds: string[]; continueCursor: string; isDone: boolean };
        allUserIds.push(...page.userIds);
        cursor = page.continueCursor;
        isDone = page.isDone;
      }
    }
    const start = args.userId || allUserIds.length <= usersLimit
      ? 0
      : (Math.floor(Date.now() / CRON_ROTATION_MS) * usersLimit) % allUserIds.length;
    const userIds: string[] = args.userId
      ? allUserIds
      : [...allUserIds.slice(start), ...allUserIds.slice(0, start)].slice(0, usersLimit);

    const results = [];
    for (const userId of userIds) {
      const hashBackfill: any = await ctx.runAction((internal as any).crystal.ltmExtraction.backfillMessageContentHashes, {
        userId,
        limit: messagesPerUser * 4,
        dryRun: args.dryRun,
      });
      const extraction: any = await ctx.runAction((internal as any).crystal.ltmExtraction.runLtmExtractionForUser, {
        userId,
        limit: messagesPerUser,
        dryRun: args.dryRun,
      });
      results.push({ userId, hashBackfill, extraction });
    }

    return { users: userIds.length, dryRun: args.dryRun ?? false, results };
  },
});
