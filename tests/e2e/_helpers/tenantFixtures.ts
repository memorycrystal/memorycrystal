/**
 * Shared tenant fixtures for E2E tests.
 *
 * These are stable, deterministic values used by the mock harness and
 * individual test files. Never real keys — for testing only.
 */

export const TENANT_SLUG = "e2e-test-tenant";
export const TENANT_ID = "j571abc0000000000000000e2e";

/** MCP API key — format: mck_v1_<base62>{30,80} */
export const TENANT_API_KEY =
  "mck_v1_" + "a".repeat(64);

/** Bootstrap token — 64-char hex */
export const BOOTSTRAP_TOKEN =
  "boot_" + "b".repeat(59);

/** Tunnel token (opaque CF tunnel credential) */
export const TUNNEL_TOKEN = "cf_tunnel_tok_" + "c".repeat(50);

/** Subdomain the tenant's stack is reachable at */
export const TUNNEL_HOST = `${TENANT_SLUG}.tunnels.memorycrystal.ai`;
export const TUNNEL_BASE_URL = `https://${TUNNEL_HOST}`;

/** A second machine's API key (same key, different browser context for AC2) */
export const API_KEY_MACHINE_B = TENANT_API_KEY;

/** Invalid key that should return 401 */
export const INVALID_API_KEY = "mck_v1_INVALID";

/** Provision result shape returned by provisionTenantPublic */
export const PROVISION_RESULT = {
  tenantId: TENANT_ID,
  subdomain: TUNNEL_HOST,
  apiKey: TENANT_API_KEY,
  bootstrapToken: BOOTSTRAP_TOKEN,
  tunnelToken: TUNNEL_TOKEN,
};

/** lastSeenAt value representing "5 minutes ago" for AC3 offline tests */
export const LAST_SEEN_5_MIN_AGO = Date.now() - 5 * 60 * 1000;

/** lastSeenAt value representing "2 minutes ago" — still offline (>90s) */
export const LAST_SEEN_2_MIN_AGO = Date.now() - 2 * 60 * 1000;

/** MCP recall response shape for a healthy tenant */
export const MCP_RECALL_OK = {
  ok: true,
  tenant: TENANT_SLUG,
  memories: [],
};

/** 401 shape for revoked / invalid key */
export const MCP_RECALL_401 = {
  error: "invalid_key",
  code: 401,
};
