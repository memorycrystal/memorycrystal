import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { buildMessageDedupeScopeInput, buildMessageHashInput } from "./contentHash";
import { sha256Hex } from "./crypto";

// Operator-only secret scrub (ILL-484, runbook docs/operations/secret-scrub.md).
// The secret never reaches these functions: the operator script finds the
// ranges client-side and sends only ranges plus the sha256 of the content it
// read. Nothing here logs content, and nothing returns it except the snapshot
// page the script needs for in-memory matching.

export const REDACTION_MARKER = "[REDACTED]";
export const MAX_REDACTION_RANGES = 200;
const SNAPSHOT_PAGE_LIMIT = 25;

const rangesValidator = v.array(v.object({ start: v.number(), end: v.number() }));
type Range = { start: number; end: number };

function scrubError(code: string): never {
  throw new ConvexError({ code });
}

/** Throws before any write; returns the content with every range replaced. */
async function redactContent(content: string, expectedContentSha256: string, ranges: Range[]): Promise<string> {
  if ((await sha256Hex(content)) !== expectedContentSha256) scrubError("content_changed");
  if (ranges.length === 0 || ranges.length > MAX_REDACTION_RANGES) scrubError("invalid_ranges");
  let previousEnd = 0;
  for (const { start, end } of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > content.length
      || start >= end || start < previousEnd) scrubError("invalid_ranges");
    previousEnd = end;
  }
  // Last range first, so earlier offsets still point at the fetched content.
  let next = content;
  for (let index = ranges.length - 1; index >= 0; index--) {
    const { start, end } = ranges[index];
    next = next.slice(0, start) + REDACTION_MARKER + next.slice(end);
  }
  return next;
}

/**
 * Replaces ranges of one raw message with [REDACTED]. contentHash and
 * dedupeScopeHash are recomputed with the capture path's helpers, from the
 * row's stored role, channel, session and turn fields. dedupeCheckedAt is left
 * as is, so the dedupe sweep does not revisit the row. Any legacy inline
 * vector is cleared and `embedded` set to false: raw-message vectors are
 * retired and no job re-embeds messages, so the row simply stays vectorless.
 */
export const redactMessageRanges = internalMutation({
  args: {
    messageId: v.id("crystalMessages"),
    userId: v.string(),
    expectedContentSha256: v.string(),
    ranges: rangesValidator,
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) scrubError("not_found");
    if (message.userId !== args.userId) scrubError("owner_mismatch");
    const content = await redactContent(message.content, args.expectedContentSha256, args.ranges);
    const contentHash = await sha256Hex(buildMessageHashInput({ role: message.role, content }));
    const dedupeScopeHash = await sha256Hex(buildMessageDedupeScopeInput({
      userId: message.userId,
      role: message.role,
      contentHash,
      channel: message.channel,
      sessionKey: message.sessionKey,
      turnId: message.turnId,
      turnMessageIndex: message.turnMessageIndex,
    }));
    await ctx.db.patch(args.messageId, {
      content,
      contentHash,
      dedupeScopeHash,
      embedding: undefined,
      embedded: false,
    });
    return { redacted: args.ranges.length };
  },
});

/**
 * Replaces ranges of one snapshot message's content. messageCount and
 * totalTokens are left unchanged: they describe the captured session, and the
 * marker's length difference is not worth a token recount.
 */
export const redactSnapshotMessageRanges = internalMutation({
  args: {
    snapshotId: v.id("crystalSnapshots"),
    userId: v.string(),
    messageIndex: v.number(),
    expectedContentSha256: v.string(),
    ranges: rangesValidator,
  },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (!snapshot) scrubError("not_found");
    if (snapshot.userId !== args.userId) scrubError("owner_mismatch");
    if (!Number.isInteger(args.messageIndex) || args.messageIndex < 0
      || args.messageIndex >= snapshot.messages.length) scrubError("invalid_index");
    const target = snapshot.messages[args.messageIndex];
    const content = await redactContent(target.content, args.expectedContentSha256, args.ranges);
    const messages = snapshot.messages.map((message, index) =>
      index === args.messageIndex ? { ...message, content } : message);
    await ctx.db.patch(args.snapshotId, { messages });
    return { redacted: args.ranges.length };
  },
});

export const listSnapshotsForUserPage = internalQuery({
  args: { userId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const requested = Math.floor(args.paginationOpts.numItems);
    const numItems = Math.min(Math.max(Number.isFinite(requested) ? requested : 1, 1), SNAPSHOT_PAGE_LIMIT);
    const result = await ctx.db
      .query("crystalSnapshots")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .paginate({ ...args.paginationOpts, numItems });
    return {
      page: result.page.map(({ _id, createdAt, messages }) => ({ _id, createdAt, messages })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** Delete-instead path only; the scrub script never calls this by default. */
export const deleteSnapshotForUser = internalMutation({
  args: { snapshotId: v.id("crystalSnapshots"), userId: v.string() },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (!snapshot) return { deleted: false };
    if (snapshot.userId !== args.userId) scrubError("owner_mismatch");
    await ctx.db.delete(args.snapshotId);
    return { deleted: true };
  },
});
