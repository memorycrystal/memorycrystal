import { v } from "convex/values";
import { mutation } from "../_generated/server";

export const upsertLocalInstallerApiKey = mutation({
  args: {
    userId: v.string(),
    keyHash: v.string(),
    label: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { userId, keyHash, label, now }) => {
    if (process.env.CRYSTAL_BACKEND !== "local") {
      throw new Error("Local installer API key import is only available when CRYSTAL_BACKEND=local");
    }

    const effectiveLabel = label ?? "local installer";

    const existing = await ctx.db
      .query("crystalApiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
      .first();

    // Archive any prior installer rows for this user with the same label so
    // a re-run of the installer doesn't accumulate orphaned active keys
    // (15h review US-10). The current keyHash row is exempt — it gets patched
    // back to active below.
    const priorInstallerRows = await ctx.db
      .query("crystalApiKeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of priorInstallerRows) {
      if ((row.label ?? "") !== effectiveLabel) continue;
      if (existing && row._id === existing._id) continue;
      if (row.active) await ctx.db.patch(row._id, { active: false });
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        userId,
        label: existing.label ?? effectiveLabel,
        active: true,
      });
      return { id: existing._id, created: false };
    }

    const id = await ctx.db.insert("crystalApiKeys", {
      userId,
      keyHash,
      label: effectiveLabel,
      createdAt: now,
      active: true,
    });
    return { id, created: true };
  },
});
