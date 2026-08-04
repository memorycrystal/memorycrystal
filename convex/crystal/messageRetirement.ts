import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
} from "./dashboardTotals";
import { rawContentExpiresAt } from "./retention";
import { sha256Hex } from "./crypto";

const CAPSULE_MIN_CHARS = 160;
const CAPSULE_MAX_CHARS = 900;
const CAPSULE_MAX_MESSAGES = 12;
export const TERMINAL_SKIP_REASONS = new Set([
  "low_signal",
  "no_durable_memory",
  "blocked_by_content_scanner",
  "unscoped_channel",
]);

function shouldScheduleRetirementBackgroundWork() {
  return !(
    typeof process !== "undefined" &&
    (process.env.VITEST || process.env.NODE_ENV === "test")
  );
}

type RetiredMessage = {
  _id: Id<"crystalMessages">;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  channel?: string;
  sessionKey?: string;
  timestamp: number;
  contentHash?: string;
  ltmExtractedAt?: number;
  ltmExtractionSkippedReason?: string;
};

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

const BARE_GREETING_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|yep|yes|no|done|got it)[.!?\s]*$/i;

function capsuleWorthKeeping(messages: RetiredMessage[]) {
  const joined = normalizeText(messages.map((message) => message.content).join(" "));
  if (joined.length < CAPSULE_MIN_CHARS) return false;
  if (BARE_GREETING_RE.test(joined)) {
    return false;
  }
  return true;
}

// Looser gate for the force-retirement path: keep any non-empty, non-greeting
// content (no CAPSULE_MIN_CHARS floor) so a short-but-real window isn't lost
// when its messages are force-deleted after repeated extraction failures.
function capsuleHasContent(messages: RetiredMessage[]) {
  const joined = normalizeText(messages.map((message) => message.content).join(" "));
  if (joined.length === 0) return false;
  return !BARE_GREETING_RE.test(joined);
}

function buildCapsule(messages: RetiredMessage[]) {
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp).slice(0, CAPSULE_MAX_MESSAGES);
  const startedAt = sorted[0]?.timestamp ?? Date.now();
  const endedAt = sorted[sorted.length - 1]?.timestamp ?? startedAt;
  const roles = sorted.map((message) => `${message.role}: ${normalizeText(message.content)}`);
  const summary = normalizeText(roles.join(" | ")).slice(0, CAPSULE_MAX_CHARS);
  const titleDate = new Date(startedAt).toISOString().slice(0, 10);
  const title = `Retired conversation window: ${titleDate}`;
  const metadata = {
    source: "message_retirement",
    channel: sorted[0]?.channel,
    sessionKey: sorted[0]?.sessionKey,
    startedAt,
    endedAt,
    messageCount: messages.length,
    sourceMessageIds: messages.map((message) => String(message._id)),
    sourceMessageHashes: messages.map((message) => message.contentHash).filter(Boolean),
    skippedReasons: Array.from(new Set(messages.map((message) => message.ltmExtractionSkippedReason).filter(Boolean))),
  };
  return {
    title,
    content: summary,
    summary,
    recallText: summary.slice(0, 500),
    metadata: JSON.stringify(metadata),
    startedAt,
    endedAt,
  };
}

export function isTerminallyProcessed(message: Pick<RetiredMessage, "ltmExtractedAt" | "ltmExtractionSkippedReason">) {
  return Boolean(message.ltmExtractedAt || (
    message.ltmExtractionSkippedReason &&
    TERMINAL_SKIP_REASONS.has(message.ltmExtractionSkippedReason)
  ));
}

export const getMessagesByIds = internalQuery({
  args: {
    messageIds: v.array(v.id("crystalMessages")),
  },
  handler: async (ctx, args) => {
    const messages = await Promise.all(args.messageIds.map((id) => ctx.db.get(id)));
    return messages.filter(Boolean) as RetiredMessage[];
  },
});

export const createRetirementCapsule = internalMutation({
  args: {
    userId: v.string(),
    channel: v.optional(v.string()),
    title: v.string(),
    content: v.string(),
    summary: v.string(),
    recallText: v.string(),
    metadata: v.string(),
    contentHash: v.string(),
    sourceMessageIds: v.array(v.id("crystalMessages")),
    sensoryRawTtlDays: v.number(),
  },
  handler: async (ctx, args) => {
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
    if (existing) return { id: existing._id, inserted: false };

    const now = Date.now();
    const memoryId = await ctx.db.insert("crystalMemories", {
      userId: args.userId,
      store: "sensory",
      category: "conversation",
      title: args.title,
      content: args.content,
      metadata: args.metadata,
      embedding: [],
      strength: 0.35,
      confidence: 0.65,
      valence: 0,
      arousal: 0.2,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      source: "conversation",
      channel: args.channel,
      tags: ["message-retirement", "conversation-residue", "sensory-mode:message_retirement"],
      archived: false,
      contentHash: args.contentHash,
      sourceMessageIds: args.sourceMessageIds,
      summary: args.summary,
      summaryCreatedAt: now,
      summarySource: "backfill",
      recallText: args.recallText,
      rawContentExpiresAt: rawContentExpiresAt(now, args.sensoryRawTtlDays),
      rawRetentionState: "summarized",
      sensoryRawTtlDaysApplied: args.sensoryRawTtlDays,
      embeddingSource: "summary",
    });

    await applyDashboardTotalsDelta(
      ctx,
      args.userId,
      buildMemoryCreateDelta({
        store: "sensory",
        archived: false,
        title: args.title,
        memoryId,
        createdAt: now,
        strength: 0.35,
      })
    );

    if (shouldScheduleRetirementBackgroundWork()) {
      await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, { memoryId });
    }
    return { id: memoryId, inserted: true };
  },
});

// Force-retire messages that reached MAX_RETIREMENT_ATTEMPTS: build a capsule
// (if the content is worth keeping) so conversation continuity is preserved,
// then force-delete so a message that can never terminally LTM-process still
// drains instead of churning forever.
async function forceRetireMaxedMessages(
  ctx: any,
  maxedMessageIds: Array<Id<"crystalMessages">>,
): Promise<number> {
  if (maxedMessageIds.length === 0) return 0;
  const messages = (await ctx.runQuery(internal.crystal.messageRetirement.getMessagesByIds, {
    messageIds: maxedMessageIds,
  })) as RetiredMessage[];
  if (messages.length === 0) return 0;

  // Force path preserves content more eagerly than the normal terminal path:
  // capsule whenever there is ANY meaningful content (only bare greetings /
  // empty are skipped), NOT the stricter capsuleWorthKeeping 160-char floor.
  // These messages are about to be hard-deleted after repeated extraction
  // failures, so silently dropping a short-but-real exchange is worse than an
  // over-eager capsule.
  let capsuled = false;
  if (capsuleHasContent(messages)) {
    const userId = messages[0].userId;
    const channel = messages[0].channel;
    const sessionKey = messages[0].sessionKey;
    const tierInfo: { sensoryRawTtlDays: number } = await ctx
      .runQuery((internal as any).crystal.userProfiles.getUserTierInfo, { userId })
      .catch(() => ({ sensoryRawTtlDays: 7 }));
    const capsule = buildCapsule(messages);
    const contentHash = await sha256Hex(
      `${userId}|${channel ?? ""}|${sessionKey ?? ""}|${capsule.startedAt}|${capsule.endedAt}|${capsule.content}`,
    );
    const { startedAt: _startedAt, endedAt: _endedAt, ...capsuleArgs } = capsule;
    await ctx.runMutation(internal.crystal.messageRetirement.createRetirementCapsule, {
      userId,
      channel,
      ...capsuleArgs,
      contentHash,
      sourceMessageIds: messages.map((message) => message._id),
      sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
    });
    capsuled = true;
  }

  const deletion = (await ctx.runMutation(internal.crystal.messages.deleteRetiredMessages, {
    messageIds: maxedMessageIds,
    retiredAt: Date.now(),
    force: true,
  })) as { deleted: number; blocked: number };
  // force:true makes the terminally-processed guard unreachable, so a non-zero
  // blocked here means a NEW pre-delete guard silently swallowed a force-delete
  // (rows would neither drain nor surface). Fail loud so it can't hide.
  if (deletion.blocked > 0) {
    throw new Error(
      `forceRetireMaxedMessages: ${deletion.blocked} message(s) blocked despite force:true`,
    );
  }
  console.warn(
    `[message-retirement] force-retired ${deletion.deleted} message(s) after ${
      "" + messages.length
    }-message window hit MAX_RETIREMENT_ATTEMPTS (capsuled=${capsuled})`,
  );
  return deletion.deleted;
}

// A retire attempt could not terminally process this group. Increment attempts
// and LEAVE the rows queued (markRetirementBlocked) — this breaks the churn loop
// where blocked messages were un-queued back into the never-queued scan every
// hour. Any message that reached MAX_RETIREMENT_ATTEMPTS is force-retired.
async function handleRetirementBlocked(
  ctx: any,
  messageIds: Array<Id<"crystalMessages">>,
  reason: string,
) {
  const { maxedMessageIds } = (await ctx.runMutation(
    internal.crystal.messages.markRetirementBlocked,
    { messageIds },
  )) as { maxedMessageIds: Array<Id<"crystalMessages">> };
  const forceRetired = await forceRetireMaxedMessages(ctx, maxedMessageIds);
  return { deleted: forceRetired, capsuleInserted: false, reason, forceRetired };
}

export const retireExpiredMessageWindow = internalAction({
  args: {
    messageIds: v.array(v.id("crystalMessages")),
  },
  handler: async (ctx, args) => {
    const messages = (await ctx.runQuery(internal.crystal.messageRetirement.getMessagesByIds, {
      messageIds: args.messageIds,
    })) as RetiredMessage[];
    if (messages.length === 0) return { deleted: 0, capsuleInserted: false, reason: "no_messages" };

    const userId = messages[0].userId;
    const channel = messages[0].channel;
    const sessionKey = messages[0].sessionKey;
    const unextracted = messages.filter((message) => message.ltmExtractedAt === undefined);
    if (unextracted.length > 0) {
      const extraction = await ctx.runAction((internal as any).crystal.ltmExtraction.runOnDemandLtmExtraction, {
        userId,
        channel,
        sessionKey,
        messageIds: unextracted.map((message) => message._id),
      }) as { inserted?: number; deduped?: number; errors?: number; skipped?: number; reason?: string };
      if ((extraction.errors ?? 0) > 0 || extraction.reason) {
        return await handleRetirementBlocked(
          ctx,
          args.messageIds,
          extraction.reason ?? "ltm_error",
        );
      }
    }

    const refreshed = (await ctx.runQuery(internal.crystal.messageRetirement.getMessagesByIds, {
      messageIds: args.messageIds,
    })) as RetiredMessage[];
    const unprocessed = refreshed.filter((message) => !isTerminallyProcessed(message));
    if (unprocessed.length > 0) {
      return await handleRetirementBlocked(ctx, args.messageIds, "not_terminally_processed");
    }

    const shouldCapsule = refreshed.some((message) =>
      message.ltmExtractionSkippedReason === "low_signal" ||
      message.ltmExtractionSkippedReason === "no_durable_memory" ||
      message.ltmExtractionSkippedReason === "blocked_by_content_scanner"
    ) && capsuleWorthKeeping(refreshed);

    let capsuleInserted = false;
    if (shouldCapsule) {
      const tierInfo: { sensoryRawTtlDays: number } = await ctx
        .runQuery((internal as any).crystal.userProfiles.getUserTierInfo, { userId })
        .catch(() => ({ sensoryRawTtlDays: 7 }));
      const capsule = buildCapsule(refreshed);
      const contentHash = await sha256Hex(`${userId}|${channel ?? ""}|${sessionKey ?? ""}|${capsule.startedAt}|${capsule.endedAt}|${capsule.content}`);
      const { startedAt: _startedAt, endedAt: _endedAt, ...capsuleArgs } = capsule;
      const result = await ctx.runMutation(internal.crystal.messageRetirement.createRetirementCapsule, {
        userId,
        channel,
        ...capsuleArgs,
        contentHash,
        sourceMessageIds: refreshed.map((message) => message._id),
        sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
      }) as { inserted: boolean };
      capsuleInserted = result.inserted;
    }

    const deletion = await ctx.runMutation(internal.crystal.messages.deleteRetiredMessages, {
      messageIds: args.messageIds,
      retiredAt: Date.now(),
    }) as { deleted: number; blocked: number };

    return {
      deleted: deletion.deleted,
      capsuleInserted,
      reason: deletion.blocked > 0 ? "delete_blocked_unprocessed" : undefined,
    };
  },
});
