import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import {
  assertApiKeyMutationAllowed,
  assertApiKeyScopeMutationAllowed,
} from "./apiKeyRotationGuards";
import { assertSourceRotationIntegrityForMerge } from "./apiKeyRotationIntegrity";

/**
 * Guarded merge tooling for duplicate-identity `users` rows (ILL-94).
 *
 * This is deliberately SEPARATE from `accountEmailRepair.ts` (which retargets an
 * account's email address). This module answers a different question: "two
 * `users` rows exist for one human — collapse them into one without losing
 * their API keys or auth accounts."
 *
 * Two entry points:
 *  - `inventoryDuplicateEmails` (internalQuery, read-only): iterate the `users`
 *    table — NOT `crystalUserProfiles` (prod has more `users` rows than
 *    profiles, so a profile-based scan under-reports) — and list every email
 *    with more than one `users` row.
 *  - `mergeDuplicateUsers` (internalMutation): collapse a `source` row into an
 *    `expectedSurvivingUserId`. DEFAULTS TO DRY-RUN. Applying requires an
 *    explicit confirm token. It re-points `crystalApiKeys.userId` AND
 *    `authAccounts.userId` from source→survivor BEFORE deleting the source row
 *    (atomically — a Convex mutation is one transaction), and REFUSES when
 *    either row holds memories/messages, or when the source carries Polar
 *    billing linkage. Silently deleting a `users` row while leaving its API
 *    keys pointing at it is exactly the outcome this tool forbids.
 */

const MERGE_CONFIRM = "MERGE_DUPLICATE_USERS";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function userHasMemories(ctx: any, userId: string): Promise<boolean> {
  const rows = await ctx.db
    .query("crystalMemories")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .take(1);
  return rows.length > 0;
}

async function userHasMessages(ctx: any, userId: string): Promise<boolean> {
  const rows = await ctx.db
    .query("crystalMessages")
    .withIndex("by_user_time", (q: any) => q.eq("userId", userId))
    .take(1);
  return rows.length > 0;
}

async function apiKeysForUser(ctx: any, userId: string): Promise<any[]> {
  return await ctx.db
    .query("crystalApiKeys")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
}

async function authAccountsForUser(ctx: any, userId: string): Promise<any[]> {
  return await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q: any) => q.eq("userId", userId as any))
    .collect();
}

async function authSessionsForUser(ctx: any, userId: string): Promise<any[]> {
  return await ctx.db
    .query("authSessions")
    .withIndex("userId", (q: any) => q.eq("userId", userId as any))
    .collect();
}

async function profilesForUser(ctx: any, userId: string): Promise<any[]> {
  return await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
}

function hasPolarLinkage(profiles: any[]): boolean {
  return profiles.some(
    (profile: any) => Boolean(profile.polarCustomerId || profile.polarSubscriptionId),
  );
}

export const inventoryDuplicateEmails = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();

    const byEmail = new Map<string, Array<{ userId: string; creationTime: number }>>();
    let usersWithoutEmail = 0;
    for (const user of users) {
      const rawEmail = (user as any).email;
      if (typeof rawEmail !== "string" || rawEmail.trim() === "") {
        usersWithoutEmail += 1;
        continue;
      }
      const email = normalizeEmail(rawEmail);
      const bucket = byEmail.get(email) ?? [];
      bucket.push({ userId: String(user._id), creationTime: user._creationTime });
      byEmail.set(email, bucket);
    }

    const duplicates = [] as Array<{
      email: string;
      count: number;
      userIds: string[];
    }>;
    for (const [email, rows] of byEmail) {
      if (rows.length > 1) {
        duplicates.push({
          email,
          count: rows.length,
          // Oldest first — a natural default surviving candidate.
          userIds: rows
            .sort((a, b) => a.creationTime - b.creationTime)
            .map((row) => row.userId),
        });
      }
    }
    duplicates.sort((a, b) => b.count - a.count);

    return {
      totalUsers: users.length,
      distinctEmails: byEmail.size,
      usersWithoutEmail,
      duplicateEmailCount: duplicates.length,
      duplicates,
    };
  },
});

async function buildMergePlan(
  ctx: any,
  args: { sourceUserId: string; expectedSurvivingUserId: string },
) {
  if (args.sourceUserId === args.expectedSurvivingUserId) {
    throw new Error("sourceUserId and expectedSurvivingUserId must be different");
  }

  const source = await ctx.db.get(args.sourceUserId as any);
  if (!source) {
    throw new Error(`Source user ${args.sourceUserId} was not found in this deployment`);
  }
  const survivor = await ctx.db.get(args.expectedSurvivingUserId as any);
  if (!survivor) {
    throw new Error(
      `Expected surviving user ${args.expectedSurvivingUserId} was not found in this deployment`,
    );
  }

  // Safety: only merge rows that share a normalized email. This tool exists to
  // collapse duplicate-EMAIL identities, not to fuse two unrelated accounts.
  const sourceEmail =
    typeof (source as any).email === "string" ? normalizeEmail((source as any).email) : null;
  const survivorEmail =
    typeof (survivor as any).email === "string"
      ? normalizeEmail((survivor as any).email)
      : null;
  if (!sourceEmail || !survivorEmail || sourceEmail !== survivorEmail) {
    throw new Error(
      `Refusing to merge: source (${sourceEmail ?? "no email"}) and survivor ` +
        `(${survivorEmail ?? "no email"}) do not share the same normalized email`,
    );
  }

  // Refuse when EITHER row holds memory/message data. A data-bearing merge needs
  // a full N-table userId rewrite, which this narrow tool intentionally does not
  // perform. Grow the tool before merging data-rich rows.
  const [
    sourceHasMemories,
    sourceHasMessages,
    survivorHasMemories,
    survivorHasMessages,
  ] = await Promise.all([
    userHasMemories(ctx, args.sourceUserId),
    userHasMessages(ctx, args.sourceUserId),
    userHasMemories(ctx, args.expectedSurvivingUserId),
    userHasMessages(ctx, args.expectedSurvivingUserId),
  ]);
  if (sourceHasMemories || sourceHasMessages) {
    throw new Error(
      `Refusing to merge: source user ${args.sourceUserId} holds memory/message data ` +
        `(memories=${sourceHasMemories}, messages=${sourceHasMessages})`,
    );
  }
  if (survivorHasMemories || survivorHasMessages) {
    throw new Error(
      `Refusing to merge: surviving user ${args.expectedSurvivingUserId} holds ` +
        `memory/message data (memories=${survivorHasMemories}, messages=${survivorHasMessages})`,
    );
  }

  // Refuse when the SOURCE carries Polar billing linkage — a billing-linked row
  // must never be a merge source (it can only ever be a destination).
  const sourceProfiles = await profilesForUser(ctx, args.sourceUserId);
  if (hasPolarLinkage(sourceProfiles)) {
    throw new Error(
      `Refusing to merge: source user ${args.sourceUserId} carries Polar billing ` +
        `linkage (polarCustomerId/polarSubscriptionId); billing-linked rows are ` +
        `merge-destination-only`,
    );
  }

  const sourceApiKeys = await apiKeysForUser(ctx, args.sourceUserId);
  const sourceAuthAccounts = await authAccountsForUser(ctx, args.sourceUserId);
  const sourceAuthSessions = await authSessionsForUser(ctx, args.sourceUserId);
  const sourceRotations = await ctx.db
    .query("crystalApiKeyRotations")
    .withIndex("by_user_label", (q: any) => q.eq("userId", args.sourceUserId))
    .collect();
  const survivorRotations = await ctx.db
    .query("crystalApiKeyRotations")
    .withIndex("by_user_label", (q: any) =>
      q.eq("userId", args.expectedSurvivingUserId),
    )
    .collect();

  // Same fence as mergeAccountsByEmail / deleteUserByEmail: a prepared or
  // abandoned rotation credential is never safe to re-home or delete.
  const unsafeSource = sourceRotations.find(
    (rotation: any) => rotation.status !== "finalized",
  );
  if (unsafeSource) {
    throw new Error(
      `Refusing to merge: source user ${args.sourceUserId} has a ` +
        `${unsafeSource.status} API key rotation; resolve it before merging`,
    );
  }
  const activeDest = survivorRotations.find(
    (rotation: any) => rotation.status === "prepared",
  );
  if (activeDest) {
    throw new Error(
      `Refusing to merge: surviving user ${args.expectedSurvivingUserId} has an ` +
        `in-progress API key rotation for label "${activeDest.label}"`,
    );
  }

  return {
    email: sourceEmail,
    source: { userId: args.sourceUserId },
    survivor: { userId: args.expectedSurvivingUserId },
    operations: {
      repointApiKeyIds: sourceApiKeys.map((key: any) => String(key._id)),
      repointRotationIds: sourceRotations.map((rotation: any) => String(rotation._id)),
      repointAuthAccountIds: sourceAuthAccounts.map((account: any) => String(account._id)),
      deleteAuthSessionIds: sourceAuthSessions.map((session: any) => String(session._id)),
      deleteProfileIds: sourceProfiles.map((profile: any) => String(profile._id)),
      deleteSourceUserId: args.sourceUserId,
    },
  };
}

export const mergeDuplicateUsers = internalMutation({
  args: {
    sourceUserId: v.string(),
    expectedSurvivingUserId: v.string(),
    dryRun: v.optional(v.boolean()),
    confirm: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Default to dry-run: only an explicit `dryRun: false` performs writes.
    const dryRun = args.dryRun !== false;

    const plan = await buildMergePlan(ctx, {
      sourceUserId: args.sourceUserId,
      expectedSurvivingUserId: args.expectedSurvivingUserId,
    });

    if (dryRun) {
      return { ok: true, dryRun: true, plan };
    }

    if (args.confirm !== MERGE_CONFIRM) {
      throw new Error(`Apply mode requires confirm: "${MERGE_CONFIRM}"`);
    }

    const now = Date.now();
    const survivorId = args.expectedSurvivingUserId;

    // Resolve and fence every credential before changing any key state. This
    // makes an active destination/source rotation conflict fail atomically,
    // and refuses to move a prepared or abandoned credential to another user.
    const keysToRepoint = [];
    for (const keyId of plan.operations.repointApiKeyIds) {
      const key = await ctx.db.get(keyId as any);
      if (!key) throw new Error("API key disappeared while applying merge plan");
      await assertApiKeyMutationAllowed(ctx, key as any);
      await assertApiKeyScopeMutationAllowed(
        ctx,
        survivorId,
        (key as any).label,
      );
      keysToRepoint.push(key as any);
    }
    const rotationsToRepoint = [];
    for (const rotationId of plan.operations.repointRotationIds) {
      const rotation = await ctx.db.get(rotationId as any);
      if (!rotation) {
        throw new Error("API key rotation disappeared while applying merge plan");
      }
      if ((rotation as any).status !== "finalized") {
        throw new Error(
          `Refusing to merge: source rotation ${rotationId} is ${(rotation as any).status}`,
        );
      }
      await assertApiKeyScopeMutationAllowed(
        ctx,
        args.sourceUserId,
        (rotation as any).label,
      );
      await assertApiKeyScopeMutationAllowed(
        ctx,
        survivorId,
        (rotation as any).label,
      );
      rotationsToRepoint.push(rotation as any);
    }

    // Fail closed on orphan/mismatched finalized graphs before any write.
    await assertSourceRotationIntegrityForMerge(ctx, {
      sourceUserId: args.sourceUserId,
      sourceKeys: keysToRepoint,
      sourceRotations: rotationsToRepoint,
    });

    // Re-point credentials BEFORE deleting the source row. All of this runs in a
    // single Convex transaction, so it is atomic: if any later step throws, the
    // whole merge rolls back and nothing is persisted.
    for (const key of keysToRepoint) {
      await ctx.db.patch(key._id, { userId: survivorId });
    }
    for (const rotation of rotationsToRepoint) {
      await ctx.db.patch(rotation._id, { userId: survivorId });
    }
    for (const accountId of plan.operations.repointAuthAccountIds) {
      await ctx.db.patch(accountId as any, { userId: survivorId as any });
    }

    // Source sessions point at a row that is about to disappear — drop them so
    // no session resolves to a deleted user (forces a clean re-login).
    for (const sessionId of plan.operations.deleteAuthSessionIds) {
      await ctx.db.delete(sessionId as any);
    }
    // The source's (empty) profile shells go with the source row.
    for (const profileId of plan.operations.deleteProfileIds) {
      await ctx.db.delete(profileId as any);
    }

    await ctx.db.delete(plan.operations.deleteSourceUserId as any);

    // Post-condition verification. Throwing here rolls back the entire
    // transaction (re-points included), which is the rollback path.
    const survivorStillExists = await ctx.db.get(survivorId as any);
    if (!survivorStillExists) {
      throw new Error("Post-merge invariant failed: surviving user disappeared");
    }
    const orphanApiKeys = await apiKeysForUser(ctx, args.sourceUserId);
    if (orphanApiKeys.length > 0) {
      throw new Error(
        `Post-merge invariant failed: ${orphanApiKeys.length} API key(s) still point ` +
          `at the deleted source user`,
      );
    }
    const orphanAuthAccounts = await authAccountsForUser(ctx, args.sourceUserId);
    if (orphanAuthAccounts.length > 0) {
      throw new Error(
        `Post-merge invariant failed: ${orphanAuthAccounts.length} auth account(s) still ` +
          `point at the deleted source user`,
      );
    }
    const orphanRotations = await ctx.db
      .query("crystalApiKeyRotations")
      .withIndex("by_user_label", (q: any) => q.eq("userId", args.sourceUserId))
      .collect();
    if (orphanRotations.length > 0) {
      throw new Error(
        `Post-merge invariant failed: ${orphanRotations.length} rotation(s) still point ` +
          `at the deleted source user`,
      );
    }
    // Survivor holds every moved key/rotation with reciprocal integrity intact.
    for (const key of keysToRepoint) {
      const moved = await ctx.db.get(key._id);
      if (!moved || String((moved as any).userId) !== String(survivorId)) {
        throw new Error(
          `Post-merge invariant failed: API key ${String(key._id)} was not re-pointed`,
        );
      }
      if ((moved as any).rotationId) {
        const rot = await ctx.db.get((moved as any).rotationId);
        if (
          !rot ||
          String((rot as any).keyId) !== String(key._id) ||
          String((rot as any).userId) !== String(survivorId) ||
          String((rot as any).label ?? "") !== String((moved as any).label ?? "")
        ) {
          throw new Error(
            `Post-merge invariant failed: key ${String(key._id)} rotation integrity broken`,
          );
        }
      }
    }
    for (const rotation of rotationsToRepoint) {
      const moved = await ctx.db.get(rotation._id);
      if (!moved || String((moved as any).userId) !== String(survivorId)) {
        throw new Error(
          `Post-merge invariant failed: rotation ${String(rotation._id)} was not re-pointed`,
        );
      }
      const linkedKey = await ctx.db.get((moved as any).keyId);
      if (
        !linkedKey ||
        String((linkedKey as any).rotationId ?? "") !== String(rotation._id) ||
        String((linkedKey as any).userId) !== String(survivorId)
      ) {
        throw new Error(
          `Post-merge invariant failed: rotation ${String(rotation._id)} key integrity broken`,
        );
      }
    }
    const sourceStillExists = await ctx.db.get(args.sourceUserId as any);
    if (sourceStillExists) {
      throw new Error("Post-merge invariant failed: source user was not deleted");
    }
    // The whole point of the merge is a reachable surviving account. If the
    // result would leave the survivor with zero sign-in methods, the merge is a
    // net loss — throw so the transaction rolls back (re-points included) rather
    // than persist an unreachable identity.
    const survivorAuthAccounts = await authAccountsForUser(ctx, survivorId);
    if (survivorAuthAccounts.length === 0) {
      throw new Error(
        "Post-merge invariant failed: surviving user would have no sign-in method after merge",
      );
    }

    await ctx.db.insert("crystalAuditLog", {
      userId: survivorId,
      keyHash: "admin_account_merge",
      action: "admin_merge_duplicate_users",
      ts: now,
      actorUserId: survivorId,
      effectiveUserId: survivorId,
      targetUserId: survivorId,
      targetType: "user",
      targetId: args.sourceUserId,
      meta: JSON.stringify({
        email: plan.email,
        sourceUserId: args.sourceUserId,
        survivingUserId: survivorId,
        repointedApiKeyIds: plan.operations.repointApiKeyIds,
        repointedRotationIds: plan.operations.repointRotationIds,
        repointedAuthAccountIds: plan.operations.repointAuthAccountIds,
        deletedAuthSessionIds: plan.operations.deleteAuthSessionIds,
        deletedProfileIds: plan.operations.deleteProfileIds,
      }),
    });

    return {
      ok: true,
      dryRun: false,
      email: plan.email,
      survivingUserId: survivorId,
      deletedSourceUserId: args.sourceUserId,
      repointedApiKeyIds: plan.operations.repointApiKeyIds,
      repointedRotationIds: plan.operations.repointRotationIds,
      repointedAuthAccountIds: plan.operations.repointAuthAccountIds,
      deletedAuthSessionIds: plan.operations.deleteAuthSessionIds,
      deletedProfileIds: plan.operations.deleteProfileIds,
    };
  },
});
