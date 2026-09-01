import type { ActionCtx } from "../_generated/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

const api = (internal as any).crystal;
const ID_RE = /^[a-z0-9]{10,40}$/;
const RESEARCH_SCHEMA_VERSION = "research.v1";

class ResearchHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const requestId = crypto.randomUUID();
  const payload = data && typeof data === "object" && !Array.isArray(data)
    ? { schemaVersion: RESEARCH_SCHEMA_VERSION, requestId, ...(data as Record<string, unknown>) }
    : { schemaVersion: RESEARCH_SCHEMA_VERSION, requestId, data };
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      "x-memory-crystal-schema-version": RESEARCH_SCHEMA_VERSION,
      ...extraHeaders,
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ResearchHttpError) {
    return json({ error: error.message, code: error.code, retryable: error.retryable }, error.status);
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Uncaught Error:\s*/i, "").split("\n")[0].trim();
  if (/too many writes per second|changed while this mutation was being run|rate limit/i.test(message)) {
    return json({ error: message, code: "research_rate_limited", retryable: true }, 429, { "retry-after": "60" });
  }
  if (/bootstrapping|temporarily unavailable/i.test(message)) {
    return json({ error: message, code: "research_temporarily_unavailable", retryable: true }, 503, { "retry-after": "30" });
  }
  if (/not found/i.test(message)) return json({ error: message, code: "research_not_found", retryable: false }, 404);
  if (/capacity policy|not enabled|capability|scope/i.test(message)) return json({ error: message, code: "research_forbidden", retryable: false }, 403);
  return json({ error: message, code: "research_invalid_request", retryable: false }, 400);
}

async function body(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const [scheme, token] = value.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token.trim() : null;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function authorize(ctx: ActionCtx, request: Request) {
  const token = bearer(request);
  if (!token) return null;
  const keyHash = await sha256Hex(token);
  const key = await ctx.runQuery(api.mcp.getApiKeyRecord, { keyHash });
  if (!key || !key.active || typeof key.userId !== "string") return null;
  if (key.expiresAt && key.expiresAt < Date.now()) return null;
  ctx.runMutation(api.apiKeys.touchLastUsedAt, { keyHash }).catch(() => null);
  return { userId: key.userId as string, keyHash, key };
}

type ResearchAuth = NonNullable<Awaited<ReturnType<typeof authorize>>>;
type ResearchCapability = "research:read" | "research:ingest" | "research:promote" | "research:admin";

function requireCapability(auth: ResearchAuth, capability: ResearchCapability): void {
  const configured = auth.key.capabilities as ResearchCapability[] | undefined;
  if (configured === undefined) return; // Legacy keys retain their historical full-access behavior.
  if (configured.includes("research:admin") || configured.includes(capability)) return;
  throw new ResearchHttpError(`API credential lacks ${capability} capability`, 403, "research_capability_denied");
}

async function boundScope(
  ctx: ActionCtx,
  auth: ResearchAuth,
  collectionId: string,
  requested: { agentId?: string; channel?: string } = {},
) {
  const collection = await ctx.runQuery(api.research.requireCollectionInternal, { userId: auth.userId, collectionId });
  const ids = auth.key.boundCollectionIds as string[] | undefined;
  if (ids && !ids.includes(String(collection._id))) {
    throw new ResearchHttpError("Collection is outside the credential scope", 403, "research_scope_denied");
  }
  for (const [keyField, collectionField] of [
    ["boundWorkspaceId", "workspaceId"], ["boundAgentId", "agentId"], ["boundChannel", "channel"],
  ] as const) {
    const bound = auth.key[keyField];
    if (bound !== undefined && collection[collectionField] !== bound) {
      throw new ResearchHttpError(`${collectionField} is outside the credential scope`, 403, "research_scope_denied");
    }
  }
  if (auth.key.boundAgentId !== undefined && requested.agentId !== undefined && requested.agentId !== auth.key.boundAgentId) {
    throw new ResearchHttpError("Request cannot expand the credential agent scope", 403, "research_scope_expansion_denied");
  }
  if (auth.key.boundChannel !== undefined && requested.channel !== undefined && requested.channel !== auth.key.boundChannel) {
    throw new ResearchHttpError("Request cannot expand the credential channel scope", 403, "research_scope_expansion_denied");
  }
  return {
    collection,
    agentId: auth.key.boundAgentId ?? requested.agentId,
    channel: auth.key.boundChannel ?? requested.channel,
  };
}

function assertAllowedParams(params: URLSearchParams, allowed: readonly string[]): void {
  for (const key of params.keys()) {
    if (!allowed.includes(key)) throw new ResearchHttpError(`Unsupported filter: ${key}`, 400, "research_unsupported_filter");
  }
}

function assertAllowedFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new ResearchHttpError(`Unsupported filter: ${key}`, 400, "research_unsupported_filter");
  }
}

function publicPage(result: any): any {
  if (!result || typeof result !== "object") return result;
  return { ...result, nextCursor: result.isDone ? null : (result.continueCursor ?? null) };
}

async function enforceRateLimit(ctx: ActionCtx, keyHash: string): Promise<Response | null> {
  const result = await ctx.runMutation(api.mcp.checkAndIncrementRateLimit, { key: `research:${keyHash}` });
  if (result.allowed) return null;
  return json({ error: "Capacity-policy request limit exceeded", code: "research_rate_limited", retryable: true, retryAfterSeconds: 60 }, 429, { "retry-after": "60" });
}

function segments(request: Request): string[] {
  return new URL(request.url).pathname.replace(/^\/api\/research\/?/, "").split("/").filter(Boolean);
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function numberParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const researchCollectionsRoot = httpAction(async (ctx, request) => {
  const auth = await authorize(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const limited = await enforceRateLimit(ctx, auth.keyHash);
  if (limited) return limited;
  try {
    if (request.method === "GET") {
      requireCapability(auth, "research:read");
      const url = new URL(request.url);
      assertAllowedParams(url.searchParams, ["status", "domain", "workspaceId", "agentId", "channel", "cursor", "limit"]);
      for (const [field, bound] of [["workspaceId", auth.key.boundWorkspaceId], ["agentId", auth.key.boundAgentId], ["channel", auth.key.boundChannel]] as const) {
        const requested = url.searchParams.get(field);
        if (bound !== undefined && requested !== null && requested !== bound) {
          throw new ResearchHttpError(`Request cannot expand the credential ${field} scope`, 403, "research_scope_expansion_denied");
        }
      }
      const result = await ctx.runQuery(api.research.listCollectionsInternal, {
        userId: auth.userId,
        status: url.searchParams.get("status") || undefined,
        domain: url.searchParams.get("domain") || undefined,
        workspaceId: auth.key.boundWorkspaceId ?? url.searchParams.get("workspaceId") ?? undefined,
        agentId: auth.key.boundAgentId ?? url.searchParams.get("agentId") ?? undefined,
        channel: auth.key.boundChannel ?? url.searchParams.get("channel") ?? undefined,
        cursor: url.searchParams.get("cursor") || undefined,
        limit: numberParam(url.searchParams.get("limit")),
      });
      const ids = auth.key.boundCollectionIds as string[] | undefined;
      if (ids) result.collections = result.collections.filter((row: any) => ids.includes(String(row._id)));
      return json(publicPage(result));
    }
    if (request.method === "POST") {
      requireCapability(auth, "research:ingest");
      const input = await body(request);
      if (auth.key.boundCollectionIds !== undefined) {
        throw new ResearchHttpError("Collection creation cannot expand a collection-bound credential", 403, "research_scope_expansion_denied");
      }
      for (const [field, bound] of [["workspaceId", auth.key.boundWorkspaceId], ["agentId", auth.key.boundAgentId], ["channel", auth.key.boundChannel]] as const) {
        if (bound !== undefined && input[field] !== undefined && input[field] !== bound) {
          throw new ResearchHttpError(`Request cannot expand the credential ${field} scope`, 403, "research_scope_expansion_denied");
        }
      }
      const collectionId = await ctx.runMutation(api.research.createCollectionInternal, {
        userId: auth.userId,
        name: input.name,
        domain: input.domain,
        description: input.description,
        retentionPolicy: input.retentionPolicy,
        workspaceId: auth.key.boundWorkspaceId ?? input.workspaceId,
        agentId: auth.key.boundAgentId ?? input.agentId,
        channel: auth.key.boundChannel ?? input.channel,
        visibility: input.visibility,
      });
      return json({ collectionId }, 201);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return errorResponse(error);
  }
});

export const researchOperations = httpAction(async (ctx, request) => {
  const auth = await authorize(ctx, request);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const limited = await enforceRateLimit(ctx, auth.keyHash);
  if (limited) return limited;
  const path = segments(request);
  try {
    const preview = request.method === "POST" ? await body(request.clone()) : {};
    if (request.method === "GET" || (request.method === "POST" && path[0] === "query")) {
      requireCapability(auth, "research:read");
    } else if (path[0] === "promote" || path[0] === "demote" || path[0] === "memory") {
      requireCapability(auth, "research:promote");
    } else if ((path[0] === "collections" && (path[2] === "archive" || path[2] === "restore"))) {
      requireCapability(auth, "research:admin");
    } else {
      requireCapability(auth, "research:ingest");
    }
    const pathCollectionId = path[0] === "collections" && path[1] ? requiredId(path[1], "collectionId") : undefined;
    const bodyCollectionId = preview.collectionId ? requiredId(preview.collectionId, "collectionId") : undefined;
    const primaryCollectionId = pathCollectionId ?? bodyCollectionId;
    const primaryScope = primaryCollectionId
      ? await boundScope(ctx, auth, primaryCollectionId, { agentId: preview.agentId, channel: preview.channel })
      : undefined;
    if (request.method === "POST" && path[0] === "collections" && path[2] === "archive") {
      return json(await ctx.runMutation(api.research.archiveCollectionInternal, {
        userId: auth.userId,
        collectionId: requiredId(path[1], "collectionId"),
        archived: (await body(request)).archived !== false,
      }));
    }
    if (request.method === "GET" && path[0] === "collections" && path[2] === "export") {
      const url = new URL(request.url);
      assertAllowedParams(url.searchParams, ["entity", "cursor", "limit"]);
      return json(publicPage(await ctx.runQuery(api.researchTransfer.exportPageInternal, {
        userId: auth.userId,
        collectionId: requiredId(path[1], "collectionId"),
        entity: url.searchParams.get("entity"),
        cursor: url.searchParams.get("cursor") || undefined,
        limit: numberParam(url.searchParams.get("limit")),
      })));
    }
    if (request.method === "POST" && path[0] === "collections" && path[2] === "restore") {
      const input = await body(request);
      const collectionId = requiredId(path[1], "collectionId");
      const records = Array.isArray(input.records) ? input.records : [];
      if (records.length === 0 || records.length > 100) return json({ error: "records must contain 1 to 100 exported rows" }, 400);
      const results = [];
      for (const record of records) {
        if (input.entity === "sources") {
          results.push(await ctx.runMutation(api.research.upsertSourceInternal, {
            userId: auth.userId, collectionId,
            source: {
              stableKey: record.stableKey, idempotencyKey: record.idempotencyKey, sourceType: record.sourceType,
              host: record.host, canonicalUrl: record.canonicalUrl, repositoryOwner: record.repositoryOwner,
              repositoryName: record.repositoryName, immutableVersion: record.immutableVersion, filePath: record.filePath,
              retrievedAt: record.retrievedAt, contentHash: record.contentHash, licenseId: record.licenseId,
              licenseDisposition: record.licenseDisposition, securityDisposition: record.securityDisposition,
              quarantineState: record.quarantineState, parserVersion: record.parserVersion, rejectionReason: record.rejectionReason,
            },
          }));
        } else if (input.entity === "artifacts") {
          const refs = record.sourceStableKey ? await ctx.runQuery(api.researchTransfer.resolveStableReferencesInternal, {
            userId: auth.userId, collectionId, sourceStableKeys: [record.sourceStableKey],
          }) : { sourceIds: [] };
          results.push(await ctx.runMutation(api.researchArtifacts.registerInternal, {
            userId: auth.userId, collectionId,
            sourceId: refs.sourceIds[0], stableKey: record.stableKey, idempotencyKey: record.idempotencyKey,
            artifactType: record.artifactType, storageId: record.storageId, checksum: record.checksum,
            mimeType: record.mimeType, compressedBytes: record.compressedBytes, uncompressedBytes: record.uncompressedBytes,
            status: record.storageId ? record.status : "prepared",
            rejectionReason: record.rejectionReason,
          }));
        } else if (input.entity === "items") {
          const refs = await ctx.runQuery(api.researchTransfer.resolveStableReferencesInternal, {
            userId: auth.userId, collectionId, sourceStableKeys: record.sourceStableKeys,
          });
          results.push(await ctx.runMutation(api.research.upsertItemInternal, {
            userId: auth.userId, collectionId,
            item: {
              stableKey: record.stableKey, idempotencyKey: record.idempotencyKey, itemType: record.itemType,
              contentHash: record.contentHash, ruleHash: record.ruleHash, normalizedRuleJson: record.normalizedRuleJson,
              strategyCard: record.strategyCard, sourceIds: refs.sourceIds, indicators: record.indicators,
              entries: record.entries, exits: record.exits, riskControls: record.riskControls, directions: record.directions,
              markets: record.markets, assets: record.assets, timeframes: record.timeframes,
              causalTimestampPolicy: record.causalTimestampPolicy, parserVersion: record.parserVersion,
              reviewStatus: record.reviewStatus, securityStatus: record.securityStatus,
            },
          }));
        } else if (input.entity === "variants") {
          const refs = await ctx.runQuery(api.researchTransfer.resolveStableReferencesInternal, {
            userId: auth.userId, collectionId, itemStableKey: record.itemStableKey,
          });
          results.push(await ctx.runMutation(api.research.upsertVariantInternal, {
            userId: auth.userId, collectionId,
            variant: {
              stableKey: record.stableKey, idempotencyKey: record.idempotencyKey, itemId: refs.itemId,
              parameterJson: record.parameterJson, parameterHash: record.parameterHash, market: record.market,
              venue: record.venue, symbol: record.symbol, timeframe: record.timeframe, direction: record.direction,
              executionAssumptionsJson: record.executionAssumptionsJson, variantHash: record.variantHash,
            },
          }));
        } else if (input.entity === "datasets") {
          const refs = record.artifactStableKey ? await ctx.runQuery(api.researchTransfer.resolveStableReferencesInternal, {
            userId: auth.userId, collectionId, artifactStableKeys: [record.artifactStableKey],
          }) : { artifactIds: [] };
          results.push(await ctx.runMutation(api.research.upsertDatasetInternal, {
            userId: auth.userId, collectionId,
            dataset: {
              stableKey: record.stableKey, idempotencyKey: record.idempotencyKey, provider: record.provider,
              venue: record.venue, symbols: record.symbols, resolution: record.resolution,
              startTimestamp: record.startTimestamp, endTimestamp: record.endTimestamp, retrievedAt: record.retrievedAt,
              checksum: record.checksum, adjustmentPolicy: record.adjustmentPolicy,
              missingDataPolicy: record.missingDataPolicy, timezonePolicy: record.timezonePolicy,
              causalityStatus: record.causalityStatus, artifactId: refs.artifactIds[0],
            },
          }));
        } else if (input.entity === "runs") {
          const refs = await ctx.runQuery(api.researchTransfer.resolveStableReferencesInternal, {
            userId: auth.userId, collectionId, itemStableKey: record.itemStableKey,
            variantStableKey: record.variantStableKey, datasetStableKey: record.datasetStableKey,
            artifactStableKeys: record.artifactStableKeys,
          });
          results.push(await ctx.runMutation(api.research.insertRunInternal, {
            userId: auth.userId, collectionId,
            run: {
              itemId: refs.itemId, variantId: refs.variantId, datasetId: refs.datasetId,
              runSpecHash: record.runSpecHash, idempotencyKey: record.idempotencyKey,
              engineVersion: record.engineVersion, codeVersion: record.codeVersion, fold: record.fold, seed: record.seed,
              splitJson: record.splitJson, costAssumptionsJson: record.costAssumptionsJson,
              startedAt: record.startedAt, completedAt: record.completedAt, status: record.status,
              netReturn: record.netReturn, sharpe: record.sharpe, maxDrawdown: record.maxDrawdown,
              winRate: record.winRate, tradeCount: record.tradeCount, rankingScore: record.rankingScore,
              robustnessScore: record.robustnessScore, metricsJson: record.metricsJson,
              failureReason: record.failureReason, artifactIds: refs.artifactIds,
            },
          }));
        } else if (input.entity === "rollups") {
          results.push(await ctx.runMutation(api.researchTransfer.restoreRollupInternal, {
            userId: auth.userId, collectionId,
            dimensionType: record.dimensionType, dimensionKey: record.dimensionKey,
            methodologyVersion: record.methodologyVersion, runCount: record.runCount,
            survivedCount: record.survivedCount, qualifiedCount: record.qualifiedCount,
            failedCount: record.failedCount, aggregateJson: record.aggregateJson, score: record.score,
          }));
        } else if (input.entity === "promotions") {
          const refs = await ctx.runQuery(api.researchTransfer.resolveStableReferencesInternal, {
            userId: auth.userId, collectionId, itemStableKey: record.itemStableKey,
            datasetStableKey: record.datasetStableKey, runSpecHash: record.runSpecHash,
          });
          if (!refs.itemId || !refs.runId || !refs.datasetId) {
            throw new Error("Promotion lineage was not restored before the promotion record");
          }
          results.push(await ctx.runAction(api.research.promoteInternal, {
            userId: auth.userId, collectionId, itemId: refs.itemId, runId: refs.runId,
            datasetId: refs.datasetId, knowledgeBaseId: input.knowledgeBaseId,
            reason: record.reason ?? "restored qualified research promotion",
          }));
        } else if (input.entity === "relations") {
          results.push(await ctx.runMutation(api.researchTransfer.restoreRelationInternal, {
            userId: auth.userId, collectionId,
            fromType: record.fromType, fromId: record.fromId, relationType: record.relationType,
            toType: record.toType, toId: record.toId, deterministicKey: record.deterministicKey,
            evidenceJson: record.evidenceJson,
          }));
        } else if (input.entity === "rejections") {
          results.push(await ctx.runMutation(api.researchTransfer.restoreRejectionInternal, {
            userId: auth.userId, collectionId,
            entityType: record.entityType, idempotencyKey: record.idempotencyKey,
            payloadHash: record.payloadHash, reason: record.reason,
            securityDisposition: record.securityDisposition, licenseDisposition: record.licenseDisposition,
          }));
        } else {
          return json({ error: "Unsupported restore entity" }, 400);
        }
      }
      return json({ entity: input.entity, restored: results.length, results }, 201);
    }

    if (request.method === "POST" && path.length === 1 && path[0] === "sources") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.upsertSourceInternal, {
        userId: auth.userId, collectionId: requiredId(input.collectionId, "collectionId"), source: input.source,
      }), 201);
    }
    if (request.method === "POST" && path[0] === "sources" && path[1] === "bulk") {
      const input = await body(request);
      const records = Array.isArray(input.sources) ? input.sources : [];
      if (records.length === 0) return json({ error: "sources[] is required" }, 400);
      if (records.length > 100) return json({ error: "sources[] is limited to 100 records per request; use a durable ingestion job for larger batches" }, 400);
      const results = [];
      for (const source of records) {
        results.push(await ctx.runMutation(api.research.upsertSourceInternal, {
          userId: auth.userId,
          collectionId: requiredId(input.collectionId, "collectionId"),
          source,
        }));
      }
      return json({
        submitted: records.length,
        inserted: results.filter((result) => result.created).length,
        duplicate: results.filter((result) => result.created === false).length,
        rejected: results.filter((result) => result.rejected).length,
      }, 201);
    }
    if (request.method === "POST" && path.length === 1 && path[0] === "items") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.upsertItemInternal, {
        userId: auth.userId, collectionId: requiredId(input.collectionId, "collectionId"), item: input.item,
      }), 201);
    }
    if (request.method === "POST" && path[0] === "items" && path[1] === "embedding") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.upsertItemEmbeddingInternal, {
        userId: auth.userId,
        collectionId: requiredId(input.collectionId, "collectionId"),
        itemId: requiredId(input.itemId, "itemId"),
        contentHash: input.contentHash,
        model: input.model,
        embedding: input.embedding,
      }), 201);
    }
    if (request.method === "POST" && path.length === 1 && path[0] === "variants") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.upsertVariantInternal, {
        userId: auth.userId, collectionId: requiredId(input.collectionId, "collectionId"), variant: input.variant,
      }), 201);
    }
    if (request.method === "POST" && path.length === 1 && path[0] === "datasets") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.upsertDatasetInternal, {
        userId: auth.userId, collectionId: requiredId(input.collectionId, "collectionId"), dataset: input.dataset,
      }), 201);
    }
    if (request.method === "POST" && path.length === 1 && path[0] === "runs") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.insertRunInternal, {
        userId: auth.userId, collectionId: requiredId(input.collectionId, "collectionId"), run: input.run,
      }), 201);
    }
    if (request.method === "POST" && path[0] === "runs" && path[1] === "bulk") {
      const input = await body(request);
      const records = Array.isArray(input.runs) ? input.runs : [];
      if (records.length === 0) return json({ error: "runs[] is required" }, 400);
      if (records.length > 1_000) return json({ error: "runs[] is limited to 1000 summaries per request; use a durable ingestion job for larger batches" }, 400);
      const aggregate = { submitted: 0, inserted: 0, duplicate: 0, runIds: [] as string[] };
      for (let offset = 0; offset < records.length; offset += 100) {
        const result = await ctx.runMutation(api.research.bulkInsertRunsInternal, {
          userId: auth.userId,
          collectionId: requiredId(input.collectionId, "collectionId"),
          runs: records.slice(offset, offset + 100),
        });
        aggregate.submitted += result.submitted;
        aggregate.inserted += result.inserted;
        aggregate.duplicate += result.duplicate;
        aggregate.runIds.push(...result.runIds.map(String));
      }
      return json(aggregate, 201);
    }

    if (request.method === "POST" && path[0] === "artifacts" && path[1] === "upload-url") {
      const input = await body(request);
      return json(await ctx.runMutation(api.researchArtifacts.createUploadUrlInternal, {
        userId: auth.userId,
        collectionId: requiredId(input.collectionId, "collectionId"),
        expectedBytes: input.expectedBytes,
        sourceId: input.sourceId,
        stableKey: input.stableKey,
        idempotencyKey: input.idempotencyKey,
        artifactType: input.artifactType,
        checksum: input.checksum,
        mimeType: input.mimeType,
        uncompressedBytes: input.uncompressedBytes,
        compressionType: input.compressionType,
      }));
    }
    if (request.method === "POST" && path[0] === "artifacts" && path[1] === "register") {
      const input = await body(request);
      const artifactId = requiredId(input.artifactId, "artifactId");
      const artifact = await ctx.runQuery(api.researchArtifacts.getVerificationContextInternal, { userId: auth.userId, artifactId });
      await boundScope(ctx, auth, String(artifact.collectionId));
      return json(await ctx.runAction(api.researchArtifacts.verifyAndAcceptInternal, {
        userId: auth.userId,
        artifactId,
        storageId: input.storageId,
      }), 201);
    }
    if (request.method === "GET" && path[0] === "artifacts" && path[2] === "read") {
      const url = new URL(request.url);
      const descriptor = await ctx.runQuery(api.researchArtifacts.getReadDescriptorInternal, {
        userId: auth.userId,
        artifactId: requiredId(path[1], "artifactId"),
        agentId: auth.key.boundAgentId ?? url.searchParams.get("agentId") ?? undefined,
        channel: auth.key.boundChannel ?? url.searchParams.get("channel") ?? undefined,
      });
      if (!descriptor) return json({ error: "Artifact not found" }, 404);
      await boundScope(ctx, auth, String(descriptor.collectionId), {
        agentId: url.searchParams.get("agentId") || undefined,
        channel: url.searchParams.get("channel") || undefined,
      });
      const storageUrl = await ctx.storage.getUrl(descriptor.storageId);
      if (!storageUrl) return json({ error: "Artifact bytes not found" }, 404);
      return Response.redirect(storageUrl, 307);
    }

    if (request.method === "POST" && path.length === 1 && path[0] === "jobs") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.createJobInternal, {
        userId: auth.userId,
        collectionId: requiredId(input.collectionId, "collectionId"),
        jobType: input.jobType,
        idempotencyKey: input.idempotencyKey,
        manifestJson: typeof input.manifestJson === "string" ? input.manifestJson : JSON.stringify(input.manifest ?? {}),
        totalCount: input.totalCount,
      }), 201);
    }
    if (request.method === "POST" && path[0] === "jobs" && path[2] === "shards") {
      const input = await body(request);
      const job = await ctx.runQuery(api.research.getJobStatusInternal, { userId: auth.userId, jobId: requiredId(path[1], "jobId") });
      if (!job) throw new ResearchHttpError("Research job not found", 404, "research_not_found");
      await boundScope(ctx, auth, String(job.collectionId));
      return json(await ctx.runMutation(api.research.enqueueShardInternal, {
        userId: auth.userId, jobId: requiredId(path[1], "jobId"),
        shardKey: input.shardKey, ordinal: input.ordinal, totalCount: input.totalCount, maxAttempts: input.maxAttempts,
      }), 201);
    }
    if (request.method === "POST" && path[0] === "jobs" && path[2] === "claim") {
      const input = await body(request);
      const job = await ctx.runQuery(api.research.getJobStatusInternal, { userId: auth.userId, jobId: requiredId(path[1], "jobId") });
      if (!job) throw new ResearchHttpError("Research job not found", 404, "research_not_found");
      await boundScope(ctx, auth, String(job.collectionId));
      return json(await ctx.runMutation(api.research.claimShardInternal, {
        userId: auth.userId, jobId: requiredId(path[1], "jobId"), workerId: input.workerId, leaseMs: input.leaseMs,
      }));
    }
    if (request.method === "POST" && path[0] === "shards" && path[2] === "heartbeat") {
      const input = await body(request);
      const shard = await ctx.runQuery(api.research.getShardStatusInternal, { userId: auth.userId, shardId: requiredId(path[1], "shardId") });
      if (!shard) throw new ResearchHttpError("Research shard not found", 404, "research_not_found");
      await boundScope(ctx, auth, String(shard.collectionId));
      return json(await ctx.runMutation(api.research.heartbeatShardInternal, {
        userId: auth.userId, shardId: requiredId(path[1], "shardId"), workerId: input.workerId,
        progressCount: input.progressCount, cursor: input.cursor, leaseMs: input.leaseMs,
      }));
    }
    if (request.method === "POST" && path[0] === "shards" && path[2] === "ingest") {
      const input = await body(request);
      const shardId = requiredId(path[1], "shardId");
      const shard = await ctx.runQuery(api.research.getShardStatusInternal, { userId: auth.userId, shardId });
      if (!shard) throw new ResearchHttpError("Research shard not found", 404, "research_not_found");
      await boundScope(ctx, auth, String(shard.collectionId));
      if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
        throw new ResearchHttpError("payload must be an object", 400, "research_invalid_payload");
      }
      const payloadJson = canonicalJson(input.payload);
      const payloadHash = await sha256Hex(payloadJson);
      if (input.payloadHash !== undefined && input.payloadHash !== payloadHash) {
        throw new ResearchHttpError("Worker payloadHash does not match the server-derived hash", 400, "research_payload_hash_mismatch");
      }
      const prepared = await ctx.runMutation(api.research.prepareIngestRecordInternal, {
        userId: auth.userId, shardId, workerId: input.workerId,
        recordType: input.recordType, idempotencyKey: input.idempotencyKey, payloadHash, payloadJson,
      });
      if (!prepared.created && prepared.status !== "prepared") {
        return json({ recordId: prepared.recordId, status: prepared.status, resultingEntityId: prepared.resultingEntityId, replay: true });
      }
      let result: any;
      try {
        if (input.recordType === "source") {
          result = await ctx.runMutation(api.research.upsertSourceInternal, {
            userId: auth.userId, collectionId: prepared.collectionId, source: input.payload,
          });
        } else if (input.recordType === "item") {
          result = await ctx.runMutation(api.research.upsertItemInternal, {
            userId: auth.userId, collectionId: prepared.collectionId, item: input.payload,
          });
        } else if (input.recordType === "variant") {
          result = await ctx.runMutation(api.research.upsertVariantInternal, {
            userId: auth.userId, collectionId: prepared.collectionId, variant: input.payload,
          });
        } else if (input.recordType === "dataset") {
          result = await ctx.runMutation(api.research.upsertDatasetInternal, {
            userId: auth.userId, collectionId: prepared.collectionId, dataset: input.payload,
          });
        } else if (input.recordType === "run") {
          result = await ctx.runMutation(api.research.insertRunInternal, {
            userId: auth.userId, collectionId: prepared.collectionId, run: input.payload,
          });
        } else {
          throw new ResearchHttpError(`Unsupported ingest recordType: ${input.recordType}`, 400, "research_unsupported_record_type");
        }
        const resultingEntityId = String(result.sourceId ?? result.itemId ?? result.variantId ?? result.datasetId ?? result.runId ?? "") || undefined;
        const outcome = result.rejected ? "rejected"
          : input.recordType === "source" && input.payload.quarantineState === "quarantined" ? "quarantined"
            : result.created === false ? "duplicate" : "imported";
        const committed = await ctx.runMutation(api.research.commitIngestRecordInternal, {
          userId: auth.userId, recordId: prepared.recordId, workerId: input.workerId,
          outcome, resultingEntityId, rejectionReason: result.reason,
        });
        return json({ recordId: prepared.recordId, payloadHash, ...committed }, prepared.created ? 201 : 200);
      } catch (error) {
        await ctx.runMutation(api.research.commitIngestRecordInternal, {
          userId: auth.userId, recordId: prepared.recordId, workerId: input.workerId,
          outcome: "failed", rejectionReason: error instanceof Error ? error.message : String(error),
        }).catch(() => null);
        throw error;
      }
    }
    if (request.method === "POST" && path[0] === "shards" && path[2] === "complete") {
      const input = await body(request);
      const shard = await ctx.runQuery(api.research.getShardStatusInternal, { userId: auth.userId, shardId: requiredId(path[1], "shardId") });
      if (!shard) throw new ResearchHttpError("Research shard not found", 404, "research_not_found");
      await boundScope(ctx, auth, String(shard.collectionId));
      return json(await ctx.runMutation(api.research.completeShardInternal, {
        userId: auth.userId, shardId: requiredId(path[1], "shardId"), workerId: input.workerId,
        importedCount: input.importedCount, duplicateCount: input.duplicateCount, rejectedCount: input.rejectedCount,
        quarantinedCount: input.quarantinedCount, failedCount: input.failedCount, error: input.error,
      }));
    }
    if (request.method === "POST" && path[0] === "jobs" && path[2] === "state") {
      const input = await body(request);
      const job = await ctx.runQuery(api.research.getJobStatusInternal, { userId: auth.userId, jobId: requiredId(path[1], "jobId") });
      if (!job) throw new ResearchHttpError("Research job not found", 404, "research_not_found");
      await boundScope(ctx, auth, String(job.collectionId));
      return json(await ctx.runMutation(api.research.setJobStateInternal, {
        userId: auth.userId, jobId: requiredId(path[1], "jobId"), state: input.state,
      }));
    }
    if (request.method === "GET" && path[0] === "jobs" && path[2] === "status") {
      const result = await ctx.runQuery(api.research.getJobStatusInternal, {
        userId: auth.userId, jobId: requiredId(path[1], "jobId"),
      });
      if (result) await boundScope(ctx, auth, String(result.collectionId));
      return result ? json(result) : json({ error: "Research job not found", code: "research_not_found", retryable: false }, 404);
    }

    if (request.method === "GET" && path[0] === "collections" && path[2] === "jobs") {
      const url = new URL(request.url);
      assertAllowedParams(url.searchParams, ["status", "cursor", "limit"]);
      return json(publicPage(await ctx.runQuery(api.research.listJobsInternal, {
        userId: auth.userId, collectionId: requiredId(path[1], "collectionId"),
        status: url.searchParams.get("status") || undefined,
        cursor: url.searchParams.get("cursor") || undefined, limit: numberParam(url.searchParams.get("limit")),
      })));
    }
    if (request.method === "GET" && path[0] === "jobs" && path[2] === "shards") {
      const url = new URL(request.url);
      assertAllowedParams(url.searchParams, ["status", "cursor", "limit"]);
      const jobId = requiredId(path[1], "jobId");
      const job = await ctx.runQuery(api.research.getJobStatusInternal, { userId: auth.userId, jobId });
      if (!job) throw new ResearchHttpError("Research job not found", 404, "research_not_found");
      await boundScope(ctx, auth, String(job.collectionId));
      return json(publicPage(await ctx.runQuery(api.research.listJobShardsInternal, {
        userId: auth.userId, jobId, status: url.searchParams.get("status") || undefined,
        cursor: url.searchParams.get("cursor") || undefined, limit: numberParam(url.searchParams.get("limit")),
      })));
    }
    if (request.method === "GET" && path[0] === "collections" && path[2] === "rollups") {
      const url = new URL(request.url);
      assertAllowedParams(url.searchParams, ["dimensionType", "cursor", "limit"]);
      return json(publicPage(await ctx.runQuery(api.research.listRollupsInternal, {
        userId: auth.userId, collectionId: requiredId(path[1], "collectionId"),
        dimensionType: url.searchParams.get("dimensionType") || undefined,
        cursor: url.searchParams.get("cursor") || undefined, limit: numberParam(url.searchParams.get("limit")),
      })));
    }
    if (request.method === "GET" && path[0] === "collections" && path[2] === "promotions") {
      const url = new URL(request.url);
      assertAllowedParams(url.searchParams, ["status", "cursor", "limit"]);
      return json(publicPage(await ctx.runQuery(api.research.listPromotionsInternal, {
        userId: auth.userId, collectionId: requiredId(path[1], "collectionId"),
        status: url.searchParams.get("status") || undefined,
        cursor: url.searchParams.get("cursor") || undefined, limit: numberParam(url.searchParams.get("limit")),
      })));
    }

    if (request.method === "GET" && path[0] === "collections" && path[2] === "stats") {
      return json(await ctx.runQuery(api.research.getCollectionStatsInternal, {
        userId: auth.userId, collectionId: requiredId(path[1], "collectionId"),
      }));
    }
    if (request.method === "POST" && path.length === 1 && path[0] === "query") {
      const input = await body(request);
      const commonFields = ["kind", "collectionId", "agentId", "channel", "cursor", "limit"];
      const scope = primaryScope ?? await boundScope(ctx, auth, requiredId(input.collectionId, "collectionId"), { agentId: input.agentId, channel: input.channel });
      const common = {
        userId: auth.userId,
        collectionId: requiredId(input.collectionId, "collectionId"),
        agentId: scope.agentId,
        channel: scope.channel,
        cursor: input.cursor,
        limit: input.limit,
      };
      if (input.kind === "items") {
        assertAllowedFields(input, [...commonFields, "itemType", "reviewStatus", "securityStatus", "market", "asset", "timeframe", "direction"]);
        return json(publicPage(await ctx.runQuery(api.research.queryItemsInternal, {
          ...common, itemType: input.itemType, reviewStatus: input.reviewStatus, securityStatus: input.securityStatus,
          market: input.market, asset: input.asset, timeframe: input.timeframe, direction: input.direction,
        })));
      }
      if (input.kind === "runs") {
        assertAllowedFields(input, [...commonFields, "status", "itemId", "variantId", "datasetId", "minRankingScore", "minRobustnessScore", "minSharpe", "maxDrawdown", "minTradeCount", "startedFrom", "startedTo", "completedFrom", "completedTo", "sortBy"]);
        return json(publicPage(await ctx.runQuery(api.research.queryRunsInternal, {
          ...common, status: input.status,
          itemId: input.itemId ? requiredId(input.itemId, "itemId") : undefined,
          variantId: input.variantId ? requiredId(input.variantId, "variantId") : undefined,
          datasetId: input.datasetId ? requiredId(input.datasetId, "datasetId") : undefined,
          minRankingScore: input.minRankingScore, minRobustnessScore: input.minRobustnessScore,
          minSharpe: input.minSharpe, maxDrawdown: input.maxDrawdown, minTradeCount: input.minTradeCount,
          startedFrom: input.startedFrom, startedTo: input.startedTo, completedFrom: input.completedFrom,
          completedTo: input.completedTo, sortBy: input.sortBy,
        })));
      }
      if (input.kind === "semantic") {
        assertAllowedFields(input, [...commonFields, "query", "embedding", "model"]);
        return json(await ctx.runAction(api.research.semanticSearchInternal, {
          ...common, query: input.query, embedding: input.embedding, model: input.model ?? "gemini-embedding-2-preview",
        }));
      }
      return json({ error: "kind must be items, runs, or semantic" }, 400);
    }
    if (request.method === "GET" && path[0] === "trace") {
      const url = new URL(request.url);
      assertAllowedParams(url.searchParams, ["runId"]);
      const runId = requiredId(url.searchParams.get("runId"), "runId");
      const result = await ctx.runQuery(api.research.getTraceInternal, { userId: auth.userId, runId });
      if (result) await boundScope(ctx, auth, String(result.run.collectionId));
      return result ? json(result) : json({ error: "Research run not found" }, 404);
    }
    if (request.method === "POST" && path[0] === "promote") {
      const input = await body(request);
      return json(await ctx.runAction(api.research.promoteInternal, {
        userId: auth.userId,
        collectionId: requiredId(input.collectionId, "collectionId"),
        itemId: requiredId(input.itemId, "itemId"),
        runId: requiredId(input.runId, "runId"),
        datasetId: requiredId(input.datasetId, "datasetId"),
        knowledgeBaseId: input.knowledgeBaseId,
        reason: input.reason,
      }), 201);
    }
    if (request.method === "POST" && path[0] === "demote") {
      const input = await body(request);
      const promotion = await ctx.runQuery(api.research.getPromotionInternal, {
        userId: auth.userId, promotionId: requiredId(input.promotionId, "promotionId"),
      });
      if (!promotion) throw new ResearchHttpError("Research promotion not found", 404, "research_not_found");
      await boundScope(ctx, auth, String(promotion.collectionId));
      return json(await ctx.runMutation(api.research.demoteInternal, {
        userId: auth.userId,
        promotionId: requiredId(input.promotionId, "promotionId"),
        reason: input.reason,
      }));
    }
    if (request.method === "POST" && path[0] === "memory") {
      const input = await body(request);
      return json({ memoryId: await ctx.runAction(api.research.recordDurableFindingInternal, {
        userId: auth.userId,
        collectionId: requiredId(input.collectionId, "collectionId"),
        category: input.category,
        title: input.title,
        content: input.content,
        channel: input.channel,
        tags: input.tags,
      }) }, 201);
    }

    return json({ error: "Research route not found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
});
