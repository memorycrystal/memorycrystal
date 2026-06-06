# Tenant-Local (Self-Hosted Stack) — Schema Reference

These tables live in the **local Convex** running on the operator's Mac.
They are deployed alongside the cloud control-plane tables (in the same
`convex/schema.ts` for schema-validation parity), but only the local Convex
deployment writes to them.

The bearer-auth path used by `mcp-server/src/middleware/bearer.ts` is the only
hot-path consumer.

---

## `localApiKeys`

Local-side mirror of the bearer keys issued by the cloud control plane. Stores
sha256(cleartext_bearer) only — the cleartext lives in the operator's `.env`
and never in Convex (R4 Option α).

| Field | Type | Notes |
|-------|------|-------|
| `keyHash` | `string` | sha256 hex of the cleartext bearer. |
| `keyVersion` | `string` | `"v1"` (matches `mck_v1_…` prefix). |
| `label` | `string?` | Operator-supplied label, e.g. `"laptop"`. |
| `createdAt` | `number` | ms since epoch at issuance. |
| `lastUsedAt` | `number?` | Updated fire-and-forget by `bearer.ts` on each request. |
| `revokedAt` | `number?` | Local-side revocation. |
| `cloudRevokedAt` | `number?` | Mirrored from the cloud heartbeat (M6). |

Indexes: `by_keyHash` (hot path), `by_revoked`.

---

## `bootstrapState`

Singleton row (`id: "singleton"`) tracking the first-boot bootstrap-token
exchange. The local Convex starts with `state: "pending"` and the
`bootstrapInitialFetch` cron drives it to `"ready"` (success) or `"expired"`
(token TTL exhausted, 1h budget per plan §6.5).

Backoff schedule (per attempt): `min(5000 * 1.5 ** attemptCount, 300_000)` ms,
capped at 5 minutes; total budget = 1 hour.

| Field | Type | Notes |
|-------|------|-------|
| `id` | `"singleton"` | Enforced by mutations. |
| `state` | `"pending" \| "ready" \| "expired"` | Bearer middleware short-circuits to 503 unless `"ready"`. |
| `lastFetchAttemptAt` | `number?` | ms since epoch of the last fetch attempt. |
| `attemptCount` | `number` | Drives exponential backoff. |
| `errorMessage` | `string?` | Last error (e.g. `"bootstrap_token_expired"`). |
| `tenantId` | `string?` | Cloud tenant id, set after first successful pull. |
| `tenantSlug` | `string?` | e.g. `"amdo"` — used by §10 envelopes. |
| `mcVersion` | `string?` | Last MC version string seen. |

Indexes: `by_id`.

---

## `localTelemetryQueue`

Outbound telemetry queue. The local stack appends payloads on heartbeat
cadence; M6's sender drains them to the cloud `telemetry` HTTP action with
`payloadId`-based idempotency.

| Field | Type | Notes |
|-------|------|-------|
| `payloadId` | `string` | Idempotency key sent to the cloud receiver. |
| `payload` | `any` | Validated against `shared/telemetry/v1.schema.json` at the action layer. |
| `status` | `"pending" \| "sent" \| "failed"` | Lifecycle. |
| `attemptedCount` | `number` | Bookkeeping for backoff. |
| `nextAttemptAt` | `number` | ms since epoch. |
| `createdAt` | `number` | ms since epoch. |

Indexes: `by_status_nextAttempt`, `by_payloadId`.
