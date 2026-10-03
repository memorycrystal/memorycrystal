# M6 Telemetry Roll-up Contract

This document describes the telemetry push contract between the local Memory Crystal stack and the cloud control-plane.

---

## Overview

The local stack periodically compiles aggregate statistics and delivers them to the cloud via an authenticated HTTP POST. **No end-user memory content ever transits this boundary** — only structured metadata counts (Principle 1).

---

## Payload Shape

The canonical payload schema is at `shared/telemetry/v1.schema.json`. All fields are required unless marked optional.

| Field            | Type            | Description                                                    |
|------------------|-----------------|----------------------------------------------------------------|
| `payloadVersion` | `"v1"`          | Schema version literal. Cloud accepts `"v1"` and `"v2"`.      |
| `payloadId`      | `string` (UUID) | Idempotency key — re-POSTing the same ID is a no-op.          |
| `tenant_id`      | `string`        | Cloud tenant ID (Convex document ID). Wire canonical field.    |
| `tenantId`       | `string`        | Alias of `tenant_id` (camelCase). Must carry the same value.   |
| `mc_version`     | `string`        | Semver of the local stack (from `MC_VERSION` env).             |
| `last_activity_at` | `number`      | Unix ms of most recent memory capture / session activity.      |
| `memory_count`   | `integer ≥ 0`   | Total non-archived memory count.                               |
| `archived_count` | `integer ≥ 0`   | Total archived memory count.                                   |
| `captures_24h`   | `integer ≥ 0`   | Memory captures in the last 24 hours.                          |
| `storage_bytes`  | `integer ≥ 0`   | Approximate local DB storage in bytes.                         |
| `embedder`       | `"gemini" \| "openai" \| "none"` | Active embedding provider.              |
| `errors_24h`     | `integer ≥ 0`   | MCP-layer error count in the last 24 hours.                    |
| `online_since`   | `number`        | Unix ms when the local stack last came online.                 |

**`additionalProperties: false`** — any extra key causes a 400 rejection at the cloud.

### What CANNOT be in the payload

The following are permanently forbidden from the telemetry payload:

- Memory titles, bodies, embeddings, or any PII from `crystalMemories`
- Session content from `crystalSessions` or `crystalMessages`
- Any field containing the literal identifiers `crystalMemories`, `crystalSessions`, `crystalMessages`, `embedding`, `content`, `rawContent`, `title`, `body`

This is enforced at three layers:
1. **ESLint rule** `eslint-local-rules/no-memory-payload-to-cloud.js` — fails at CI if `convex/cloud/**` imports user-data tables.
2. **Schema validation** — `additionalProperties: false` rejects any extra keys at the cloud boundary.
3. **Runtime assertion** in `telemetryHttp.ts` — `assertNoMemoryContent()` throws before any DB write.

---

## Cadence

| Cron name          | Interval  | Function                | Description                              |
|--------------------|-----------|-------------------------|------------------------------------------|
| `telemetry-tick`   | 15 min    | `tickTelemetry()`       | Compile stats + enqueue to queue table.  |
| `telemetry-flush`  | 60 sec    | `flushTelemetry()`      | Drain queue → POST to cloud.             |

The two-cron design decouples compilation (I/O-heavy query) from delivery (network-heavy). The queue (`localTelemetryQueue`) survives crashes and retries independently.

---

## Idempotency

- **Local**: `enqueueTelemetry` checks `localTelemetryQueue.by_payloadId` before inserting. Re-calling with the same `payloadId` is a safe no-op.
- **Cloud**: `_checkDuplicate` checks `telemetry.by_payloadId` before inserting. Duplicate submissions return `200 { accepted: false, duplicate: true }` without double-counting.

---

## Retry / Backoff

Failed deliveries stay in `localTelemetryQueue` with `status="pending"` and a bumped `nextAttemptAt`:

| Condition | Behaviour |
|-----------|-----------|
| `429` or `5xx` | Exponential backoff: `delay = min(60_000 * 2^attemptedCount, 3_600_000)` (1min → 2min → 4min → … → 1h cap) |
| `4xx` (not 429) | Permanent failure — `status="failed"`, no further retry |
| Network error | Treated as transient, same backoff as 429/5xx |
| `200` | Row marked `status="sent"` |

---

## Authentication

The local stack authenticates to the cloud via `Authorization: Bearer ${MC_TUNNEL_TELEMETRY_TOKEN}`. This token is a separate credential from the user-facing MCP API key. It is:

- Issued at tenant provisioning (M2)
- Written to the local `.env` by `bootstrap.sh`
- Never displayed in the UI
- Verified cloud-side by hashing the bearer and comparing against `tunnels.cfTokenHash`

---

## Revocation Back-channel

The cloud response body for a successful push includes:

```json
{
  "accepted": true,
  "server_time": 1746000000000,
  "revoked_keys": ["sha256_of_key_hash_1", "sha256_of_key_hash_2"]
}
```

`revoked_keys` contains hashes of API keys whose `cloudRevokedAt` was set in the last 60 seconds. The local `flushTelemetry` action passes these to `local/apiKeys:applyCloudRevocations` (M5), which writes `cloudRevokedAt` on the matching `localApiKeys` rows. The MCP bearer middleware then rejects those keys as `"key_revoked"`.

**Propagation latency**: worst case 60 seconds (one flush cycle). Best case: the next flush that succeeds immediately after the cloud revocation.

---

## Required Environment Variables

| Variable                  | Description                                         |
|---------------------------|-----------------------------------------------------|
| `MC_CLOUD_TELEMETRY_URL`  | Base URL of the cloud Convex site (e.g. `https://memorycrystal.ai`) |
| `MC_TUNNEL_TELEMETRY_TOKEN` | Bearer token for telemetry push auth              |
| `MC_TENANT_ID`            | Cloud tenant ID (used as fallback if bootstrapState table not ready) |
| `MC_VERSION`              | Semver of this local stack build (baked at image build time) |

If `MC_CLOUD_TELEMETRY_URL` or `MC_TUNNEL_TELEMETRY_TOKEN` are unset, `flushTelemetry` silently skips — this is the expected state before `bootstrap.sh` runs.

---

## M3 Reconciliation Note

The cron declarations for `tickTelemetry` and `flushTelemetry` live in `convex/local/telemetry-crons.ts` and must be merged into `convex/crons.ts` during the M3 reconciliation step. See the top-of-file comment in `telemetry-crons.ts` for exact instructions.

---

## Schema Dependency on M5

This module depends on the `localTelemetryQueue` and `bootstrapState` tables added by M5. If M5 has not been deployed, `flushTelemetry` and `tickTelemetry` will throw a Convex "unknown table" error at runtime. Deploy M5 before enabling M6 crons.

The `applyCloudRevocations` mutation from `convex/local/apiKeys.ts` (M5) is called to mirror cloud revocations. If M5 is unavailable, `flushTelemetry` logs a warning and continues — revocation propagation is degraded but delivery still succeeds.
