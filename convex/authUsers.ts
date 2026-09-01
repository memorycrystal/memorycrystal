import { ConvexError } from "convex/values";

/**
 * Account-linking policy for Convex Auth's `createOrUpdateUser` callback.
 *
 * This module holds the linking *decision* as a plain, unit-testable function
 * so it can be exercised against a hand-mocked `ctx` without booting the whole
 * `convexAuth(...)` runtime. `convex/auth.ts` wires it in as the callback.
 *
 * Why a custom callback at all: Convex Auth ships a `defaultCreateOrUpdateUser`
 * that already links a new provider account to a unique, already-verified
 * `users` row by email. The previous custom callback replaced that algorithm
 * and, on a password *signUp* (email not yet verified), fell through to
 * `insert("users", ...)` — minting a second identity for an email that already
 * owned a verified OAuth account (see the confirmed prod duplicate for
 * admin@illumin8.ca). This implementation restores the library's safe
 * verified-email linking contract while keeping the project-specific email
 * normalization and fail-closed behaviour.
 *
 * The runtime `args` handed to the callback are `{ existingUserId, ...args }`
 * where `...args` is the internal upsert payload — so it includes `provider`,
 * `profile`, `type`, and crucially `shouldLinkViaEmail`. The Password provider
 * sets `shouldLinkViaEmail: config.verify !== undefined`, and this project
 * configures `verify`, so password signups arrive here with
 * `shouldLinkViaEmail === true`. (The public type only advertises `shouldLink`,
 * but the dist spreads the full internal args, hence the `any` reads below.)
 */

export type CreateOrUpdateUserArgs = {
  existingUserId?: string | null;
  profile?: Record<string, unknown> & {
    email?: string;
    emailVerified?: boolean;
    phoneVerified?: boolean;
  };
  // Present at runtime even though the published callback type only declares
  // `shouldLink`. Set true by the Password provider because `verify` is
  // configured; absent on the OAuth path.
  shouldLinkViaEmail?: boolean;
  // Included for completeness; the decision does not branch on provider type —
  // trust comes exclusively from a real `emailVerified` signal (below).
  provider?: unknown;
  type?: string;
};

/** Trim + lowercase so case/whitespace variants cannot mint a second identity. */
export function normalizeAuthEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Provider email-trust policy (documented, ILL-94):
 *
 * - Password: never trusted at signup time (`profile.emailVerified` is absent
 *   until the OTP verification mutation supplies it). It links only via the
 *   library's `shouldLinkViaEmail` intent, and the account cannot open a
 *   session until OTP succeeds — so attaching a pending password account to a
 *   unique already-verified user is safe.
 * - Google (oidc): trusted ONLY when Google's actual `email_verified` claim is
 *   true. `convex/auth.ts` maps that claim into `profile.emailVerified` via a
 *   custom `profile()` — provider.type === "oidc" alone is NOT sufficient, and
 *   the inert `allowDangerousEmailAccountLinking` flag has been removed.
 * - GitHub (oauth): @auth/core does not surface a verified flag in its default
 *   profile, so `convex/auth.ts` fetches the user's email records from the
 *   GitHub API and sets `profile.emailVerified` only when the chosen email is
 *   GitHub-verified. GitHub is therefore NOT trusted merely for being OAuth.
 *
 * In every case, trust reduces to a single real signal: `profile.emailVerified
 * === true`. This function never infers trust from `provider.type`.
 */
function isEmailVerified(args: CreateOrUpdateUserArgs): boolean {
  return args.profile?.emailVerified === true;
}

/**
 * Decide the canonical `users._id` for an incoming sign-in/sign-up, linking to
 * an existing verified account by email where safe and failing closed when the
 * email is ambiguous.
 *
 * Contract (returns a `users` id):
 *  (a) existing provider account → patch that user, return it unchanged.
 *  (b) shouldLinkViaEmail OR verified email, and exactly one `users` row with
 *      that normalized email has `emailVerificationTime` set → link to it
 *      (patch + return); no new row is inserted. Applies to password signups.
 *  (c) two or more verified `users` rows share the email → FAIL CLOSED: throw a
 *      recoverable ConvexError; never insert an additional identity.
 *  (d) email is trim+lowercased before BOTH the lookup and any insert/patch.
 */
export async function createOrUpdateUser(
  ctx: any,
  args: CreateOrUpdateUserArgs,
): Promise<any> {
  const incoming = (args.profile ?? {}) as Record<string, any>;

  // Strip the verification booleans — they are decision inputs, not columns on
  // the `users` table.
  const userData: Record<string, any> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "emailVerified" || key === "phoneVerified") continue;
    userData[key] = value;
  }

  // (d) Normalize the email once, and use the normalized value everywhere.
  const normalizedEmail =
    typeof userData.email === "string" ? normalizeAuthEmail(userData.email) : undefined;
  if (normalizedEmail !== undefined) {
    userData.email = normalizedEmail;
  }

  const emailVerified = isEmailVerified(args);
  if (emailVerified) {
    userData.emailVerificationTime = Date.now();
  }

  // (a) Existing account for this provider — just refresh its profile.
  if (args.existingUserId) {
    await ctx.db.patch(args.existingUserId, userData);
    return args.existingUserId;
  }

  // Link by email when the library asked us to (password-with-verify) or when
  // the incoming email is genuinely provider-verified (Google/GitHub).
  const mayLinkViaEmail = args.shouldLinkViaEmail === true || emailVerified;

  if (normalizedEmail !== undefined && mayLinkViaEmail) {
    // Replicate `uniqueUserWithVerifiedEmail` exactly: email index, only rows
    // with `emailVerificationTime` set, take(2), unique-match only.
    const verified = await ctx.db
      .query("users")
      .withIndex("email", (q: any) => q.eq("email", normalizedEmail))
      .filter((q: any) => q.neq(q.field("emailVerificationTime"), undefined))
      .take(2);

    if (verified.length >= 2) {
      // (c) Ambiguous — refuse rather than compound the corruption with a third
      // identity. Recoverable: the client can surface an account-resolution
      // path and the sign-in simply does not complete.
      throw new ConvexError({
        code: "AMBIGUOUS_ACCOUNT_EMAIL",
        message:
          `Multiple accounts already exist for ${normalizedEmail}. ` +
          `Sign in with an existing method or contact support to merge them.`,
      });
    }

    if (verified.length === 1) {
      // (b) Attach to the single verified identity.
      await ctx.db.patch(verified[0]._id, userData);
      return verified[0]._id;
    }
    // Zero verified matches → fall through and create a genuinely new user.
  }

  return await ctx.db.insert("users", userData);
}
