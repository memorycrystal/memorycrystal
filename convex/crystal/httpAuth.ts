type DbQueryBuilder = {
  withIndex: (indexName: string, cb: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
    first: () => Promise<any>;
  };
};

type DbCtx = {
  db: {
    query: (table: string) => DbQueryBuilder;
    patch: (id: any, value: Record<string, unknown>) => Promise<unknown>;
    insert: (table: string, value: Record<string, unknown>) => Promise<unknown>;
  };
};

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 60;

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
  const existing = await ctx.db
    .query("crystalRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    return { allowed: true, remaining: RATE_LIMIT_MAX };
  }

  if (existing.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - existing.count };
}

export async function checkAndIncrementRateLimitForKey(ctx: DbCtx, key: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
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
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  if (existing.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }

  await ctx.db.patch(existing._id, { count: existing.count + 1 });
  return { allowed: true, remaining: RATE_LIMIT_MAX - existing.count - 1 };
}
