/**
 * §10 Uniform 503 envelope — canonical type + assertion helper.
 *
 * Two concrete shapes exist in the codebase:
 *
 * Shape A — mcp-server bootstrap middleware (§10 plan spec):
 *   { error: "service_unavailable", code: 503, tenant_slug, last_seen_at,
 *     retry_after, status, support }
 *
 * Shape B — CF Worker Tier-2 (`infra/cloudflare/worker/src/auth.ts`):
 *   { error: "tunnel_unreachable", tenant_slug, last_seen_at,
 *     retry_after, status, support_link, message }
 *
 * `assertValid503Envelope` accepts both shapes. The invariants that are
 * common to both (and therefore machine-checkable against any 503 responder):
 *   - `error` is a non-empty string (present in both)
 *   - `tenant_slug` is a non-empty string
 *   - `last_seen_at` is a number or null
 *   - `retry_after` is a positive number
 *   - `status` is a non-empty string (the §10 discriminator)
 *   - At least one of `support` / `support_link` is a non-empty string
 *
 * `code: 503` is present only in Shape A. Tests that target Shape B
 * (Worker output) must NOT assert `code` — use `response.status` instead.
 */

import { expect } from "vitest";

/** All valid status discriminator values from the §10 taxonomy. */
export type Sec10Status =
  | "tunnel-fallback-ingress"
  | "worker-tier2-mac-off"
  | "bootstrap_pending"
  | "bootstrap_expired";

/** Canonical §10 structured-503 body shape (Shape A — mcp-server / Caddy). */
export interface Sec10Envelope {
  /** "service_unavailable" (Shape A) or "tunnel_unreachable" (Shape B). */
  error: string;
  /** Present in Shape A (503). May be absent in Shape B. */
  code?: number;
  /** The tenant slug. */
  tenant_slug: string;
  /** Epoch ms timestamp or null. */
  last_seen_at: number | null;
  /** Retry hint in seconds. */
  retry_after: number;
  /** Discriminator — see §10 status taxonomy. */
  status: Sec10Status | string;
  /** Status page or recovery docs URL (Shape A). */
  support?: string;
  /** Status page URL (Shape B — Worker). */
  support_link?: string;
  /** Human-readable message (Shape B — Worker). */
  message?: string;
}

/**
 * Assert that `body` is a valid §10 503 envelope (Shape A or Shape B).
 *
 * Common invariants checked:
 *  1. `error` — non-empty string.
 *  2. `tenant_slug` — non-empty string.
 *  3. `last_seen_at` — number or null (never undefined or a non-null non-number).
 *  4. `retry_after` — positive number.
 *  5. `status` — non-empty string.
 *  6. At least one of `support` / `support_link` — non-empty string.
 */
export function assertValid503Envelope(body: unknown): asserts body is Sec10Envelope {
  expect(body, "503 body must be an object").toBeDefined();
  expect(typeof body).toBe("object");
  const b = body as Record<string, unknown>;

  // error — present in both shapes
  expect(b, '§10 field "error" must be present').toHaveProperty("error");
  expect(typeof b.error, '§10 "error" must be a string').toBe("string");
  expect((b.error as string).length, '§10 "error" must be non-empty').toBeGreaterThan(0);

  // tenant_slug
  expect(b, '§10 field "tenant_slug" must be present').toHaveProperty("tenant_slug");
  expect(typeof b.tenant_slug, '§10 "tenant_slug" must be a string').toBe("string");
  expect((b.tenant_slug as string).length, '§10 "tenant_slug" must be non-empty').toBeGreaterThan(0);

  // last_seen_at — must be a number OR null, never undefined or a non-null non-number
  expect(b, '§10 field "last_seen_at" must be present').toHaveProperty("last_seen_at");
  expect(
    b.last_seen_at === null || typeof b.last_seen_at === "number",
    '§10 "last_seen_at" must be a number or null',
  ).toBe(true);

  // retry_after
  expect(b, '§10 field "retry_after" must be present').toHaveProperty("retry_after");
  expect(typeof b.retry_after, '§10 "retry_after" must be a number').toBe("number");
  expect(b.retry_after as number, '§10 "retry_after" must be positive').toBeGreaterThan(0);

  // status
  expect(b, '§10 field "status" must be present').toHaveProperty("status");
  expect(typeof b.status, '§10 "status" must be a string').toBe("string");
  expect((b.status as string).length, '§10 "status" must be non-empty').toBeGreaterThan(0);

  // support or support_link — at least one must be a non-empty string
  const hasSupport =
    (typeof b.support === "string" && (b.support as string).length > 0) ||
    (typeof b.support_link === "string" && (b.support_link as string).length > 0);
  expect(hasSupport, '§10 at least one of "support" / "support_link" must be a non-empty string').toBe(true);
}

/**
 * Assert the status discriminator matches exactly one of the §10 taxonomy values.
 */
export function assertStatusIs(body: unknown, expected: Sec10Status): void {
  assertValid503Envelope(body);
  expect(body.status, `§10 "status" should be "${expected}"`).toBe(expected);
}
