/**
 * Bearer-token middleware for the Memory Crystal MCP HTTP server (R4 Option α).
 *
 * Replaces the previous `MEMORY_CRYSTAL_API_KEY` env-var comparison with a
 * lookup against the local Convex `localApiKeys` table. The cleartext bearer
 * never leaves the operator's `.env`; what's persisted is sha256(bearer).
 *
 * Response shapes follow §10 of the implementation plan:
 *   - 401 for missing / malformed / unknown / revoked keys
 *   - 503 for bootstrap-pending / bootstrap-expired (uniform envelope shared
 *     with the Caddy fallback and the Worker Tier-2 path)
 *
 * The middleware is wire-format agnostic — callers pass a normalized
 * `BearerHeaderCarrier` so it works with both `node:http` IncomingMessage
 * and the SDK's transport-layer `Request`-shaped objects.
 */

import { createHash } from "node:crypto";

const BOOTSTRAP_RECOVERY_DOCS = "https://memorycrystal.ai/docs/bootstrap-recovery";
const BOOTSTRAP_RETRY_AFTER_SECONDS = 30;

export type BearerHeaderCarrier =
  | { headers: { get(name: string): string | null } }
  | { headers: Record<string, string | string[] | undefined> };

/**
 * Minimal contract for the Convex client passed in. Tests inject a stub
 * exposing `query` and `mutation`. Production wiring uses the project's
 * existing Convex client.
 */
export interface BearerConvexClient {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface BearerEnv {
  /** Tenant slug to surface in §10 envelopes. Pulled from `MC_TENANT_SLUG`. */
  tenantSlug?: string;
}

export interface BearerOk {
  ok: true;
  keyHash: string;
}

export interface BearerErr {
  ok: false;
  status: 401 | 503;
  body: Record<string, unknown>;
}

export type BearerResult = BearerOk | BearerErr;

interface LocalApiKeyRow {
  keyHash: string;
  revokedAt?: number | null;
  cloudRevokedAt?: number | null;
}

interface BootstrapStateView {
  state: "pending" | "ready" | "expired";
  errorMessage?: string;
}

function readAuthorizationHeader(req: BearerHeaderCarrier): string | null {
  const headers = req.headers as {
    get?: (name: string) => string | null;
    authorization?: string | string[] | undefined;
  };
  if (typeof headers.get === "function") {
    return headers.get("authorization");
  }
  const authorization = headers.authorization;
  if (typeof authorization === "string") return authorization;
  if (Array.isArray(authorization)) return authorization[0] ?? null;
  return null;
}

export function extractBearer(req: BearerHeaderCarrier): string | null {
  const header = readAuthorizationHeader(req);
  if (!header) return null;
  const [scheme, credentials] = header.split(/\s+/, 2);
  if (scheme !== "Bearer" || !credentials) return null;
  return credentials;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function bootstrapEnvelope(
  state: "pending" | "expired",
  env: BearerEnv,
): BearerErr {
  const error = state === "expired" ? "bootstrap_expired" : "bootstrap_pending";
  const status = state === "expired" ? "bootstrap_expired" : "bootstrap_pending";
  return {
    ok: false,
    status: 503,
    body: {
      error,
      status,
      retry_after: BOOTSTRAP_RETRY_AFTER_SECONDS,
      tenant_slug: env.tenantSlug ?? "unknown",
      last_seen_at: null,
      support_link: BOOTSTRAP_RECOVERY_DOCS,
    },
  };
}

/**
 * Verify a bearer-authenticated request against the local Convex stack.
 *
 * Decision order matters — bootstrap state is checked BEFORE the key
 * lookup so that operators get the correct §10 envelope when their stack
 * is still finishing first-boot.
 */
export async function verifyBearer(
  req: BearerHeaderCarrier,
  client: BearerConvexClient,
  env: BearerEnv = {},
): Promise<BearerResult> {
  const bearer = extractBearer(req);
  if (!bearer) {
    return {
      ok: false,
      status: 401,
      body: { error: "missing_authorization" },
    };
  }

  // 1. Bootstrap-state gate.
  const bootstrap = (await client.query("local/bootstrap:getBootstrapState", {})) as
    | BootstrapStateView
    | null;
  const bootstrapState = bootstrap?.state ?? "pending";
  if (bootstrapState !== "ready") {
    return bootstrapEnvelope(bootstrapState, env);
  }

  // 2. Key lookup.
  const keyHash = sha256Hex(bearer);
  const row = (await client.query("local/apiKeys:getByHash", { keyHash })) as
    | LocalApiKeyRow
    | null;
  if (!row) {
    return { ok: false, status: 401, body: { error: "invalid_key" } };
  }
  if (row.revokedAt || row.cloudRevokedAt) {
    return { ok: false, status: 401, body: { error: "key_revoked" } };
  }

  // 3. Mark used (fire-and-forget — never block the request on this).
  Promise.resolve(client.mutation("local/apiKeys:markUsed", { keyHash })).catch(() => {
    /* swallow — markUsed is best-effort telemetry, not auth-critical */
  });

  return { ok: true, keyHash };
}
