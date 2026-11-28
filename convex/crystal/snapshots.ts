import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { stableUserId } from "./auth";

const VALID_ROLES = new Set(["user", "assistant", "system"]);


export const SNAPSHOT_BYTE_LIMIT = 750_000;
export const SNAPSHOT_MAX_MESSAGES = 10_000;
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export const snapshotTruncationValidator = v.object({
  originalMessageCount: v.number(),
  skippedMessageCount: v.number(),
  droppedMessageCount: v.number(),
  truncatedContentCount: v.number(),
  originalTotalTokens: v.number(),
  byteLimit: v.number(),
});

type SnapshotMessage = { role: "user" | "assistant" | "system"; content: string; timestamp?: number };

/** Keep the newest usable suffix. The minimum 1,024-byte budget always fits
 * one message envelope (including a finite timestamp) and "\n[truncated]".
 * Entries with unreadable properties are unusable, just like malformed JSON entries.
 */
export function boundSnapshotMessages(raw: unknown[], opts?: { byteLimit?: number; maxMessages?: number }) {
  const normalizedLimit = (value: unknown, min: number, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= min ? value : fallback;
  let byteLimit = SNAPSHOT_BYTE_LIMIT;
  let maxMessages = SNAPSHOT_MAX_MESSAGES;
  try {
    byteLimit = normalizedLimit(opts?.byteLimit, 1024, SNAPSHOT_BYTE_LIMIT);
    maxMessages = normalizedLimit(opts?.maxMessages, 1, SNAPSHOT_MAX_MESSAGES);
  } catch { /* Unreadable options use defaults. */ }
  const usable: SnapshotMessage[] = [];
  let originalMessageCount = 0;
  try {
    if (Array.isArray(raw)) {
      originalMessageCount = raw.length;
      for (let i = 0; i < originalMessageCount; i++) {
        try {
          const entry = raw[i];
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          const m = entry as Record<string, unknown>;
          const rawRole = m.role;
          const role = rawRole == null ? "user" : typeof rawRole === "string" ? rawRole.trim().toLowerCase() : "";
          if (!VALID_ROLES.has(role)) continue;
          const source = m.content;
          const content = typeof source === "string" ? source : Array.isArray(source)
            ? source.flatMap(part => part && typeof part === "object" && typeof part.text === "string" ? [part.text] : []).join("\n")
            : "";
          if (!content.trim()) continue;
          const timestamp = m.timestamp;
          usable.push({ role: role as SnapshotMessage["role"], content,
            ...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { timestamp } : {}) });
        } catch { /* Skip hostile objects as well as unusable entries. */ }
      }
    }
  } catch { /* Non-array or unreadable input contains no usable messages. */ }
  const messages: SnapshotMessage[] = [];
  let usedBytes = 2;
  let truncatedContentCount = 0;
  for (let i = usable.length - 1; i >= 0 && messages.length < maxMessages; i--) {
    let message = usable[i];
    let size = byteLength(message);
    if (usedBytes + size + (messages.length ? 1 : 0) > byteLimit) {
      if (messages.length) break;
      const suffix = "\n[truncated]";
      const prefix = (length: number) => {
        if (length > 0 && length < message.content.length &&
            /[\uD800-\uDBFF]/.test(message.content[length - 1]) &&
            /[\uDC00-\uDFFF]/.test(message.content[length])) length--;
        return message.content.slice(0, length);
      };
      let low = 0, high = message.content.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (byteLength([{ ...message, content: prefix(mid) + suffix }]) <= byteLimit) low = mid;
        else high = mid - 1;
      }
      message = { ...message, content: prefix(low) + suffix };
      size = byteLength(message);
      truncatedContentCount = 1;
    }
    usedBytes += size + (messages.length ? 1 : 0);
    messages.push(message);
    if (truncatedContentCount) break;
  }
  messages.reverse();
  const skippedMessageCount = originalMessageCount - usable.length;
  const droppedMessageCount = usable.length - messages.length;
  const truncation = skippedMessageCount || droppedMessageCount || truncatedContentCount ? {
    originalMessageCount, skippedMessageCount, droppedMessageCount, truncatedContentCount,
    originalTotalTokens: Math.ceil(usable.reduce((sum, m) => sum + m.content.length, 0) / 4),
    byteLimit,
  } : undefined;
  return { messages, truncation };
}

const normalizeRequiredString = (value: string, field: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConvexError(`${field} is required`);
  }
  return trimmed;
};

export const createSnapshot = internalMutation({
  args: {
    userId: v.string(),
    sessionKey: v.optional(v.string()),
    channel: v.optional(v.string()),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        timestamp: v.optional(v.number()),
      })
    ),
    reason: v.string(),
    truncation: v.optional(snapshotTruncationValidator),
  },
  handler: async (ctx, args) => {
    if (args.messages.length === 0) {
      throw new ConvexError("messages array must not be empty");
    }
    if (args.messages.length > 10_000) {
      throw new ConvexError("messages array must not exceed 10000 items");
    }

    const sessionKey = normalizeRequiredString(args.sessionKey ?? "", "sessionKey");
    const channel = normalizeRequiredString(args.channel ?? "", "channel");
    const reason = normalizeRequiredString(args.reason, "reason");

    const messages = args.messages.map((message, index) => {
      if (!VALID_ROLES.has(message.role)) {
        throw new ConvexError(`invalid message role at index ${index}`);
      }
      if (typeof message.content !== "string" || message.content.trim().length === 0) {
        throw new ConvexError(`message content must be a non-empty string at index ${index}`);
      }
      return {
        ...message,
        role: message.role as "user" | "assistant" | "system",
      };
    });

    if (byteLength(messages) > SNAPSHOT_BYTE_LIMIT) {
      throw new ConvexError("snapshot exceeds byte limit");
    }

    const messageCount = messages.length;
    const totalTokens = Math.ceil(
      messages.reduce((sum, m) => sum + m.content.length, 0) / 4
    );

    const id = await ctx.db.insert("crystalSnapshots", {
      userId: args.userId,
      sessionKey,
      channel,
      messages,
      messageCount,
      totalTokens,
      reason,
      createdAt: Date.now(),
      ...(args.truncation ? { truncation: args.truncation } : {}),
    });

    return { id, messageCount, totalTokens };
  },
});

export const getSnapshot = internalQuery({
  args: { snapshotId: v.id("crystalSnapshots"), userId: v.string() },
  handler: async (ctx, { snapshotId, userId }) => {
    const snapshot = await ctx.db.get(snapshotId);
    if (!snapshot) return null;
    if (snapshot.userId !== userId) throw new ConvexError("unauthorized");
    return snapshot;
  },
});

export const listSnapshots = query({
  args: {
    sessionKey: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("unauthenticated");
    const userId = stableUserId(identity.subject);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const sessionKey = args.sessionKey?.trim() || undefined;

    let q;
    if (sessionKey) {
      q = ctx.db
        .query("crystalSnapshots")
        .withIndex("by_session", (q) =>
          q.eq("userId", userId).eq("sessionKey", sessionKey)
        )
        .order("desc");
    } else {
      q = ctx.db
        .query("crystalSnapshots")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .order("desc");
    }

    return await q.take(limit);
  },
});
