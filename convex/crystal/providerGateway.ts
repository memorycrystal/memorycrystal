// ── OpenRouter provider gateway (ILL-184, ILL-302) ──────────────────────────
//
// Single choke point for every user-key OpenRouter request — inference and
// embedding alike. All classification, outcome recording, and alert policy
// live here; a new call path that fetches OpenRouter directly bypasses the
// alert and is a defect (enforced by a source-grep test).
//
// Incident identity (ILL-302): one incident per complete scope —
//   crystal userId + call-site source operation + endpoint kind
//   (chat_completions | embeddings) + model + SHA-256 digest of the key.
// The digest is computed action-side; no raw credential crosses into
// mutation args. A missing key uses the constant MISSING_KEY_DIGEST. Metadata
// is normalised to a closed set of safe identifiers; prompts, provider
// response/error text, request IDs, full URLs and last4 are never identity.
//
// Alert policy:
//  - Actionable classes (payment_required, authentication, permission_denied,
//    token_limit_exceeded, missing_openrouter_key) email on first occurrence
//    in a scope, once per template per incident generation.
//  - Transient classes (rate_limit_exceeded, provider_overloaded, server,
//    http_error, timeout) email only once the scope has >= 2 failures in one
//    unresolved window spanning >= 24 hours. Two failures two minutes apart
//    across UTC midnight are NOT two blocked days.
//  - A template stays suppressed only once emailEngine reports the alert
//    *delivered* (confirmProviderAlertSent) for the same row incarnation
//    (_id), scope, generation and scheduled attempt. Failed / skipped /
//    dry-run sends leave it retryable on the next matching failure after
//    ALERT_SEND_GRACE_MS. Row _id fencing is what stops a delayed send from
//    an evicted incident matching a recreated row (generation restarts at 1).
//  - Recovery is scoped: only successes for the same scope arm and, after
//    RECOVERY_STABLE_MS without an intervening scoped failure, resolve the
//    incident. Recovery means observed successes for that operation, not proof
//    of continuous uptime. Successes on other operations/models/keys/users
//    cannot recover an incident. A missing-key incident is also advanced by
//    keyed successes for the same operation, so a keyed failure for that
//    operation resets its hold (or cancels an undelivered recovery email);
//    the failure itself is still recorded only on its own keyed incident.
//  - Legacy rows without scopeKey remain readable and conservatively
//    unresolved; scoped traffic never resolves them.
//  - At most MAX_TRACKED_SCOPES_PER_USER scopes per user; only resolved rows
//    are evicted (oldest first). When all are active, new scopes are counted in
//    one separate per-user overflow summary that never merges into a scope.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { logError, logLabel } from "./crypto";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "./crypto";

export const OPENROUTER_CHAT_COMPLETIONS_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
// Keep paid provider work bounded. Extraction leases are five minutes, so an
// aborted request still leaves ample time for fenced persistence/finalization.
export const OPENROUTER_REQUEST_TIMEOUT_MS = 60 * 1000;

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
/** Generic warning for the per-user overflow summary (ILL-302 req 5). */
export const OVERFLOW_TEMPLATE_SLUG = "openrouter-alert-overflow";

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

// ── Incident scope (ILL-302) ─────────────────────────────────────────────────

export type ProviderEndpointKind = "chat_completions" | "embeddings" | "unknown";

export type ProviderScope = {
  /** Gateway call-site operation, e.g. "ltmExtraction.extractWindowMemories". */
  source: string;
  endpointKind: ProviderEndpointKind;
  model: string;
  /** SHA-256 hex of the credential, MISSING_KEY_DIGEST, or UNKNOWN_SCOPE_VALUE. */
  keyDigest: string;
};

export const MISSING_KEY_DIGEST = "missing";
export const UNKNOWN_SCOPE_VALUE = "unknown";
export const SCOPE_VERSION = 2;
/** Reserved scopeKey of the per-user overflow summary row. Sorts after every normal key. */
export const OVERFLOW_SCOPE_KEY = "~overflow";
export const MAX_TRACKED_SCOPES_PER_USER = 50;
export const MAX_INCIDENT_TRANSITIONS = 10;
export const TRANSIENT_WINDOW_MIN_FAILURES = 2;
export const TRANSIENT_WINDOW_MIN_SPAN_MS = 24 * 60 * 60 * 1000;

/**
 * Closed set of call-site operations that reach requestOpenRouter /
 * recordMissingOpenRouterKey (directly or via the embedding helpers). A label
 * outside this set is recorded as "unknown"; add new call sites here.
 */
export const PROVIDER_SOURCE_LABELS: ReadonlySet<string> = new Set([
  "assets.embedAsset",
  "assets.embedAssetDoc",
  "assets.processAssetText",
  "cleanup.runCleanup",
  "cleanup.runMyRetentionCleanup",
  "cleanup.summarizeBatchForManualBackfill",
  "knowledgeBases.backfillKnowledgeBaseEmbeddings",
  "knowledgeBases.batchEmbedTexts",
  "knowledgeBases.embedText",
  "knowledgeBases.runKnowledgeBaseQuery",
  "ltmExtraction.extractWindowMemories",
  "mcp.backfillEmbeddings",
  "mcp.embedMemory",
  "mcp.recall",
  "onlineMigration.reembedOne",
  "providerDiagnostics.probeOpenRouterEmbeddingForUser",
  "reembed.reembedStaleAssets",
  "reflection.reviewLowSalienceMemories",
  "research.semanticSearch",
  "seed.embedFixtureContent",
]);
/** OpenRouter model id: `provider/model` with an optional `:variant`. */
const SAFE_MODEL = /^[a-z0-9][a-z0-9-]{0,39}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(:[a-z0-9-]{1,20})?$/;
const CREDENTIAL_SHAPE = /(^|[^A-Za-z0-9])(sk|pk|rk)-[A-Za-z0-9]/i;
const SAFE_DIGEST = /^[a-f0-9]{16,64}$/;

export function endpointKindFor(endpoint: string | null | undefined): ProviderEndpointKind {
  if (!endpoint) return "unknown";
  if (endpoint === OPENROUTER_CHAT_COMPLETIONS_ENDPOINT || /\/chat\/completions(\?|$)/.test(endpoint)) {
    return "chat_completions";
  }
  if (endpoint === OPENROUTER_EMBEDDINGS_ENDPOINT || /\/embeddings(\?|$)/.test(endpoint)) {
    return "embeddings";
  }
  return "unknown";
}

/**
 * Closed, bounded normalisation of scope metadata. Anything that does not fit
 * the safe identifier grammar collapses to "unknown" — free text (prompts,
 * error messages, URLs, request IDs) can never become part of an identity.
 */
export function normalizeProviderScope(input: Partial<ProviderScope> | null | undefined): ProviderScope {
  const source = typeof input?.source === "string" && PROVIDER_SOURCE_LABELS.has(input.source) ? input.source : UNKNOWN_SCOPE_VALUE;
  const endpointKind: ProviderEndpointKind =
    input?.endpointKind === "chat_completions" || input?.endpointKind === "embeddings" ? input.endpointKind : "unknown";
  const model =
    typeof input?.model === "string" && SAFE_MODEL.test(input.model) && !CREDENTIAL_SHAPE.test(input.model)
      ? input.model
      : UNKNOWN_SCOPE_VALUE;
  const rawDigest = input?.keyDigest;
  const keyDigest =
    rawDigest === MISSING_KEY_DIGEST
      ? MISSING_KEY_DIGEST
      : typeof rawDigest === "string" && SAFE_DIGEST.test(rawDigest)
        ? rawDigest
        : UNKNOWN_SCOPE_VALUE;
  return { source, endpointKind, model, keyDigest };
}

export function buildScopeKey(scope: ProviderScope): string {
  return `${scope.source}|${scope.endpointKind}|${scope.model}|${scope.keyDigest}`;
}

/** Action-side only: hash the credential so mutation args never carry it. */
export async function computeKeyDigest(apiKey: string | null | undefined): Promise<string> {
  if (!apiKey) return MISSING_KEY_DIGEST;
  return await sha256Hex(apiKey);
}

export function isLegacyScope(scope: ProviderScope): boolean {
  return scope.source === UNKNOWN_SCOPE_VALUE && scope.endpointKind === "unknown" && scope.model === UNKNOWN_SCOPE_VALUE && scope.keyDigest === UNKNOWN_SCOPE_VALUE;
}

/** Human-readable, already-safe scope line for templates ("" when unknown). */
export function describeScope(scope: Partial<ProviderScope> | null | undefined): string {
  const normalised = normalizeProviderScope(scope);
  const parts: string[] = [];
  if (normalised.source !== UNKNOWN_SCOPE_VALUE) parts.push(`operation ${normalised.source}`);
  if (normalised.endpointKind !== "unknown") parts.push(normalised.endpointKind.replace("_", " "));
  if (normalised.model !== UNKNOWN_SCOPE_VALUE) parts.push(`model ${normalised.model}`);
  return parts.length ? `Affected request: ${parts.join(", ")}.` : "";
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

export type AlertDelivery = {
  templateSlug: string;
  generation: number;
  attempt: number;
  scheduledAt: number;
  sentAt?: number;
};

export type IncidentTransition = {
  at: number;
  kind: string;
  failureClass?: string;
  httpStatus?: number;
  templateSlug?: string;
};

export type ProviderFailureState = {
  userId: string;
  failureClass: string;
  status: "failure" | "recovered";
  /** Latest alert send dispatched (any template). Kept for legacy readers. */
  emailScheduledAt?: number;
  /** Latest alert send confirmed delivered (any template). Kept for legacy readers. */
  emailSentAt?: number;
  /** Start of the current uninterrupted matching-success streak, if any. */
  recoveryPendingSince?: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lastFailureDayKey?: string;
  /** Legacy adjacent-UTC-date counter. Informational only since ILL-302. */
  consecutiveBlockedDays: number;
  keyLast4?: string;
  lastSuccessAt?: number;
  updatedAt: number;
  // ── ILL-302 scoped incident fields (absent on legacy unscoped rows) ──
  scopeVersion?: number;
  scopeKey?: string;
  source?: string;
  endpointKind?: string;
  model?: string;
  keyDigest?: string;
  generation?: number;
  resolvedAt?: number;
  transientWindowStartAt?: number;
  transientWindowCount?: number;
  lastHttpStatus?: number;
  lastFailureCategory?: string;
  alertDeliveries?: AlertDelivery[];
  transitions?: IncidentTransition[];
  recoveryScheduledAt?: number;
  recoverySentAt?: number;
  recoveryAttempt?: number;
  overflowCount?: number;
  overflowFirstFailureAt?: number;
  overflowAcknowledgedAt?: number;
};

export type DeliveryFence = { generation: number; attempt: number };

export type OutcomeDecision =
  | { action: "send"; templateSlug: string; variables: Record<string, string>; fence?: DeliveryFence }
  | { action: "suppress" }
  | { action: "none" };

function variablesForScope(state: Pick<ProviderFailureState, "keyLast4" | "source" | "endpointKind" | "model" | "keyDigest">): Record<string, string> {
  const variables: Record<string, string> = {};
  if (state.keyLast4) variables.keyLast4 = state.keyLast4;
  const scope = normalizeProviderScope({
    source: state.source,
    endpointKind: state.endpointKind as ProviderEndpointKind | undefined,
    model: state.model,
    keyDigest: state.keyDigest,
  });
  variables.scopeSummary = describeScope(scope);
  variables.operation = scope.source === UNKNOWN_SCOPE_VALUE ? "" : scope.source;
  variables.model = scope.model === UNKNOWN_SCOPE_VALUE ? "" : scope.model;
  return variables;
}

function pushTransition(list: IncidentTransition[] | undefined, transition: IncidentTransition): IncidentTransition[] {
  return [...(list ?? []), transition].slice(-MAX_INCIDENT_TRANSITIONS);
}

function deliveryFor(state: ProviderFailureState, templateSlug: string, generation: number): AlertDelivery | undefined {
  return (state.alertDeliveries ?? []).find((d) => d.templateSlug === templateSlug && d.generation === generation);
}

function upsertDelivery(list: AlertDelivery[] | undefined, entry: AlertDelivery): AlertDelivery[] {
  const rest = (list ?? []).filter((d) => !(d.templateSlug === entry.templateSlug && d.generation === entry.generation));
  // Only the current generation's entries matter; keep the array bounded.
  return [...rest, entry].filter((d) => d.generation === entry.generation).slice(-8);
}

export function isIncidentResolved(state: ProviderFailureState | null | undefined): boolean {
  return Boolean(state && state.resolvedAt !== undefined);
}

export type FailureEvent = {
  userId: string;
  failureClass: string;
  keyLast4?: string | null;
  now: number;
  /** Override for tests; defaults to ALERT_SEND_GRACE_MS. */
  sendGraceMs?: number;
  scope?: Partial<ProviderScope> | null;
  httpStatus?: number | null;
};

/**
 * Pure state machine for one scoped incident row on an observed failure.
 *
 * Identity is the scope, not the failure class: the class is recorded as the
 * latest observed class and drives template choice. Per-template delivery
 * state means an actionable alert is still sent immediately even if a
 * transient warning was already delivered for the same incident (and vice
 * versa). Suppression keys off *confirmed delivery* for the same generation
 * and template, never off having scheduled a send.
 *
 * Transient warning rule: >= TRANSIENT_WINDOW_MIN_FAILURES failures in one
 * unresolved window spanning >= TRANSIENT_WINDOW_MIN_SPAN_MS. The window start
 * and count are independent of the bounded transition history.
 */
export function evaluateFailureDecision(
  prev: ProviderFailureState | null,
  event: FailureEvent,
): { decision: OutcomeDecision; next: ProviderFailureState } {
  const { userId, failureClass, keyLast4, now } = event;
  const sendGraceMs = event.sendGraceMs ?? ALERT_SEND_GRACE_MS;
  const scope = normalizeProviderScope(
    event.scope ??
      (prev?.scopeKey
        ? { source: prev.source, endpointKind: prev.endpointKind as ProviderEndpointKind, model: prev.model, keyDigest: prev.keyDigest }
        : null),
  );
  const dayKey = dayKeyFor(now);
  const reopened = prev !== null && isIncidentResolved(prev);
  const base = reopened ? null : prev;
  const generation = reopened ? (prev!.generation ?? 1) + 1 : (prev?.generation ?? 1);
  const category: FailureCategory = isActionableFailureClass(failureClass) ? "actionable" : "transient";
  const httpStatus = typeof event.httpStatus === "number" && Number.isFinite(event.httpStatus) ? event.httpStatus : undefined;

  const consecutiveBlockedDays =
    base && base.lastFailureDayKey
      ? base.lastFailureDayKey === dayKey
        ? base.consecutiveBlockedDays
        : base.lastFailureDayKey === previousDayKey(dayKey)
          ? base.consecutiveBlockedDays + 1
          : 1
      : 1;

  const transientWindowStartAt =
    category === "transient" ? (base?.transientWindowStartAt ?? now) : base?.transientWindowStartAt;
  const transientWindowCount =
    category === "transient" ? (base?.transientWindowCount ?? 0) + 1 : (base?.transientWindowCount ?? 0);

  let transitions = prev?.transitions;
  if (reopened) transitions = pushTransition(transitions, { at: now, kind: "reopened", failureClass });
  transitions = pushTransition(transitions, { at: now, kind: "failure", failureClass, httpStatus });

  const next: ProviderFailureState = {
    userId,
    failureClass,
    status: "failure",
    emailScheduledAt: base?.emailScheduledAt,
    emailSentAt: base?.emailSentAt,
    // Any failure in the scope ends a pending recovery streak.
    recoveryPendingSince: undefined,
    firstFailureAt: base?.firstFailureAt ?? now,
    lastFailureAt: now,
    lastFailureDayKey: dayKey,
    consecutiveBlockedDays,
    keyLast4: keyLast4 ?? prev?.keyLast4,
    lastSuccessAt: prev?.lastSuccessAt,
    updatedAt: now,
    scopeVersion: SCOPE_VERSION,
    scopeKey: buildScopeKey(scope),
    source: scope.source,
    endpointKind: scope.endpointKind,
    model: scope.model,
    keyDigest: scope.keyDigest,
    generation,
    resolvedAt: undefined,
    transientWindowStartAt,
    transientWindowCount,
    lastHttpStatus: httpStatus ?? base?.lastHttpStatus,
    lastFailureCategory: category,
    alertDeliveries: reopened ? [] : (prev?.alertDeliveries ?? []),
    transitions,
    recoveryScheduledAt: undefined,
    recoverySentAt: undefined,
    // A reopened incident starts a new generation, so its attempt counter
    // restarts; otherwise keep it so a cancelled-and-replaced recovery never
    // reuses a superseded attempt number within the same generation.
    recoveryAttempt: reopened ? undefined : prev?.recoveryAttempt,
  };

  let templateSlug: string | null = null;
  if (category === "actionable") {
    templateSlug = FAILURE_CLASS_TEMPLATE_SLUGS[failureClass] ?? null;
  } else if (
    transientWindowCount >= TRANSIENT_WINDOW_MIN_FAILURES &&
    transientWindowStartAt !== undefined &&
    now - transientWindowStartAt >= TRANSIENT_WINDOW_MIN_SPAN_MS
  ) {
    templateSlug = TRANSIENT_BLOCKED_TEMPLATE_SLUG;
  }
  if (!templateSlug) return { decision: { action: "none" }, next };

  const existing = deliveryFor(next, templateSlug, generation);
  // Confirmed delivered for this template + generation: stay quiet.
  if (existing?.sentAt !== undefined) return { decision: { action: "suppress" }, next };
  // Dispatched moments ago and not yet reported: assume in flight so a burst
  // of failures in one cycle produces one email, not one per failure.
  if (existing && now - existing.scheduledAt < sendGraceMs) return { decision: { action: "suppress" }, next };

  const attempt = (existing?.attempt ?? 0) + 1;
  next.alertDeliveries = upsertDelivery(next.alertDeliveries, { templateSlug, generation, attempt, scheduledAt: now });
  next.emailScheduledAt = now;
  next.transitions = pushTransition(next.transitions, { at: now, kind: "alert_scheduled", templateSlug });
  return {
    decision: { action: "send", templateSlug, variables: variablesForScope(next), fence: { generation, attempt } },
    next,
  };
}

function hasUnknownScopePart(scope: { source?: string; endpointKind?: string; model?: string; keyDigest?: string }): boolean {
  return (
    !scope.source || scope.source === UNKNOWN_SCOPE_VALUE ||
    !scope.endpointKind || scope.endpointKind === "unknown" ||
    !scope.model || scope.model === UNKNOWN_SCOPE_VALUE ||
    !scope.keyDigest || scope.keyDigest === UNKNOWN_SCOPE_VALUE
  );
}

/** True when a success in `scope` may act on `state` (exact scope, or the missing-key transition). */
export function successMatchesIncident(state: ProviderFailureState, scope: ProviderScope | null | undefined): boolean {
  if (!state.scopeKey) return false; // legacy unscoped rows: conservatively unresolved
  if (!scope) return false; // legacy/unknown success context cannot clear scoped incidents
  if (state.scopeKey === OVERFLOW_SCOPE_KEY) return false; // overflow recovery is never inferred
  // Unknown or partially unknown context (either side) cannot infer recovery.
  if (hasUnknownScopePart(scope) || hasUnknownScopePart(state)) return false;
  if (buildScopeKey(scope) === state.scopeKey) return true;
  // Missing-key transition (req 4): a credential became available and calls for
  // the *same* user/operation/endpoint/model now succeed. Key replacement alone
  // is not success; other operations never count.
  return (
    state.keyDigest === MISSING_KEY_DIGEST &&
    scope.keyDigest !== MISSING_KEY_DIGEST &&
    state.source === scope.source &&
    state.endpointKind === scope.endpointKind &&
    state.model === scope.model
  );
}

/**
 * Missing-key rows a failure in `scope` must interrupt: same user/operation/
 * endpoint/model with a real key (the mirror of the success transition in
 * successMatchesIncident). Unknown or missing-key failures never qualify —
 * a missing-key failure already lands on the missing-key row itself.
 */
export function missingKeyScopeInterruptedBy(scope: ProviderScope): ProviderScope | null {
  if (hasUnknownScopePart(scope) || scope.keyDigest === MISSING_KEY_DIGEST) return null;
  return { ...scope, keyDigest: MISSING_KEY_DIGEST };
}

/**
 * Pure: a failure on the keyed counterpart of a missing-key incident breaks
 * that incident's recovery evidence without merging identities (the failure
 * itself is recorded only on its own keyed row).
 *  - Unresolved with a hold armed: the hold resets, so recovery again needs
 *    two matching successes RECOVERY_STABLE_MS apart after this failure.
 *  - Resolved with a recovery email scheduled (or failed) but not delivered:
 *    that send is cancelled and the row is reopened on the same generation so
 *    the recovery stays owed. The attempt counter is kept, so the replacement
 *    (after a fresh uninterrupted hold) is fenced under a higher attempt: the
 *    cancelled send is skipped as stale and its late callback confirms nothing.
 * Returns `next: null` when the row is unaffected.
 */
export function evaluateMissingKeyInterruption(
  prev: ProviderFailureState,
  scope: ProviderScope,
  now: number,
): { next: ProviderFailureState | null } {
  const target = missingKeyScopeInterruptedBy(scope);
  if (!target || prev.scopeKey !== buildScopeKey(target)) return { next: null };
  if (isIncidentResolved(prev)) {
    if (prev.recoveryScheduledAt === undefined || prev.recoverySentAt !== undefined) return { next: null };
    return {
      next: {
        ...prev,
        status: "failure",
        resolvedAt: undefined,
        recoveryPendingSince: undefined,
        recoveryScheduledAt: undefined,
        updatedAt: now,
        transitions: pushTransition(prev.transitions, { at: now, kind: "recovery_cancelled", templateSlug: RECOVERY_TEMPLATE_SLUG }),
      },
    };
  }
  if (prev.recoveryPendingSince === undefined) return { next: null };
  return {
    next: {
      ...prev,
      status: "failure",
      recoveryPendingSince: undefined,
      updatedAt: now,
      transitions: pushTransition(prev.transitions, { at: now, kind: "recovery_interrupted" }),
    },
  };
}

/**
 * Pure recovery decision for one scoped incident on an observed success.
 *
 * Returns `next: null` when the success does not apply to this row (wrong
 * scope, legacy row, overflow row) so callers leave the row untouched.
 *
 *  - Unalerted incident, nothing pending in grace: the success resets the
 *    transient window and resolves the incident quietly.
 *  - Alerted (or send pending in grace): the first success arms a hold; a
 *    success once the hold outlives `stableMs` resolves the incident and, if
 *    any alert of this generation was delivered, sends one recovery email.
 *  - Already resolved: an undelivered recovery older than the send grace is
 *    re-dispatched (retry without cron or probes); otherwise no-op.
 */
export function evaluateSuccessDecision(
  prev: ProviderFailureState | null,
  now: number,
  options?: { stableMs?: number; sendGraceMs?: number; scope?: Partial<ProviderScope> | null },
): { decision: OutcomeDecision; resolved: boolean; next: ProviderFailureState | null } {
  if (!prev) return { decision: { action: "none" }, resolved: false, next: null };
  const stableMs = options?.stableMs ?? RECOVERY_STABLE_MS;
  const sendGraceMs = options?.sendGraceMs ?? ALERT_SEND_GRACE_MS;
  const scope = options?.scope ? normalizeProviderScope(options.scope) : null;
  if (!successMatchesIncident(prev, scope)) {
    return { decision: { action: "none" }, resolved: isIncidentResolved(prev), next: null };
  }
  const generation = prev.generation ?? 1;

  if (isIncidentResolved(prev)) {
    const recoveryPending = prev.recoveryScheduledAt !== undefined && prev.recoverySentAt === undefined;
    if (recoveryPending && now - (prev.recoveryScheduledAt as number) >= sendGraceMs) {
      const attempt = (prev.recoveryAttempt ?? 0) + 1;
      return {
        decision: { action: "send", templateSlug: RECOVERY_TEMPLATE_SLUG, variables: variablesForScope(prev), fence: { generation, attempt } },
        resolved: true,
        next: {
          ...prev,
          lastSuccessAt: now,
          recoveryScheduledAt: now,
          recoveryAttempt: attempt,
          updatedAt: now,
          transitions: pushTransition(prev.transitions, { at: now, kind: "recovery_scheduled", templateSlug: RECOVERY_TEMPLATE_SLUG }),
        },
      };
    }
    return { decision: { action: "none" }, resolved: true, next: { ...prev, lastSuccessAt: now, updatedAt: now } };
  }

  const deliveries = (prev.alertDeliveries ?? []).filter((d) => d.generation === generation);
  const anyDelivered = deliveries.some((d) => d.sentAt !== undefined);
  const anyPendingInGrace = deliveries.some((d) => d.sentAt === undefined && now - d.scheduledAt < sendGraceMs);

  if (!anyDelivered && !anyPendingInGrace) {
    // Nobody was told: reset the transient window and close quietly.
    return {
      decision: { action: "none" },
      resolved: true,
      next: {
        ...prev,
        status: "recovered",
        resolvedAt: now,
        recoveryPendingSince: undefined,
        transientWindowStartAt: undefined,
        transientWindowCount: 0,
        lastSuccessAt: now,
        updatedAt: now,
        transitions: pushTransition(prev.transitions, { at: now, kind: "resolved" }),
      },
    };
  }

  const pendingSince = prev.recoveryPendingSince;
  if (pendingSince === undefined || now < pendingSince) {
    // First matching success since the last failure: arm the hold, keep the row.
    return {
      decision: { action: "none" },
      resolved: false,
      next: {
        ...prev,
        status: "recovered",
        recoveryPendingSince: now,
        lastSuccessAt: now,
        updatedAt: now,
        transitions: pushTransition(prev.transitions, { at: now, kind: "recovery_armed" }),
      },
    };
  }

  if (now - pendingSince < stableMs) {
    return {
      decision: { action: "none" },
      resolved: false,
      next: { ...prev, status: "recovered", lastSuccessAt: now, updatedAt: now },
    };
  }

  const resolvedState: ProviderFailureState = {
    ...prev,
    status: "recovered",
    resolvedAt: now,
    transientWindowStartAt: undefined,
    transientWindowCount: 0,
    lastSuccessAt: now,
    updatedAt: now,
    transitions: pushTransition(prev.transitions, { at: now, kind: "resolved" }),
  };
  if (!anyDelivered) {
    return { decision: { action: "none" }, resolved: true, next: resolvedState };
  }
  // First recovery of a generation is attempt 1; a recovery re-owed after a
  // cancelled attempt continues the count so old fences never match again.
  const recoveryAttempt = (prev.recoveryAttempt ?? 0) + 1;
  resolvedState.recoveryScheduledAt = now;
  resolvedState.recoveryAttempt = recoveryAttempt;
  resolvedState.transitions = pushTransition(resolvedState.transitions, { at: now, kind: "recovery_scheduled", templateSlug: RECOVERY_TEMPLATE_SLUG });
  return {
    decision: { action: "send", templateSlug: RECOVERY_TEMPLATE_SLUG, variables: variablesForScope(prev), fence: { generation, attempt: recoveryAttempt } },
    resolved: true,
    next: resolvedState,
  };
}

/**
 * Pure delivery confirmation, fenced to template + generation + attempt. A
 * late callback from an older generation or a superseded attempt confirms
 * nothing, so it can never suppress a newer incident.
 */
export function applyAlertDelivery(
  prev: ProviderFailureState,
  confirmation: { templateSlug: string; generation: number; attempt: number; sentAt: number; now?: number },
): { confirmed: boolean; next: ProviderFailureState } {
  const now = confirmation.now ?? confirmation.sentAt;
  if ((prev.generation ?? 1) !== confirmation.generation) return { confirmed: false, next: prev };
  if (confirmation.templateSlug === RECOVERY_TEMPLATE_SLUG) {
    if (!isIncidentResolved(prev) || prev.recoveryAttempt !== confirmation.attempt || prev.recoverySentAt !== undefined) {
      return { confirmed: false, next: prev };
    }
    return {
      confirmed: true,
      next: {
        ...prev,
        recoverySentAt: confirmation.sentAt,
        updatedAt: now,
        transitions: pushTransition(prev.transitions, { at: now, kind: "recovery_delivered", templateSlug: RECOVERY_TEMPLATE_SLUG }),
      },
    };
  }
  const entry = deliveryFor(prev, confirmation.templateSlug, confirmation.generation);
  if (!entry || entry.attempt !== confirmation.attempt || entry.sentAt !== undefined) return { confirmed: false, next: prev };
  return {
    confirmed: true,
    next: {
      ...prev,
      emailSentAt: confirmation.sentAt,
      alertDeliveries: upsertDelivery(prev.alertDeliveries, { ...entry, sentAt: confirmation.sentAt }),
      updatedAt: now,
      transitions: pushTransition(prev.transitions, { at: now, kind: "alert_delivered", templateSlug: confirmation.templateSlug }),
    },
  };
}

/** True when a scheduled send (generation + attempt) is still the current one. */
export function isAlertSendCurrent(
  state: ProviderFailureState | null,
  send: { templateSlug: string; generation: number; attempt: number },
): boolean {
  if (!state || (state.generation ?? 1) !== send.generation) return false;
  if (send.templateSlug === RECOVERY_TEMPLATE_SLUG) {
    return isIncidentResolved(state) && state.recoveryAttempt === send.attempt && state.recoverySentAt === undefined;
  }
  if (isIncidentResolved(state)) return false;
  const entry = deliveryFor(state, send.templateSlug, send.generation);
  return Boolean(entry && entry.attempt === send.attempt && entry.sentAt === undefined);
}

/**
 * Pure reducer for the per-user overflow summary (req 5). Counts failures
 * that could not get a tracked scope; sends at most one generic warning with
 * the same delivered/retry semantics. Ordinary successes never touch it.
 */
export function evaluateOverflowFailure(
  prev: ProviderFailureState | null,
  event: { userId: string; failureClass: string; now: number; sendGraceMs?: number },
): { decision: OutcomeDecision; next: ProviderFailureState } {
  const { userId, failureClass, now } = event;
  const sendGraceMs = event.sendGraceMs ?? ALERT_SEND_GRACE_MS;
  const next: ProviderFailureState = {
    userId,
    failureClass,
    status: "failure",
    emailScheduledAt: prev?.emailScheduledAt,
    emailSentAt: prev?.emailSentAt,
    firstFailureAt: prev?.firstFailureAt ?? now,
    lastFailureAt: now,
    lastFailureDayKey: dayKeyFor(now),
    consecutiveBlockedDays: 1,
    updatedAt: now,
    scopeVersion: SCOPE_VERSION,
    scopeKey: OVERFLOW_SCOPE_KEY,
    generation: prev?.generation ?? 1,
    lastFailureCategory: isActionableFailureClass(failureClass) ? "actionable" : "transient",
    alertDeliveries: prev?.alertDeliveries ?? [],
    overflowCount: (prev?.overflowCount ?? 0) + 1,
    overflowFirstFailureAt: prev?.overflowFirstFailureAt ?? now,
    overflowAcknowledgedAt: prev?.overflowAcknowledgedAt,
  };
  if (next.overflowAcknowledgedAt !== undefined) return { decision: { action: "suppress" }, next };
  const generation = next.generation ?? 1;
  const existing = deliveryFor(next, OVERFLOW_TEMPLATE_SLUG, generation);
  if (existing?.sentAt !== undefined) return { decision: { action: "suppress" }, next };
  if (existing && now - existing.scheduledAt < sendGraceMs) return { decision: { action: "suppress" }, next };
  const attempt = (existing?.attempt ?? 0) + 1;
  next.alertDeliveries = upsertDelivery(next.alertDeliveries, { templateSlug: OVERFLOW_TEMPLATE_SLUG, generation, attempt, scheduledAt: now });
  next.emailScheduledAt = now;
  return {
    decision: { action: "send", templateSlug: OVERFLOW_TEMPLATE_SLUG, variables: { scopeSummary: "", operation: "", model: "" }, fence: { generation, attempt } },
    next,
  };
}

/** Rows eligible for eviction: resolved, and any recovery mail already delivered (or never owed). */
export function isEvictable(state: ProviderFailureState): boolean {
  if (!state.scopeKey || state.scopeKey === OVERFLOW_SCOPE_KEY) return false;
  if (!isIncidentResolved(state)) return false;
  return state.recoveryScheduledAt === undefined || state.recoverySentAt !== undefined;
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

const scopeValidator = v.object({
  source: v.string(),
  endpointKind: v.string(),
  model: v.string(),
  keyDigest: v.string(),
});

type StoredRow = ProviderFailureState & { _id: any; _creationTime: number };

function toProviderFailureState(row: StoredRow): ProviderFailureState {
  const { _id, _creationTime, ...rest } = row;
  return rest as ProviderFailureState;
}

async function findScopedRow(ctx: any, userId: string, scopeKey: string): Promise<StoredRow | null> {
  return (await ctx.db
    .query("providerFailureState")
    .withIndex("by_user_scope", (q: any) => q.eq("userId", userId).eq("scopeKey", scopeKey))
    .first()) as StoredRow | null;
}

/** Bounded: normal scoped rows only (legacy rows have no scopeKey, overflow sorts after "~"). */
async function listNormalScopedRows(ctx: any, userId: string, limit: number): Promise<StoredRow[]> {
  return (await ctx.db
    .query("providerFailureState")
    .withIndex("by_user_scope", (q: any) => q.eq("userId", userId).gt("scopeKey", "").lt("scopeKey", OVERFLOW_SCOPE_KEY))
    .take(limit)) as StoredRow[];
}

async function scheduleProviderEmail(
  ctx: any,
  args: { userId: string; stateId: Id<"providerFailureState">; scopeKey: string; failureClass: string; decision: Extract<OutcomeDecision, { action: "send" }> },
) {
  // Mutations cannot call actions directly; schedule the send so it runs after
  // this mutation commits, via the shared emailEngine path. The send confirms
  // itself back into this scope, fenced to generation + attempt AND the row's
  // immutable _id: generation restarts at 1 when an evicted scope is recreated,
  // so a delayed send from the old incarnation must never match the new row.
  await ctx.scheduler.runAfter(0, (internal as any).crystal.emailEngine.sendTemplateEmail, {
    userId: args.userId,
    templateSlug: args.decision.templateSlug,
    variables: args.decision.variables,
    onSent: {
      kind: "providerAlert" as const,
      userId: args.userId,
      failureClass: args.failureClass,
      stateId: args.stateId,
      scopeKey: args.scopeKey,
      templateSlug: args.decision.templateSlug,
      generation: args.decision.fence?.generation,
      attempt: args.decision.fence?.attempt,
    },
  });
}

/**
 * Resolves the row a scoped send/callback was fenced to. The row must still be
 * the same incarnation (same _id) and still carry the same user + scopeKey;
 * anything else (evicted, recreated, foreign) is not bound.
 */
async function findFencedRow(ctx: any, args: { userId: string; scopeKey: string; stateId: Id<"providerFailureState"> }): Promise<StoredRow | null> {
  const row = (await ctx.db.get(args.stateId)) as StoredRow | null;
  if (!row || row.userId !== args.userId || row.scopeKey !== args.scopeKey) return null;
  return row;
}

/**
 * Atomically applies one observed outcome (failure or success) for a scope
 * and dispatches any email the policy calls for. Emails are sent via the
 * shared emailEngine path (crystalEmailTemplates / crystalEmailLog), never a
 * parallel mail path.
 *
 * Compatibility: `scope` is optional. A failure without scope is recorded
 * under the all-unknown scope; a success without scope cannot resolve
 * anything (legacy context must not clear scoped incidents).
 */
export const applyProviderOutcome = internalMutation({
  args: {
    userId: v.string(),
    kind: v.union(v.literal("failure"), v.literal("success")),
    failureClass: v.optional(v.string()),
    keyLast4: v.optional(v.string()),
    scope: v.optional(scopeValidator),
    httpStatus: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const scope = args.scope ? normalizeProviderScope(args.scope as Partial<ProviderScope>) : null;

    if (args.kind === "success") {
      if (!scope) return { kind: "success" as const, cleared: false, resolved: false, emailSent: false };
      const candidates: StoredRow[] = [];
      const exact = await findScopedRow(ctx, args.userId, buildScopeKey(scope));
      if (exact) candidates.push(exact);
      if (scope.keyDigest !== MISSING_KEY_DIGEST) {
        const missingKeyRow = await findScopedRow(ctx, args.userId, buildScopeKey({ ...scope, keyDigest: MISSING_KEY_DIGEST }));
        if (missingKeyRow) candidates.push(missingKeyRow);
      }
      let resolvedNow = false;
      let emailSent = false;
      for (const row of candidates) {
        const state = toProviderFailureState(row);
        const wasResolved = isIncidentResolved(state);
        const { decision, resolved, next } = evaluateSuccessDecision(state, now, { scope });
        if (!next) continue;
        await ctx.db.patch(row._id, next);
        if (resolved && !wasResolved) resolvedNow = true;
        if (decision.action === "send") {
          emailSent = true;
          await scheduleProviderEmail(ctx, { userId: args.userId, stateId: row._id, scopeKey: row.scopeKey as string, failureClass: state.failureClass, decision });
        }
      }
      return { kind: "success" as const, cleared: resolvedNow, resolved: resolvedNow, emailSent };
    }

    const failureClass = args.failureClass ?? "http_error";
    const failureScope = scope ?? normalizeProviderScope(null);
    const scopeKey = buildScopeKey(failureScope);
    // A keyed failure invalidates the same operation's missing-key recovery
    // evidence (hold or undelivered recovery), whatever row it lands on below.
    const interruptedScope = missingKeyScopeInterruptedBy(failureScope);
    if (interruptedScope) {
      const missingKeyRow = await findScopedRow(ctx, args.userId, buildScopeKey(interruptedScope));
      if (missingKeyRow) {
        const { next } = evaluateMissingKeyInterruption(toProviderFailureState(missingKeyRow), failureScope, now);
        if (next) await ctx.db.patch(missingKeyRow._id, next);
      }
    }
    const prev = await findScopedRow(ctx, args.userId, scopeKey);
    const event: FailureEvent = {
      userId: args.userId,
      failureClass,
      keyLast4: args.keyLast4,
      now,
      scope: failureScope,
      httpStatus: args.httpStatus,
    };

    if (prev) {
      const { decision, next } = evaluateFailureDecision(toProviderFailureState(prev), event);
      await ctx.db.patch(prev._id, next);
      if (decision.action === "send") {
        await scheduleProviderEmail(ctx, { userId: args.userId, stateId: prev._id, scopeKey, failureClass, decision });
      }
      return { kind: "failure" as const, failureClass, decision: decision.action, scopeKey, overflow: false };
    }

    // New scope: enforce the per-user bound before inserting.
    const tracked = await listNormalScopedRows(ctx, args.userId, MAX_TRACKED_SCOPES_PER_USER + 1);
    if (tracked.length >= MAX_TRACKED_SCOPES_PER_USER) {
      const evictable = tracked.filter((row) => isEvictable(toProviderFailureState(row)));
      if (evictable.length === 0) {
        const overflowRow = await findScopedRow(ctx, args.userId, OVERFLOW_SCOPE_KEY);
        const { decision, next } = evaluateOverflowFailure(
          overflowRow ? toProviderFailureState(overflowRow) : null,
          { userId: args.userId, failureClass, now },
        );
        let overflowId: Id<"providerFailureState">;
        if (overflowRow) {
          overflowId = overflowRow._id;
          await ctx.db.patch(overflowId, next);
        } else {
          overflowId = await ctx.db.insert("providerFailureState", next);
        }
        if (decision.action === "send") {
          await scheduleProviderEmail(ctx, { userId: args.userId, stateId: overflowId, scopeKey: OVERFLOW_SCOPE_KEY, failureClass, decision });
        }
        return { kind: "failure" as const, failureClass, decision: decision.action, scopeKey: OVERFLOW_SCOPE_KEY, overflow: true };
      }
      evictable.sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
      await ctx.db.delete(evictable[0]._id);
    }

    const { decision, next } = evaluateFailureDecision(null, event);
    const insertedId = await ctx.db.insert("providerFailureState", next);
    if (decision.action === "send") {
      await scheduleProviderEmail(ctx, { userId: args.userId, stateId: insertedId, scopeKey, failureClass, decision });
    }
    return { kind: "failure" as const, failureClass, decision: decision.action, scopeKey, overflow: false };
  },
});

/**
 * Pre-send stale check used by emailEngine: a scheduled provider alert whose
 * generation/attempt is no longer current — or whose row incarnation no longer
 * exists (evicted, possibly recreated under the same scope) — is skipped
 * instead of sent.
 */
export const isProviderAlertCurrent = internalQuery({
  args: {
    userId: v.string(),
    stateId: v.id("providerFailureState"),
    scopeKey: v.string(),
    templateSlug: v.string(),
    generation: v.number(),
    attempt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await findFencedRow(ctx, args);
    return isAlertSendCurrent(row ? toProviderFailureState(row) : null, args);
  },
});

/**
 * Delivery callback for a provider alert. Invoked by emailEngine only when the
 * send reached SendGrid with a 2xx (crystalEmailLog status "sent"); a failed,
 * skipped, or dry-run send never calls it, which is what keeps the template
 * re-alertable on the next matching failure.
 *
 * Scoped callbacks are fenced to row incarnation (_id) + scope + generation +
 * attempt; a callback whose row was evicted confirms nothing even if the same
 * scope has since been recreated. Legacy callbacks (no scopeKey — an in-flight
 * send scheduled before this deploy) may only stamp legacy unscoped rows, never
 * a scoped record.
 */
export const confirmProviderAlertSent = internalMutation({
  args: {
    userId: v.string(),
    failureClass: v.string(),
    sentAt: v.number(),
    stateId: v.optional(v.id("providerFailureState")),
    scopeKey: v.optional(v.string()),
    templateSlug: v.optional(v.string()),
    generation: v.optional(v.number()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.scopeKey !== undefined) {
      if (args.stateId === undefined || args.templateSlug === undefined || args.generation === undefined || args.attempt === undefined) {
        return { confirmed: false };
      }
      const row = await findFencedRow(ctx, { userId: args.userId, scopeKey: args.scopeKey, stateId: args.stateId });
      if (!row) return { confirmed: false };
      const { confirmed, next } = applyAlertDelivery(toProviderFailureState(row), {
        templateSlug: args.templateSlug,
        generation: args.generation,
        attempt: args.attempt,
        sentAt: args.sentAt,
        now: Date.now(),
      });
      if (confirmed) await ctx.db.patch(row._id, next);
      return { confirmed };
    }
    const rows = (await ctx.db
      .query("providerFailureState")
      .withIndex("by_user_failure_class", (q) => q.eq("userId", args.userId).eq("failureClass", args.failureClass))
      .take(20)) as StoredRow[];
    const legacy = rows.find((row) => row.scopeKey === undefined);
    if (!legacy) return { confirmed: false };
    await ctx.db.patch(legacy._id, { emailSentAt: args.sentAt, updatedAt: Date.now() });
    return { confirmed: true };
  },
});

// ── Action-side helpers used by every call site ──────────────────────────────

type RecordCtx = Pick<any, "runMutation">;

export async function recordProviderFailure(
  ctx: RecordCtx,
  args: { userId: string; failureClass: string; keyLast4?: string | null; scope?: ProviderScope | null; httpStatus?: number | null },
): Promise<void> {
  await ctx.runMutation(internal.crystal.providerGateway.applyProviderOutcome, {
    userId: args.userId,
    kind: "failure",
    failureClass: args.failureClass,
    keyLast4: args.keyLast4 ?? undefined,
    scope: args.scope ?? undefined,
    httpStatus: typeof args.httpStatus === "number" ? args.httpStatus : undefined,
  });
}

export async function recordProviderSuccess(ctx: RecordCtx, userId: string, scope?: ProviderScope | null): Promise<void> {
  await ctx.runMutation(internal.crystal.providerGateway.applyProviderOutcome, {
    userId,
    kind: "success",
    scope: scope ?? undefined,
  });
}

/**
 * Missing credential at a call site. Scope carries the operation, endpoint kind
 * and model the call would have used, with keyDigest = MISSING_KEY_DIGEST. The
 * incident recovers only once calls for that same operation/endpoint/model
 * succeed (see successMatchesIncident); adding a key is not itself success.
 */
export async function recordMissingOpenRouterKey(
  ctx: RecordCtx,
  args: { userId: string; keyLast4?: string | null; source?: string; endpointKind?: ProviderEndpointKind; model?: string },
): Promise<void> {
  await recordProviderFailure(ctx, {
    userId: args.userId,
    failureClass: "missing_openrouter_key",
    keyLast4: args.keyLast4 ?? null,
    scope: normalizeProviderScope({ source: args.source, endpointKind: args.endpointKind, model: args.model, keyDigest: MISSING_KEY_DIGEST }),
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_REQUEST_TIMEOUT_MS);
  // Scope identity is computed here, action-side, only when an outcome is
  // recorded: the key is hashed and never leaves this function; model/source
  // are normalised to safe identifiers.
  const scopeFor = async (): Promise<ProviderScope> =>
    normalizeProviderScope({
      source: args.source,
      endpointKind: endpointKindFor(args.endpoint),
      model: typeof (args.body as any)?.model === "string" ? (args.body as any).model : undefined,
      keyDigest: await computeKeyDigest(args.apiKey),
    });
  try {
    const response = await fetch(args.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`,
        ...(args.headers ?? {}),
      },
      body: JSON.stringify(args.body),
      signal: controller.signal,
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
        await recordProviderSuccess(ctx, args.userId, await scopeFor()).catch(async (error) => {
          console.warn(`[providerGateway] failed to record success for ${await logLabel(args.userId)}`, await logError(error, args.userId));
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
        scope: await scopeFor(),
        httpStatus,
      }).catch(async (error) => {
        console.warn(`[providerGateway] failed to record failure for ${await logLabel(args.userId)}`, await logError(error, args.userId));
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
        scope: await scopeFor().catch(() => null),
        httpStatus: 0,
      }).catch(() => {});
    }
    return { ok: false, status: 0, failureClass: "timeout", category: "transient", errorMessage: null };
  } finally {
    clearTimeout(timeout);
  }
}
