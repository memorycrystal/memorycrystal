// Functions that return active credentials must never run through a wrapper
// with inherited stdout/stderr. Keep this classification centralized and
// source-audited by convex-run-self-hosted.test.mjs across the Convex tree
// (crystal + cloud, mutations/queries/actions).
//
// Two complementary signals feed enforcement:
//  1. Explicit CREDENTIAL_RETURNING_FUNCTIONS (hand-maintained + source-checked)
//  2. Source discovery for property-name returns AND sensitive-table passthrough
//
// This is conservative auditing, not full dataflow analysis. Every export that
// references a SENSITIVE_TABLES name must be either credential-classified or
// listed in SENSITIVE_TABLE_SAFE_PROJECTIONS with a test proving the returned
// shape excludes raw secret fields.

/**
 * Tables whose full documents contain cleartext provider keys, API keys,
 * bootstrap/session tokens, or comparable secrets. Returning an entire row
 * (or Doc<"table">) from an exported Convex function is treated as credential
 * output unless an explicit safe projection is used (and listed below).
 */
export const SENSITIVE_TABLES = new Set([
  // Cleartext secret staging / stored admin secrets
  "crystalAdminSettingsStaging",
  "crystalAdminSettings",
  // Device install flow may hold a one-time apiKey
  "crystalDeviceAuth",
  // Per-user provider BYOK material
  "userProviderSettings",
]);

/**
 * Explicit allowlist of exports that touch a sensitive table but only return a
 * proven-safe projection (no cleartext / full secret-bearing rows). Each entry
 * is reviewed and guarded by source-shape tests in
 * scripts/convex-run-self-hosted.test.mjs.
 */
export const SENSITIVE_TABLE_SAFE_PROJECTIONS = new Set([
  // Projects secrets to last4/presence only — not full rows.
  "crystal/adminSettings/queries:getAdminSettings",
  // Side-effect / status-only mutations and non-secret projections that touch
  // sensitive tables without returning full documents or cleartext keys.
  "crystal/adminSettings/mutations:adminStageSecret",
  "crystal/adminSettings/mutations:deleteStagingRow",
  "crystal/adminSettings/mutations:pruneStaleStagingRows",
  "crystal/adminSettings/mutations:writeSecretRow",
  // adminPromoteSecret does not string-reference a SENSITIVE_TABLES name
  // (it reads via getStagingRow); it returns { ok, last4 } only — not listed.
  "crystal/deviceAuth:authorizeSession",
  "crystal/deviceAuth:clearApiKeyAfterRetrieval",
  "crystal/deviceAuth:markExpired",
  "crystal/evalStats:getTelemetryDiagnosticsForUser",
  // saveSelection returns void. getForUser uses distillationModelId only to
  // select a public catalog row (modelId, name, context/pricing, reasoning,
  // updatedAt); it never returns userProviderSettings.apiKey. Recovery returns
  // only { reset, approvalReference }, where the reference is caller-supplied.
  "crystal/distillationModels:saveSelection",
  "crystal/distillationModels:getForUser",
  "crystal/distillationRecovery:requeueApprovedPage",
  // Operator key copy: reads the source row server-side and returns only
  // { dryRun, fromUserId, targets: [{ userId, hadPersonalKey, alreadySame,
  // copied }] } — no key, prefix, last4 or digest.
  "crystal/providerSettings:copyOpenRouterKeyToUsers",
]);

export const CREDENTIAL_RETURNING_FUNCTIONS = new Set([
  // crystal — API keys / provider secrets / device install keys
  "crystal/adminSettings/mutations:getStagingRow",
  // stagingToken is a one-time capability to retrieve staged cleartext
  "crystal/adminSettings/mutations:adminUploadSecretCleartext",
  "crystal/adminSupport:adminRegenerateUserApiKey",
  "crystal/apiKeys:createApiKey",
  "crystal/apiKeys:mintApiKeyForUserInternal",
  "crystal/apiKeys:prepareApiKeyRotationForUserInternal",
  "crystal/apiKeys:provisionScopedResearchKeyInternal",
  "crystal/apiKeys:regenerateApiKey",
  "crystal/deviceAuth:getSessionStatus",
  // Newly minted device/user codes are session capabilities
  "crystal/deviceAuth:startSession",
  "crystal/mcp:issueApiKeyForUser",
  "crystal/providerSettings:resolveOpenRouterKeyForUser",
  // cloud — tenant bootstrap / tunnel / provision credentials
  "cloud/cfTunnel:claimTunnel",
  "cloud/provisionTenant:provisionTenant",
  "cloud/provisionTenantPublic:provisionTenantPublic",
  "cloud/tenants:reissueBootstrapToken",
  "cloud/tunnelReclaim:_resumeTenant",
]);

/**
 * Exact internal actions whose successful results may be printed by the
 * self-hosted wrapper after schema validation and field projection.
 * AC-7 / AC-8 / AC-10 count evidence only. Never a generic open channel.
 */
export const SAFE_OBSERVABLE_OUTPUT_SCHEMAS = Object.freeze({
  "crystal/dashboardTotals:backfillAllDashboardTotals": Object.freeze([
    "usersProcessed",
  ]),
  "crystal/apiKeys:scopedApiKeyExposureSummary": Object.freeze([
    "keysScanned",
    "scopedKeys",
    "scopedActiveKeys",
    "scopedKeysUsedLast30d",
    "scopedKeysWithOrdinaryAuditRows",
    "ordinaryAuditRows",
    "ordinaryAuditDestructiveRows",
    "ordinaryAuditAssetReadRows",
    "scopedKeysWithOrdinaryRateLimitRows",
    "scopedKeysWithExportRateLimitRow",
    "scopedKeysAuditCapped",
  ]),
});

export function classifyConvexFunctionOutput(functionName) {
  if (CREDENTIAL_RETURNING_FUNCTIONS.has(functionName)) {
    return "credential";
  }
  if (Object.prototype.hasOwnProperty.call(SAFE_OBSERVABLE_OUTPUT_SCHEMAS, functionName)) {
    return "safe-observable";
  }
  return "unclassified";
}

/**
 * Validate a successful function result against the allowlisted schema and
 * project only the documented non-negative integer count fields.
 * Throws on malformed payloads, extra fields, wrong types, or negative values.
 * Never returns or rethrows the raw value when invalid.
 */
export function projectSafeObservableOutput(functionName, value) {
  const fields = SAFE_OBSERVABLE_OUTPUT_SCHEMAS[functionName];
  if (!fields) {
    throw new Error(
      `Internal error: projectSafeObservableOutput called for non-allowlisted function ${functionName}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Safe-observable result for ${functionName} failed schema validation; privileged child output was suppressed.`,
    );
  }

  const keys = Object.keys(value);
  if (keys.length !== fields.length) {
    throw new Error(
      `Safe-observable result for ${functionName} failed schema validation; privileged child output was suppressed.`,
    );
  }

  const projected = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(
        `Safe-observable result for ${functionName} failed schema validation; privileged child output was suppressed.`,
      );
    }
    const n = value[field];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || !Number.isFinite(n)) {
      throw new Error(
        `Safe-observable result for ${functionName} failed schema validation; privileged child output was suppressed.`,
      );
    }
    projected[field] = n;
  }

  // Reject unexpected keys that are not in the allowlist (already checked via
  // length + hasOwnProperty, but re-check for defensive clarity).
  for (const key of keys) {
    if (!fields.includes(key)) {
      throw new Error(
        `Safe-observable result for ${functionName} failed schema validation; privileged child output was suppressed.`,
      );
    }
  }

  return projected;
}
