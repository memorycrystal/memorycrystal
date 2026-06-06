import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { stableUserId } from "./auth";

const DEVICE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_TTL_MS = 10 * 60 * 1000;

type DeviceStatus = "pending" | "complete" | "expired";

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

// Security note: this query is intentionally public (no auth) so the /device page can show
// the authorization UI to a logged-out user. It returns minimal metadata only — no API key,
// no userId, no email. The device code itself is the capability token for this lookup.
// Rate limiting on the HTTP polling endpoint (deviceHttp.ts) is the primary defense against
// brute-force enumeration of user codes.
export const getSessionByUserCode = query({
  args: { userCode: v.string() },
  handler: async (ctx, { userCode }) => {
    const session = await ctx.db
      .query("crystalDeviceAuth")
      .withIndex("by_user_code", (q) => q.eq("userCode", userCode.toUpperCase()))
      .first();

    if (!session) return null;

    const expired = session.expiresAt <= Date.now();
    // Return only what the UI needs — never userId, email, apiKey, or deviceCode
    return {
      userCode: session.userCode,
      status: expired ? "expired" : session.status,
      expiresAt: session.expiresAt,
      completed: session.status === "complete",
    };
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
      status: session.status,
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

    if (!session) throw new Error("Device session not found");
    if (session.expiresAt <= Date.now()) {
      if (session.status !== "expired") {
        await ctx.db.patch(session._id, { status: "expired" });
      }
      throw new Error("Device session expired");
    }

    if (session.status === "complete" && session.apiKey) {
      return { ok: true, status: "complete" as const };
    }

    const userId = actorUserId;
    await ctx.runMutation(internal.crystal.userProfiles.ensureProfileForUserInternal, {
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

    return { ok: true, status: "complete" as const };
  },
});
