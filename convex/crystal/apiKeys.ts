import { stableUserId } from "./auth";
import { internal } from "../_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { v } from "convex/values";
import { resolveEffectiveUserId } from "./impersonation";
import {
  assertApiKeyMutationAllowed,
  assertApiKeyScopeMutationAllowed,
  deactivateUnprotectedApiKeysForScope,
  isApiKeyProtectedFromMutation,
} from "./apiKeyRotationGuards";
import { assertSingleKeySafeToDelete } from "./apiKeyRotationIntegrity";

export const LAST_USED_AT_FRESHNESS_SLA_MS = 60 * 60 * 1000;
export const API_KEY_ROTATION_LEASE_MS = 15 * 60 * 1000;

const researchCapability = v.union(
  v.literal("research:read"),
  v.literal("research:ingest"),
  v.literal("research:promote"),
  v.literal("research:admin"),
);

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    await ctx.runMutation(
      internal.crystal.userProfiles.ensureProfileForUserInternal,
      {
        userId,
        email: identity.email ?? undefined,
      },
    );
    await assertApiKeyScopeMutationAllowed(ctx, userId, label);
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
    await assertApiKeyMutationAllowed(ctx, key);
    await ctx.db.patch(keyId, { active: false });
    if (userId !== actorUserId) {
      await ctx.runMutation(internal.crystal.mcp.writeAuditLog, {
        userId: actorUserId,
        keyHash: "dashboard",
        action: "impersonation_write_api_key_revoke",
        ts: Date.now(),
        actorUserId,
        effectiveUserId: userId,
        targetUserId: userId,
        targetType: "api_key",
        targetId: keyId,
      });
    }
  },
});

export const regenerateApiKey = mutation({
  args: {
    oldKeyId: v.id("crystalApiKeys"),
    label: v.optional(v.string()),
    asUserId: v.optional(v.string()),
  },
  handler: async (ctx, { oldKeyId, label, asUserId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const actorUserId = stableUserId(identity.subject);
    const userId = await resolveEffectiveUserId(ctx, actorUserId, asUserId);
    await ctx.runMutation(
      internal.crystal.userProfiles.ensureProfileForUserInternal,
      {
        userId,
        email: identity.email ?? undefined,
      },
    );

    const oldKey = await ctx.db.get(oldKeyId);
    if (!oldKey || oldKey.userId !== userId) throw new Error("Not found");
    const effectiveLabel = label ?? oldKey.label;
    await assertApiKeyMutationAllowed(ctx, oldKey, effectiveLabel);

    const rawKey = generateKey();
    const keyHash = await sha256Hex(rawKey);
    await ctx.db.patch(oldKeyId, {
      keyHash,
      label: effectiveLabel,
      createdAt: Date.now(),
      lastUsedAt: undefined,
      active: true,
      rotationId: undefined,
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
    const now = Date.now();
    const key = await ctx.db
      .query("crystalApiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
      .first();
    if (!key) return;
    if (key.lastUsedAt && now - key.lastUsedAt < LAST_USED_AT_FRESHNESS_SLA_MS)
      return;
    await ctx.db.patch(key._id, { lastUsedAt: now });
  },
});

export const provisionScopedResearchKeyInternal = internalMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    capabilities: v.array(researchCapability),
    boundWorkspaceId: v.optional(v.string()),
    boundAgentId: v.optional(v.string()),
    boundChannel: v.optional(v.string()),
    boundCollectionIds: v.optional(v.array(v.id("crystalResearchCollections"))),
  },
  handler: async (ctx, args) => {
    if (process.env.CRYSTAL_BACKEND !== "local") {
      throw new Error("Scoped research handoff keys may only be provisioned by the local backend");
    }
    if (args.capabilities.length === 0) throw new Error("At least one research capability is required");
    const capabilities = [...new Set(args.capabilities)];
    for (const collectionId of args.boundCollectionIds ?? []) {
      const collection = await ctx.db.get(collectionId);
      if (!collection || collection.userId !== args.userId) throw new Error("Bound research collection not found");
      if (args.boundWorkspaceId !== undefined && collection.workspaceId !== args.boundWorkspaceId) {
        throw new Error("Bound collection workspace does not match the credential scope");
      }
      if (args.boundAgentId !== undefined && collection.agentId !== args.boundAgentId) {
        throw new Error("Bound collection agent does not match the credential scope");
      }
      if (args.boundChannel !== undefined && collection.channel !== args.boundChannel) {
        throw new Error("Bound collection channel does not match the credential scope");
      }
    }
    await assertApiKeyScopeMutationAllowed(ctx, args.userId, args.label);
    await deactivateUnprotectedApiKeysForScope(ctx, args.userId, args.label);
    const rawKey = generateKey();
    const keyHash = await sha256Hex(rawKey);
    const keyId = await ctx.db.insert("crystalApiKeys", {
      userId: args.userId,
      keyHash,
      label: args.label,
      capabilities,
      boundWorkspaceId: args.boundWorkspaceId,
      boundAgentId: args.boundAgentId,
      boundChannel: args.boundChannel,
      boundCollectionIds: args.boundCollectionIds,
      immutableScope: true,
      createdAt: Date.now(),
      active: true,
    });
    return { keyId, rawKey };
  },
});

/**
 * Prepare an overlapping API key for failure-safe multi-target rotation.
 *
 * One transactionally observed lease serializes each user+label scope. Prior
 * same-label keys intentionally remain active. If a lease expires, the next
 * prepare marks it abandoned but never revokes its key: a stale host may still
 * install that key, so availability requires permanent overlap until a human
 * can prove the stale writer and every consumer are gone.
 */
export const prepareApiKeyRotationForUserInternal = internalMutation({
  args: {
    userId: v.string(),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = args.userId.trim();
    const label = args.label.trim();
    if (!userId) throw new Error("userId is required");
    if (!label) throw new Error("label is required (identifies the consumer)");

    const profile = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!profile) {
      throw new Error(
        `No crystalUserProfiles row for userId "${userId}" — refusing to mint a key for an unknown account`,
      );
    }

    const now = Date.now();
    await assertApiKeyScopeMutationAllowed(ctx, userId, label, now);

    const rawKey = generateKey();
    const keyHash = await sha256Hex(rawKey);
    const rotationNonce = generateKey();
    const nonceHash = await sha256Hex(rotationNonce);
    const keyId = await ctx.db.insert("crystalApiKeys", {
      userId,
      keyHash,
      label,
      createdAt: now,
      active: true,
    });
    const rotationId = await ctx.db.insert("crystalApiKeyRotations", {
      userId,
      label,
      keyId,
      nonceHash,
      status: "prepared",
      createdAt: now,
      leaseExpiresAt: now + API_KEY_ROTATION_LEASE_MS,
    });
    await ctx.db.patch(keyId, { rotationId });
    return {
      keyId,
      rawKey,
      rotationId,
      rotationNonce,
      leaseExpiresAt: now + API_KEY_ROTATION_LEASE_MS,
    };
  },
});

/**
 * Complete a prepared rotation after every destination contains the new key.
 * Deactivation is constrained to active keys with the same user and label; the
 * prepared key itself must still be active and match that exact scope.
 */
export const finalizeApiKeyRotationForUserInternal = internalMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    keyId: v.id("crystalApiKeys"),
    rotationId: v.id("crystalApiKeyRotations"),
    rotationNonce: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = args.userId.trim();
    const label = args.label.trim();
    if (!userId) throw new Error("userId is required");
    if (!label) throw new Error("label is required (identifies the consumer)");

    const profile = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!profile) {
      throw new Error(
        `No crystalUserProfiles row for userId "${userId}" — refusing to finalize a rotation for an unknown account`,
      );
    }

    const rotation = await ctx.db.get(args.rotationId);
    const nonceHash = await sha256Hex(args.rotationNonce);
    if (
      !rotation ||
      rotation.userId !== userId ||
      rotation.label !== label ||
      rotation.keyId !== args.keyId ||
      rotation.nonceHash !== nonceHash
    ) {
      throw new Error("Rotation ownership does not match the requested scope");
    }
    if (rotation.status === "finalized") {
      return { deactivated: 0, alreadyFinalized: true };
    }
    if (rotation.status === "abandoned" || rotation.leaseExpiresAt <= Date.now()) {
      throw new Error("API key rotation lease expired; the prepared key remains active");
    }

    const prepared = await ctx.db.get(args.keyId);
    if (
      !prepared ||
      !prepared.active ||
      prepared.userId !== userId ||
      prepared.label !== label ||
      prepared.rotationId !== args.rotationId
    ) {
      throw new Error("Prepared API key does not match the requested rotation scope");
    }

    const prior = await ctx.db
      .query("crystalApiKeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    let deactivated = 0;
    for (const key of prior) {
      if (
        key._id !== args.keyId &&
        key.label === label &&
        key.active &&
        !(await isApiKeyProtectedFromMutation(ctx, key))
      ) {
        await ctx.db.patch(key._id, { active: false });
        deactivated += 1;
      }
    }
    await ctx.db.patch(rotation._id, {
      status: "finalized",
      finalizedAt: Date.now(),
    });
    return { deactivated, alreadyFinalized: false };
  },
});

/**
 * Mint an API key for an explicit user from an admin/CLI context (ILL-135).
 *
 * The public `createApiKey` requires a JWT identity, so `npx convex run` — which
 * authenticates with the deployment admin key and carries NO user identity —
 * cannot call it. `provisionScopedResearchKeyInternal` can mint but is hard
 * gated to the local backend. This fills the gap for operational key rotation:
 * internal-only (never reachable over HTTP) with no identity requirement.
 *
 * This immediate-deactivation mutation is retained for non-file consumers that
 * can install the returned key atomically. Multi-target file rotation must use
 * prepareApiKeyRotationForUserInternal plus finalizeApiKeyRotationForUserInternal.
 * The raw key is returned exactly once and is never stored or logged.
 */
export const mintApiKeyForUserInternal = internalMutation({
  args: {
    userId: v.string(),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = args.userId.trim();
    const label = args.label.trim();
    if (!userId) throw new Error("userId is required");
    if (!label) throw new Error("label is required (identifies the consumer)");

    // Refuse to mint for an account that does not exist. Without this a typo'd
    // userId yields a perfectly valid credential bound to nobody: requireAuth
    // resolves the hash, reads return empty, and a smoke test asserting only
    // "HTTP 200" cannot tell a good rotation from a mistyped one.
    const profile = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!profile) {
      throw new Error(
        `No crystalUserProfiles row for userId "${userId}" — refusing to mint a key for an unknown account`,
      );
    }

    await assertApiKeyScopeMutationAllowed(ctx, userId, label);
    const deactivated = await deactivateUnprotectedApiKeysForScope(
      ctx,
      userId,
      label,
    );

    const rawKey = generateKey();
    const keyHash = await sha256Hex(rawKey);
    const keyId = await ctx.db.insert("crystalApiKeys", {
      userId,
      keyHash,
      label,
      createdAt: Date.now(),
      active: true,
    });
    // rawKey is returned once; the caller writes it straight into its env file.
    return { keyId, rawKey, deactivated };
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
    await assertApiKeyMutationAllowed(ctx, key);
    // Fail closed on cross-user / non-reciprocal inbound rotations; delete a
    // same-owner finalized reciprocal rotation together with the key.
    const pairedRotation = await assertSingleKeySafeToDelete(ctx, key);
    if (pairedRotation) {
      await ctx.db.delete(pairedRotation._id);
    }
    await ctx.db.delete(keyId);
    if (userId !== actorUserId) {
      await ctx.runMutation(internal.crystal.mcp.writeAuditLog, {
        userId: actorUserId,
        keyHash: "dashboard",
        action: "impersonation_write_api_key_delete",
        ts: Date.now(),
        actorUserId,
        effectiveUserId: userId,
        targetUserId: userId,
        targetType: "api_key",
        targetId: keyId,
      });
    }
  },
});
