// ── OpenRouter provider gateway (ILL-184) ────────────────────────────────────
//
// Single choke point for every user-key OpenRouter request — inference and
// embedding alike. All classification, outcome recording, and alert policy
// live here; a new call path that fetches OpenRouter directly bypasses the
// alert and is a defect (enforced by a source-grep test).
//
// Alert policy:
//  - Actionable classes (payment_required, authentication, permission_denied,
//    token_limit_exceeded, missing_openrouter_key) email on first occurrence.
//  - Transient classes (rate_limit_exceeded, provider_overloaded, server,
//    http_error, timeout) email only after blocking on two consecutive days,
//    using the "memory stopped updating" template.
//  - A class stays suppressed only once emailEngine reports the alert
//    *delivered* (confirmProviderAlertSent). A send that fails at SendGrid, is
//    skipped for a missing address or a disabled template, or is swallowed by
//    dry-run leaves the class re-alertable next cycle. Scheduling an email is
//    not evidence that anyone was told, and this alarm exists precisely
//    because a paying customer went six weeks without being told.
//  - The first success after a failure only arms recovery; the row is cleared
//    and exactly one recovery email sent once the success streak outlives
//    RECOVERY_STABLE_MS. A class that flaps success/failure every cycle
//    therefore produces one alert and no recovery mail, instead of a
//    failure→recovery→failure loop.
//
// No credential value ever appears in an email, log line, or returned value:
// only a redacted error message and last-4 are carried here.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

export const OPENROUTER_CHAT_COMPLETIONS_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

export type FailureCategory = "actionable" | "transient";

export const ACTIONABLE_FAILURE_CLASSES = new Set([
  "payment_required",
  "authentication",
  "permission_denied",
  "token_limit_exceeded",
  "missing_openrouter_key",
]);

export const TRANSIENT_FAILURE_CLASSES = new Set([
  "rate_limit_exceeded",
  "provider_overloaded",
  "server",
  "http_error",
  "timeout",
]);

export const FAILURE_CLASS_TEMPLATE_SLUGS: Record<string, string> = {
  payment_required: "openrouter-out-of-credit",
  authentication: "openrouter-key-revoked",
  permission_denied: "openrouter-permission-denied",
  token_limit_exceeded: "openrouter-token-limit",
  missing_openrouter_key: "openrouter-missing-key",
};

export const RECOVERY_TEMPLATE_SLUG = "openrouter-recovered";
export const TRANSIENT_BLOCKED_TEMPLATE_SLUG = "memory-stopped-updating";

const ERROR_TYPE_TO_CLASS: Record<string, { failureClass: string; category: FailureCategory }> = {
  authentication: { failureClass: "authentication", category: "actionable" },
  payment_required: { failureClass: "payment_required", category: "actionable" },
  permission_denied: { failureClass: "permission_denied", category: "actionable" },
  token_limit_exceeded: { failureClass: "token_limit_exceeded", category: "actionable" },
  rate_limit_exceeded: { failureClass: "rate_limit_exceeded", category: "transient" },
  provider_overloaded: { failureClass: "provider_overloaded", category: "transient" },
  server: { failureClass: "server", category: "transient" },
};

/**
 * Classify an OpenRouter failure. Uses error.metadata.error_type when present
 * (even on HTTP 2xx payload-level errors — OpenRouter sometimes returns a 200
 * with an error object); otherwise falls back to HTTP status. Returns null only
 * when there is no typed error and the status is 2xx.
 */
export function classifyOpenRouterFailure(
  httpStatus: number,
  errorType?: string | null,
): { failureClass: string; category: FailureCategory } | null {
  // Requirement 3: error_type wins when present — check it before any 2xx
  // short-circuit so a payload-level payment_required on HTTP 200 is still
  // actionable (the Dennis 402 case is the common path; 200+error is real too).
  if (typeof errorType === "string" && errorType) {
    const mapped = ERROR_TYPE_TO_CLASS[errorType];
    if (mapped) return mapped;
    // Unrecognised type: fall through to HTTP status so an unknown label on a
    // 402 is not silently treated as "transient" without status evidence.
  }
  if (httpStatus >= 200 && httpStatus < 300) return null;
  switch (httpStatus) {
    case 401:
      return { failureClass: "authentication", category: "actionable" };
    case 402:
      return { failureClass: "payment_required", category: "actionable" };
    case 403:
      return { failureClass: "permission_denied", category: "actionable" };
    case 429:
      return { failureClass: "rate_limit_exceeded", category: "transient" };
    default:
      if (httpStatus >= 500) return { failureClass: "server", category: "transient" };
      return { failureClass: "http_error", category: "transient" };
  }
}

export function isActionableFailureClass(failureClass: string): boolean {
  return ACTIONABLE_FAILURE_CLASSES.has(failureClass);
}

const SK_OR_PATTERN = /sk-or-[A-Za-z0-9_-]{4,}/g;

/** Strip anything that looks like a credential from an error message. */
export function redactErrorMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.replace(SK_OR_PATTERN, "[redacted-key]").slice(0, 240);
}

export function dayKeyFor(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function previousDayKey(dayKey: string): string {
  const parsed = new Date(`${dayKey}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * How long a dispatched-but-unconfirmed alert suppresses its class. One failing
 * cycle can record dozens of failures before the scheduled send reports back;
 * without this window each of them would dispatch its own email. It is
 * deliberately far shorter than any producer cycle, so a send that never
 * confirms leaves the class re-alertable on the next cycle.
 */
export const ALERT_SEND_GRACE_MS = 15 * 60 * 1000;

/**
 * How long a class must stay success-only before a recovery email is sent and
 * its state row is cleared. A key that succeeds on one lane and fails on
 * another every cycle would otherwise emit failure→recovery→failure mail
 * forever (ILL-184 P3-1); with the hold it emits exactly one failure alert and
 * no recovery mail until the failures actually stop.
 */
export const RECOVERY_STABLE_MS = 6 * 60 * 60 * 1000;

export type ProviderFailureState = {
  userId: string;
  failureClass: string;
  status: "failure" | "recovered";
  /** An alert send was dispatched (scheduled), not necessarily delivered. */
  emailScheduledAt?: number;
  /** An alert send was confirmed delivered. Only this suppresses the class. */
  emailSentAt?: number;
  /** Start of the current uninterrupted success streak, if any. */
  recoveryPendingSince?: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lastFailureDayKey?: string;
  consecutiveBlockedDays: number;
  keyLast4?: string;
  lastSuccessAt?: number;
  updatedAt: number;
};

export type OutcomeDecision =
  | { action: "send"; templateSlug: string; variables: Record<string, string> }
  | { action: "suppress" }
  | { action: "none" };

function variablesForFailure(failureClass: string, keyLast4?: string | null): Record<string, string> {
  const variables: Record<string, string> = {};
  if (keyLast4) variables.keyLast4 = keyLast4;
  return variables;
}

/**
 * Pure suppression state machine for one (user, failureClass) row. Returns the
 * email decision and the next state row. Actionable: send on first occurrence,
 * suppress once a send is *confirmed delivered*. Transient: send only once two
 * consecutive distinct days show failures. Success (see
 * evaluateSuccessDecision) eventually clears.
 *
 * Suppression deliberately keys off emailSentAt (confirmed) rather than
 * emailScheduledAt (dispatched). A send that fails at SendGrid, is skipped
 * because the user has no resolvable address, or is skipped because an admin
 * disabled the template must leave the class re-alertable — otherwise the row
 * reads "already told them" while nobody was told, which is the exact silent
 * failure this alarm exists to prevent.
 */
export function evaluateFailureDecision(
  prev: ProviderFailureState | null,
  event: {
    userId: string;
    failureClass: string;
    keyLast4?: string | null;
    now: number;
    /** Override for tests; defaults to ALERT_SEND_GRACE_MS. */
    sendGraceMs?: number;
  },
): { decision: OutcomeDecision; next: ProviderFailureState } {
  const { userId, failureClass, keyLast4, now } = event;
  const sendGraceMs = event.sendGraceMs ?? ALERT_SEND_GRACE_MS;
  const dayKey = dayKeyFor(now);
  const consecutiveBlockedDays =
    prev && prev.lastFailureDayKey
      ? prev.lastFailureDayKey === dayKey
        ? prev.consecutiveBlockedDays
        : prev.lastFailureDayKey === previousDayKey(dayKey)
          ? prev.consecutiveBlockedDays + 1
          : 1
      : 1;

  const next: ProviderFailureState = {
    userId,
    failureClass,
    status: "failure",
    emailScheduledAt: prev?.emailScheduledAt,
    emailSentAt: prev?.emailSentAt,
    // A fresh failure ends any pending recovery streak.
    recoveryPendingSince: undefined,
    firstFailureAt: prev?.firstFailureAt ?? now,
    lastFailureAt: now,
    lastFailureDayKey: dayKey,
    consecutiveBlockedDays,
    keyLast4: keyLast4 ?? prev?.keyLast4,
    lastSuccessAt: prev?.lastSuccessAt,
    updatedAt: now,
  };

  // Confirmed delivered: stay quiet until a success clears the row.
  if (next.emailSentAt !== undefined) {
    return { decision: { action: "suppress" }, next };
  }

  // Dispatched moments ago and not yet reported: assume in flight so a burst of
  // failures in one cycle produces one email, not one per failure.
  if (
    next.emailScheduledAt !== undefined &&
    now - next.emailScheduledAt < sendGraceMs
  ) {
    return { decision: { action: "suppress" }, next };
  }

  if (isActionableFailureClass(failureClass)) {
    next.emailScheduledAt = now;
    return {
      decision: {
        action: "send",
        templateSlug: FAILURE_CLASS_TEMPLATE_SLUGS[failureClass],
        variables: variablesForFailure(failureClass, keyLast4),
      },
      next,
    };
  }

  if (consecutiveBlockedDays >= 2) {
    next.emailScheduledAt = now;
    return {
      decision: { action: "send", templateSlug: TRANSIENT_BLOCKED_TEMPLATE_SLUG, variables: variablesForFailure(failureClass, keyLast4) },
      next,
    };
  }

  return { decision: { action: "none" }, next };
}

/**
 * Pure recovery decision for one (user, failureClass) row.
 *
 * Two-phase on purpose. The first success only *arms* recovery by starting a
 * success streak; the row survives. The row is cleared — and a recovery email
 * sent, if the failure was ever emailed — only once that streak outlives
 * `stableMs`. Any failure of the same class in between resets the streak
 * (evaluateFailureDecision clears recoveryPendingSince) and, because
 * emailSentAt is still set, is suppressed.
 *
 * That is what stops the flap: a key that succeeds on embeddings and fails on
 * chat every cycle used to emit failure→recovery→failure mail forever, because
 * one success deleted every class row user-wide. Now it emits exactly one
 * failure alert and no recovery mail until the failures actually stop.
 */
export function evaluateSuccessDecision(
  prev: ProviderFailureState | null,
  now: number,
  options?: { stableMs?: number },
): { decision: OutcomeDecision; shouldClear: boolean; next: ProviderFailureState | null } {
  if (!prev) return { decision: { action: "none" }, shouldClear: false, next: null };
  const stableMs = options?.stableMs ?? RECOVERY_STABLE_MS;
  const pendingSince = prev.recoveryPendingSince;

  if (pendingSince === undefined || now < pendingSince) {
    // First success since the last failure: arm the hold, keep the row.
    return {
      decision: { action: "none" },
      shouldClear: false,
      next: {
        ...prev,
        status: "recovered",
        recoveryPendingSince: now,
        lastSuccessAt: now,
        updatedAt: now,
      },
    };
  }

  if (now - pendingSince < stableMs) {
    // Still inside the hold: record the success, decide nothing.
    return {
      decision: { action: "none" },
      shouldClear: false,
      next: { ...prev, status: "recovered", lastSuccessAt: now, updatedAt: now },
    };
  }

  return {
    decision:
      prev.emailSentAt !== undefined
        ? {
            action: "send",
            templateSlug: RECOVERY_TEMPLATE_SLUG,
            variables: prev.keyLast4 ? { keyLast4: prev.keyLast4 } : {},
          }
        : { action: "none" },
    shouldClear: true,
    next: null,
  };
}

// ── Convex state plumbing ────────────────────────────────────────────────────

export const getProviderFailureStates = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("providerFailureState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(100);
  },
});

/**
 * Atomically applies one observed outcome (failure or success) for a user and
 * dispatches any email the policy calls for. Emails are sent via the shared
 * emailEngine path (crystalEmailTemplates / crystalEmailLog), never a parallel
 * mail path.
 */
export const applyProviderOutcome = internalMutation({
  args: {
    userId: v.string(),
    kind: v.union(v.literal("failure"), v.literal("success")),
    failureClass: v.optional(v.string()),
    keyLast4: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    if (args.kind === "success") {
      const rows = await ctx.db
        .query("providerFailureState")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .take(100);
      if (rows.length === 0) return { kind: "success" as const, cleared: false, emailSent: false };

      // Per-row: a success no longer deletes every class blindly. Each row runs
      // the pure two-phase recovery machine, so a class that is still failing
      // on another lane keeps its own suppression state instead of being reset
      // by an unrelated success (P3-1).
      let cleared = false;
      let recovery: { templateSlug: string; variables: Record<string, string> } | null = null;
      for (const row of rows) {
        const { decision, shouldClear, next } = evaluateSuccessDecision(
          toProviderFailureState(row),
          now,
        );
        if (decision.action === "send" && !recovery) {
          // Exactly one recovery email per success, regardless of how many
          // classes recovered together (AC5).
          recovery = { templateSlug: decision.templateSlug, variables: decision.variables };
        }
        if (shouldClear) {
          await ctx.db.delete(row._id);
          cleared = true;
        } else if (next) {
          await ctx.db.patch(row._id, next);
        }
      }

      if (recovery) {
        // Mutations cannot call actions directly; schedule the send so it runs
        // after this mutation commits, via the shared emailEngine path.
        await ctx.scheduler.runAfter(0, internal.crystal.emailEngine.sendTemplateEmail, {
          userId: args.userId,
          templateSlug: recovery.templateSlug,
          variables: recovery.variables,
        });
      }
      return {
        kind: "success" as const,
        cleared,
        emailSent: recovery !== null,
      };
    }

    const failureClass = args.failureClass ?? "http_error";
    const prev = await ctx.db
      .query("providerFailureState")
      .withIndex("by_user_failure_class", (q) =>
        q.eq("userId", args.userId).eq("failureClass", failureClass),
      )
      .first();
    const { decision, next } = evaluateFailureDecision(prev ?? null, {
      userId: args.userId,
      failureClass,
      keyLast4: args.keyLast4,
      now,
    });
    if (prev) {
      await ctx.db.patch(prev._id, next);
    } else {
      await ctx.db.insert("providerFailureState", next);
    }
    if (decision.action === "send") {
      await ctx.scheduler.runAfter(0, internal.crystal.emailEngine.sendTemplateEmail, {
        userId: args.userId,
        templateSlug: decision.templateSlug,
        variables: decision.variables,
        // The send confirms itself back into this row. Until that callback
        // fires, the class counts as un-alerted and stays re-alertable.
        onSent: { kind: "providerAlert" as const, userId: args.userId, failureClass },
      });
    }
    return { kind: "failure" as const, failureClass, decision: decision.action };
  },
});

function toProviderFailureState(row: {
  userId: string;
  failureClass: string;
  status: "failure" | "recovered";
  emailScheduledAt?: number;
  emailSentAt?: number;
  recoveryPendingSince?: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lastFailureDayKey?: string;
  consecutiveBlockedDays: number;
  keyLast4?: string;
  lastSuccessAt?: number;
  updatedAt: number;
}): ProviderFailureState {
  return {
    userId: row.userId,
    failureClass: row.failureClass,
    status: row.status,
    emailScheduledAt: row.emailScheduledAt,
    emailSentAt: row.emailSentAt,
    recoveryPendingSince: row.recoveryPendingSince,
    firstFailureAt: row.firstFailureAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureDayKey: row.lastFailureDayKey,
    consecutiveBlockedDays: row.consecutiveBlockedDays,
    keyLast4: row.keyLast4,
    lastSuccessAt: row.lastSuccessAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Delivery callback for a provider alert. Invoked by emailEngine only when the
 * send reached SendGrid with a 2xx (crystalEmailLog status "sent"); a failed,
 * skipped, or dry-run send never calls it, which is what keeps the class
 * re-alertable on the next cycle.
 */
export const confirmProviderAlertSent = internalMutation({
  args: {
    userId: v.string(),
    failureClass: v.string(),
    sentAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerFailureState")
      .withIndex("by_user_failure_class", (q) =>
        q.eq("userId", args.userId).eq("failureClass", args.failureClass),
      )
      .first();
    // The row can legitimately be gone (a success cleared it while the send was
    // in flight). Nothing to stamp, and nothing to suppress either.
    if (!row) return { confirmed: false };
    await ctx.db.patch(row._id, { emailSentAt: args.sentAt, updatedAt: Date.now() });
    return { confirmed: true };
  },
});

// ── Action-side helpers used by every call site ──────────────────────────────

type RecordCtx = Pick<any, "runMutation">;

export async function recordProviderFailure(
  ctx: RecordCtx,
  args: { userId: string; failureClass: string; keyLast4?: string | null },
): Promise<void> {
  await ctx.runMutation(internal.crystal.providerGateway.applyProviderOutcome, {
    userId: args.userId,
    kind: "failure",
    failureClass: args.failureClass,
    keyLast4: args.keyLast4 ?? undefined,
  });
}

export async function recordProviderSuccess(ctx: RecordCtx, userId: string): Promise<void> {
  await ctx.runMutation(internal.crystal.providerGateway.applyProviderOutcome, {
    userId,
    kind: "success",
  });
}

export async function recordMissingOpenRouterKey(
  ctx: RecordCtx,
  args: { userId: string; keyLast4?: string | null },
): Promise<void> {
  await recordProviderFailure(ctx, {
    userId: args.userId,
    failureClass: "missing_openrouter_key",
    keyLast4: args.keyLast4 ?? null,
  });
}

// ── The single request choke point ───────────────────────────────────────────

export type OpenRouterGatewayResult =
  | { ok: true; status: number; payload: unknown }
  | {
      ok: false;
      status: number;
      failureClass: string;
      category: FailureCategory;
      errorMessage: string | null;
    };

export type OpenRouterGatewayRequest = {
  userId: string;
  apiKey: string;
  keyLast4?: string | null;
  endpoint: string;
  source: string;
  body: unknown;
  headers?: Record<string, string>;
  /**
   * Diagnostic probes intentionally induce failures (e.g. provider-restricted
   * variants). Recording those induced failures would fire user alert emails,
   * so probes opt out of outcome recording. Every real user-facing request
   * leaves this unset (true) so classification + alert policy always apply.
   */
  recordOutcome?: boolean;
};

function payloadErrorMessage(payload: any): string | null {
  const message = payload?.error?.message;
  return typeof message === "string" && message ? message : null;
}

function payloadErrorType(payload: any): string | null {
  const errorType = payload?.error?.metadata?.error_type;
  return typeof errorType === "string" && errorType ? errorType : null;
}

export async function requestOpenRouter(
  ctx: RecordCtx,
  args: OpenRouterGatewayRequest,
): Promise<OpenRouterGatewayResult> {
  try {
    const response = await fetch(args.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`,
        ...(args.headers ?? {}),
      },
      body: JSON.stringify(args.body),
    });

    const payload = await response.json().catch(() => null);
    // Some providers return a payload-level error with a 200 status; treat a
    // payload error as a failure and prefer its error.code as the status.
    const httpStatus =
      response.ok && Number.isFinite(Number(payload?.error?.code))
        ? Number(payload.error.code)
        : response.status;
    const hasError = !response.ok || Boolean(payload?.error);

    if (!hasError) {
      if (args.recordOutcome !== false) {
        await recordProviderSuccess(ctx, args.userId).catch((error) => {
          console.warn(`[providerGateway] failed to record success for ${args.userId}: ${error?.message ?? error}`);
        });
      }
      return { ok: true, status: response.status, payload };
    }

    const classified = classifyOpenRouterFailure(httpStatus, payloadErrorType(payload));
    const failureClass = classified?.failureClass ?? "http_error";
    const category = classified?.category ?? "transient";
    const errorMessage = redactErrorMessage(payloadErrorMessage(payload));

    if (args.recordOutcome !== false) {
      await recordProviderFailure(ctx, {
        userId: args.userId,
        failureClass,
        keyLast4: args.keyLast4 ?? null,
      }).catch((error) => {
        console.warn(`[providerGateway] failed to record failure for ${args.userId}: ${error?.message ?? error}`);
      });
    }

    return { ok: false, status: httpStatus, failureClass, category, errorMessage };
  } catch (error) {
    // Network / timeout errors are transient.
    if (args.recordOutcome !== false) {
      await recordProviderFailure(ctx, {
        userId: args.userId,
        failureClass: "timeout",
        keyLast4: args.keyLast4 ?? null,
      }).catch(() => {});
    }
    return { ok: false, status: 0, failureClass: "timeout", category: "transient", errorMessage: null };
  }
}
