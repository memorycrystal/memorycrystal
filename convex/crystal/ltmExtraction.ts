import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
} from "./dashboardTotals";
import { scanMemoryContent } from "./contentScanner";
import { sha256Hex } from "./crypto";
import {
  buildMemoryHashInput,
  buildMessageDedupeScopeInput,
  buildMessageHashInput,
  normalizeMemoryContentForHash,
} from "./contentHash";

const OPENAI_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const EXTRACTION_MODEL = "gpt-4o-mini";
const DEFAULT_MESSAGES_PER_USER = 60;
const DEFAULT_USERS_PER_RUN = 20;
const CRON_ROTATION_MS = 15 * 60 * 1000;
const MAX_MESSAGES_PER_USER = 200;
const MAX_USERS_PER_RUN = 100;
const EXTRACTION_SETTLE_MS = 2 * 60 * 1000;
const TURN_GAP_MS = 15 * 60 * 1000;
const MAX_WINDOW_MESSAGES = 12;
const MAX_WINDOW_CHARS = 8_000;

type Role = "user" | "assistant" | "system";
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

const buildExtractionPrompt = (window: ExtractionWindow) => `You extract durable long-term memories from short-term conversation logs.

Return ONLY valid JSON in this exact shape:
{"memories":[{"title":"short title","content":"durable fact/decision/preference/lesson","store":"semantic|episodic|procedural|prospective","category":"decision|lesson|person|rule|event|fact|goal|skill|workflow|conversation","tags":["tag"],"importance":0.0,"confidence":0.0}]}

Rules:
- Extract only durable memories useful in future sessions: decisions, preferences, stable facts, goals, lessons, reusable workflows, commitments, or meaningful events.
- Do not save transient chatter, greetings, tool output noise, or content already phrased as a temporary status.
- Prefer semantic/fact for stable facts, episodic/event for dated work/events, procedural/skill or workflow for reusable processes, prospective/goal for future commitments.
- Keep each content item self-contained, factual, and under 600 characters.
- Return {"memories":[]} when no durable memory exists.

Conversation window:
${window.text}`;

async function extractWindowMemories(window: ExtractionWindow, apiKey: string): Promise<ExtractedMemory[]> {
  const response = await fetch(OPENAI_COMPLETIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      temperature: 0.1,
      messages: [{ role: "user", content: buildExtractionPrompt(window) }],
    }),
  });

  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) {
    throw new Error(`OpenAI extraction failed: ${response.status} ${JSON.stringify(payload?.error ?? null).slice(0, 200)}`);
  }
  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) return [];
  return parseExtractedMemories(raw);
}

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
      await ctx.db.patch(existing._id, {
        lastAccessedAt: now,
        strength: Math.max(existing.strength ?? 0, args.strength),
        confidence: Math.max(existing.confidence ?? 0, args.confidence),
        tags: mergedTags,
        sourceMessageIds: mergedSourceIds,
      });
      return { id: existing._id, inserted: false };
    }

    const memoryId = await ctx.db.insert("crystalMemories", {
      userId: args.userId,
      title: args.title,
      content: args.content,
      store: args.store,
      category: args.category,
      tags: normalizeTags([...args.tags, "auto-extracted", "ltm-backfill"]),
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
      })
    );

    if (shouldScheduleLtmBackgroundWork()) {
      await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, { memoryId });
      await ctx.scheduler.runAfter(50, internal.crystal.salience.computeAndStoreSalience, { memoryId });
      await ctx.scheduler.runAfter(100, internal.crystal.graphEnrich.enrichMemoryGraph, {
        memoryId,
        userId: args.userId,
      });
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
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!args.mockMemories && !openaiApiKey) {
      return { scanned: messages.length, windows: windows.length, inserted: 0, deduped: 0, skipped: windows.length, reason: "OPENAI_API_KEY not set" };
    }

    let inserted = 0;
    let deduped = 0;
    let skipped = 0;
    let errors = 0;

    for (const window of windows) {
      try {
        const extracted = args.mockMemories ?? await extractWindowMemories(window, openaiApiKey as string);
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
      dryRun: args.dryRun ?? false,
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
    const allUserIds = args.userId
      ? [args.userId]
      : (await ctx.runQuery(internal.crystal.userProfiles.listAllUserIds, {}) as string[]);
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
