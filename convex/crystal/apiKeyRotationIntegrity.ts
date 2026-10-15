/**
 * Bidirectional API-key / rotation integrity for account-merge, delete, and
 * ordinary API-key mutation paths.
 *
 * Finalized rotations may be re-homed or deleted only when every source
 * key↔rotation edge is reciprocal and user/label ownership matches. Orphan,
 * mismatched, prepared, abandoned, duplicate, or cross-user inbound
 * relationships fail closed before any write.
 *
 * Mutation/deactivation guards share {@link evaluateApiKeyInboundRotationIntegrity}
 * so inbound `by_keyId` edges cannot bypass protection that only followed
 * `key.rotationId`.
 */

type DbGet = { get: (id: any) => Promise<any> };
// Structural typing against Convex GenericDatabaseWriter is intentionally
// loose here — callers pass real mutation contexts; the helpers only use
// get / query(...).withIndex(...).collect().
type DbCtx = { db: DbGet };
type DbQueryCtx = { db: any };

/**
 * Canonical inbound-integrity decision for a single API key.
 *
 * Mutation/deactivation is permitted only when either:
 *  1. no inbound rotation exists and `key.rotationId` is absent; or
 *  2. exactly one inbound rotation exists and it is same-user, same-label,
 *     finalized, and reciprocal (`rotation.keyId === key._id` and
 *     `key.rotationId === rotation._id`).
 *
 * Everything else fails closed (duplicate inbound, cross-user, prepared/
 * abandoned, missing/non-reciprocal IDs, user/label mismatch, key-only
 * rotationId, rotation-only keyId).
 */
export type ApiKeyInboundIntegrityDecision =
  | { ok: true; kind: "none" }
  | { ok: true; kind: "finalized_reciprocal"; rotation: any }
  | { ok: false; reason: string; statusHint?: "prepared" | "abandoned" | "other" };

export async function evaluateApiKeyInboundRotationIntegrity(
  ctx: DbQueryCtx,
  key: any,
): Promise<ApiKeyInboundIntegrityDecision> {
  const keyId = String(key._id);
  const inbound = await ctx.db
    .query("crystalApiKeyRotations")
    .withIndex("by_keyId", (q: any) => q.eq("keyId", key._id))
    .collect();

  if (inbound.length > 1) {
    return {
      ok: false,
      reason: `key ${keyId} is referenced by multiple rotations`,
      statusHint: "other",
    };
  }

  if (inbound.length === 0) {
    if (key.rotationId) {
      return {
        ok: false,
        reason: `key ${keyId} points to rotation ${String(key.rotationId)} with no inbound edge`,
        statusHint: "other",
      };
    }
    return { ok: true, kind: "none" };
  }

  const rotation = inbound[0];
  const rotationId = String(rotation._id);

  if (String(key.rotationId ?? "") !== rotationId) {
    return {
      ok: false,
      reason: `key ${keyId} / rotation ${rotationId} reciprocal mismatch`,
      statusHint:
        rotation.status === "prepared" || rotation.status === "abandoned"
          ? rotation.status
          : "other",
    };
  }

  // by_keyId should guarantee this, but fail closed if the edge is corrupted.
  if (String(rotation.keyId ?? "") !== keyId) {
    return {
      ok: false,
      reason: `key ${keyId} / rotation ${rotationId} reciprocal mismatch`,
      statusHint: "other",
    };
  }

  if (String(rotation.userId) !== String(key.userId)) {
    return {
      ok: false,
      reason: `key ${keyId} is referenced by cross-user rotation ${rotationId}`,
      statusHint:
        rotation.status === "prepared" || rotation.status === "abandoned"
          ? rotation.status
          : "other",
    };
  }

  if (String(rotation.label ?? "") !== String(key.label ?? "")) {
    return {
      ok: false,
      reason: `key ${keyId} and rotation ${rotationId} label mismatch`,
      statusHint: "other",
    };
  }

  if (rotation.status !== "finalized") {
    return {
      ok: false,
      reason: `key ${keyId} is referenced by ${rotation.status} rotation ${rotationId}`,
      statusHint:
        rotation.status === "prepared" || rotation.status === "abandoned"
          ? rotation.status
          : "other",
    };
  }

  return { ok: true, kind: "finalized_reciprocal", rotation };
}

export type MergeRotationIntegrityArgs = {
  sourceUserId: string;
  sourceKeys: any[];
  sourceRotations: any[];
  /** Wording for errors: "merge" (default) or "delete". */
  operation?: "merge" | "delete";
};

/**
 * Validate the complete bidirectional graph for credentials about to move
 * or be deleted. Throws before the caller performs any write so the Convex
 * transaction stays atomic on the pre-change state.
 */
export async function assertSourceRotationIntegrityForMerge(
  ctx: DbCtx,
  args: MergeRotationIntegrityArgs,
): Promise<void> {
  const { sourceUserId, sourceKeys, sourceRotations } = args;
  const op = args.operation === "delete" ? "delete" : "merge";
  const refuse = (detail: string) =>
    new Error(`Refusing to ${op}: ${detail}`);

  const keysById = new Map<string, any>();
  for (const key of sourceKeys) {
    keysById.set(String(key._id), key);
  }

  const rotationsById = new Map<string, any>();
  for (const rotation of sourceRotations) {
    const id = String(rotation._id);
    if (rotationsById.has(id)) {
      throw refuse(`duplicate source rotation ownership for ${id}`);
    }
    rotationsById.set(id, rotation);
  }

  // Every source rotation must resolve to a reciprocal, same-owner key.
  for (const rotation of sourceRotations) {
    const rotationId = String(rotation._id);
    if (rotation.status !== "finalized") {
      throw refuse(`source rotation ${rotationId} is ${rotation.status}`);
    }
    if (String(rotation.userId) !== String(sourceUserId)) {
      throw refuse(`source rotation ${rotationId} user mismatch`);
    }
    if (!rotation.keyId) {
      throw refuse(`source rotation ${rotationId} has no keyId`);
    }

    const keyId = String(rotation.keyId);
    let key = keysById.get(keyId);
    if (!key) {
      key = await ctx.db.get(rotation.keyId);
    }
    if (!key) {
      throw refuse(
        `source rotation ${rotationId} points to missing key ${keyId}`,
      );
    }

    if (String(key.rotationId ?? "") !== rotationId) {
      throw refuse(
        `rotation ${rotationId} / key ${keyId} reciprocal mismatch`,
      );
    }
    if (String(key.userId) !== String(sourceUserId)) {
      throw refuse(
        `key ${keyId} user does not match source rotation ownership`,
      );
    }
    if (String(key.userId) !== String(rotation.userId)) {
      throw refuse(
        `key ${keyId} and rotation ${rotationId} user mismatch`,
      );
    }
    if (String(key.label ?? "") !== String(rotation.label ?? "")) {
      throw refuse(
        `key ${keyId} and rotation ${rotationId} label mismatch`,
      );
    }
  }

  // Every source key that claims a rotation must resolve to a finalized
  // reciprocal rotation with matching ownership (catches orphan key→rotation).
  for (const key of sourceKeys) {
    const keyId = String(key._id);
    if (!key.rotationId) continue;

    const rotationId = String(key.rotationId);
    let rotation = rotationsById.get(rotationId);
    if (!rotation) {
      rotation = await ctx.db.get(key.rotationId);
    }
    if (!rotation) {
      throw refuse(
        `key ${keyId} points to missing rotation ${rotationId}`,
      );
    }
    if (rotation.status !== "finalized") {
      throw refuse(
        `key ${keyId} references ${rotation.status} rotation ${rotationId}`,
      );
    }
    if (String(rotation.keyId ?? "") !== keyId) {
      throw refuse(
        `key ${keyId} / rotation ${rotationId} reciprocal mismatch`,
      );
    }
    if (String(rotation.userId) !== String(key.userId)) {
      throw refuse(
        `key ${keyId} and rotation ${rotationId} user mismatch`,
      );
    }
    if (String(rotation.userId) !== String(sourceUserId)) {
      throw refuse(
        `rotation ${rotationId} user does not match source key ownership`,
      );
    }
    if (String(rotation.label ?? "") !== String(key.label ?? "")) {
      throw refuse(
        `key ${keyId} and rotation ${rotationId} label mismatch`,
      );
    }
  }
}

export type DeleteKeyRotationIntegrityArgs = {
  /** User whose keys/rotations are about to be deleted. */
  ownerUserId: string;
  keys: any[];
  /** Rotations owned by the target user that will be deleted in the same txn. */
  ownedRotations: any[];
};

/**
 * Fail closed before any key/user deletion when:
 *  - a non-finalized rotation is still owned by the target,
 *  - owned key↔rotation graphs are not reciprocal, or
 *  - any rotation (including cross-user) references a target key and is not
 *    exactly the target-owned reciprocal rotation that will be deleted too.
 *
 * Uses the by_keyId index on crystalApiKeyRotations.
 */
export async function assertKeysSafeToDeleteWithRotations(
  ctx: DbQueryCtx,
  args: DeleteKeyRotationIntegrityArgs,
): Promise<void> {
  const { ownerUserId, keys, ownedRotations } = args;

  // Non-finalized target-owned rotations are never safe to wipe mid-install.
  for (const rotation of ownedRotations) {
    if (rotation.status !== "finalized") {
      throw new Error(
        "Cannot delete user while a prepared or abandoned API key rotation exists",
      );
    }
  }

  // Owned graph must already be reciprocal (shared validator with merge).
  await assertSourceRotationIntegrityForMerge(ctx, {
    sourceUserId: ownerUserId,
    sourceKeys: keys,
    sourceRotations: ownedRotations,
    operation: "delete",
  });

  const allowedRotationIds = new Set(
    ownedRotations.map((rotation) => String(rotation._id)),
  );

  for (const key of keys) {
    const keyId = String(key._id);
    const inbound = await ctx.db
      .query("crystalApiKeyRotations")
      .withIndex("by_keyId", (q: any) => q.eq("keyId", key._id))
      .collect();

    if (inbound.length > 1) {
      throw new Error(
        `Refusing delete: key ${keyId} is referenced by multiple rotations`,
      );
    }

    if (inbound.length === 0) {
      // Ordinary key with no rotation is fine; orphan key→rotationId is not.
      if (key.rotationId) {
        throw new Error(
          `Refusing delete: key ${keyId} points to rotation ${String(key.rotationId)} with no inbound edge`,
        );
      }
      continue;
    }

    const rotation = inbound[0];
    const rotationId = String(rotation._id);

    // Only the exact target-owned reciprocal rotation that will be deleted
    // with this key is permitted. Cross-user or unlisted rotations fail closed.
    if (!allowedRotationIds.has(rotationId)) {
      throw new Error(
        `Refusing delete: key ${keyId} is referenced by rotation ${rotationId} that is not owned by the target user`,
      );
    }
    if (String(rotation.userId) !== String(ownerUserId)) {
      throw new Error(
        `Refusing delete: key ${keyId} is referenced by cross-user rotation ${rotationId}`,
      );
    }
    if (rotation.status !== "finalized") {
      throw new Error(
        `Refusing delete: key ${keyId} is referenced by ${rotation.status} rotation ${rotationId}`,
      );
    }
    if (String(key.rotationId ?? "") !== rotationId) {
      throw new Error(
        `Refusing delete: key ${keyId} / rotation ${rotationId} reciprocal mismatch`,
      );
    }
    if (String(key.label ?? "") !== String(rotation.label ?? "")) {
      throw new Error(
        `Refusing delete: key ${keyId} and rotation ${rotationId} label mismatch`,
      );
    }
  }
}

/**
 * Guard a single-key delete path against inbound rotation orphans.
 * Allowed when:
 *  - no rotation references the key, or
 *  - exactly one same-owner finalized reciprocal rotation will also be deleted.
 * Returns that rotation id (if any) so the caller can delete it in-txn.
 */
export async function assertSingleKeySafeToDelete(
  ctx: DbQueryCtx,
  key: any,
): Promise<any | null> {
  const keyId = String(key._id);
  const inbound = await ctx.db
    .query("crystalApiKeyRotations")
    .withIndex("by_keyId", (q: any) => q.eq("keyId", key._id))
    .collect();

  if (inbound.length > 1) {
    throw new Error(
      `Refusing delete: key ${keyId} is referenced by multiple rotations`,
    );
  }

  if (inbound.length === 0) {
    if (key.rotationId) {
      throw new Error(
        `Refusing delete: key ${keyId} points to rotation ${String(key.rotationId)} with no inbound edge`,
      );
    }
    return null;
  }

  const rotation = inbound[0];
  const rotationId = String(rotation._id);
  if (String(rotation.userId) !== String(key.userId)) {
    throw new Error(
      `Refusing delete: key ${keyId} is referenced by cross-user rotation ${rotationId}`,
    );
  }
  if (rotation.status !== "finalized") {
    throw new Error(
      `Refusing delete: key ${keyId} is referenced by ${rotation.status} rotation ${rotationId}`,
    );
  }
  if (String(key.rotationId ?? "") !== rotationId) {
    throw new Error(
      `Refusing delete: key ${keyId} / rotation ${rotationId} reciprocal mismatch`,
    );
  }
  if (String(key.label ?? "") !== String(rotation.label ?? "")) {
    throw new Error(
      `Refusing delete: key ${keyId} and rotation ${rotationId} label mismatch`,
    );
  }
  return rotation;
}
