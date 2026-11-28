import { agentStampKey } from "./agentStamp";

/**
 * First active row in index order (oldest first) whose stamp key equals the
 * write. The equal-key range is read to the end: other stamps are not a bound.
 * userId stays in the index prefix, so another user's row is never a match.
 */
export async function findSameStampExactDuplicate(
  ctx: any,
  args: {
    userId: string;
    contentHash: string;
    channel: string | undefined;
    stampKey: string | null;
  },
) {
  const matches = ctx.db
    .query("crystalMemories")
    .withIndex("by_user_content_hash_channel", (q: any) =>
      q
        .eq("userId", args.userId)
        .eq("contentHash", args.contentHash)
        .eq("channel", args.channel)
        .eq("archived", false),
    );
  for await (const doc of matches) {
    if (agentStampKey(doc.metadata) === args.stampKey) return doc;
  }
  return null;
}