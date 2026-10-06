import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { UserTier } from "../../../shared/tierLimits";
import type { RecallPorts } from "./types";

/** Query adapter: each invocation owns one bounded transaction. */
export function createMessagePageReader(
  ctx: ActionCtx,
  userId: string,
  getTier: () => Promise<UserTier | undefined>,
): NonNullable<RecallPorts["searchMessagePage"]> {
  // One reader serves one recall request. A pagination cursor is bound to its query's index range, so the default
  // 14-day lower bound is fixed here: recomputing it from the clock on every page makes the second page an
  // InvalidCursor ("this cursor is from a different query") and fails the whole lane.
  const defaultSinceMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  return async (args) => {
    if (args.lane === "text") {
      if (!args.textAllowed) {
        // Keep the messages budget's ultra/unlimited exemption.
        let tier: UserTier | undefined;
        // The caller's tier port: the public-mirror sync pins which files may reference userProfiles.
        try { tier = await getTier(); }
        catch { console.error("[searchMessageMatches] tier lookup failed, keeping budget skip"); }
        if (tier !== "ultra" && tier !== "unlimited") {
          args.messageLaneOutcome.bm25SkippedForBudget = true;
          if (tier) args.messageLaneOutcome.tier = tier;
          return { page: [], continueCursor: "", isDone: true };
        }
      }
      return ctx.runQuery(internal.crystal.messages.searchMessagePageForRecall, {
        userId, query: args.query, cursor: args.cursor, pageSize: args.pageSize,
      });
    }
    return ctx.runQuery(internal.crystal.messages.getRecallRecentMessagesPageForUser, {
      userId, cursor: args.cursor, pageSize: args.pageSize,
      channel: args.channel, sessionKey: args.sessionKey,
      sinceMs: args.sinceMs ?? defaultSinceMs,
      beforeMs: args.beforeMs,
    });
  };
}

/** Shared tier wiring keeps the adapter and message reader on the same port. */
export function createMessagePagePorts(ctx: ActionCtx, userId: string, getTier: () => Promise<UserTier>) {
  return { getTier, searchMessagePage: createMessagePageReader(ctx, userId, getTier) };
}
