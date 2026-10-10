import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
  buildStrengthDelta,
} from "./publicDashboardTotals";
import { scanMemoryContent, type ScanResult } from "./contentScanner";
import { sha256Hex } from "./crypto";
import {
  buildMemoryHashInput,
  buildMessageDedupeScopeInput,
  buildMessageHashInput,
} from "./contentHash";
import { stableUserId } from "./auth";
import { canPerformWriteActions, normalizeRoles } from "./permissions";
import { classifyChunkKind, compressRecallText } from "./recallCompression";
import { agentStampKey, unanimousAgentStamp } from "./agentStamp";
import { findSameStampExactDuplicate } from "./exactDuplicate";
import { patchMemoryAndSyncCleanupProjection } from "./cleanupProjection";
import { scheduleMemoryEmbedding } from "./embedRetry";
export { isProactiveDistillationChannelEligible } from "./channelScope";
import { buildDistillationPrompt, deriveDistillationProfile } from "./distillationProfiles";
import { requestOpenRouter, recordMissingOpenRouterKey } from "./providerGateway";
import { DEFAULT_MODEL, type DistillationModel } from "./distillationModels";
import { isDistillationPaused } from "./distillationPause.helper";
import { logError, logLabel } from "./crypto";

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
const ON_DEMAND_COOLDOWN_MS = 60 * 1000;
const ON_DEMAND_HOURLY_CAP = 20;
// requestOpenRouter aborts after 60s, leaving more than four minutes for the
// bounded post-inference mutations before this lease can be transferred.
// Crashed actions recover after expiry; every write/finalize re-checks the
// owner token (fencing).
export const EXTRACTION_CLAIM_LEASE_MS = 5 * 60 * 1000;
const LTM_TELEMETRY_KIND = "ltm_extraction";
export const EXTRACTION_VERSION = 2;
export const MAX_PROVIDER_ATTEMPTS = 3;
const partValidator = v.object({ messageId: v.id("crystalMessages"), start: v.number(), end: v.number() });
type MessagePart = { messageId: Id<"crystalMessages">; start: number; end: number };

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
  ltmExtractionOffset?: number;
  ltmExtractionBlocked?: string;
  ltmExtractionRetryAt?: number;
  partEnd?: number;
  ltmExtractionSkippedReason?: string;
  ltmExtractionClaim?: { token: string; leaseUntil: number };
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
  parts?: MessagePart[];
};

function buildExtractionClaimToken(): string {
  // The source window is represented by the rows carrying this token. A UUID
  // is sufficient fencing identity and avoids duplicating IDs/user scope in
  // every claimed message.
  return crypto.randomUUID();
}

export function buildExtractionAttemptKey(userId: string, window: Pick<ExtractionWindow, "messageIds" | "parts">): string {
  // Exact ordered source identity is stable across session/nightly callers.
  // Context and run IDs are deliberately excluded from the paid-attempt key.
  return `ltm-result-v2:${JSON.stringify([userId, ...window.messageIds.map(String), (window.parts ?? []).map(part => [String(part.messageId), part.start, part.end])])}`;
}

type OpenRouterCredential = { apiKey: string | null; source: "personal" | "shared" | null; keyPrefix?: string | null; keyLast4?: string | null };
type ExtractionUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  model?: string;
};
type ExtractionCallResult = {
  memories: ExtractedMemory[];
  usage: ExtractionUsage;
};

const NONBILLABLE_EXTRACTION_USAGE: ExtractionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
};

type DurableExtractionResult = {
  call: ExtractionCallResult;
  attemptKey: string;
  sourceMessageIds: Id<"crystalMessages">[];
  extractionRunId: string;
  context: ExtractionContext;
  resumed: boolean;
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

function estimateExtractionCostUsd(inputTokens: number, outputTokens: number, model = DEFAULT_MODEL): number {
  const value = (inputTokens / 1_000_000) * model.inputUsdPerMillion
    + (outputTokens / 1_000_000) * model.outputUsdPerMillion;
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0;
}

function usageFromExtractionPayload(payload: any, prompt: string, model: DistillationModel): ExtractionUsage {
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
    estimatedCostUsd: Number.isFinite(payload?.usage?.cost) ? payload.usage.cost : estimateExtractionCostUsd(estimatedInputTokens, estimatedOutputTokens, model),
    model: model.modelId,
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
        .map((tag) => String(tag).trim().toLowerCase().slice(0, 64))
        .filter((tag) => tag.length > 0)
    )
  ).slice(0, 12);

function tagsForExtractionContext(tags: string[], context: ExtractionContext): string[] {
  return normalizeTags(context === "on_demand" ? ["ltm-on-demand", ...tags] : tags);
}

const normalizeExtractedMemory = (candidate: any): ExtractedMemory | null => {
  const title = normalizeText(String(candidate?.title ?? ""));
  const content = normalizeText(String(candidate?.content ?? ""));
  const store = String(candidate?.store ?? "semantic") as MemoryStore;
  const category = String(candidate?.category ?? "fact") as MemoryCategory;
  if (!title || !content) return null;
  if (!STORE_VALUES.has(store) || !CATEGORY_VALUES.has(category)) return null;
  return {
    title: title.slice(0, 200),
    content,
    store,
    category,
    tags: normalizeTags(candidate?.tags),
    confidence: clamp01(Number(candidate?.confidence), 0.75),
    strength: clamp01(Number(candidate?.importance ?? candidate?.strength), 0.75),
  };
};

function boundedStoredExtractionResult(value: string | ExtractionCallResult): ExtractionCallResult {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const finiteNonNegative = (candidate: unknown) => {
    const number = Number(candidate);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  };
  return {
    memories: (Array.isArray(parsed?.memories) ? parsed.memories : [])
      .map((memory: unknown) => normalizeExtractedMemory(memory))
      .filter((memory: ExtractedMemory | null): memory is ExtractedMemory => memory !== null),
    usage: {
      inputTokens: finiteNonNegative(parsed?.usage?.inputTokens),
      outputTokens: finiteNonNegative(parsed?.usage?.outputTokens),
      estimatedCostUsd: finiteNonNegative(parsed?.usage?.estimatedCostUsd),
      model: parsed?.usage?.model,
    },
  };
}

function injectedExtractionFailure(phase: "before_result" | "after_result" | "after_memory", memoryWrites?: number) {
  if (typeof process === "undefined" || !process.env.VITEST) return false;
  const requested = process.env.MC_TEST_LTM_EXTRACTION_FAILURE;
  if (phase === "before_result") return requested === "before_result";
  if (phase === "after_result") return requested === "after_result";
  return requested === `after_memory:${memoryWrites}`;
}

export function parseExtractedMemories(raw: string): ExtractedMemory[] {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  const candidates = Array.isArray(parsed) ? parsed : parsed?.memories;
  if (!Array.isArray(candidates)) throw new Error("Invalid extraction response: memories array missing");
  return candidates.map((candidate) => {
    const memory = normalizeExtractedMemory(candidate);
    if (!memory) throw new Error("Invalid extracted memory; source remains pending");
    return memory;
  });
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
  const content = message.content;
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
    text: ordered.map(formatMessageForPrompt).join("\n\n"),
    parts: ordered.map(message => ({ messageId: message._id, start: message.ltmExtractionOffset ?? 0,
      end: message.partEnd ?? message.content.length })),
  };
};

export function groupMessagesForExtraction(messages: MessageRecord[]): ExtractionWindow[] {
  const candidates = [...messages]
    .filter((message) => message.role !== "system" && normalizeText(message.content) && !message.ltmExtractionBlocked &&
      (message.ltmExtractionRetryAt ?? 0) <= Date.now())
    .flatMap(message => {
      const start = message.ltmExtractionOffset ?? 0;
      if (start === 0 && message.content.length <= MAX_WINDOW_CHARS) return [message];
      const parts: MessageRecord[] = [];
      for (let offset = start; offset < message.content.length;) {
        let end = Math.min(offset + MAX_WINDOW_CHARS, message.content.length);
        // Never split a UTF-16 surrogate pair between requests.
        if (end < message.content.length && /[\uD800-\uDBFF]/.test(message.content[end - 1])) end--;
        parts.push({ ...message, turnId: undefined, content: message.content.slice(offset, end),
          ltmExtractionOffset: offset, partEnd: end });
        offset = end;
      }
      return parts;
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  const turnGroups = new Map<string, MessageRecord[]>();
  const ungrouped: MessageRecord[] = [];
  for (const message of candidates) {
    if (message.turnId) {
      const key = `turn:${message.channel ?? ""}:${message.sessionKey ?? ""}:${message.turnId}`;
      turnGroups.set(key, [...(turnGroups.get(key) ?? []), message]);
    } else {
      ungrouped.push(message);
    }
  }

  const windows: ExtractionWindow[] = [];
  for (const [key, group] of turnGroups) {
    if (group.reduce((sum, m) => sum + m.content.length, 0) <= MAX_WINDOW_CHARS) windows.push(makeWindow(key, group));
    else ungrouped.push(...group);
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

  for (const message of ungrouped.sort((a, b) => a.timestamp - b.timestamp)) {
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

/**
 * ILL-302: the missing-key incident is scoped to the model the extraction
 * would have used, so it can only recover once that same operation/model
 * succeeds. Falls back to "unknown" if the model lookup itself fails.
 */
async function distillationModelIdForMissingKey(ctx: any, userId: string): Promise<string | undefined> {
  try {
    const model = (await ctx.runQuery((internal as any).crystal.distillationModels.getForUser, { userId })) as { modelId?: string } | null;
    return typeof model?.modelId === "string" ? model.modelId : undefined;
  } catch {
    return undefined;
  }
}

async function extractWindowMemories(
  ctx: Pick<any, "runMutation">,
  userId: string,
  window: ExtractionWindow,
  credential: { apiKey: string | null; keyLast4?: string | null },
  recentDigests: RecentExtractionDigest[] = [],
  claimToken: string,
  attemptKey: string,
): Promise<ExtractionCallResult> {
  // Channel-derived distillation profile: codex/mission-control windows use the
  // engineering profile, peer-coach/telegram keep the relational rules, and
  // everything else uses the general prompt.
  const prompt = buildDistillationPrompt(window, deriveDistillationProfile(window.channel), recentDigests);
  const model: DistillationModel = await (ctx as any).runQuery((internal as any).crystal.distillationModels.getForUser, { userId });
  if (isDistillationPaused()) {
    throw new DistillationPausedError(claimToken, attemptKey);
  }
  const gatewayResult = await requestOpenRouter(ctx, {
    userId,
    apiKey: credential.apiKey as string,
    keyLast4: credential.keyLast4 ?? null,
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    source: "ltmExtraction.extractWindowMemories",
    body: {
      model: model.modelId,
      ...(model.reasoningNone ? { reasoning: { effort: "none" } } : model.reasoningMinimal ? { reasoning: { effort: "minimal" } } : {}),
      max_tokens: 8192,
      provider: { require_parameters: true },
      response_format: { type: "json_schema", json_schema: { name: "durable_memories", strict: true, schema: {
        type: "object", additionalProperties: false, required: ["memories"], properties: {
          memories: { type: "array", items: { type: "object", additionalProperties: false,
            required: ["title", "content", "store", "category", "tags", "importance", "confidence"], properties: {
              title: { type: "string" }, content: { type: "string" },
              store: { type: "string", enum: [...STORE_VALUES] }, category: { type: "string", enum: [...CATEGORY_VALUES] },
              tags: { type: "array", items: { type: "string" } }, importance: { type: "number" }, confidence: { type: "number" },
            } } },
        },
      } } },
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
  if (payload?.choices?.[0]?.finish_reason === "length") throw new Error("Extraction output truncated; source remains pending");
  const usage = usageFromExtractionPayload(payload, prompt, model);
  const raw = payload?.choices?.[0]?.message?.content;
  if (payload?.choices?.[0]?.message?.refusal || typeof raw !== "string" || !raw.trim()) {
    throw new Error("Empty or refused extraction response; source remains pending");
  }
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

export const claimExtractionWindow = internalMutation({
  args: {
    userId: v.string(),
    messageIds: v.array(v.id("crystalMessages")),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    claimToken: v.string(),
    now: v.number(),
    leaseMs: v.number(),
    parts: v.optional(v.array(partValidator)),
  },
  handler: async (ctx, args) => {
    if (args.messageIds.length === 0) return { acquired: false, reason: "empty" };
    const messages = await Promise.all(args.messageIds.map((id) => ctx.db.get(id)));
    const validOwnerAndScope = messages.every((message) =>
      message &&
      message.userId === args.userId &&
      message.role !== "system" &&
      (message.channel ?? undefined) === (args.channel ?? undefined) &&
      (message.sessionKey ?? undefined) === (args.sessionKey ?? undefined)
    );
    if (!validOwnerAndScope) return { acquired: false, reason: "owner_or_scope_changed" };
    if (messages.some(message => message!.ltmExtractionBlocked)) {
      return { acquired: false, reason: "blocked" };
    }
    const retryAt = Math.max(...messages.map(message => message!.ltmExtractionRetryAt ?? 0));
    if (retryAt > args.now) return { acquired: false, reason: "retry_wait", waitUntil: retryAt };
    if (args.parts && (args.parts.length !== messages.length || new Set(args.parts.map(part => part.messageId)).size !== messages.length || !args.parts.every(part => {
      const message = messages.find(m => m?._id === part.messageId);
      return message && (message.ltmExtractionOffset ?? 0) === part.start &&
        Number.isInteger(part.start) && Number.isInteger(part.end) && part.end > part.start && part.end <= message.content.length;
    }))) return { acquired: false, reason: "coverage_changed" };
    if (messages.some((message) => message!.ltmExtractedAt !== undefined)) {
      return { acquired: false, reason: "completed" };
    }
    if (messages.some((message) =>
      message!.ltmExtractionClaim !== undefined &&
      message!.ltmExtractionClaim!.leaseUntil > args.now
    )) {
      return { acquired: false, reason: "active", waitUntil: Math.max(...messages.map(message => message!.ltmExtractionClaim?.leaseUntil ?? 0)) };
    }

    const leaseUntil = args.now + Math.max(1, Math.min(args.leaseMs, EXTRACTION_CLAIM_LEASE_MS));
    for (const message of messages) {
      await ctx.db.patch(message!._id, {
        ltmExtractionClaim: { token: args.claimToken, leaseUntil },
      });
    }
    return { acquired: true, leaseUntil };
  },
});

async function scheduleAttemptRetry(
  ctx: any,
  attempt: { _id: any; userId: string; messageIds: Id<"crystalMessages">[]; attempts?: number },
  args: { userId: string; now: number },
) {
  const sourceMessages = await Promise.all(attempt.messageIds.map((id) => ctx.db.get(id)));
  const attempts = attempt.attempts ?? 1;
  const blocked = attempts >= MAX_PROVIDER_ATTEMPTS;
  const retryAt = args.now + 60_000 * 2 ** (attempts - 1);
  for (const message of sourceMessages) {
    if (!message || message.userId !== args.userId) continue;
    await ctx.db.patch(message._id, {
      ltmExtractionBlocked: blocked ? "provider_attempts_exhausted" : undefined,
      ltmExtractionRetryAt: blocked ? undefined : retryAt,
      ltmExtractionClaim: undefined,
    });
  }
  await ctx.db.patch(attempt._id, { status: blocked ? "blocked" : "retry", attempts, retryAt: blocked ? undefined : retryAt });
  return blocked
    ? { disposition: "blocked" as const }
    : { disposition: "retry_wait" as const, waitUntil: retryAt };
}

export const beginExtractionAttempt = internalMutation({
  args: {
    attemptKey: v.string(),
    userId: v.string(),
    messageIds: v.array(v.id("crystalMessages")),
    claimToken: v.string(),
    extractionRunId: v.string(),
    context: v.union(v.literal("on_demand"), v.literal("reflection_cycle")),
    parts: v.optional(v.array(partValidator)),
  },
  handler: async (ctx, args) => {
    const sources = await Promise.all(args.messageIds.map((id) => ctx.db.get(id)));
    if (isDistillationPaused()) {
      for (const source of sources) {
        if (source?.ltmExtractionClaim?.token === args.claimToken)
          await ctx.db.patch(source._id, { ltmExtractionClaim: undefined });
      }
      return { disposition: "paused" as const };
    }
    const fenced = sources.length > 0 && sources.every((message) =>
      message && message.userId === args.userId && message.ltmExtractedAt === undefined &&
      message.ltmExtractionClaim?.token === args.claimToken &&
      (message.ltmExtractionClaim?.leaseUntil ?? 0) >= Date.now()
    );
    if (!fenced) return { disposition: "claim_lost" as const };
    const existing = await ctx.db.query("crystalLtmExtractionAttempts")
      .withIndex("by_attempt_key", (q) => q.eq("attemptKey", args.attemptKey)).unique();
    if (existing && existing.userId !== args.userId) {
      return { disposition: "claim_lost" as const };
    }
    if (existing?.status === "result" && existing.resultJson) {
      const storedSources = await Promise.all(existing.messageIds.map((id) => ctx.db.get(id)));
      const storedSourcesFenced = storedSources.length > 0 && storedSources.every((message) =>
        message && message.userId === args.userId && message.ltmExtractedAt === undefined &&
        message.ltmExtractionClaim?.token === args.claimToken &&
        (message.ltmExtractionClaim?.leaseUntil ?? 0) >= Date.now()
      );
      if (!storedSourcesFenced) return { disposition: "claim_lost" as const };
      return {
        disposition: "resume" as const,
        resultJson: existing.resultJson,
        messageIds: existing.messageIds,
        extractionRunId: existing.extractionRunId,
        context: existing.context,
      };
    }
    if (existing?.status === "blocked") return { disposition: "blocked" as const };
    // This caller acquired the source claim, but cannot do work while the
    // persisted attempt is still active/backing off. Release only our fenced
    // claim so it cannot shadow the attempt's (possibly earlier) wake time.
    const releaseWaitingClaim = async () => {
      for (const message of sources) await ctx.db.patch(message!._id, { ltmExtractionClaim: undefined });
    };
    if (existing?.status === "retry") {
      if ((existing.retryAt ?? 0) > Date.now()) {
        await releaseWaitingClaim();
        return { disposition: "retry_wait" as const, waitUntil: existing.retryAt };
      }
      await ctx.db.patch(existing._id, { status: "started", attempts: (existing.attempts ?? 1) + 1, createdAt: Date.now(), retryAt: undefined });
      return { disposition: "call_provider" as const };
    }
    if (existing) {
      const now = Date.now();
      if (existing.createdAt + EXTRACTION_CLAIM_LEASE_MS > now) {
        await releaseWaitingClaim();
        return { disposition: "active" as const, waitUntil: existing.createdAt + EXTRACTION_CLAIM_LEASE_MS };
      }
      return await scheduleAttemptRetry(ctx, existing, {
        userId: args.userId,
        now,
      });
    }
    const now = Date.now();
    for (const message of sources) await ctx.db.patch(message!._id, { ltmExtractionAttemptKey: args.attemptKey });
    await ctx.db.insert("crystalLtmExtractionAttempts", {
      attemptKey: args.attemptKey,
      userId: args.userId,
      messageIds: args.messageIds,
      extractionRunId: args.extractionRunId,
      context: args.context,
      status: "started",
      attempts: 1,
      parts: args.parts,
      createdAt: now,
    });
    return { disposition: "call_provider" as const };
  },
});

export const releasePausedExtractionAttempt = internalMutation({
  args: {
    attemptKey: v.string(),
    userId: v.string(),
    claimToken: v.string(),
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("crystalLtmExtractionAttempts")
      .withIndex("by_attempt_key", (q) => q.eq("attemptKey", args.attemptKey))
      .unique();
    const sources = await Promise.all(
      (attempt?.messageIds ?? []).map((id) => ctx.db.get(id)),
    );
    const owned = sources.filter(
      (source: any) => source?.ltmExtractionClaim?.token === args.claimToken,
    );
    if (
      attempt?.userId === args.userId &&
      attempt.status === "started" &&
      owned.length === sources.length &&
      sources.length > 0
    ) {
      await ctx.db.patch(attempt._id, {
        status: "retry",
        attempts: Math.max(0, (attempt.attempts ?? 1) - 1),
        retryAt: undefined,
      });
    }
    for (const source of owned) {
      if (source)
        await ctx.db.patch(source._id, { ltmExtractionClaim: undefined });
    }
    return { released: owned.length };
  },
});

export const persistExtractionAttemptResult = internalMutation({
  args: {
    attemptKey: v.string(),
    userId: v.string(),
    messageIds: v.array(v.id("crystalMessages")),
    claimToken: v.string(),
    resultJson: v.string(),
  },
  handler: async (ctx, args) => {
    const sources = await Promise.all(args.messageIds.map((id) => ctx.db.get(id)));
    const fenced = sources.length > 0 && sources.every((message) =>
      message && message.userId === args.userId && message.ltmExtractedAt === undefined &&
      message.ltmExtractionClaim?.token === args.claimToken &&
      (message.ltmExtractionClaim?.leaseUntil ?? 0) >= Date.now()
    );
    if (!fenced) throw new Error("Extraction claim lost before provider result persistence");
    const attempt = await ctx.db.query("crystalLtmExtractionAttempts")
      .withIndex("by_attempt_key", (q) => q.eq("attemptKey", args.attemptKey)).unique();
    const exactSources = attempt?.messageIds.length === args.messageIds.length &&
      attempt.messageIds.every((id, index) => id === args.messageIds[index]);
    if (!attempt || attempt.userId !== args.userId || attempt.status !== "started" || !exactSources) {
      throw new Error("Extraction attempt is not persistable");
    }
    const bounded = boundedStoredExtractionResult(args.resultJson);
    await ctx.db.patch(attempt._id, {
      status: "result",
      resultJson: JSON.stringify(bounded),
    });
    return { persisted: true };
  },
});

export const finalizeUnknownExtractionAttempt = internalMutation({
  args: {
    attemptKey: v.string(),
    userId: v.string(),
    claimToken: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.query("crystalLtmExtractionAttempts")
      .withIndex("by_attempt_key", (q) => q.eq("attemptKey", args.attemptKey)).unique();
    if (!attempt) return { finalized: false, reason: "not_found" };
    if (attempt.userId !== args.userId || attempt.status !== "started") {
      return { finalized: false, reason: "not_started" };
    }
    const claimed = await Promise.all(attempt.messageIds.map((id) => ctx.db.get(id)));
    const fenced = claimed.length > 0 && claimed.every((message) =>
      message && message.userId === args.userId && message.ltmExtractedAt === undefined &&
      message.ltmExtractionClaim?.token === args.claimToken &&
      (message.ltmExtractionClaim?.leaseUntil ?? 0) >= args.now
    );
    if (!fenced) {
      return { finalized: false, reason: "claim_lost" };
    }
    await scheduleAttemptRetry(ctx, attempt, args);
    return { finalized: true };
  },
});

export const finalizeExtractionWindow = internalMutation({
  args: {
    userId: v.string(),
    messageIds: v.array(v.id("crystalMessages")),
    claimToken: v.string(),
    extractedAt: v.number(),
    skippedReason: v.optional(v.string()),
    attemptKey: v.optional(v.string()),
    parts: v.optional(v.array(partValidator)),
  },
  handler: async (ctx, args) => {
    const messages = await Promise.all(args.messageIds.map((id) => ctx.db.get(id)));
    const fenced = messages.length > 0 && messages.every((message) =>
      message &&
      message.userId === args.userId &&
      message.ltmExtractedAt === undefined &&
      message.ltmExtractionClaim?.token === args.claimToken &&
      (message.ltmExtractionClaim?.leaseUntil ?? 0) >= args.extractedAt
    );
    if (!fenced) return { finalized: false, reason: "claim_lost" };
    if (args.parts && (args.parts.length !== messages.length || new Set(args.parts.map(part => part.messageId)).size !== messages.length || args.parts.some(part => !args.messageIds.includes(part.messageId)))) {
      throw new Error("Incomplete extraction coverage");
    }
    let attempt: any = null;
    if (args.attemptKey) {
      attempt = await ctx.db.query("crystalLtmExtractionAttempts")
        .withIndex("by_attempt_key", (q) => q.eq("attemptKey", args.attemptKey!)).unique();
      const expectedIds = attempt?.messageIds.map(String).join(",");
      const sourceIds = args.messageIds.map(String).join(",");
      if (!attempt || attempt.userId !== args.userId || attempt.status !== "result" || expectedIds !== sourceIds) {
        return { finalized: false, reason: "attempt_mismatch" };
      }
    }
    for (const message of messages) {
      const part = args.parts?.find(p => p.messageId === message!._id);
      const end = part?.end ?? message!.content.length;
      if (part && (part.start !== (message!.ltmExtractionOffset ?? 0) || !Number.isInteger(end) || end <= part.start || end > message!.content.length)) {
        throw new Error("Invalid extraction coverage");
      }
      const complete = end === message!.content.length;
      await ctx.db.patch(message!._id, {
        ltmExtracted: complete ? true : undefined,
        ltmExtractedAt: complete ? args.extractedAt : undefined,
        ltmExtractionSkippedReason: complete ? args.skippedReason : undefined,
        ltmExtractionOffset: end,
        ltmExtractionAttemptKey: undefined,
        ltmExtractionVersion: EXTRACTION_VERSION,
        ltmExtractionBlocked: undefined,
        ltmExtractionRetryAt: undefined,
        ltmExtractionClaim: undefined,
      });
    }
    if (attempt) await ctx.db.delete(attempt._id);
    return { finalized: true };
  },
});

// Persisted source membership prevents a new arrival from changing the key of
// a failed or already-paid window. Replay the exact ranges before new work.
export const getPinnedWindows = internalQuery({
  args: { userId: v.string(), messageIds: v.array(v.id("crystalMessages")) },
  handler: async (ctx, args): Promise<{ windows: ExtractionWindow[]; pinnedIds: Id<"crystalMessages">[] }> => {
    const keys = new Set<string>();
    for (const id of args.messageIds.slice(0, 200)) {
      const message = await ctx.db.get(id);
      if (message?.userId === args.userId && message.ltmExtractionAttemptKey) keys.add(message.ltmExtractionAttemptKey);
    }
    const windows: ExtractionWindow[] = [];
    const pinnedIds = new Set<Id<"crystalMessages">>();
    for (const key of keys) {
      const attempt = await ctx.db.query("crystalLtmExtractionAttempts").withIndex("by_attempt_key", q => q.eq("attemptKey", key)).unique();
      if (!attempt || attempt.userId !== args.userId || !attempt.parts) continue;
      for (const id of attempt.messageIds) pinnedIds.add(id);
      if (attempt.status === "blocked") continue;
      const sources = await Promise.all(attempt.messageIds.map(id => ctx.db.get(id)));
      if (sources.some(message => !message || message.userId !== args.userId || message.ltmExtractedAt !== undefined)) continue;
      const messages = attempt.parts.map(part => {
        const message = sources.find(source => source!._id === part.messageId)!;
        return { ...message, content: message.content.slice(part.start, part.end), ltmExtractionOffset: part.start, partEnd: part.end };
      });
      windows.push(makeWindow(key, messages));
    }
    return { windows, pinnedIds: [...pinnedIds] };
  },
});

async function recoverableWindows(ctx: any, userId: string, messages: MessageRecord[]): Promise<ExtractionWindow[]> {
  const pinned = await ctx.runQuery(internal.crystal.ltmExtraction.getPinnedWindows, { userId, messageIds: messages.map(message => message._id) });
  const pinnedIds = new Set(pinned.pinnedIds);
  return [...pinned.windows, ...groupMessagesForExtraction(messages.filter(message => !pinnedIds.has(message._id)))];
}

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
        ltmExtractionClaim: undefined,
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
  waitUntil?: number;
  paused?: boolean;
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

function partitionScannedMemories(memories: ExtractedMemory[]) {
  const safe: ExtractedMemory[] = [];
  const blocked: Array<{ memory: ExtractedMemory; scan: Exclude<ScanResult, { allowed: true }> }> = [];
  for (const memory of memories) {
    const scan = scanExtractedMemory(memory);
    if (scan.allowed) safe.push(memory);
    else blocked.push({ memory, scan });
  }
  return { safe, blocked };
}

async function claimWindow(ctx: any, userId: string, window: ExtractionWindow) {
  const claimToken = buildExtractionClaimToken();
  const result = await ctx.runMutation(
    (internal as any).crystal.ltmExtraction.claimExtractionWindow,
    {
      userId,
      messageIds: window.messageIds,
      channel: window.channel,
      sessionKey: window.sessionKey,
      claimToken,
      now: Date.now(),
      leaseMs: EXTRACTION_CLAIM_LEASE_MS,
      parts: window.parts,
    },
  ) as { acquired: boolean; reason?: string; waitUntil?: number };
  return { ...result, claimToken };
}

async function markWindowExtracted(
  ctx: any,
  userId: string,
  window: ExtractionWindow,
  claim: { claimToken: string },
  skippedReason?: string,
  durable?: Pick<DurableExtractionResult, "attemptKey" | "sourceMessageIds">,
) {
  const result = await ctx.runMutation((internal as any).crystal.ltmExtraction.finalizeExtractionWindow, {
    userId,
    messageIds: durable?.sourceMessageIds ?? window.messageIds,
    claimToken: claim.claimToken,
    extractedAt: Date.now(),
    skippedReason,
    attemptKey: durable?.attemptKey,
    parts: window.parts,
  }) as { finalized: boolean; reason?: string };
  if (!result.finalized) throw new Error(`Extraction claim lost before finalize: ${result.reason}`);
}

class ExtractionWait extends Error {
  constructor(public waitUntil: number, reason: string) {
    super(reason);
  }
}

class DistillationPausedError extends Error {
  constructor(
    public claimToken: string,
    public attemptKey: string,
  ) {
    super("Distillation paused");
  }
}

async function extractWindowDurably(
  ctx: any,
  userId: string,
  window: ExtractionWindow,
  credential: { apiKey: string | null; keyLast4?: string | null },
  recentDigests: RecentExtractionDigest[],
  claimToken: string,
  extractionRunId: string,
  context: ExtractionContext,
): Promise<DurableExtractionResult> {
  const attemptKey = buildExtractionAttemptKey(userId, window);
  const attempt = await ctx.runMutation((internal as any).crystal.ltmExtraction.beginExtractionAttempt, {
    attemptKey,
    userId,
    messageIds: window.messageIds,
    claimToken,
    extractionRunId,
    context,
    parts: window.parts,
  }) as {
    disposition: "call_provider" | "resume" | "active" | "retry_wait" | "blocked" | "claim_lost" | "paused";
    resultJson?: string;
    messageIds?: Id<"crystalMessages">[];
    extractionRunId?: string;
    context?: ExtractionContext;
    waitUntil?: number;
  };
  if (attempt.disposition === "resume" && attempt.resultJson) {
    const stored = boundedStoredExtractionResult(attempt.resultJson);
    return {
      // The provider usage belongs to the fresh request that produced this
      // durable row. Replaying DB-only work is explicitly nonbillable.
      call: { ...stored, usage: NONBILLABLE_EXTRACTION_USAGE },
      attemptKey,
      sourceMessageIds: attempt.messageIds!,
      extractionRunId: attempt.extractionRunId!,
      context: attempt.context!,
      resumed: true,
    };
  }
  if (attempt.disposition === "paused")
    throw new DistillationPausedError(claimToken, attemptKey);
  if ((attempt.disposition === "retry_wait" || attempt.disposition === "active") && attempt.waitUntil !== undefined) {
    throw new ExtractionWait(attempt.waitUntil, `extraction_${attempt.disposition}`);
  }
  if (attempt.disposition === "retry_wait" || attempt.disposition === "blocked") {
    throw new Error(`Extraction ${attempt.disposition}; source window remains pending`);
  }
  if (attempt.disposition === "active") {
    throw new Error("Extraction provider attempt is still active");
  }
  if (attempt.disposition !== "call_provider") {
    throw new Error("Extraction claim lost before provider attempt");
  }
  let call: ExtractionCallResult;
  try {
    const providerCall = await extractWindowMemories(
      ctx,
      userId,
      window,
      credential,
      recentDigests,
      claimToken,
      attemptKey,
    );
    call = boundedStoredExtractionResult({
      ...providerCall,
      // Replay the exact provider result after a database/action interruption.
      memories: providerCall.memories,
    });
    // Simulate a hard action loss in the only irreducible uncertainty gap:
    // the provider responded, but the result mutation has not committed.
    if (injectedExtractionFailure("before_result")) {
      throw new Error("TEST_CRASH_AFTER_PROVIDER_BEFORE_RESULT");
    }
    await ctx.runMutation((internal as any).crystal.ltmExtraction.persistExtractionAttemptResult, {
      attemptKey,
      userId,
      messageIds: window.messageIds,
      claimToken,
      resultJson: JSON.stringify(call),
    });
  } catch (error) {
    if ((error as Error)?.message === "TEST_CRASH_AFTER_PROVIDER_BEFORE_RESULT") throw error;
    if (error instanceof DistillationPausedError) {
      await ctx.runMutation(
        (internal as any).crystal.ltmExtraction.releasePausedExtractionAttempt,
        { attemptKey, userId, claimToken },
      );
      throw error;
    }
    // A known HTTP/transport failure still crossed the paid-call boundary.
    // Retry with bounded backoff, preserving the source. An ambiguous outcome
    // may be billed twice; after the retry limit only explicit retry can spend.
    await ctx.runMutation((internal as any).crystal.ltmExtraction.finalizeUnknownExtractionAttempt, {
      attemptKey,
      userId,
      claimToken,
      now: Date.now(),
    }).catch(() => {});
    throw error;
  }
  return {
    call,
    attemptKey,
    sourceMessageIds: window.messageIds,
    extractionRunId,
    context,
    resumed: false,
  };
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

async function loadExtractionSources(
  ctx: { db: { get: (id: Id<"crystalMessages">) => Promise<any> } },
  args: { userId: string; sourceMessageIds: Array<Id<"crystalMessages">>; claimToken?: string },
) {
  const sources = await Promise.all(args.sourceMessageIds.map((id) => ctx.db.get(id)));
  if (!args.claimToken) return sources;
  const now = Date.now();
  const fenced = sources.length > 0 && sources.every((message) =>
    message &&
    message.userId === args.userId &&
    message.ltmExtractedAt === undefined &&
    message.ltmExtractionClaim?.token === args.claimToken &&
    (message.ltmExtractionClaim?.leaseUntil ?? 0) >= now
  );
  if (!fenced) throw new Error("Extraction claim lost before memory write");
  return sources;
}

async function mergeExtractedDuplicate(ctx: any, existing: any, args: {
  userId: string;
  tags: string[];
  confidence: number;
  strength: number;
  sourceMessageIds: Array<Id<"crystalMessages">>;
  sessionKey?: string;
  extractionRunId?: string;
}, now: number) {
  const mergedSourceIds = Array.from(
    new Set([...(existing.sourceMessageIds ?? []), ...args.sourceMessageIds].map(String)),
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
    await applyDashboardTotalsDelta(ctx, args.userId, buildStrengthDelta(oldStrength, newStrength));
  }
  return { id: existing._id, inserted: false as const };
}

async function insertFreshExtractedMemory(ctx: any, args: {
  userId: string;
  title: string;
  content: string;
  store: "episodic" | "semantic" | "procedural" | "prospective";
  category: "decision" | "lesson" | "person" | "rule" | "event" | "fact" | "goal" | "skill" | "workflow" | "conversation";
  tags: string[];
  confidence: number;
  strength: number;
  contentHash: string;
  sourceMessageIds: Array<Id<"crystalMessages">>;
  channel?: string;
  sessionKey?: string;
  extractionRunId?: string;
}, now: number, agentId: string | undefined) {
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
    contentHash: args.contentHash,
    sourceMessageIds: args.sourceMessageIds,
    extractionSessionKey: args.sessionKey,
    extractionRunId: args.extractionRunId,
    ...(agentId ? { metadata: JSON.stringify({ agentId }) } : {}),
  });
  await applyDashboardTotalsDelta(ctx, args.userId, buildMemoryCreateDelta({
    store: args.store,
    archived: false,
    title: args.title,
    memoryId,
    createdAt: now,
    strength: args.strength ?? 1,
  }));
  if (shouldScheduleLtmBackgroundWork()) {
    await scheduleMemoryEmbedding(ctx, memoryId);
    await ctx.scheduler.runAfter(50, internal.crystal.salience.computeAndStoreSalience, { memoryId });
  }
  return { id: memoryId, inserted: true as const };
}

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
    claimToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sources = await loadExtractionSources(ctx, args);
    const titleScanResult = scanMemoryContent(args.title);
    if (!titleScanResult.allowed) {
      throw new Error(`Memory blocked: ${titleScanResult.reason} [${titleScanResult.threatId}]`);
    }
    const scanResult = scanMemoryContent(args.content);
    if (!scanResult.allowed) {
      throw new Error(`Memory blocked: ${scanResult.reason} [${scanResult.threatId}]`);
    }

    // Stamp from the source documents in sourceMessageIds order. No caller
    // argument and no re-sort. Unanimity fails closed to today's unstamped insert.
    const agentId = unanimousAgentStamp(sources);
    const existing = await findSameStampExactDuplicate(ctx, {
      userId: args.userId,
      contentHash: args.contentHash,
      channel: args.channel,
      stampKey: agentStampKey(agentId ? JSON.stringify({ agentId }) : undefined),
    });
    const now = Date.now();
    if (existing) return mergeExtractedDuplicate(ctx, existing, args, now);
    return insertFreshExtractedMemory(ctx, args, now, agentId);
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
    const windows = await recoverableWindows(ctx, args.userId, messages);
    const extractionRunId = buildExtractionRunId({ userId: args.userId });
    const openRouterCredential = await resolveUserOpenRouterCredential(ctx, args.userId);

    // A dry run must not create a paid inference request. Callers that need to
    // exercise extraction parsing can provide mockMemories explicitly.
    if (args.dryRun && !args.mockMemories) {
      return {
        scanned: messages.length,
        windows: windows.length,
        inserted: 0,
        wouldInsert: 0,
        deduped: 0,
        skipped: windows.length,
        errors: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        reason: "dry_run_no_provider_call",
        dryRun: true,
      };
    }

    if (!args.mockMemories && !openRouterCredential.apiKey) {
      // ILL-184: route the silent skip through the choke point so the alert
      // policy applies (missing_openrouter_key is actionable).
      await recordMissingOpenRouterKey(ctx, {
        userId: args.userId,
        keyLast4: openRouterCredential.keyLast4 ?? null,
        source: "ltmExtraction.extractWindowMemories",
        endpointKind: "chat_completions",
        model: await distillationModelIdForMissingKey(ctx, args.userId),
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
    let paused = false;

    for (const window of windows) {
      if (isDistillationPaused()) {
        paused = true;
        break;
      }
      try {
        const claim = args.dryRun ? undefined : await claimWindow(ctx, args.userId, window);
        if (claim && !claim.acquired) {
          skipped += 1;
          continue;
        }
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
        const durableExtraction = args.mockMemories ? null : await extractWindowDurably(
          ctx,
          args.userId,
          window,
          openRouterCredential,
          recentDigests,
          claim!.claimToken,
          extractionRunId,
          "on_demand",
        );
        const extractionCall: ExtractionCallResult = args.mockMemories
          ? {
              memories: args.mockMemories,
              usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            }
          : durableExtraction!.call;
        estimatedInputTokens += extractionCall.usage.inputTokens;
        estimatedOutputTokens += extractionCall.usage.outputTokens;
        estimatedCostUsd += extractionCall.usage.estimatedCostUsd;
        const extractionContext = durableExtraction?.context ?? "on_demand";
        const extracted = extractionCall.memories;
        if (extracted.length === 0) {
          skipped += 1;
          if (!args.dryRun) {
            await markWindowExtracted(ctx, args.userId, window, claim!, "no_durable_memory", durableExtraction ?? undefined);
          }
          continue;
        }

        const scanned = partitionScannedMemories(extracted);
        if (scanned.safe.length === 0) {
          skipped += 1;
          if (!args.dryRun) {
            await markWindowExtracted(
              ctx,
              args.userId,
              window,
              claim!,
              "blocked_by_content_scanner",
              durableExtraction ?? undefined,
            );
          }
          continue;
        }

        for (const memory of scanned.safe) {
          const contentHash = await sha256Hex(buildMemoryHashInput(memory));
          if (args.dryRun) {
            inserted += 1;
            continue;
          }
          const result = await ctx.runMutation((internal as any).crystal.ltmExtraction.insertExtractedMemory, {
            ...memory,
            userId: args.userId,
            tags: tagsForExtractionContext(memory.tags, extractionContext),
            contentHash,
            sourceMessageIds: durableExtraction?.sourceMessageIds ?? window.messageIds,
            channel: window.channel,
            sessionKey: window.sessionKey,
            extractionRunId: durableExtraction?.extractionRunId ?? extractionRunId,
            claimToken: claim?.claimToken,
          }) as { inserted: boolean };
          if (result.inserted) inserted += 1;
          else deduped += 1;
        }

        if (!args.dryRun) {
          await markWindowExtracted(ctx, args.userId, window, claim!, undefined, durableExtraction ?? undefined);
        }
      } catch (error) {
        if (error instanceof DistillationPausedError) {
          paused = true;
          break;
        }
        errors += 1;
        console.log(`[ltm-extraction] user ${await logLabel(args.userId)}: failed window ${await logLabel(window.key)}`, await logError(error, args.userId, [window.key]));
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
      paused: paused || isDistillationPaused(),
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
    maxWindows: v.optional(v.number()),
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
    const grouped = await recoverableWindows(ctx, args.userId, messages);
    const allWindows = args.messageIds && args.messageIds.length > 0 ? grouped : grouped.slice(0, 1);
    const windows = allWindows.slice(0, clampInt(args.maxWindows, 1, 200, 200));

    // Preserve dry-run as a genuinely zero-cost inspection path. Supplying
    // mockMemories remains available for deterministic extraction simulation.
    if (args.dryRun && !args.mockMemories) {
      return {
        scanned: messages.length,
        windows: windows.length,
        inserted: 0,
        wouldInsert: 0,
        deduped: 0,
        skipped: windows.length,
        blockedContentSkipped: 0,
        discardedMessages: 0,
        errors: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        reason: "dry_run_no_provider_call",
        dryRun: true,
      };
    }
    let inserted = 0;
    let deduped = 0;
    let skipped = 0;
    let noDurableSkipped = 0;
    let blockedContentSkipped = 0;
    let discardedMessages = 0;
    let errors = 0;
    let lastError: LtmTelemetryError | undefined;
    let nonTerminalReason: string | undefined;
    // Grouping omits sources in retry backoff; surface those waits even when
    // there are no runnable windows. Pinned windows also report claim waits.
    const retryTimes = messages.filter(message => !message.ltmExtractionBlocked)
      .map(message => message.ltmExtractionRetryAt ?? 0).filter(time => time > Date.now());
    let waitUntil: number | undefined = retryTimes.length ? Math.min(...retryTimes) : undefined;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;
    let paused = false;

    for (const window of windows) {
      if (isDistillationPaused()) {
        paused = true;
        nonTerminalReason = "distillation_paused";
        break;
      }
      let phase: LtmTelemetryPhase = "extract";
      try {
        if (!args.mockMemories && !openRouterCredential.apiKey) {
          // ILL-184: route the silent skip through the choke point so the
          // alert policy applies (missing_openrouter_key is actionable).
          await recordMissingOpenRouterKey(ctx, {
            userId: args.userId,
            keyLast4: openRouterCredential.keyLast4 ?? null,
            source: "ltmExtraction.extractWindowMemories",
            endpointKind: "chat_completions",
            model: await distillationModelIdForMissingKey(ctx, args.userId),
          }).catch(() => {});
          skipped += 1;
          nonTerminalReason = MISSING_USER_OPENROUTER_KEY_REASON;
          continue;
        }

        const claim = args.dryRun ? undefined : await claimWindow(ctx, args.userId, window);
        if (claim && !claim.acquired) {
          skipped += 1;
          nonTerminalReason = `extraction_claim_${claim.reason ?? "unavailable"}`;
          if (claim.waitUntil !== undefined) waitUntil = Math.min(waitUntil ?? Infinity, claim.waitUntil);
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
        const durableExtraction = args.mockMemories ? null : await extractWindowDurably(
          ctx,
          args.userId,
          window,
          openRouterCredential,
          recentDigests,
          claim!.claimToken,
          extractionRunId,
          context,
        );
        const extractionCall: ExtractionCallResult = args.mockMemories
          ? {
              memories: args.mockMemories,
              usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            }
          : durableExtraction!.call;
        estimatedInputTokens += extractionCall.usage.inputTokens;
        estimatedOutputTokens += extractionCall.usage.outputTokens;
        estimatedCostUsd += extractionCall.usage.estimatedCostUsd;
        if (injectedExtractionFailure("after_result") && !durableExtraction?.resumed) {
          throw new Error("TEST_CRASH_AFTER_PERSISTED_PROVIDER_RESULT");
        }
        const extractionContext = durableExtraction?.context ?? context;
        const extracted = extractionCall.memories;
        if (extracted.length === 0) {
          skipped += 1;
          noDurableSkipped += 1;
          discardedMessages += window.messageIds.length;
          if (!args.dryRun) {
            phase = "mark_messages";
            await markWindowExtracted(ctx, args.userId, window, claim!, "no_durable_memory", durableExtraction ?? undefined);
          }
          continue;
        }

        phase = "content_scan";
        const scanned = partitionScannedMemories(extracted);
        for (const blocked of scanned.blocked) {
          blockedContentSkipped += 1;
          lastError = blockedContentTelemetry(blocked.scan, window);
        }

        if (scanned.safe.length === 0) {
          skipped += 1;
          discardedMessages += window.messageIds.length;
          if (!args.dryRun) {
            phase = "mark_messages";
            await markWindowExtracted(ctx, args.userId, window, claim!, "blocked_by_content_scanner", durableExtraction ?? undefined);
          }
          continue;
        }

        let memoryWrites = 0;
        for (const memory of scanned.safe) {
          const contentHash = await sha256Hex(buildMemoryHashInput(memory));
          if (args.dryRun) {
            inserted += 1;
            continue;
          }
          phase = "insert";
          const result = await ctx.runMutation((internal as any).crystal.ltmExtraction.insertExtractedMemory, {
            ...memory,
            userId: args.userId,
            tags: tagsForExtractionContext(memory.tags, extractionContext),
            contentHash,
            sourceMessageIds: durableExtraction?.sourceMessageIds ?? window.messageIds,
            channel: window.channel,
            sessionKey: window.sessionKey,
            extractionRunId: durableExtraction?.extractionRunId ?? extractionRunId,
            claimToken: claim?.claimToken,
          }) as { inserted: boolean };
          if (result.inserted) inserted += 1;
          else deduped += 1;
          memoryWrites += 1;
          if (injectedExtractionFailure("after_memory", memoryWrites) && !durableExtraction?.resumed) {
            throw new Error("TEST_CRASH_DURING_MEMORY_PERSISTENCE");
          }
        }

        if (!args.dryRun) {
          phase = "mark_messages";
          await markWindowExtracted(ctx, args.userId, window, claim!, undefined, durableExtraction ?? undefined);
        }
      } catch (error) {
        if (error instanceof DistillationPausedError) {
          paused = true;
          nonTerminalReason = "distillation_paused";
          break;
        }
        if (error instanceof ExtractionWait) {
          skipped += 1;
          nonTerminalReason = error.message;
          waitUntil = Math.min(waitUntil ?? Infinity, error.waitUntil);
          continue;
        }
        errors += 1;
        lastError = errorTelemetry(error, phase, window);
        console.log(`[ltm-on-demand] user ${await logLabel(args.userId)}: failed window ${await logLabel(window.key)}`, await logError(error, args.userId, [window.key]));
      }
    }

    if (!args.dryRun) {
      const status = errors > 0
        ? "error"
        : inserted > 0
          ? "inserted"
          : deduped > 0
            ? "deduped"
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
      waitUntil,
      paused: paused || isDistillationPaused(),
      dryRun: args.dryRun ?? false,
    };
  },
});

export const getReflectionCycleCandidates = internalQuery({
  args: {
    userId: v.string(),
    beforeTimestamp: v.number(),
    limit: v.number(),
    sessionKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MessageRecord[]> => {
    const limit = clampInt(args.limit, 1, MAX_MESSAGES_PER_USER, MAX_MESSAGES_PER_USER);
    if (args.sessionKey) {
      return await ctx.db
        .query("crystalMessages")
        .withIndex("by_session_time", (q) =>
          q.eq("userId", args.userId).eq("sessionKey", args.sessionKey).lte("timestamp", args.beforeTimestamp)
        )
        .filter((q) => q.and(q.eq(q.field("ltmExtractedAt"), undefined), q.neq(q.field("role"), "system")))
        .order("asc")
        .take(limit) as MessageRecord[];
    }
    return await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_ltm_runnable", (q) =>
        q
          .eq("userId", args.userId)
          .eq("ltmExtractedAt", undefined)
          .eq("ltmExtractionBlocked", undefined)
          .lte("timestamp", args.beforeTimestamp)
      )
      .filter((q) => q.neq(q.field("role"), "system"))
      .order("asc")
      .take(limit) as MessageRecord[];
  },
});

export const getDueDistillationUserIds = internalQuery({
  args: {
    beforeTimestamp: v.number(),
    limit: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMessages")
      .withIndex("by_ltm_extracted_time", (q) =>
        q.eq("ltmExtractedAt", undefined).lte("timestamp", args.beforeTimestamp)
      )
      .order("asc")
      .paginate({
        numItems: clampInt(args.limit, 1, 500, 500),
        maximumBytesRead: 1_000_000,
        cursor: args.cursor ?? null,
      });
    return {
      userIds: [...new Set(
        page.page
          .filter((row) => row.role !== "system")
          .map((row) => row.userId),
      )],
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
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
        const page = await ctx.runQuery((internal as any).crystal.userProfiles.listUserIdsPage, {
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
