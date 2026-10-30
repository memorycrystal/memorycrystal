import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import {
  classifyChannel,
  channelFamily,
  isDevSessionFamily,
  isReportableBareLabel,
  privateBucket,
  sanitizeAllowlist,
  type ChannelClass,
  type PrivateBucket,
} from "./channelClassifier";

const MAX_PAGE_SIZE = 100;

type PageCounts = {
  /** Rows read from crystalMemories on this page, every tenant. */
  readMemories: number;
  /** Rows read from crystalMessages on this page, every tenant. */
  readMessages: number;
  /** Memories counted toward this report: all read rows, or only `userId`'s when set. */
  scannedMemories: number;
  /** Messages counted toward this report: all read rows, or only `userId`'s when set. */
  scannedMessages: number;
  byClass: Record<ChannelClass, number>;
  bareLabels: Array<{ label: string; count: number }>;
  devSessionFamilies: Array<{ family: string; count: number }>;
  privateBuckets: Record<PrivateBucket, number>;
  allowlistRejectedCount: number;
};

function emptyCounts(rejectedCount: number): PageCounts {
  return {
    readMemories: 0,
    readMessages: 0,
    scannedMemories: 0,
    scannedMessages: 0,
    byClass: { global: 0, work: 0, private: 0 },
    bareLabels: [],
    devSessionFamilies: [],
    privateBuckets: {
      peerMessaging: 0,
      numericOrPhone: 0,
      email: 0,
      group: 0,
      ambiguousOrPeerScope: 0,
      other: 0,
    },
    allowlistRejectedCount: rejectedCount,
  };
}

function absorbChannel(counts: PageCounts, channel: string | undefined, allowlist: readonly string[]) {
  const value = channel ?? "";
  const channelClass = classifyChannel(value, allowlist);
  counts.byClass[channelClass] += 1;
  if (channelClass === "private") {
    counts.privateBuckets[privateBucket(value)] += 1;
  }
  if (isReportableBareLabel(value)) {
    const label = value.trim();
    const existing = counts.bareLabels.find((row) => row.label.toLowerCase() === label.toLowerCase());
    if (existing) existing.count += 1;
    else counts.bareLabels.push({ label, count: 1 });
  }
  const family = channelFamily(value);
  if (isDevSessionFamily(family)) {
    const existing = counts.devSessionFamilies.find((row) => row.family === family);
    if (existing) existing.count += 1;
    else counts.devSessionFamilies.push({ family: family as string, count: 1 });
  }
}

function finish(counts: PageCounts, userId: string | undefined): PageCounts {
  // All-tenant pages are aggregate-only, including the s: transition page.
  if (!userId) {
    counts.bareLabels = [];
    counts.devSessionFamilies = [];
  }
  counts.bareLabels.sort((a, b) => a.label.localeCompare(b.label));
  counts.devSessionFamilies.sort((a, b) => a.family.localeCompare(b.family));
  return counts;
}

/**
 * Read-only operator scope report. Pages are bounded to 1..100 rows.
 * Output is counts plus safe bare labels. Memory bodies, message bodies, and
 * peer identifiers are not returned.
 *
 * ILL-320 (audit A04): with `userId`, every count (`scannedMemories`,
 * `scannedMessages`, `byClass`, `messagesByClass`, labels, buckets) covers
 * only that user's rows; `readMemories` / `readMessages` still report how many
 * rows the page read from each table across all tenants, for progress.
 */
export const operatorScopeReport = internalQuery({
  args: {
    pageSize: v.number(),
    cursor: v.optional(v.string()),
    allowlist: v.optional(v.array(v.string())),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const pageSize = Math.trunc(args.pageSize);
    if (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new Error(`scope report pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
    }
    const allowlist = args.allowlist ?? [];
    const sanitized = sanitizeAllowlist(allowlist);
    const targetUserId: string | undefined = args.userId?.trim() || undefined;
    if (sanitized.rejectedCount > 0) {
      console.info(`scope report allowlist entries rejected: ${sanitized.rejectedCount}`);
    }
    const counts = emptyCounts(sanitized.rejectedCount);
    // ILL‑320 A04: separate message class counts
    const messagesByClass = { global: 0, work: 0, private: 0 };
    const remaining = pageSize;
    let phase: "memories" | "messages" = "memories";
    let convexCursor: string | null = null;
    const cursor = args.cursor ?? "";
    if (cursor.startsWith("s:")) {
      phase = "messages";
      convexCursor = cursor.length > 2 ? cursor.slice(2) : null;
    } else if (cursor.startsWith("m:")) {
      convexCursor = cursor.length > 2 ? cursor.slice(2) : null;
    } else if (cursor) {
      throw new Error("invalid scope report cursor");
    }

    if (phase === "memories") {
      const page = await ctx.db.query("crystalMemories").paginate({
        numItems: remaining,
        cursor: convexCursor,
      });
      for (const memory of page.page) {
        counts.readMemories += 1;
        if (targetUserId !== undefined && memory.userId !== targetUserId) continue;
        counts.scannedMemories += 1;
        absorbChannel(counts, memory.channel, allowlist);
      }
      if (!page.isDone) {
        return { done: false, cursor: `m:${page.continueCursor}`, page: { ...finish(counts, targetUserId), messagesByClass } };
      }
      // Convex allows one paginated query per function call, so the messages
      // phase always starts in the next call.
      return { done: false, cursor: "s:", page: { ...finish(counts, targetUserId), messagesByClass } };
    }

    const messages = await ctx.db.query("crystalMessages").paginate({
      numItems: remaining,
      cursor: convexCursor,
    });
    for (const message of messages.page) {
      counts.readMessages += 1;
      if (targetUserId !== undefined && message.userId !== targetUserId) continue;
      counts.scannedMessages += 1;
      absorbChannel(counts, message.channel, allowlist);
      // ILL‑320 A04: per-message class count
      const chClass = classifyChannel(message.channel ?? "", allowlist);
      messagesByClass[chClass] += 1;
    }
    const page = { ...finish(counts, targetUserId), messagesByClass };
    if (!messages.isDone) {
      return { done: false, cursor: `s:${messages.continueCursor}`, page };
    }
    return { done: true, cursor: null, page };
  },
});
