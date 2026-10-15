import { hasActiveApiKeySlot } from "./apiKeyLimits";
import { API_KEY_LIMIT_MESSAGE } from "../../shared/apiKeyErrors";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation } from "../_generated/server";
import { v } from "convex/values";
import { stableUserId } from "./auth";

const DEVICE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_TTL_MS = 10 * 60 * 1000;

type DeviceStatus = "pending" | "complete" | "expired" | "api_key_limit";

function randomString(length: number, alphabet: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let value = "";
  for (let i = 0; i < length; i += 1) {
    value += alphabet[bytes[i] % alphabet.length];
  }
  return value;
}

function generateDeviceCode() {
  return randomString(8, DEVICE_CODE_ALPHABET);
}

function generateUserCode() {
  const raw = randomString(6, USER_CODE_ALPHABET);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function formatCliInstallLabel(now: number) {
  return `CLI Install ${new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

export const startSession = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    let deviceCode = generateDeviceCode();
    while (
      await ctx.db
        .query("crystalDeviceAuth")
        .withIndex("by_device_code", (q) => q.eq("deviceCode", deviceCode))
        .first()
    ) {
      deviceCode = generateDeviceCode();
    }

    let userCode = generateUserCode();
    while (
      await ctx.db
        .query("crystalDeviceAuth")
        .withIndex("by_user_code", (q) => q.eq("userCode", userCode))
        .first()
    ) {
      userCode = generateUserCode();
    }

    await ctx.db.insert("crystalDeviceAuth", {
      deviceCode,
      userCode,
      status: "pending",
      expiresAt: now + SESSION_TTL_MS,
      createdAt: now,
    });

    return { deviceCode, userCode, expiresAt: now + SESSION_TTL_MS };
  },
});

export const getSessionStatus = internalQuery({
  args: { deviceCode: v.string() },
  handler: async (ctx, { deviceCode }) => {
    const session = await ctx.db
      .query("crystalDeviceAuth")
      .withIndex("by_device_code", (q) => q.eq("deviceCode", deviceCode.toUpperCase()))
      .first();

    if (!session) return { found: false as const, status: "expired" as DeviceStatus };
    if (session.expiresAt <= Date.now()) {
      return {
        found: true as const,
        status: "expired" as DeviceStatus,
        apiKey: undefined,
        sessionId: session._id,
      };
    }

    return {
      found: true as const,
      status: session.error ?? session.status,
      apiKey: session.apiKey,
      sessionId: session._id,
    };
  },
});

// Called immediately after the CLI retrieves the API key — clears the plaintext key from the DB
// so a subsequent breach of the crystalDeviceAuth table does not expose already-issued keys.
const DEVICE_POLL_RATE_LIMIT_MAX = 10;
const DEVICE_POLL_RATE_LIMIT_WINDOW_MS = 60_000;
const DEVICE_AUTHORIZE_RATE_LIMIT_MAX = 20;
const DEVICE_AUTHORIZE_RATE_LIMIT_WINDOW_MS = 60_000;

export const checkDevicePollRateLimit = internalMutation({
  args: { deviceCode: v.string() },
  handler: async (ctx, { deviceCode }): Promise<{ allowed: boolean; remaining: number }> => {
    const key = `device_poll:${deviceCode.toUpperCase()}`;
    const now = Date.now();
    const existing = await ctx.db
      .query("crystalRateLimits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();

    if (!existing || now - existing.windowStart > DEVICE_POLL_RATE_LIMIT_WINDOW_MS) {
      if (existing) {
        await ctx.db.patch(existing._id, { windowStart: now, count: 1 });
      } else {
        await ctx.db.insert("crystalRateLimits", { key, windowStart: now, count: 1 });
      }
      return { allowed: true, remaining: DEVICE_POLL_RATE_LIMIT_MAX - 1 };
    }

    if (existing.count >= DEVICE_POLL_RATE_LIMIT_MAX) {
      return { allowed: false, remaining: 0 };
    }

    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return { allowed: true, remaining: DEVICE_POLL_RATE_LIMIT_MAX - existing.count - 1 };
  },
});

export const clearApiKeyAfterRetrieval = internalMutation({
  args: { deviceCode: v.string() },
  handler: async (ctx, { deviceCode }) => {
    const session = await ctx.db
      .query("crystalDeviceAuth")
      .withIndex("by_device_code", (q) => q.eq("deviceCode", deviceCode.toUpperCase()))
      .first();
    if (!session) return;
    await ctx.db.patch(session._id, { apiKey: undefined });
  },
});

export const markExpired = internalMutation({
  args: { deviceCode: v.string() },
  handler: async (ctx, { deviceCode }) => {
    const session = await ctx.db
      .query("crystalDeviceAuth")
      .withIndex("by_device_code", (q) => q.eq("deviceCode", deviceCode.toUpperCase()))
      .first();

    if (!session || session.status === "complete") return null;
    if (session.status === "expired") return session._id;

    await ctx.db.patch(session._id, { status: "expired" });
    return session._id;
  },
});

// authorizeSession is the only public user-code lookup. It requires an authenticated
// user and applies the ILL-326 per-user rate limit before checking the code.
export const authorizeSession = mutation({
  args: { userCode: v.string() },
  handler: async (ctx, { userCode }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const actorUserId = stableUserId(identity.subject);

    const rateKey = `device_authorize:${actorUserId}`;
    const now = Date.now();
    const existing = await ctx.db
      .query("crystalRateLimits")
      .withIndex("by_key", (q) => q.eq("key", rateKey))
      .first();

    if (!existing || now - existing.windowStart > DEVICE_AUTHORIZE_RATE_LIMIT_WINDOW_MS) {
      if (existing) {
        await ctx.db.patch(existing._id, { windowStart: now, count: 1 });
      } else {
        await ctx.db.insert("crystalRateLimits", { key: rateKey, windowStart: now, count: 1 });
      }
    } else {
      if (existing.count >= DEVICE_AUTHORIZE_RATE_LIMIT_MAX) {
        throw new Error("Too many authorization attempts. Please wait and try again.");
      }
      await ctx.db.patch(existing._id, { count: existing.count + 1 });
    }

    const normalizedUserCode = userCode.trim().toUpperCase();
    const session = await ctx.db
      .query("crystalDeviceAuth")
      .withIndex("by_user_code", (q) => q.eq("userCode", normalizedUserCode))
      .first();

    // Failures after the debit return instead of throwing: a throw rolls back the whole
    // mutation, rate-limit debit included, so invalid guesses would never consume the quota.
    if (!session) {
      return { ok: false as const, error: "not_found" as const, message: "Device session not found" };
    }
    // A completed session never mints a second key, even after the CLI cleared the first,
    // and its terminal status is never rewritten, even past expiry.
    if (session.status === "complete") {
      return { ok: true as const, status: "complete" as const };
    }
    if (session.expiresAt <= Date.now()) {
      // Only a pending session moves to expired, matching markExpired.
      if (session.status === "pending") {
        await ctx.db.patch(session._id, { status: "expired" });
      }
      return { ok: false as const, error: "expired" as const, message: "Device session expired" };
    }

    // Do not throw after the debit: the refusal and session state must commit.
    // Nested issueApiKeyForUser also checks the cap in this same transaction.
    if (session.error === "api_key_limit" || !await hasActiveApiKeySlot(ctx, actorUserId)) {
      await ctx.db.patch(session._id, { error: "api_key_limit" });
      return { ok: false as const, error: "api_key_limit" as const, message: API_KEY_LIMIT_MESSAGE };
    }

    const userId = actorUserId;
    await ctx.runMutation((internal as any).crystal.userProfiles.ensureProfileForUserInternal, {
      userId,
      email: identity.email ?? undefined,
    });

    const apiKey = await ctx.runMutation(internal.crystal.mcp.issueApiKeyForUser, {
      userId,
      label: formatCliInstallLabel(Date.now()),
    });

    await ctx.db.patch(session._id, {
      status: "complete",
      apiKey,
      userId,
    });

    return { ok: true as const, status: "complete" as const };
  },
});
