/**
 * Local-stack telemetry push — M6.
 *
 * Compiles local stats into a v1 telemetry payload and queues it for delivery
 * to the cloud control-plane at ${MC_CLOUD_TELEMETRY_URL}/api/cloud/telemetry/push.
 *
 * Architecture:
 *   tickTelemetry()   (cron, every 15 min)  → compileStatsPayload + enqueueTelemetry
 *   flushTelemetry()  (cron, every 60s)      → read localTelemetryQueue + POST to cloud
 *
 * Dependency on M5:
 *   This module reads from and writes to the `localTelemetryQueue` table defined
 *   by M5 (convex/local/apiKeys.ts schema additions). If that table is not yet
 *   present in the schema, the queries will fail at runtime with a Convex
 *   "unknown table" error. M5 must be merged before M6 is deployed.
 *
 *   Expected schema from M5 (document the gap here for M3 reconciliation):
 *   ```ts
 *   localTelemetryQueue: defineTable({
 *     payloadId:      v.string(),
 *     payload:        v.any(),
 *     status:         v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
 *     attemptedCount: v.number(),
 *     nextAttemptAt:  v.number(),
 *     createdAt:      v.number(),
 *   })
 *     .index("by_status_nextAttemptAt", ["status", "nextAttemptAt"])
 *     .index("by_payloadId", ["payloadId"])
 *   ```
 *
 *   Also references `applyCloudRevocations` from `convex/local/apiKeys.ts` (M5).
 *   That function is imported conditionally so this file compiles even before M5
 *   lands, but will throw at runtime if called without M5.
 *
 * Idempotency:
 *   payloadId is generated with crypto.randomUUID() at enqueue time. The cloud
 *   side deduplicates by payloadId. enqueueTelemetry checks the queue for an
 *   existing pending row with the same payloadId before inserting, making
 *   double-enqueue safe.
 *
 * No memory content:
 *   compileStatsPayload queries only aggregate counts from crystalMemories —
 *   it never returns memory titles, bodies, embeddings, or any PII.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max retry delay: 1 hour */
const MAX_RETRY_DELAY_MS = 3_600_000;
const BASE_RETRY_DELAY_MS = 60_000;
const FLUSH_BATCH_SIZE = 5;

// ---------------------------------------------------------------------------
// compileStatsPayload — build a v1-conformant payload from local tables
// ---------------------------------------------------------------------------

export const compileStatsPayload = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const ms24h = 24 * 60 * 60 * 1000;
    const cutoff24h = now - ms24h;

    // ── Tenant ID ──────────────────────────────────────────────────────────
    // bootstrapState table is written by M5's bootstrap flow.
    // We fall back to the env var MC_TENANT_ID if the table row is absent.
    const bootstrapEnvTenantId = process.env.MC_TENANT_ID ?? "";
    let tenantId = bootstrapEnvTenantId;
    try {
      const bootstrapRow = await (ctx.db as any)
        .query("bootstrapState")
        .withIndex("by_marker", (q: any) => q.eq("marker", "singleton"))
        .unique();
      if (bootstrapRow?.tenantId) tenantId = bootstrapRow.tenantId;
    } catch {
      // bootstrapState table not yet present (pre-M5 deploy) — use env var
    }

    // ── MC version ─────────────────────────────────────────────────────────
    const mcVersion = process.env.MC_VERSION ?? "0.0.0-dev";

    // ── Embedder ───────────────────────────────────────────────────────────
    // Derive from env vars set in the docker compose .env
    let embedder: "gemini" | "openai" | "none" = "none";
    if (process.env.GEMINI_API_KEY) embedder = "gemini";
    else if (process.env.OPENAI_API_KEY) embedder = "openai";

    // ── Memory counts ──────────────────────────────────────────────────────
    // Query crystalMemories for aggregate counts only — no content or titles.
    const SAMPLE_LIMIT = 2000;

    // by_user index is ["userId", "archived"] — scan all users without filter
    // since local stack is single-tenant. We use a table scan limited to SAMPLE_LIMIT.
    const allMemoriesSample = await ctx.db
      .query("crystalMemories")
      .take(SAMPLE_LIMIT * 2);

    const activeMemoriesSample = allMemoriesSample.filter((m: any) => !m.archived);
    const memory_count = activeMemoriesSample.length;

    const archivedSample = allMemoriesSample.filter((m: any) => m.archived);
    const archived_count = archivedSample.length;

    const captures_24h = activeMemoriesSample.filter(
      (m: any) => m.createdAt >= cutoff24h,
    ).length;

    // ── Last activity ──────────────────────────────────────────────────────
    const lastMemory = [...activeMemoriesSample]
      .sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
    const last_activity_at = lastMemory?.createdAt ?? now;

    // ── Storage bytes ─────────────────────────────────────────────────────
    // Estimate: average ~2KB per memory row (title + store metadata, no body)
    const APPROX_BYTES_PER_MEMORY = 2048;
    const storage_bytes = (memory_count + archived_count) * APPROX_BYTES_PER_MEMORY;

    // ── Error count (last 24h) ─────────────────────────────────────────────
    // Read from crystalMetrics table if present; fallback to 0.
    let errors_24h = 0;
    try {
      const metricRows = await (ctx.db as any)
        .query("crystalMetrics")
        .withIndex("by_createdAt", (q: any) => q.gte("createdAt", cutoff24h))
        .take(500);
      errors_24h = metricRows.filter(
        (m: any) => typeof m.key === "string" && m.key.startsWith("mcp.error."),
      ).length;
    } catch {
      // crystalMetrics table may not exist in all deployments
    }

    // ── Online since ───────────────────────────────────────────────────────
    // Use the bootstrapState.readyAt if available, else current time.
    let online_since = now;
    try {
      const bootstrapRow = await (ctx.db as any)
        .query("bootstrapState")
        .withIndex("by_marker", (q: any) => q.eq("marker", "singleton"))
        .unique();
      if (bootstrapRow?.lastFetchAttemptAt && bootstrapRow.state === "ready") {
        online_since = bootstrapRow.lastFetchAttemptAt;
      }
    } catch {
      // not yet present
    }

    const payloadId = crypto.randomUUID();

    return {
      payloadVersion: "v1" as const,
      payloadId,
      tenant_id: tenantId,
      tenantId,
      mc_version: mcVersion,
      last_activity_at,
      memory_count,
      archived_count,
      captures_24h,
      storage_bytes,
      embedder,
      errors_24h,
      online_since,
    };
  },
});

// ---------------------------------------------------------------------------
// enqueueTelemetry — write payload to localTelemetryQueue
// ---------------------------------------------------------------------------

export const enqueueTelemetry = internalMutation({
  args: {
    payload: v.any(),
  },
  handler: async (ctx, { payload }) => {
    const payloadId: string = payload.payloadId;

    // Idempotency: skip if this payloadId is already in the queue
    const existing = await (ctx.db as any)
      .query("localTelemetryQueue")
      .withIndex("by_payloadId", (q: any) => q.eq("payloadId", payloadId))
      .first();
    if (existing) return; // already enqueued — safe no-op

    await (ctx.db as any).insert("localTelemetryQueue", {
      payloadId,
      payload,
      status: "pending",
      attemptedCount: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// _markSent — mark a queue row as sent
// ---------------------------------------------------------------------------

export const _markSent = internalMutation({
  args: { rowId: v.string() },
  handler: async (ctx, { rowId }) => {
    await (ctx.db as any).patch(rowId, { status: "sent" });
  },
});

// ---------------------------------------------------------------------------
// _markFailed — mark a queue row as permanently failed (4xx)
// ---------------------------------------------------------------------------

export const _markFailed = internalMutation({
  args: { rowId: v.string(), errorMessage: v.string() },
  handler: async (ctx, { rowId, errorMessage: _errorMessage }) => {
    // Note: localTelemetryQueue schema has no `lastError` field (M5 schema).
    // We only flip the status to "failed"; error detail is in Convex logs.
    await (ctx.db as any).patch(rowId, {
      status: "failed",
    });
  },
});

// ---------------------------------------------------------------------------
// _bumpRetry — exponential backoff for 429/5xx
// ---------------------------------------------------------------------------

export const _bumpRetry = internalMutation({
  args: { rowId: v.string(), attemptedCount: v.number() },
  handler: async (ctx, { rowId, attemptedCount }) => {
    const newCount = attemptedCount + 1;
    const delay = Math.min(
      BASE_RETRY_DELAY_MS * Math.pow(2, attemptedCount),
      MAX_RETRY_DELAY_MS,
    );
    await (ctx.db as any).patch(rowId, {
      attemptedCount: newCount,
      nextAttemptAt: Date.now() + delay,
    });
  },
});

// ---------------------------------------------------------------------------
// _getPendingRows — fetch pending rows due for delivery
// ---------------------------------------------------------------------------

export const _getPendingRows = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    return await (ctx.db as any)
      .query("localTelemetryQueue")
      .withIndex("by_status_nextAttempt", (q: any) =>
        q.eq("status", "pending").lte("nextAttemptAt", now),
      )
      .take(FLUSH_BATCH_SIZE);
  },
});

// ---------------------------------------------------------------------------
// flushTelemetry — internal action (cron every 60s)
// ---------------------------------------------------------------------------

export const flushTelemetry = internalAction({
  args: {},
  handler: async (ctx) => {
    const cloudUrl = process.env.MC_CLOUD_TELEMETRY_URL;
    const token = process.env.MC_TUNNEL_TELEMETRY_TOKEN;

    if (!cloudUrl || !token) {
      // Not yet configured — skip silently. This is normal before bootstrap.
      return;
    }

    // _generated/api is stale until `npx convex dev` re-runs; cast to any for
    // the new local/ module references (resolved at Convex deploy time).
    const iLocal = (internal as any).local;

    const rows = await ctx.runQuery(iLocal.telemetryPush._getPendingRows, {});
    if (rows.length === 0) return;

    for (const row of rows) {
      const rowId = String(row._id);
      let response: Response;

      try {
        response = await fetch(`${cloudUrl}/api/cloud/telemetry/push`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(row.payload),
        });
      } catch (networkErr) {
        // Network error — treat as transient, bump retry
        await ctx.runMutation(iLocal.telemetryPush._bumpRetry, {
          rowId,
          attemptedCount: row.attemptedCount,
        });
        continue;
      }

      if (response.status === 200) {
        // Success — mark sent, then apply any revoked keys from cloud
        await ctx.runMutation(iLocal.telemetryPush._markSent, { rowId });

        let responseBody: {
          accepted?: boolean;
          duplicate?: boolean;
          revoked_keys?: string[];
        } = {};
        try {
          responseBody = await response.json();
        } catch {
          // Non-JSON response — ignore, row is still marked sent
        }

        const revokedKeys: string[] = responseBody.revoked_keys ?? [];
        if (revokedKeys.length > 0) {
          // Delegate to M5's applyCloudRevocations.
          // Cast to any because _generated/api.d.ts is stale (pre-deploy).
          // If M5 has not yet landed this function, the call will throw at
          // runtime — documented as a pre-deployment dependency above.
          try {
            await ctx.runMutation(
              iLocal.apiKeys.applyCloudRevocations,
              { revokedHashes: revokedKeys },
            );
          } catch (err) {
            // M5's applyCloudRevocations not yet deployed — log and continue.
            console.warn(
              "[telemetryPush] applyCloudRevocations not available (M5 not deployed?):",
              (err as Error).message,
            );
          }
        }
      } else if (response.status === 429 || response.status >= 500) {
        // Transient — exponential backoff
        await ctx.runMutation(iLocal.telemetryPush._bumpRetry, {
          rowId,
          attemptedCount: row.attemptedCount,
        });
      } else {
        // 4xx (other than 429) — permanent failure
        let errorBody = `HTTP ${response.status}`;
        try {
          const j = await response.json();
          errorBody = `HTTP ${response.status}: ${JSON.stringify(j)}`;
        } catch {
          // ignore
        }
        await ctx.runMutation(iLocal.telemetryPush._markFailed, {
          rowId,
          errorMessage: errorBody,
        });
      }
    }
  },
});

// ---------------------------------------------------------------------------
// tickTelemetry — internal action (cron every 15 min)
// ---------------------------------------------------------------------------

export const tickTelemetry = internalAction({
  args: {},
  handler: async (ctx) => {
    // Cast to any: _generated/api is stale until npx convex dev re-runs.
    const iLocal = (internal as any).local;

    const payload = await ctx.runQuery(
      iLocal.telemetryPush.compileStatsPayload,
      {},
    );

    // Only enqueue if tenant is configured (has a non-empty tenantId)
    if (!payload.tenant_id) {
      return; // Not bootstrapped yet — skip
    }

    await ctx.runMutation(iLocal.telemetryPush.enqueueTelemetry, {
      payload,
    });
  },
});
