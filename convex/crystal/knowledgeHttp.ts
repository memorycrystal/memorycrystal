import { httpAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

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
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function requireAuth(
  ctx: ActionCtx,
  request: Request
): Promise<{ userId: string; keyHash: string } | null> {
  const rawKey = extractBearerToken(request);
  if (!rawKey) return null;
  const keyHash = await sha256Hex(rawKey);
  const keyRecord = await ctx.runQuery(internal.crystal.mcp.getApiKeyRecord, { keyHash });
  if (!keyRecord || !keyRecord.active || typeof keyRecord.userId !== "string") return null;
  if (keyRecord.expiresAt && keyRecord.expiresAt < Date.now()) return null;
  ctx.runMutation(internal.crystal.apiKeys.touchLastUsedAt, { keyHash }).catch(() => {});
  return { userId: keyRecord.userId, keyHash };
}

async function withRateLimit(ctx: ActionCtx, keyHash: string): Promise<Response | null> {
  const result = await ctx.runMutation(internal.crystal.mcp.checkAndIncrementRateLimit, {
    key: `knowledge:${keyHash}`,
  });
  if (!result.allowed) {
    return json({ error: "Rate limit exceeded. Max 60 requests/minute." }, 429);
  }
  return null;
}

function parseKnowledgeBaseIdFromPath(request: Request) {
  const url = new URL(request.url);
  const suffix = url.pathname.replace(/^\/api\/knowledge-bases\//, "").replace(/\/+$/, "");
  if (!suffix) {
    return { knowledgeBaseId: null, tail: [] as string[] };
  }

  const parts = suffix.split("/").filter(Boolean);
  const knowledgeBaseId = parts[0] ?? null;
  return {
    knowledgeBaseId,
    tail: parts.slice(1),
  };
}

function normalizeBackfillType(value: unknown): "embeddings" | "graph" | "both" | null {
  if (value === "embeddings" || value === "graph" || value === "both") {
    return value;
  }
  return null;
}

const knowledgeBasesApi = (internal as any).crystal.knowledgeBases;

export const knowledgeBasesRoot = httpAction(async (ctx, request) => {
  const auth = await requireAuth(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const rateLimitResponse = await withRateLimit(ctx, auth.keyHash);
  if (rateLimitResponse) return rateLimitResponse;

  if (request.method === "GET") {
    const searchParams = new URL(request.url).searchParams;
    const includeInactive = searchParams.get("includeInactive") === "true";
    const scope = searchParams.get("scope")?.trim() || undefined;
    const agentId = searchParams.get("agentId")?.trim() || undefined;
    const knowledgeBases = await ctx.runQuery(
      knowledgeBasesApi.listKnowledgeBasesInternal,
      {
        userId: auth.userId,
        includeInactive,
        agentId,
        channel: scope,
      }
    );
    return json({ knowledgeBases });
  }

  if (request.method === "POST") {
    const body = await parseBody(request);
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return json({ error: "name is required" }, 400);
    }

    const knowledgeBaseId = await ctx.runMutation(
      knowledgeBasesApi.createKnowledgeBaseInternal,
      {
        userId: auth.userId,
        name: body.name,
        description: typeof body.description === "string" ? body.description : undefined,
        agentIds: Array.isArray(body.agentIds) ? body.agentIds.filter((value: unknown) => typeof value === "string") : undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        sourceType: typeof body.sourceType === "string" ? body.sourceType : undefined,
        peerScopePolicy: body.peerScopePolicy === "strict" || body.peerScopePolicy === "permissive"
          ? body.peerScopePolicy
          : undefined,
      }
    );

    return json({ knowledgeBaseId }, 201);
  }

  return json({ error: "Method not allowed" }, 405);
});

export const knowledgeBasesItem = httpAction(async (ctx, request) => {
  const auth = await requireAuth(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const rateLimitResponse = await withRateLimit(ctx, auth.keyHash);
  if (rateLimitResponse) return rateLimitResponse;

  const { knowledgeBaseId, tail } = parseKnowledgeBaseIdFromPath(request);

  if (request.method === "POST" && knowledgeBaseId === "backfill" && tail.length === 0) {
    const body = await parseBody(request);
    const type = normalizeBackfillType(body.type);

    if (!type) {
      return json({ error: "type must be one of: embeddings, graph, both" }, 400);
    }

    if (type === "embeddings" || type === "both") {
      await ctx.scheduler.runAfter(0, knowledgeBasesApi.backfillKBEmbeddings, {
        userId: auth.userId,
        batchSize: 20,
      });
    }

    if (type === "graph" || type === "both") {
      await ctx.scheduler.runAfter(0, knowledgeBasesApi.backfillKBGraphEnrichment, {
        userId: auth.userId,
        batchSize: 10,
      });
    }

    return json({ started: true, type });
  }

  if (request.method === "GET" && knowledgeBaseId === "backfill-status" && tail.length === 0) {
    let cursor: string | undefined = undefined;
    let total = 0;
    let unembedded = 0;
    let unenriched = 0;

    while (true) {
      const page: {
        total: number;
        unembedded: number;
        unenriched: number;
        isDone: boolean;
        continueCursor?: string;
      } = await ctx.runQuery(knowledgeBasesApi.countKnowledgeBaseBackfillPage, {
        userId: auth.userId,
        cursor,
        pageSize: 100,
      });

      total += page.total;
      unembedded += page.unembedded;
      unenriched += page.unenriched;

      if (page.isDone || !page.continueCursor) {
        break;
      }

      cursor = page.continueCursor;
    }

    return json({ unembedded, unenriched, total });
  }

  if (!knowledgeBaseId || !CONVEX_ID_RE.test(knowledgeBaseId)) {
    return json({ error: "Invalid knowledge base id" }, 400);
  }

  if (request.method === "GET" && tail.length === 0) {
    const limitParam = new URL(request.url).searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const knowledgeBase = await ctx.runQuery(
      knowledgeBasesApi.getKnowledgeBaseForUserInternal,
      {
        userId: auth.userId,
        knowledgeBaseId: knowledgeBaseId as any,
        limit: Number.isFinite(limit) ? limit : undefined,
      }
    );
    if (!knowledgeBase) {
      return json({ error: "Knowledge base not found" }, 404);
    }
    return json(knowledgeBase);
  }

  if (request.method === "POST" && tail[0] === "backfill-scope" && tail.length === 1) {
    // Verify ownership before scheduling the backfill — defense-in-depth against id enumeration.
    const knowledgeBase = await ctx.runQuery(
      knowledgeBasesApi.getKnowledgeBaseForUserInternal,
      {
        userId: auth.userId,
        knowledgeBaseId: knowledgeBaseId as any,
        limit: 1,
      }
    );
    if (!knowledgeBase) {
      return json({ error: "Knowledge base not found" }, 404);
    }
    await ctx.scheduler.runAfter(0, knowledgeBasesApi.backfillScopeFromTitle,
      { userId: auth.userId, knowledgeBaseId: knowledgeBaseId as any, patchedSoFar: 0 }
    );
    return json({ scheduled: true, note: "Backfill will self-schedule in batches of 100" });
  }

  if (request.method === "PATCH" && tail.length === 0) {
    // Verify ownership before mutating — fail fast with 404 so an enumerator can't tell a missing id from a foreign one.
    const knowledgeBase = await ctx.runQuery(
      knowledgeBasesApi.getKnowledgeBaseForUserInternal,
      {
        userId: auth.userId,
        knowledgeBaseId: knowledgeBaseId as any,
        limit: 1,
      }
    );
    if (!knowledgeBase) {
      return json({ error: "Knowledge base not found" }, 404);
    }
    const body = await parseBody(request);
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (Array.isArray(body.agentIds)) patch.agentIds = body.agentIds.filter((v: unknown) => typeof v === "string");
    if (typeof body.scope === "string") patch.scope = body.scope;
    if (typeof body.sourceType === "string") patch.sourceType = body.sourceType;
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
    if (body.peerScopePolicy === "strict" || body.peerScopePolicy === "permissive") {
      patch.peerScopePolicy = body.peerScopePolicy;
    }

    await ctx.runMutation(
      knowledgeBasesApi.patchKnowledgeBaseInternal,
      {
        userId: auth.userId,
        knowledgeBaseId: knowledgeBaseId as any,
        patch: patch as any,
      }
    );
    return json({ updated: true });
  }

  if (request.method === "DELETE" && tail.length === 0) {
    const result = await ctx.runAction(
      knowledgeBasesApi.deleteKnowledgeBaseInternal,
      {
        userId: auth.userId,
        knowledgeBaseId: knowledgeBaseId as any,
      }
    );
    return json(result);
  }

  if (request.method === "POST" && tail.length === 1 && tail[0] === "import") {
    const body = await parseBody(request);
    const chunks = Array.isArray(body.chunks)
      ? body.chunks
          .filter((chunk: unknown) => chunk && typeof chunk === "object" && typeof (chunk as any).content === "string")
          .map((chunk: any) => ({
            content: chunk.content,
            metadata: chunk.metadata && typeof chunk.metadata === "object" ? chunk.metadata : undefined,
          }))
      : [];

    if (chunks.length === 0) {
      return json({ error: "chunks[] is required" }, 400);
    }

    const result = await ctx.runAction(
      knowledgeBasesApi.batchImportChunksInternal,
      {
        userId: auth.userId,
        knowledgeBaseId: knowledgeBaseId as any,
        chunks,
      }
    );

    return json(result, 201);
  }

  // Bulk insert — inserts rows WITHOUT embedding/enrichment (for large migrations)
  if (request.method === "POST" && tail.length === 1 && tail[0] === "bulk-insert") {
    const body = await parseBody(request);
    const chunks = Array.isArray(body.chunks)
      ? body.chunks
          .filter((chunk: unknown) => chunk && typeof chunk === "object" && typeof (chunk as any).content === "string")
          .map((chunk: any) => ({
            content: chunk.content,
            title: typeof chunk.title === "string" ? chunk.title : undefined,
            sourceType: typeof chunk.sourceType === "string" ? chunk.sourceType : undefined,
            chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : undefined,
            totalChunks: typeof chunk.totalChunks === "number" ? chunk.totalChunks : undefined,
            scope: typeof chunk.scope === "string" ? chunk.scope : undefined,
          }))
      : [];

    if (chunks.length === 0) {
      return json({ error: "chunks[] is required" }, 400);
    }
    if (chunks.length > 100) {
      return json({ error: "Max 100 chunks per request" }, 400);
    }

    const result = await ctx.runMutation(
      knowledgeBasesApi.bulkInsertChunksInternal,
      {
        userId: auth.userId,
        knowledgeBaseId: knowledgeBaseId as any,
        chunks,
      }
    );

    return json(result, 201);
  }

  if (request.method === "POST" && tail.length === 1 && tail[0] === "query") {
    const body = await parseBody(request);
    if (typeof body.query !== "string" || body.query.trim().length === 0) {
      return json({ error: "query is required" }, 400);
    }

    const result = await ctx.runAction(
      knowledgeBasesApi.queryKnowledgeBaseInternal,
      {
        userId: auth.userId,
        knowledgeBaseId: knowledgeBaseId as any,
        query: body.query,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        agentId: typeof body.agentId === "string" ? body.agentId : undefined,
        channel: typeof body.channel === "string" ? body.channel : undefined,
      }
    );

    return json(result);
  }

  return json({ error: "Not found" }, 404);
});
