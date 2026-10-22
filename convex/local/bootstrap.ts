/**
 * First-boot bootstrap-token exchange (M5 / plan §6.5).
 *
 * Flow:
 *   1. `bootstrapState` starts at `{state: "pending", attemptCount: 0}`.
 *   2. Cron `bootstrapInitialFetch` (registered in `convex/local-crons.ts`)
 *      runs every 30s while `state === "pending"`.
 *   3. Each tick computes a backoff window:
 *        delayMs = min(5000 * 1.5 ** attemptCount, 300_000)
 *      and skips work if `now - lastFetchAttemptAt < delayMs`.
 *   4. POSTs to the cloud bootstrap endpoint with `MC_BOOTSTRAP_TOKEN`.
 *      Response carries the issued API key hashes + tenant identity, parsed
 *      leniently against the shared contract (shared/bootstrapContract.ts).
 *   5. On success: atomic write of seed keys + `state: "ready"`. Cleartext
 *      bootstrap token is *not* persisted.
 *   6. On 410 (expired): `state: "expired"` with a docs link in
 *      `errorMessage`.
 *   7. On 409 (token spent outside the cloud's redelivery window): terminal
 *      `state: "expired"` with `bootstrap_token_consumed` and a docs link;
 *      retrying the same token can never succeed.
 *   8. On any other failure: increment `attemptCount`. Total budget = 1h
 *      (matches the bootstrap token TTL), measured from `firstFetchAttemptAt`,
 *      the immutable time of the first real fetch attempt (ILL-327, audit
 *      A07). Each tick checks the deadline before the backoff skip; once
 *      `now - firstFetchAttemptAt > 1h`, `state: "expired"`. Ticks without
 *      `MC_BOOTSTRAP_TOKEN` never start the budget. A pending row written
 *      before `firstFetchAttemptAt` existed gets it on its next attempt, so
 *      its budget starts then: the true first attempt can't be backfilled,
 *      and a fresh 1h is the safe reading.
 *
 * The local deadline wins over the cloud's redelivery window (ILL-323): an
 * expired local row stays expired even if the cloud would still redeliver.
 * Recovery after any `expired` state is to re-issue the bootstrap token, set
 * the new `MC_BOOTSTRAP_TOKEN`, then run the internal mutation
 * `local/bootstrap:_resetForNewToken`, which returns the row to a fresh
 * `pending` so the cron fetches again.
 */

import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { parseBootstrapResponseV1 } from "../../shared/bootstrapContract";
import {
  action,
  internalAction,
  internalMutation,
  query,
} from "../_generated/server";

// Cross-track typegen note: `localInternal.local.*` and `localApi.local.*` are not in
// `_generated/api.d.ts` until `convex codegen` is re-run after M5/M6 land.
// The runtime resolves these names by string regardless of the type. The
// `as any` casts mirror the pattern already used in `convex/local/telemetryPush.ts`.
const localInternal = internal as unknown as {
  local: {
    bootstrap: {
      _ensureSingleton: any;
      _markAttemptStarted: any;
      _markAttemptFailed: any;
      _markReady: any;
      _resetForNewToken: any;
      fetchInitialState: any;
    };
    apiKeys: {
      seedFromBootstrap: any;
    };
  };
};
const localApi = api as unknown as {
  local: { bootstrap: { getBootstrapState: any } };
};

const BOOTSTRAP_INITIAL_DELAY_MS = 5_000;
const BOOTSTRAP_MAX_DELAY_MS = 300_000;
const BOOTSTRAP_BACKOFF_FACTOR = 1.5;
const BOOTSTRAP_TOTAL_BUDGET_MS = 60 * 60 * 1000; // 1h, matches token TTL.
const BOOTSTRAP_RECOVERY_DOCS = "https://memorycrystal.ai/docs/bootstrap-recovery";

const SINGLETON_ID = "singleton" as const;

const DEFAULT_BOOTSTRAP_URL = "https://memorycrystal.ai/api/cloud/bootstrap/fetchInitialState";

/** Compute the backoff delay for the given attempt count. */
export function computeBackoffMs(attemptCount: number): number {
  const raw = BOOTSTRAP_INITIAL_DELAY_MS * Math.pow(BOOTSTRAP_BACKOFF_FACTOR, attemptCount);
  return Math.min(raw, BOOTSTRAP_MAX_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Queries / mutations
// ---------------------------------------------------------------------------

/**
 * Read the singleton bootstrap-state row. Returns a synthetic
 * `{state: "pending", attemptCount: 0}` shape if no row exists yet so callers
 * have a stable contract before the first cron tick.
 */
export const getBootstrapState = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("bootstrapState")
      .withIndex("by_marker", (q) => q.eq("marker", SINGLETON_ID))
      .unique();
    if (!row) {
      return {
        state: "pending" as const,
        attemptCount: 0,
        firstFetchAttemptAt: undefined,
        lastFetchAttemptAt: undefined,
        errorMessage: undefined,
        tenantId: undefined,
        tenantSlug: undefined,
        mcVersion: undefined,
      };
    }
    return {
      state: row.state,
      attemptCount: row.attemptCount,
      firstFetchAttemptAt: row.firstFetchAttemptAt,
      lastFetchAttemptAt: row.lastFetchAttemptAt,
      errorMessage: row.errorMessage,
      tenantId: row.tenantId,
      tenantSlug: row.tenantSlug,
      mcVersion: row.mcVersion,
    };
  },
});

export const _ensureSingleton = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("bootstrapState")
      .withIndex("by_marker", (q) => q.eq("marker", SINGLETON_ID))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("bootstrapState", {
      marker: SINGLETON_ID,
      state: "pending",
      attemptCount: 0,
    });
  },
});

export const _markAttemptStarted = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("bootstrapState")
      .withIndex("by_marker", (q) => q.eq("marker", SINGLETON_ID))
      .unique();
    if (!row) return;
    const now = Date.now();
    // `firstFetchAttemptAt` is set once and anchors the total budget;
    // `lastFetchAttemptAt` moves on every attempt and drives backoff only.
    await ctx.db.patch(row._id, {
      lastFetchAttemptAt: now,
      ...(row.firstFetchAttemptAt === undefined ? { firstFetchAttemptAt: now } : {}),
    });
  },
});

export const _markAttemptFailed = internalMutation({
  args: { errorMessage: v.string(), expired: v.boolean() },
  handler: async (ctx, { errorMessage, expired }) => {
    const row = await ctx.db
      .query("bootstrapState")
      .withIndex("by_marker", (q) => q.eq("marker", SINGLETON_ID))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      attemptCount: row.attemptCount + 1,
      lastFetchAttemptAt: Date.now(),
      errorMessage,
      state: expired ? "expired" : row.state,
    });
  },
});

/**
 * Recovery step after a bootstrap token is re-issued: returns an `expired` or
 * `pending` row to a fresh `pending` with no budget or backoff history, so the
 * next cron tick fetches with the new `MC_BOOTSTRAP_TOKEN`. A `ready` row is
 * left untouched.
 */
export const _resetForNewToken = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("bootstrapState")
      .withIndex("by_marker", (q) => q.eq("marker", SINGLETON_ID))
      .unique();
    if (!row) return { reset: false, state: "pending" as const };
    if (row.state === "ready") return { reset: false, state: row.state };
    await ctx.db.patch(row._id, {
      state: "pending",
      attemptCount: 0,
      firstFetchAttemptAt: undefined,
      lastFetchAttemptAt: undefined,
      errorMessage: undefined,
    });
    return { reset: true, state: "pending" as const };
  },
});

export const _markReady = internalMutation({
  args: {
    tenantId: v.string(),
    tenantSlug: v.string(),
    mcVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("bootstrapState")
      .withIndex("by_marker", (q) => q.eq("marker", SINGLETON_ID))
      .unique();
    if (!row) return;
    await ctx.db.patch(row._id, {
      state: "ready",
      tenantId: args.tenantId,
      tenantSlug: args.tenantSlug,
      mcVersion: args.mcVersion,
      errorMessage: undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Action — invoked by the cron tick
// ---------------------------------------------------------------------------

/**
 * Internal action driving the first-boot exchange. Idempotent — bails out
 * immediately when `state` is already `"ready"` or `"expired"`.
 */
export const fetchInitialState = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(localInternal.local.bootstrap._ensureSingleton, {});
    const current = await ctx.runQuery(localApi.local.bootstrap.getBootstrapState, {});

    if (current.state === "ready" || current.state === "expired") {
      return { skipped: true, reason: current.state };
    }

    const now = Date.now();

    // Total-budget deadline, measured from the immutable first attempt and
    // checked before the backoff skip so a waiting tick can still expire.
    const firstAttempt = current.firstFetchAttemptAt;
    if (firstAttempt !== undefined && now - firstAttempt > BOOTSTRAP_TOTAL_BUDGET_MS) {
      await ctx.runMutation(localInternal.local.bootstrap._markAttemptFailed, {
        errorMessage: `bootstrap_budget_exceeded; see ${BOOTSTRAP_RECOVERY_DOCS}`,
        expired: true,
      });
      return { skipped: true, reason: "expired" };
    }

    // Backoff gate.
    const lastAttempt = current.lastFetchAttemptAt ?? 0;
    if (lastAttempt > 0) {
      const delay = computeBackoffMs(current.attemptCount);
      if (now - lastAttempt < delay) {
        return { skipped: true, reason: "backoff", waitMs: delay - (now - lastAttempt) };
      }
    }

    const token = process.env.MC_BOOTSTRAP_TOKEN;
    if (!token) {
      await ctx.runMutation(localInternal.local.bootstrap._markAttemptFailed, {
        errorMessage: "MC_BOOTSTRAP_TOKEN env var is unset",
        expired: false,
      });
      return { skipped: true, reason: "no_token" };
    }

    const url = process.env.MC_BOOTSTRAP_URL ?? DEFAULT_BOOTSTRAP_URL;
    await ctx.runMutation(localInternal.local.bootstrap._markAttemptStarted, {});

    let response: Response;
    try {
      // SECURITY (Phase-4 reviewer MAJOR-4): the bootstrap token MUST live
      // ONLY in the Authorization header. Earlier code also placed it in the
      // request body — that path is dead code on the cloud side (the handler
      // reads only the Authorization header) but it created a footgun: a
      // future contributor swapping the cloud read to the body would expose
      // the token in CDN/logging surfaces that don't redact `Authorization`.
      // Body intentionally minimal here.
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(localInternal.local.bootstrap._markAttemptFailed, {
        errorMessage: `network_error: ${message}`,
        expired: false,
      });
      return { ok: false, error: "network_error" };
    }

    if (response.status === 410) {
      await ctx.runMutation(localInternal.local.bootstrap._markAttemptFailed, {
        errorMessage: `bootstrap_token_expired; see ${BOOTSTRAP_RECOVERY_DOCS}`,
        expired: true,
      });
      return { ok: false, error: "bootstrap_token_expired" };
    }

    if (response.status === 409) {
      await ctx.runMutation(localInternal.local.bootstrap._markAttemptFailed, {
        errorMessage: `bootstrap_token_consumed; see ${BOOTSTRAP_RECOVERY_DOCS}`,
        expired: true,
      });
      return { ok: false, error: "bootstrap_token_consumed" };
    }

    if (!response.ok) {
      await ctx.runMutation(localInternal.local.bootstrap._markAttemptFailed, {
        errorMessage: `cloud_error_${response.status}`,
        expired: false,
      });
      return { ok: false, error: `cloud_error_${response.status}` };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      await ctx.runMutation(localInternal.local.bootstrap._markAttemptFailed, {
        errorMessage: "invalid_json_response",
        expired: false,
      });
      return { ok: false, error: "invalid_json_response" };
    }

    // Lenient: accepts legacy producers (`slug`, no `version`, `null`
    // optionals) and yields validator-compatible values (absent, never null).
    const parsed = parseBootstrapResponseV1(json, { strict: false });
    if (!parsed.ok) {
      await ctx.runMutation(localInternal.local.bootstrap._markAttemptFailed, {
        errorMessage: "malformed_bootstrap_payload",
        expired: false,
      });
      return { ok: false, error: "malformed_bootstrap_payload" };
    }
    const body = parsed.bundle;

    // Atomic seed: write keys + flip state to "ready" in two adjacent calls.
    // Both mutations run on the local Convex deployment, so a failure between
    // them on a redrive will be reconciled by the idempotent
    // `seedFromBootstrap` skip logic.
    await ctx.runMutation(localInternal.local.apiKeys.seedFromBootstrap, {
      apiKeys: body.apiKeys,
    });
    await ctx.runMutation(localInternal.local.bootstrap._markReady, {
      tenantId: body.tenantId,
      tenantSlug: body.tenantSlug,
      ...(body.mcVersion !== undefined ? { mcVersion: body.mcVersion } : {}),
    });

    return { ok: true, tenantId: body.tenantId, tenantSlug: body.tenantSlug };
  },
});

// ---------------------------------------------------------------------------
// Public action wrapper (callable from cron registration sites that resolve
// `localApi.local.bootstrap.fetchInitialStatePublic`).
// ---------------------------------------------------------------------------

export const fetchInitialStatePublic = action({
  args: {},
  handler: async (ctx) => {
    return await ctx.runAction(localInternal.local.bootstrap.fetchInitialState, {});
  },
});
