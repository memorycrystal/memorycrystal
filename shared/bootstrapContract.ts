/**
 * Versioned bootstrap payload contract (ILL-323, audit A13).
 *
 * One shape shared by the cloud producer (`convex/cloud/bootstrap.ts`
 * `consumeBootstrapToken`, served by the Next route
 * `POST /api/cloud/bootstrap/fetchInitialState`) and the local first-boot
 * consumer (`convex/local/bootstrap.ts` `fetchInitialState`).
 *
 * `parseBootstrapResponseV1` has two modes:
 *  - strict (producer): `version === 1` and `tenantSlug` are required, `null`
 *    is rejected for optional fields, and unknown fields are rejected.
 *    The route's `serverTime` is tolerated because it is not part of the
 *    checked bundle.
 *  - lenient (consumer): additionally accepts a missing `version`, the legacy
 *    `slug` field, `null` as absent, and ignores unknown fields.
 *
 * Both modes return a normalized bundle whose absent optional fields are
 * omitted (never `null`/`undefined`), so it can be passed straight to Convex
 * validators such as `v.optional(v.string())`.
 */

export const BOOTSTRAP_CONTRACT_VERSION = 1 as const;

/** How long a consumed token can be redelivered (lost-delivery retry). */
export const BOOTSTRAP_REDELIVERY_WINDOW_MS = 10 * 60 * 1000;

export interface BootstrapApiKeyV1 {
  keyHash: string;
  keyVersion: string;
  label?: string;
  createdAt: number;
}

export interface BootstrapBundleV1 {
  version: typeof BOOTSTRAP_CONTRACT_VERSION;
  tenantId: string;
  tenantSlug: string;
  mcVersion?: string;
  apiKeys: BootstrapApiKeyV1[];
}

export type BootstrapParseResult =
  | { ok: true; bundle: BootstrapBundleV1 }
  | { ok: false; error: string };

const BUNDLE_FIELDS = new Set(["version", "tenantId", "tenantSlug", "mcVersion", "apiKeys"]);
// `serverTime` is stamped by the route on top of the checked bundle.
const STRICT_RESPONSE_FIELDS = new Set([...BUNDLE_FIELDS, "serverTime"]);
const KEY_FIELDS = new Set(["keyHash", "keyVersion", "label", "createdAt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read an optional string field. Strict mode rejects `null`; lenient mode
 * treats `null` as absent. Returns `{ error }` on a type mismatch.
 */
function optionalString(
  value: unknown,
  strict: boolean,
): { value?: string; error?: true } {
  if (value === undefined) return {};
  if (value === null) return strict ? { error: true } : {};
  if (typeof value === "string") return { value };
  return { error: true };
}

function unknownField(record: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(record).find((key) => !allowed.has(key));
}

export function parseBootstrapResponseV1(
  json: unknown,
  { strict }: { strict: boolean },
): BootstrapParseResult {
  if (!isRecord(json)) return { ok: false, error: "payload is not an object" };

  if (strict) {
    const extra = unknownField(json, STRICT_RESPONSE_FIELDS);
    if (extra !== undefined) return { ok: false, error: `unexpected field: ${extra}` };
    if (json.version !== BOOTSTRAP_CONTRACT_VERSION) {
      return { ok: false, error: "version must be 1" };
    }
  } else if (
    json.version !== undefined &&
    json.version !== null &&
    json.version !== BOOTSTRAP_CONTRACT_VERSION
  ) {
    return { ok: false, error: "unsupported version" };
  }

  if (!isNonEmptyString(json.tenantId)) return { ok: false, error: "tenantId is required" };

  const tenantSlug = strict
    ? json.tenantSlug
    : json.tenantSlug !== undefined && json.tenantSlug !== null
      ? json.tenantSlug
      : json.slug;
  if (!isNonEmptyString(tenantSlug)) return { ok: false, error: "tenantSlug is required" };

  const mcVersion = optionalString(json.mcVersion, strict);
  if (mcVersion.error) return { ok: false, error: "mcVersion must be a string" };

  if (!Array.isArray(json.apiKeys)) return { ok: false, error: "apiKeys must be an array" };
  const apiKeys: BootstrapApiKeyV1[] = [];
  for (const [index, raw] of json.apiKeys.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `apiKeys[${index}] is not an object` };
    if (strict) {
      const extra = unknownField(raw, KEY_FIELDS);
      if (extra !== undefined) {
        return { ok: false, error: `apiKeys[${index}] unexpected field: ${extra}` };
      }
    }
    if (!isNonEmptyString(raw.keyHash)) {
      return { ok: false, error: `apiKeys[${index}].keyHash is required` };
    }
    if (!isNonEmptyString(raw.keyVersion)) {
      return { ok: false, error: `apiKeys[${index}].keyVersion is required` };
    }
    if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) {
      return { ok: false, error: `apiKeys[${index}].createdAt must be a number` };
    }
    const label = optionalString(raw.label, strict);
    if (label.error) return { ok: false, error: `apiKeys[${index}].label must be a string` };
    apiKeys.push({
      keyHash: raw.keyHash,
      keyVersion: raw.keyVersion,
      ...(label.value !== undefined ? { label: label.value } : {}),
      createdAt: raw.createdAt,
    });
  }

  return {
    ok: true,
    bundle: {
      version: BOOTSTRAP_CONTRACT_VERSION,
      tenantId: json.tenantId,
      tenantSlug,
      ...(mcVersion.value !== undefined ? { mcVersion: mcVersion.value } : {}),
      apiKeys,
    },
  };
}
