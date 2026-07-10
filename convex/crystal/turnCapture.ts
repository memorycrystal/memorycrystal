// Idempotent turn-capture endpoint — POST /api/mcp/turn.
//
// Generic Memory Crystal feature (not client-branded): host plugins POST a
// completed conversation turn ({ sessionKey, channel, turnId, userMessage,
// assistantMessage, platform, metadata }) and the backend persists it through
// the normal STM pipeline exactly once per (userId, turnId).
//
// Contract:
// - Auth: `Authorization: Bearer <Memory Crystal API key>` → 401 otherwise.
// - 400 for missing turnId / assistantMessage / sessionKey (and channel,
//   which is a required body field).
// - IDEMPOTENT by (userId, turnId): re-delivery of a known turnId is a no-op
//   returning { ok: true, deduped: true } — no inserts, no re-scheduled
//   extraction. The check runs against the `by_user_turn` index BEFORE any
//   insert, inside the same mutation transaction as the write, so concurrent
//   duplicate deliveries cannot double-persist.
// - First delivery reuses the EXISTING persistence path
//   (internal.crystal.messages.logTurnInternal): user + assistant rows,
//   tier-based TTL, channel/sessionKey/turnId set, metadata (incl. agentId)
//   on both rows, embedding enqueue, dashboard totals — then schedules the
//   same downstream LTM extraction the normal capture path uses
//   (internal.crystal.ltmExtraction.runOnDemandLtmExtraction).
//
// turnId is treated as an opaque string. The OpenClaw plugin computes
// "openclaw-channel:" + FNV-1a-32-hex(JSON.stringify({ sessionKey, messageId,
// userMessage, assistantMessage })) so turns POSTed by operators' existing
// dist patches dedupe server-side against native plugin captures during
// migration (same inputs → same turnId → deduped here, not double-captured).
//
// Auth / rate-limit / audit helpers mirror the private helpers in mcp.ts
// (which are not exported); they call the same internal functions
// (crystal/mcp:getApiKeyRecord, crystal/mcp:checkAndIncrementRateLimit,
// crystal/mcp:writeAuditLog, crystal/apiKeys:touchLastUsedAt) so this route
// enforces the same contract as the other /api/mcp routes.

import { httpAction, internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { sha256Hex } from "./crypto";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function extractBearerToken(request: Request): string | null {
  const auth =
    request.headers.get("authorization") || request.headers.get("Authorization");
  if (!auth) return null;
  const [scheme, token] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

async function parseBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function requireAuth(
  ctx: ActionCtx,
  request: Request,
): Promise<{ userId: string; keyHash: string } | null> {
  const rawKey = extractBearerToken(request);
  if (!rawKey) return null;
  const keyHash = await sha256Hex(rawKey);
  const keyRecord = await ctx.runQuery(internal.crystal.mcp.getApiKeyRecord, {
    keyHash,
  });
  if (!keyRecord || !keyRecord.active || typeof keyRecord.userId !== "string")
    return null;
  if (keyRecord.expiresAt && keyRecord.expiresAt < Date.now()) return null;
  await ctx
    .runMutation(internal.crystal.apiKeys.touchLastUsedAt, { keyHash })
    .catch(() => {});
  return { userId: keyRecord.userId, keyHash };
}

async function withRateLimit(
  ctx: ActionCtx,
  keyHash: string,
): Promise<Response | null> {
  // Same shared per-key bucket as the other /api/mcp routes.
  const result = await ctx.runMutation(
    internal.crystal.mcp.checkAndIncrementRateLimit,
    { key: `mcp:${keyHash}` },
  );
  if (!result.allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Max 60 requests/minute." }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "Retry-After": "60",
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }
  return null;
}

async function auditLog(
  ctx: ActionCtx,
  userId: string,
  keyHash: string,
  action: string,
  meta?: object,
) {
  try {
    await ctx.runMutation(internal.crystal.mcp.writeAuditLog, {
      userId,
      keyHash,
      action,
      ts: Date.now(),
      meta: meta ? JSON.stringify(meta) : undefined,
    });
  } catch {
    /* never let audit logging break the request */
  }
}

function shouldScheduleBackgroundWork() {
  return !(typeof process !== "undefined" && process.env.VITEST);
}

const normalizeString = (value: unknown): string => String(value ?? "").trim();

const normalizeObject = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

// Mirrors mcp.ts normalizeAgentIdForMetadata so agentId lands in row metadata
// in the same sanitized shape regardless of which capture surface wrote it.
function normalizeAgentId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120) : undefined;
}

// Mirrors mcp.ts normalizeProjectId / normalizeRepoSlug / normalizeProjectContext.
function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^proj_[a-f0-9]{12,64}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function normalizeRepoSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) return undefined;
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120) || undefined;
}

async function normalizeProjectContext(projectIdValue: unknown, repoSlugValue: unknown) {
  const explicitProjectId = normalizeProjectId(projectIdValue);
  const repoSlug = normalizeRepoSlug(repoSlugValue);
  if (explicitProjectId || !repoSlug) {
    return { projectId: explicitProjectId, repoSlug };
  }
  const digest = await sha256Hex(`repo:${repoSlug.toLowerCase()}`);
  return { projectId: `proj_${digest.slice(0, 24)}`, repoSlug };
}

type TurnMessageSummary = {
  role: string;
  id?: string;
  inserted?: boolean;
  skipped?: boolean;
  reason?: string;
};

type CaptureTurnResult = {
  ok: boolean;
  deduped: boolean;
  turnId?: string;
  sessionKey?: string;
  channel?: string;
  messages?: TurnMessageSummary[];
  error?: string;
  limit?: number;
  required?: number;
  available?: number;
};

/** Rows already persisted for (userId, turnId) — cheap via by_user_turn. */
export const findTurnMessages = internalQuery({
  args: { userId: v.string(), turnId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_turn", (q) =>
        q.eq("userId", args.userId).eq("turnId", args.turnId),
      )
      .take(10);
    return rows.map((row) => ({
      id: String(row._id),
      role: row.role,
      channel: row.channel,
      sessionKey: row.sessionKey,
      turnId: row.turnId,
      turnMessageIndex: row.turnMessageIndex,
      metadata: row.metadata,
    }));
  },
});

/**
 * Idempotency check + persistence in ONE transaction.
 *
 * Checks the by_user_turn index for any existing row carrying this
 * (userId, turnId) BEFORE inserting anything. On a miss it delegates to the
 * existing atomic turn path (crystal/messages:logTurnInternal — sub-mutation,
 * same transaction) rather than forking a parallel pipeline. Convex OCC
 * serializes conflicting transactions, so two racing deliveries of the same
 * turnId cannot both insert: the loser retries, sees the winner's rows, and
 * returns deduped.
 */
export const captureTurn = internalMutation({
  args: {
    userId: v.string(),
    sessionKey: v.string(),
    channel: v.string(),
    turnId: v.string(),
    userMessage: v.optional(v.string()),
    assistantMessage: v.string(),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CaptureTurnResult> => {
    const existing = await ctx.db
      .query("crystalMessages")
      .withIndex("by_user_turn", (q) =>
        q.eq("userId", args.userId).eq("turnId", args.turnId),
      )
      .take(4);

    if (existing.length > 0) {
      return {
        ok: true,
        deduped: true,
        turnId: args.turnId,
        sessionKey: args.sessionKey,
        channel: args.channel,
        messages: existing
          .slice()
          .sort(
            (left, right) =>
              (left.turnMessageIndex ?? 0) - (right.turnMessageIndex ?? 0),
          )
          .map((row) => ({
            role: row.role,
            id: String(row._id),
            inserted: false,
          })),
      };
    }

    const result = await ctx.runMutation(
      (internal as any).crystal.messages.logTurnInternal,
      {
        userId: args.userId,
        sessionKey: args.sessionKey,
        channel: args.channel,
        turnId: args.turnId,
        userMessage: args.userMessage,
        assistantMessage: args.assistantMessage,
        metadata: args.metadata,
      },
    );

    return { ...(result as object), deduped: false } as CaptureTurnResult;
  },
});

export const turnCapture = httpAction(async (ctx, request) => {
  const auth = await requireAuth(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const rateLimitResponse = await withRateLimit(ctx, auth.keyHash);
  if (rateLimitResponse) return rateLimitResponse;

  const body = await parseBody(request);
  const sessionKey = normalizeString(body?.sessionKey);
  const channel = normalizeString(body?.channel);
  const turnId = normalizeString(body?.turnId);
  const userMessage = normalizeString(body?.userMessage);
  const assistantMessage = normalizeString(body?.assistantMessage);
  const captureMode =
    body?.captureMode === "sync-test-only" ? "sync-test-only" : "async";

  if (!sessionKey) return json({ error: "sessionKey is required" }, 400);
  if (!channel) return json({ error: "channel is required" }, 400);
  if (!turnId) return json({ error: "turnId is required" }, 400);
  if (!assistantMessage)
    return json({ error: "assistantMessage is required" }, 400);

  // Contract metadata: optional bag with agentId/provider/accountId/route/
  // conversationId/messageId/... — passed through verbatim, with agentId
  // normalized. A top-level agentId (legacy shape) wins over metadata.agentId.
  const metadata = normalizeObject(body?.metadata);
  const agentId =
    normalizeAgentId(body?.agentId) ?? normalizeAgentId(metadata?.agentId);
  const { projectId, repoSlug } = await normalizeProjectContext(
    body?.projectId,
    body?.repoSlug,
  );
  const platform = normalizeString(body?.platform);
  const externalUserId = normalizeString(body?.externalUserId);
  const mergedMetadata: Record<string, unknown> = {
    ...(metadata ?? {}),
    ...(platform ? { platform } : {}),
    ...(externalUserId ? { externalUserId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(repoSlug ? { repoSlug } : {}),
  };
  const metadataString =
    Object.keys(mergedMetadata).length > 0
      ? JSON.stringify(mergedMetadata)
      : undefined;

  await auditLog(ctx, auth.userId, auth.keyHash, "turn", {
    sessionKey,
    channel,
    turnId,
    userMessageLength: userMessage.length,
    assistantMessageLength: assistantMessage.length,
  });

  const result: CaptureTurnResult = await ctx.runMutation(
    (internal as any).crystal.turnCapture.captureTurn,
    {
      userId: auth.userId,
      sessionKey,
      channel,
      turnId,
      userMessage,
      assistantMessage,
      metadata: metadataString,
    },
  );

  if (!result?.ok) {
    return json(
      result,
      result?.error?.includes("Storage limit reached") ? 403 : 400,
    );
  }

  const response: Record<string, unknown> = {
    ...result,
    extraction: {
      scheduled: false,
      mode: captureMode,
    } as {
      scheduled: boolean;
      mode: "async" | "sync-test-only";
      result?: object;
      error?: string;
      reason?: string;
    },
  };
  const extraction = response.extraction as {
    scheduled: boolean;
    mode: "async" | "sync-test-only";
    result?: object;
    error?: string;
    reason?: string;
  };

  // Re-delivery is a full no-op: nothing persisted, nothing re-extracted.
  if (result.deduped) {
    extraction.reason = "deduped";
    return json(response);
  }

  const messageIds = (result.messages ?? [])
    .map((message) => message.id)
    .filter(Boolean) as string[];

  if (messageIds.length === 0) {
    extraction.reason = "no_messages";
    return json(response);
  }

  try {
    const extractionArgs = {
      userId: auth.userId,
      channel,
      sessionKey,
      messageIds,
      limit: Math.max(messageIds.length, 2),
    };
    if (captureMode === "sync-test-only") {
      extraction.result = await ctx.runAction(
        (internal as any).crystal.ltmExtraction.runOnDemandLtmExtraction,
        extractionArgs,
      );
      extraction.scheduled = true;
    } else if (shouldScheduleBackgroundWork()) {
      await ctx.scheduler.runAfter(
        120_000,
        (internal as any).crystal.ltmExtraction.runOnDemandLtmExtraction,
        extractionArgs,
      );
      extraction.scheduled = true;
    } else {
      extraction.reason = "background_work_disabled";
    }
  } catch (error) {
    response.degraded = true;
    extraction.scheduled = false;
    extraction.error = error instanceof Error ? error.message : String(error);
  }

  return json(response);
});
