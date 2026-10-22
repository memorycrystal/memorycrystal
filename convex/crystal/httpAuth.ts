import type { MutationCtx } from "../_generated/server";
import { resolveCapacityPolicy } from "../../shared/capacityPolicy";

type DbCtx = { db: Pick<MutationCtx["db"], "query" | "patch" | "insert"> };

type ReadDbCtx = { db: Pick<DbCtx["db"], "query"> };

export const API_KEY_SCOPE_FIELDS = [
  "capabilities", "immutableScope", "boundWorkspaceId",
  "boundAgentId", "boundChannel", "boundCollectionIds",
] as const;

export function isOrdinaryApiKeyRecord(keyRecord: {
  capabilities?: unknown; immutableScope?: unknown; boundWorkspaceId?: unknown;
  boundAgentId?: unknown; boundChannel?: unknown; boundCollectionIds?: unknown;
} | null | undefined): boolean {
  if (!keyRecord) return false;
  return keyRecord.capabilities === undefined
    && (keyRecord.immutableScope === undefined || keyRecord.immutableScope === false)
    && keyRecord.boundWorkspaceId === undefined
    && keyRecord.boundAgentId === undefined
    && keyRecord.boundChannel === undefined
    && keyRecord.boundCollectionIds === undefined;
}

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 60;

async function resolveRequestLimit(ctx: DbCtx, key: string): Promise<number | null> {
  const keyHash = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
  const keyRecord = await getApiKeyRecordByHash(ctx, keyHash);
  if (!keyRecord?.userId) return RATE_LIMIT_MAX;
  return resolveUserRequestLimit(ctx, keyRecord.userId);
}

export async function resolveUserRequestLimit(ctx: DbCtx, userId: string): Promise<number | null> {
  const profiles = await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(100);
  const profile = profiles.sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  return resolveCapacityPolicy(profile, {
    backend: process.env.CRYSTAL_BACKEND,
  }).requestLimitPerMinute;
}

export async function getApiKeyRecordByHash(ctx: ReadDbCtx, keyHash: string) {
  // Auth-time parity also covers keys revoked before this code was installed.
  // Hosted keys never consult the tenant-local table.
  if (process.env.CRYSTAL_BACKEND === "local") {
    const localKey = await ctx.db
      .query("localApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
      .first();
    if (localKey && (localKey.revokedAt != null || localKey.cloudRevokedAt != null)) {
      return null;
    }
  }
  return await ctx.db
    .query("crystalApiKeys")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
    .first();
}

// ordinary surfaces only; research uses `researchHttp.authorize`
export async function validateApiKeyRecord(ctx: ReadDbCtx, keyHash: string) {
  const keyRecord = await getApiKeyRecordByHash(ctx, keyHash);
  if (!keyRecord || !keyRecord.active || typeof keyRecord.userId !== "string") {
    return null;
  }
  if (keyRecord.expiresAt && keyRecord.expiresAt < Date.now()) {
    return null;
  }
  if (!isOrdinaryApiKeyRecord(keyRecord)) {
    return null;
  }
  return keyRecord;
}

export async function touchApiKeyLastUsedAt(ctx: DbCtx, keyHash: string) {
  const keyRecord = await getApiKeyRecordByHash(ctx, keyHash);
  if (!keyRecord?._id) {
    return;
  }
  await ctx.db.patch(keyRecord._id, { lastUsedAt: Date.now() });
}

export async function peekRateLimitForKey(ctx: DbCtx, key: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const requestLimit = await resolveRequestLimit(ctx, key);
  if (requestLimit === null) return { allowed: true, remaining: Number.MAX_SAFE_INTEGER };
  const existing = await ctx.db
    .query("crystalRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    return { allowed: true, remaining: requestLimit };
  }

  if (existing.count >= requestLimit) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: requestLimit - existing.count };
}

export type RateLimitResult = {
  allowed: boolean;
  scope: "key" | "account";
  limit: number | null;
  remaining: number;
  retryAfterSec: number;
};

async function readWindow(ctx: DbCtx, key: string, limit: number | null, now: number) {
  const existing = limit === null ? null : await ctx.db
    .query("crystalRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const fresh = !existing || now - existing.windowStart >= RATE_LIMIT_WINDOW_MS;
  const count = fresh ? 0 : existing.count;
  return {
    key, existing, fresh, count, limit,
    allowed: limit === null || count < limit,
    remaining: limit === null ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - count),
    retryAfterSec: fresh ? 60 : Math.ceil((existing.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
  };
}

async function incrementWindow(ctx: DbCtx, window: Awaited<ReturnType<typeof readWindow>>, now: number) {
  if (window.limit === null) return;
  const value = { windowStart: window.fresh ? now : window.existing!.windowStart, count: window.count + 1 };
  if (window.existing) await ctx.db.patch(window.existing._id, value);
  else await ctx.db.insert("crystalRateLimits", { key: window.key, ...value });
}

function windowResult(window: Awaited<ReturnType<typeof readWindow>>, scope: "key" | "account"): RateLimitResult {
  return {
    allowed: window.allowed, scope, limit: window.limit,
    remaining: window.allowed && window.limit !== null ? window.remaining - 1 : window.remaining,
    retryAfterSec: window.retryAfterSec,
  };
}

/** Explicit-limit fixed window; no key parsing and no debit on refusal. */
export async function checkAndIncrementWindow(ctx: DbCtx, key: string, limit: number | null): Promise<RateLimitResult> {
  const now = Date.now();
  const window = await readWindow(ctx, key, limit, now);
  if (window.allowed) await incrementWindow(ctx, window, now);
  return windowResult(window, "key");
}

export async function checkAndIncrementRateLimitForKey(ctx: DbCtx, key: string): Promise<RateLimitResult> {
  return checkAndIncrementWindow(ctx, key, await resolveRequestLimit(ctx, key));
}

/** Unset/invalid means default 4; zero explicitly disables the account envelope. */
export function accountRateLimitMultiplier(): number {
  const raw = process.env.MC_ACCOUNT_RATE_LIMIT_MULTIPLIER;
  if (!raw?.trim()) return 4;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 4;
}

/** Called within ONE mutation. Decide key first; write only after both allow. */
export async function checkKeyAndAccountWindows(ctx: DbCtx, userId: string, key?: string): Promise<RateLimitResult> {
  const now = Date.now();
  const tierLimit = await resolveUserRequestLimit(ctx, userId);
  const multiplier = accountRateLimitMultiplier();
  const accountLimit = tierLimit === null || multiplier === 0 ? null : Math.min(Number.MAX_SAFE_INTEGER, multiplier * tierLimit);
  const keyWindow = key === undefined ? null : await readWindow(ctx, key, tierLimit, now);
  const accountWindow = await readWindow(ctx, `acct:${userId}`, accountLimit, now);
  if (keyWindow && !keyWindow.allowed) return windowResult(keyWindow, "key");
  if (!accountWindow.allowed) return windowResult(accountWindow, "account");
  if (keyWindow) await incrementWindow(ctx, keyWindow, now);
  await incrementWindow(ctx, accountWindow, now);
  return windowResult(keyWindow ?? accountWindow, keyWindow ? "key" : "account");
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "Retry-After": String(result.retryAfterSec),
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Scope": result.scope,
  };
}
