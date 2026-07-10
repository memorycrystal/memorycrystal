import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

// Installer-only bridge. This must stay internal: self-hosted Convex RPC is
// commonly reachable from the local network, while `npx convex run` invokes
// this function with the generated deployment admin key.
export const upsertLocalInstallerApiKey = internalMutation({
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

    const profiles = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const profile = profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    const entitlement = {
      subscriptionStatus: "unlimited" as const,
      plan: "self_hosted_unmetered",
      capacityPolicy: "self_hosted_unmetered" as const,
      entitlementSource: "local_installer" as const,
      entitlementExpiresAt: undefined,
      entitlementGraceEndsAt: undefined,
      entitlementRevokedAt: undefined,
      entitlementUpdatedAt: now,
      updatedAt: now,
    };
    if (profile) {
      await ctx.db.patch(profile._id, entitlement);
    } else {
      await ctx.db.insert("crystalUserProfiles", {
        userId,
        ...entitlement,
        roles: ["subscriber"],
        createdAt: now,
      });
    }

    const bootstrap = await ctx.db
      .query("bootstrapState")
      .withIndex("by_marker", (q) => q.eq("marker", "singleton"))
      .unique();
    if (bootstrap) {
      await ctx.db.patch(bootstrap._id, {
        state: "ready",
        tenantId: bootstrap.tenantId ?? "local",
        tenantSlug: bootstrap.tenantSlug ?? "local",
        errorMessage: undefined,
      });
    } else {
      await ctx.db.insert("bootstrapState", {
        marker: "singleton",
        state: "ready",
        attemptCount: 0,
        tenantId: "local",
        tenantSlug: "local",
      });
    }

    const transportKey = await ctx.db
      .query("localApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
      .unique();
    if (transportKey?.revokedAt || transportKey?.cloudRevokedAt) {
      throw new Error("Local installer API key has been revoked; generate a new local key");
    }
    if (!transportKey) {
      await ctx.db.insert("localApiKeys", {
        keyHash,
        keyVersion: "local-v1",
        label: effectiveLabel,
        createdAt: now,
      });
    }

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
      if (existing.userId !== userId) {
        throw new Error("Local installer API key is already assigned to another user");
      }
      await ctx.db.patch(existing._id, {
        userId,
        label: existing.label ?? effectiveLabel,
        active: true,
      });
      return { id: existing._id, created: false, capacityPolicy: "self_hosted_unmetered" };
    }

    const id = await ctx.db.insert("crystalApiKeys", {
      userId,
      keyHash,
      label: effectiveLabel,
      createdAt: now,
      active: true,
    });
    return { id, created: true, capacityPolicy: "self_hosted_unmetered" };
  },
});
