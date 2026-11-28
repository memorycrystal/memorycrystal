import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { evaluateApiKeyInboundRotationIntegrity } from "./apiKeyRotationIntegrity";

type ApiKey = Doc<"crystalApiKeys">;
type DbCtx = Pick<MutationCtx, "db">;

/**
 * Claim the right to mutate one exact API-key scope.
 *
 * Convex mutations are serializable, so reading the active lease in the same
 * transaction as the key write makes this the fence for every key mutation,
 * not only for the file-rotation prepare call. Expired leases are released,
 * but their keys remain permanently protected because a stale filesystem
 * writer may still install the raw credential after expiry.
 */
export async function assertApiKeyScopeMutationAllowed(
  ctx: DbCtx,
  userId: string,
  label: string | undefined,
  now = Date.now(),
): Promise<void> {
  if (label === undefined) return;

  const rotations = await ctx.db
    .query("crystalApiKeyRotations")
    .withIndex("by_user_label", (q) =>
      q.eq("userId", userId).eq("label", label),
    )
    .collect();

  for (const rotation of rotations) {
    if (
      rotation.status === "prepared" &&
      rotation.leaseExpiresAt > now
    ) {
      throw new Error(
        "An API key rotation is already in progress for this user and label",
      );
    }
  }

  for (const rotation of rotations) {
    if (
      rotation.status === "prepared" &&
      rotation.leaseExpiresAt <= now
    ) {
      await ctx.db.patch(rotation._id, {
        status: "abandoned",
        abandonedAt: now,
      });
    }
  }
}

/**
 * Fail closed before any credential-state write when inbound rotation
 * integrity is not the safe ordinary or finalized-reciprocal shape.
 *
 * Uses `crystalApiKeyRotations.by_keyId` via the shared evaluator — never
 * `key.rotationId` alone — so prepared/cross-user/malformed inbound edges
 * cannot be stranded by revoke, regenerate, or scope deactivation.
 */
export async function assertApiKeyMayBeMutated(
  ctx: DbCtx,
  key: ApiKey,
): Promise<void> {
  const decision = await evaluateApiKeyInboundRotationIntegrity(ctx, key);
  if (decision.ok) return;

  if (
    decision.statusHint === "prepared" ||
    decision.statusHint === "abandoned"
  ) {
    throw new Error(
      "API key belongs to a prepared or abandoned rotation and is protected",
    );
  }
  throw new Error(
    `API key is protected by rotation integrity: ${decision.reason}`,
  );
}

/**
 * Fence both the key's current scope and a regeneration/move destination,
 * then reject direct mutation of a fail-safe prepared/abandoned credential
 * (and any other non-reciprocal inbound rotation graph).
 */
export async function assertApiKeyMutationAllowed(
  ctx: DbCtx,
  key: ApiKey,
  targetLabel: string | undefined = key.label,
): Promise<void> {
  await assertApiKeyScopeMutationAllowed(ctx, key.userId, key.label);
  if (targetLabel !== key.label) {
    await assertApiKeyScopeMutationAllowed(ctx, key.userId, targetLabel);
  }
  await assertApiKeyMayBeMutated(ctx, key);
}

/**
 * True when the key must not be deactivated or rewritten. Fail closed:
 * malformed, uncertain, prepared, abandoned, cross-user, or non-reciprocal
 * inbound state is protected (returns true).
 */
export async function isApiKeyProtectedFromMutation(
  ctx: DbCtx,
  key: ApiKey,
): Promise<boolean> {
  const decision = await evaluateApiKeyInboundRotationIntegrity(ctx, key);
  return !decision.ok;
}

/**
 * Immediate rotation may retire ordinary/finalized same-scope keys, but never
 * a credential that a prepared or abandoned filesystem writer can install,
 * nor any key whose inbound rotation graph is malformed.
 */
export async function deactivateUnprotectedApiKeysForScope(
  ctx: DbCtx,
  userId: string,
  label: string,
  exceptKeyId?: ApiKey["_id"],
): Promise<number> {
  await assertApiKeyScopeMutationAllowed(ctx, userId, label);
  const keys = await ctx.db
    .query("crystalApiKeys")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  let deactivated = 0;
  for (const key of keys) {
    if (
      key._id === exceptKeyId ||
      key.label !== label ||
      !key.active ||
      (await isApiKeyProtectedFromMutation(ctx, key))
    ) {
      continue;
    }
    await ctx.db.patch(key._id, { active: false });
    deactivated += 1;
  }
  return deactivated;
}
