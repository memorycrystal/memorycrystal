import type { ActionCtx } from "../_generated/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

const api = (internal as any).crystal;
const ID_RE = /^[a-z0-9]{10,40}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Uncaught Error:\s*/i, "").split("\n")[0].trim();
  if (/too many writes per second|changed while this mutation was being run|rate limit/i.test(message)) {
    return json({ error: message }, 429);
  }
  if (/bootstrapping|temporarily unavailable/i.test(message)) {
    return json({ error: message }, 503);
  }
  if (/not found/i.test(message)) return json({ error: message }, 404);
  if (/capacity policy|not enabled/i.test(message)) return json({ error: message }, 403);
  return json({ error: message }, 400);
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

async function authorize(ctx: ActionCtx, request: Request) {
  const token = bearer(request);
  if (!token) return null;
  const keyHash = await sha256Hex(token);
  const key = await ctx.runQuery(api.mcp.getApiKeyRecord, { keyHash });
  if (!key || !key.active || typeof key.userId !== "string") return null;
  if (key.expiresAt && key.expiresAt < Date.now()) return null;
  ctx.runMutation(api.apiKeys.touchLastUsedAt, { keyHash }).catch(() => null);
  return { userId: key.userId as string, keyHash };
}

async function enforceRateLimit(ctx: ActionCtx, keyHash: string): Promise<Response | null> {
  const result = await ctx.runMutation(api.mcp.checkAndIncrementRateLimit, { key: `research:${keyHash}` });
  if (result.allowed) return null;
  return json({ error: "Capacity-policy request limit exceeded", retryAfterSeconds: 60 }, 429);
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
      const url = new URL(request.url);
      return json(await ctx.runQuery(api.research.listCollectionsInternal, {
        userId: auth.userId,
        status: url.searchParams.get("status") || undefined,
        cursor: url.searchParams.get("cursor") || undefined,
        limit: numberParam(url.searchParams.get("limit")),
      }));
    }
    if (request.method === "POST") {
      const input = await body(request);
      const collectionId = await ctx.runMutation(api.research.createCollectionInternal, {
        userId: auth.userId,
        name: input.name,
        domain: input.domain,
        description: input.description,
        retentionPolicy: input.retentionPolicy,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        channel: input.channel,
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
    if (request.method === "POST" && path[0] === "collections" && path[2] === "archive") {
      return json(await ctx.runMutation(api.research.archiveCollectionInternal, {
        userId: auth.userId,
        collectionId: requiredId(path[1], "collectionId"),
        archived: (await body(request)).archived !== false,
      }));
    }
    if (request.method === "GET" && path[0] === "collections" && path[2] === "export") {
      const url = new URL(request.url);
      return json(await ctx.runQuery(api.researchTransfer.exportPageInternal, {
        userId: auth.userId,
        collectionId: requiredId(path[1], "collectionId"),
        entity: url.searchParams.get("entity"),
        cursor: url.searchParams.get("cursor") || undefined,
        limit: numberParam(url.searchParams.get("limit")),
      }));
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
      }));
    }
    if (request.method === "POST" && path[0] === "artifacts" && path[1] === "register") {
      const input = await body(request);
      return json(await ctx.runMutation(api.researchArtifacts.registerInternal, {
        userId: auth.userId,
        collectionId: requiredId(input.collectionId, "collectionId"),
        sourceId: input.sourceId,
        stableKey: input.stableKey,
        idempotencyKey: input.idempotencyKey,
        artifactType: input.artifactType,
        storageId: input.storageId,
        checksum: input.checksum,
        mimeType: input.mimeType,
        compressedBytes: input.compressedBytes,
        uncompressedBytes: input.uncompressedBytes,
        status: input.status,
        rejectionReason: input.rejectionReason,
      }), 201);
    }
    if (request.method === "GET" && path[0] === "artifacts" && path[2] === "read") {
      const url = new URL(request.url);
      const descriptor = await ctx.runQuery(api.researchArtifacts.getReadDescriptorInternal, {
        userId: auth.userId,
        artifactId: requiredId(path[1], "artifactId"),
        agentId: url.searchParams.get("agentId") || undefined,
        channel: url.searchParams.get("channel") || undefined,
      });
      if (!descriptor) return json({ error: "Artifact not found" }, 404);
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
      return json(await ctx.runMutation(api.research.enqueueShardInternal, {
        userId: auth.userId, jobId: requiredId(path[1], "jobId"),
        shardKey: input.shardKey, ordinal: input.ordinal, totalCount: input.totalCount, maxAttempts: input.maxAttempts,
      }), 201);
    }
    if (request.method === "POST" && path[0] === "jobs" && path[2] === "claim") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.claimShardInternal, {
        userId: auth.userId, jobId: requiredId(path[1], "jobId"), workerId: input.workerId, leaseMs: input.leaseMs,
      }));
    }
    if (request.method === "POST" && path[0] === "shards" && path[2] === "heartbeat") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.heartbeatShardInternal, {
        userId: auth.userId, shardId: requiredId(path[1], "shardId"), workerId: input.workerId,
        progressCount: input.progressCount, cursor: input.cursor, leaseMs: input.leaseMs,
      }));
    }
    if (request.method === "POST" && path[0] === "shards" && path[2] === "complete") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.completeShardInternal, {
        userId: auth.userId, shardId: requiredId(path[1], "shardId"), workerId: input.workerId,
        importedCount: input.importedCount ?? 0, rejectedCount: input.rejectedCount ?? 0,
        quarantinedCount: input.quarantinedCount ?? 0, failedCount: input.failedCount ?? 0, error: input.error,
      }));
    }
    if (request.method === "POST" && path[0] === "jobs" && path[2] === "state") {
      const input = await body(request);
      return json(await ctx.runMutation(api.research.setJobStateInternal, {
        userId: auth.userId, jobId: requiredId(path[1], "jobId"), state: input.state,
      }));
    }
    if (request.method === "GET" && path[0] === "jobs" && path[2] === "status") {
      const result = await ctx.runQuery(api.research.getJobStatusInternal, {
        userId: auth.userId, jobId: requiredId(path[1], "jobId"),
      });
      return result ? json(result) : json({ error: "Research job not found" }, 404);
    }

    if (request.method === "GET" && path[0] === "collections" && path[2] === "stats") {
      return json(await ctx.runQuery(api.research.getCollectionStatsInternal, {
        userId: auth.userId, collectionId: requiredId(path[1], "collectionId"),
      }));
    }
    if (request.method === "POST" && path.length === 1 && path[0] === "query") {
      const input = await body(request);
      const common = {
        userId: auth.userId,
        collectionId: requiredId(input.collectionId, "collectionId"),
        agentId: input.agentId,
        channel: input.channel,
        cursor: input.cursor,
        limit: input.limit,
      };
      if (input.kind === "items") return json(await ctx.runQuery(api.research.queryItemsInternal, { ...common, itemType: input.itemType, reviewStatus: input.reviewStatus }));
      if (input.kind === "runs") return json(await ctx.runQuery(api.research.queryRunsInternal, { ...common, status: input.status }));
      if (input.kind === "semantic") return json(await ctx.runAction(api.research.semanticSearchInternal, {
        ...common, query: input.query, embedding: input.embedding, model: input.model ?? "gemini-embedding-2-preview",
      }));
      return json({ error: "kind must be items, runs, or semantic" }, 400);
    }
    if (request.method === "GET" && path[0] === "trace") {
      const runId = requiredId(new URL(request.url).searchParams.get("runId"), "runId");
      const result = await ctx.runQuery(api.research.getTraceInternal, { userId: auth.userId, runId });
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
