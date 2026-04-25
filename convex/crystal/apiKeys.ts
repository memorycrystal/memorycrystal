import { stableUserId } from "./auth";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { resolveEffectiveUserId } from "./impersonation";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const createApiKey = mutation({
  args: { label: v.optional(v.string()), asUserId: v.optional(v.string()) },
  handler: async (ctx, { label, asUserId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const actorUserId = stableUserId(identity.subject);
    const userId = await resolveEffectiveUserId(ctx, actorUserId, asUserId);
    await ctx.runMutation(internal.crystal.userProfiles.ensureProfileForUserInternal, {
      userId,
      email: identity.email ?? undefined,
    });
    const rawKey = generateKey();
    const keyHash = await sha256Hex(rawKey);
    await ctx.db.insert("crystalApiKeys", {
      userId,
      keyHash,
      label,
      createdAt: Date.now(),
      active: true,
    });
    if (userId !== actorUserId) {
      await ctx.runMutation(internal.crystal.mcp.writeAuditLog, {
        userId: actorUserId,
        keyHash: "dashboard",
        action: "impersonation_write_api_key_create",
        ts: Date.now(),
        actorUserId,
        effectiveUserId: userId,
        targetUserId: userId,
        meta: JSON.stringify({ label: label ?? null }),
      });
    }
    return rawKey; // only time raw key is returned
  },
});

export const listApiKeys = query({
  args: { asUserId: v.optional(v.string()) },
  handler: async (ctx, { asUserId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const actorUserId = stableUserId(identity.subject);
    const userId = await resolveEffectiveUserId(ctx, actorUserId, asUserId);
    const keys = await ctx.db
      .query("crystalApiKeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return keys.map(({ keyHash: _kh, ...rest }) => rest);
  },
});

export const revokeApiKey = mutation({
  args: { keyId: v.id("crystalApiKeys"), asUserId: v.optional(v.string()) },
  handler: async (ctx, { keyId, asUserId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const actorUserId = stableUserId(identity.subject);
    const userId = await resolveEffectiveUserId(ctx, actorUserId, asUserId);
    const key = await ctx.db.get(keyId);
    if (!key || key.userId !== userId) throw new Error("Not found");
    await ctx.db.patch(keyId, { active: false });
    if (userId !== actorUserId) {
      await ctx.runMutation(internal.crystal.mcp.writeAuditLog, {
        userId: actorUserId, keyHash: "dashboard", action: "impersonation_write_api_key_revoke", ts: Date.now(), actorUserId, effectiveUserId: userId, targetUserId: userId, targetType: "api_key", targetId: keyId,
      });
    }
  },
});

export const regenerateApiKey = mutation({
  args: { oldKeyId: v.id("crystalApiKeys"), label: v.optional(v.string()), asUserId: v.optional(v.string()) },
  handler: async (ctx, { oldKeyId, label, asUserId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const actorUserId = stableUserId(identity.subject);
    const userId = await resolveEffectiveUserId(ctx, actorUserId, asUserId);
    await ctx.runMutation(internal.crystal.userProfiles.ensureProfileForUserInternal, {
      userId,
      email: identity.email ?? undefined,
    });

    const oldKey = await ctx.db.get(oldKeyId);
    if (!oldKey || oldKey.userId !== userId) throw new Error("Not found");

    const rawKey = generateKey();
    const keyHash = await sha256Hex(rawKey);
    await ctx.db.patch(oldKeyId, {
      keyHash,
      label: label ?? oldKey.label,
      createdAt: Date.now(),
      lastUsedAt: undefined,
      active: true,
    });

    if (userId !== actorUserId) {
      await ctx.runMutation(internal.crystal.mcp.writeAuditLog, {
        userId: actorUserId,
        keyHash: "dashboard",
        action: "impersonation_write_api_key_regenerate",
        ts: Date.now(),
        actorUserId,
        effectiveUserId: userId,
        targetUserId: userId,
        targetType: "api_key",
        targetId: oldKeyId,
      });
    }

    return rawKey;
  },
});

export const validateApiKey = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const key = await ctx.db
      .query("crystalApiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
      .first();
    if (!key || !key.active) return null;
    if (key.expiresAt && key.expiresAt < Date.now()) return null;
    return key.userId;
  },
});

export const touchLastUsedAt = internalMutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const key = await ctx.db
      .query("crystalApiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
      .first();
    if (!key) return;
    await ctx.db.patch(key._id, { lastUsedAt: Date.now() });
  },
});

export const deleteApiKey = mutation({
  args: { keyId: v.id("crystalApiKeys"), asUserId: v.optional(v.string()) },
  handler: async (ctx, { keyId, asUserId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const actorUserId = stableUserId(identity.subject);
    const userId = await resolveEffectiveUserId(ctx, actorUserId, asUserId);
    const key = await ctx.db.get(keyId);
    if (!key || key.userId !== userId) throw new Error("Key not found");
    await ctx.db.delete(keyId);
    if (userId !== actorUserId) {
      await ctx.runMutation(internal.crystal.mcp.writeAuditLog, {
        userId: actorUserId, keyHash: "dashboard", action: "impersonation_write_api_key_delete", ts: Date.now(), actorUserId, effectiveUserId: userId, targetUserId: userId, targetType: "api_key", targetId: keyId,
      });
    }
  },
});
