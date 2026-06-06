/**
 * Tenant-local bearer-key store (M5 / R4 Option α).
 *
 * Queries and mutations consumed by:
 *   - mcp-server/src/middleware/bearer.ts  → `getByHash`, `markUsed`
 *   - convex/local/bootstrap.ts            → `seedFromBootstrap`
 *   - operator dashboard / dashboard CLI   → `revoke`
 *   - M6 cloud-heartbeat reconciliation    → `applyCloudRevocations`
 *
 * Storage rule (§6.5): cleartext bearer never lives in Convex; only sha256
 * of the bearer is persisted. Cleartext is read once at issuance and stored
 * in the operator's `.env`.
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";

/**
 * Look up a key by hash. Returns null when no row matches.
 *
 * Hot-path query — called per bearer-authenticated MCP request, so it must
 * stay on the `by_keyHash` index.
 */
export const getByHash = query({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const row = await ctx.db
      .query("localApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
      .unique();
    return row;
  },
});

/**
 * Update `lastUsedAt`. Fire-and-forget from the bearer middleware.
 * No-op if no row matches (defense against race with revoke).
 */
export const markUsed = mutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const row = await ctx.db
      .query("localApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, { lastUsedAt: Date.now() });
  },
});

/**
 * Local-side revocation. Sets `revokedAt = now` if not already revoked.
 * Idempotent.
 */
export const revoke = mutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const row = await ctx.db
      .query("localApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
      .unique();
    if (!row || row.revokedAt) return;
    await ctx.db.patch(row._id, { revokedAt: Date.now() });
  },
});

/**
 * Mirror cloud-side revocations. Called by M6's heartbeat handler with the
 * list of key hashes the cloud has marked revoked since the last heartbeat.
 * Sets `cloudRevokedAt = now` for any matching local rows.
 */
export const applyCloudRevocations = internalMutation({
  args: { revokedHashes: v.array(v.string()) },
  handler: async (ctx, { revokedHashes }) => {
    const now = Date.now();
    let applied = 0;
    for (const keyHash of revokedHashes) {
      const row = await ctx.db
        .query("localApiKeys")
        .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
        .unique();
      if (!row || row.cloudRevokedAt) continue;
      await ctx.db.patch(row._id, { cloudRevokedAt: now });
      applied += 1;
    }
    return { applied };
  },
});

/**
 * Atomic seed used by `convex/local/bootstrap.ts:fetchInitialState`.
 * Idempotent on `keyHash`: existing rows are skipped.
 */
export const seedFromBootstrap = internalMutation({
  args: {
    apiKeys: v.array(
      v.object({
        keyHash: v.string(),
        keyVersion: v.string(),
        label: v.optional(v.string()),
        createdAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, { apiKeys }) => {
    let inserted = 0;
    for (const key of apiKeys) {
      const existing = await ctx.db
        .query("localApiKeys")
        .withIndex("by_keyHash", (q) => q.eq("keyHash", key.keyHash))
        .unique();
      if (existing) continue;
      await ctx.db.insert("localApiKeys", {
        keyHash: key.keyHash,
        keyVersion: key.keyVersion,
        label: key.label,
        createdAt: key.createdAt,
      });
      inserted += 1;
    }
    return { inserted };
  },
});
