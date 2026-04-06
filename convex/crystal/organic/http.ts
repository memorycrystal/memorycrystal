/**
 * HTTP endpoints for Organic Ideas.
 * Authenticated via API key (same pattern as mcp.ts handlers).
 */
import { httpAction } from "../../_generated/server";
import { internal } from "../../_generated/api";

const CONVEX_ID_RE = /^[a-z0-9]{10,40}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function parseBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!auth) return null;
  const [scheme, token] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function requireAuth(
  ctx: any,
  request: Request
): Promise<{ userId: string; keyHash: string } | null> {
  const rawKey = extractBearerToken(request);
  if (!rawKey) return null;
  const keyHash = await sha256Hex(rawKey);
  // validateApiKey returns the userId string (not a key object) or null.
  // It already checks active + expiry internally.
  const userId = await ctx.runQuery(internal.crystal.apiKeys.validateApiKey, { keyHash });
  if (!userId || typeof userId !== "string") return null;
  ctx.runMutation(internal.crystal.apiKeys.touchLastUsedAt, { keyHash }).catch(() => {});
  return { userId, keyHash };
}

// C-5: Rate limiting — reuse the same mechanism as mcp.ts
async function withRateLimit(ctx: any, keyHash: string): Promise<Response | null> {
  const result = await ctx.runMutation(internal.crystal.mcp.checkAndIncrementRateLimit, {
    key: `organic:${keyHash}`,
  });
  if (!result.allowed) {
    return json({ error: "Rate limit exceeded. Max 60 requests/minute." }, 429);
  }
  return null;
}

// ── POST /api/organic/ideas — list user's ideas ─────────────────────────────

export const organicListIdeas = httpAction(async (ctx, request) => {
  const auth = await requireAuth(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const rl = await withRateLimit(ctx, auth.keyHash);
  if (rl) return rl;

  const body = await parseBody(request);
  // Map user-facing statuses to internal values:
  // "pending" → "pending_notification", "all" → undefined (no filter)
  const rawStatus = typeof body.status === "string" ? body.status : undefined;
  const status = rawStatus === "pending" ? "pending_notification"
    : rawStatus === "all" ? undefined
    : rawStatus;
  const ideaType = typeof body.ideaType === "string" ? body.ideaType : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const cursor = typeof body.cursor === "number" ? body.cursor : undefined;

  const result = await ctx.runQuery(
    internal.crystal.organic.ideas.getMyIdeasInternal,
    { userId: auth.userId, status, ideaType, limit, cursor }
  );

  return json(result);
});

// ── POST /api/organic/ideas/update — update idea status ─────────────────────

export const organicUpdateIdea = httpAction(async (ctx, request) => {
  const auth = await requireAuth(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const rl = await withRateLimit(ctx, auth.keyHash);
  if (rl) return rl;

  const body = await parseBody(request);

  // Accept both { ideaId } (singular) and { ideaIds } (array) formats
  const ideaIds: string[] = Array.isArray(body.ideaIds)
    ? body.ideaIds
    : body.ideaId
      ? [body.ideaId]
      : [];

  if (ideaIds.length === 0 || !body.status) {
    return json({ error: "ideaId (or ideaIds) and status are required" }, 400);
  }

  const validStatuses = ["read", "dismissed", "starred", "notified"];
  if (!validStatuses.includes(body.status)) {
    return json({ error: `status must be one of: ${validStatuses.join(", ")}` }, 400);
  }

  // Validate ideaIds are non-empty strings (Convex will validate the actual ID format)
  if (ideaIds.some((id) => typeof id !== "string" || id.length === 0)) {
    return json({ error: "Invalid ideaId format" }, 400);
  }

  try {
    const result = await ctx.runMutation(
      internal.crystal.organic.ideas.updateIdeaStatusesInternal,
      { userId: auth.userId, ideaIds: ideaIds as any, status: body.status }
    );
    return json(ideaIds.length === 1 ? { success: true } : result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Update failed";
    // Sanitize: don't leak internal schema details from Convex validator errors
    const safeMsg = msg.includes("Validator") || msg.includes("table") ? "Invalid ideaId" : msg;
    return json({ error: safeMsg }, 400);
  }
});

// ── POST /api/organic/recallLog — log a recall query from plugin/MCP ────────

export const organicRecallLog = httpAction(async (ctx, request) => {
  const auth = await requireAuth(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const rl = await withRateLimit(ctx, auth.keyHash);
  if (rl) return rl;

  const body = await parseBody(request);
  if (!body.query || typeof body.query !== "string" || typeof body.resultCount !== "number") {
    return json({ error: "query (string) and resultCount (number) are required" }, 400);
  }

  // Validate topResultIds before passing them through to the mutation.
  const rawTopResultIds = Array.isArray(body.topResultIds) ? body.topResultIds : [];
  const topResultIds = rawTopResultIds.filter(
    (id: unknown) => typeof id === "string" && CONVEX_ID_RE.test(id)
  );

  try {
    await ctx.runMutation(
      internal.crystal.organic.traces.logRecallQuery,
      {
        userId: auth.userId,
        query: String(body.query),
        resultCount: body.resultCount,
        topResultIds,
        source: typeof body.source === "string" ? body.source : "http",
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
      }
    );
    return json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Log failed";
    const safeMsg = msg.includes("Validator") || msg.includes("table") ? "Invalid result IDs" : msg;
    return json({ error: safeMsg }, 400);
  }
});

// ── POST /api/organic/ideas/pending — get pending ideas for plugin ──────────

export const organicPendingIdeas = httpAction(async (ctx, request) => {
  const auth = await requireAuth(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const rl = await withRateLimit(ctx, auth.keyHash);
  if (rl) return rl;

  const ideas = await ctx.runQuery(
    internal.crystal.organic.ideas.getPendingIdeasInternal,
    { userId: auth.userId }
  );

  return json({ ideas });
});
