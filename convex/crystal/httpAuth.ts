type DbQueryBuilder = {
  withIndex: (indexName: string, cb: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
    first: () => Promise<any>;
    take: (limit: number) => Promise<any[]>;
  };
};

import { resolveCapacityPolicy } from "../../shared/capacityPolicy";

type DbCtx = {
  db: {
    query: (table: string) => DbQueryBuilder;
    patch: (id: any, value: Record<string, unknown>) => Promise<unknown>;
    insert: (table: string, value: Record<string, unknown>) => Promise<unknown>;
  };
};

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 60;

async function resolveRequestLimit(ctx: DbCtx, key: string): Promise<number | null> {
  const keyHash = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
  const keyRecord = await getApiKeyRecordByHash(ctx, keyHash);
  if (!keyRecord?.userId) return RATE_LIMIT_MAX;
  const profiles = await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q) => q.eq("userId", keyRecord.userId))
    .take(100);
  const profile = profiles.sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  return resolveCapacityPolicy(profile, {
    backend: process.env.CRYSTAL_BACKEND,
  }).requestLimitPerMinute;
}

export async function getApiKeyRecordByHash(ctx: DbCtx, keyHash: string) {
  return await ctx.db
    .query("crystalApiKeys")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
    .first();
}

export async function validateApiKeyRecord(ctx: DbCtx, keyHash: string) {
  const keyRecord = await getApiKeyRecordByHash(ctx, keyHash);
  if (!keyRecord || !keyRecord.active || typeof keyRecord.userId !== "string") {
    return null;
  }
  if (keyRecord.expiresAt && keyRecord.expiresAt < Date.now()) {
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

export async function checkAndIncrementRateLimitForKey(ctx: DbCtx, key: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const requestLimit = await resolveRequestLimit(ctx, key);
  if (requestLimit === null) return { allowed: true, remaining: Number.MAX_SAFE_INTEGER };
  const existing = await ctx.db
    .query("crystalRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    if (existing?._id) {
      await ctx.db.patch(existing._id, { windowStart: now, count: 1 });
    } else {
      await ctx.db.insert("crystalRateLimits", { key, windowStart: now, count: 1 });
    }
    return { allowed: true, remaining: requestLimit - 1 };
  }

  if (existing.count >= requestLimit) {
    return { allowed: false, remaining: 0 };
  }

  await ctx.db.patch(existing._id, { count: existing.count + 1 });
  return { allowed: true, remaining: requestLimit - existing.count - 1 };
}
