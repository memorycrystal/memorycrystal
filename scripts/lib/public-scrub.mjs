/**
 * Shared scrub rules for PUBLIC distributions of the Convex source.
 *
 * Two outputs leave this private repository: the git mirror written by
 * scripts/sync-public.mjs and the self-hosted local-backend archive written by
 * scripts/package-local-backend.mjs. Both must apply the same billing,
 * private-token and schema rewrites, so the rules live here once and each
 * producer composes them.
 *
 * This module ships on the public mirror. It therefore carries no client names
 * and no private identifiers:
 *   - the product-ID rewrite is shape-based (any `const *_PRODUCT_ID = "<uuid>"`);
 *   - the mirror leak needles stay in scripts/sync-public.mjs (mirror-excluded)
 *     and are reached through loadPublicMirrorLeakFinder();
 *   - client-term substitutions and case-insensitive stems come from
 *     scripts/client-terms.private.json (mirror-excluded).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

// ── Drift-safe replace ────────────────────────────────────────────────────────

export function replaceRequired(content, pattern, replacement, label, expectedCount) {
  const count = [...content.matchAll(pattern)].length;
  if (count === 0 || (expectedCount !== undefined && count !== expectedCount)) {
    throw new Error(
      `public-mirror rewrite drift: expected ${expectedCount ?? "at least one"} ${label} match, found ${count}`,
    );
  }
  return content.replace(pattern, replacement);
}

// ── convex/schema.ts ──────────────────────────────────────────────────────────

/** Lookup indexes that only the hosted Polar webhook path uses. */
export const POLAR_LOOKUP_INDEX_PATTERNS = [
  /^\s+\.index\("by_polar_subscription"[^\n]+\n/m,
  /^\s+\.index\("by_polar_customer"[^\n]+\n/m,
];

/** Hosted finance tables: rate cards, cost/business ledgers, provider reconciliation. */
export const PRIVATE_FINANCIAL_TABLE_PATTERNS = [
  /\n\s+crystalCostRateCards: defineTable\([\s\S]*?\n\s+\.index\("by_effective_from"[^\n]+\),/m,
  /\n\s+crystalDailyCostLedger: defineTable\([\s\S]*?\n\s+\.index\("by_payer_date"[^\n]+\),/m,
  /\n\s+crystalDailyBusinessLedger: defineTable\([\s\S]*?\n\s+\.index\("by_date"[^\n]+\),/m,
  /\n\s+crystalProviderReconciliation: defineTable\([\s\S]*?\n\s+\.index\("by_period_start"[^\n]+\),/m,
];

/**
 * Remove the Polar lookup indexes from crystalUserProfiles. The last of them
 * carried the table's trailing comma, so whichever `.index(...)` line is now
 * last before the next table gets the comma back (drift-checked).
 */
export function stripPolarLookupIndexes(content) {
  for (const re of POLAR_LOOKUP_INDEX_PATTERNS) content = content.replace(re, "");
  return replaceRequired(
    content,
    /(\n\s+\.index\([^\n]*\))\n(?=\n\s+crystalReflectionRuns: defineTable)/g,
    "$1,\n",
    "public user-profile table delimiter",
    1,
  );
}

/**
 * Unapplied Polar subscription events (ILL-321). Sits next to the finance
 * tables in convex/schema.ts and is drift-checked: exactly one table must match.
 */
export const POLAR_UNMATCHED_EVENTS_TABLE_PATTERN =
  /\n\s+\/\/ Handled Polar subscription events[^\n]*\n(?:\s+\/\/[^\n]*\n)*\s+polarUnmatchedEvents: defineTable\([\s\S]*?\n\s+\.index\("by_received"[^\n]+\),/g;

export function stripPolarUnmatchedEventsTable(content) {
  return replaceRequired(
    content,
    POLAR_UNMATCHED_EVENTS_TABLE_PATTERN,
    "",
    "polarUnmatchedEvents table",
    1,
  );
}

export function stripPrivateFinancialTables(content) {
  for (const re of PRIVATE_FINANCIAL_TABLE_PATTERNS) content = content.replace(re, "");
  return stripPolarUnmatchedEventsTable(content);
}

/** Hosted cloud control-plane tables. Tenant-local self-hosted tables stay. */
export function stripCloudControlPlaneTables(content) {
  return content.replace(
    /\n\s+\/\/ ============ Cloud Control Plane[\s\S]*?\n\s+\/\/ ============ Tenant-Local/,
    "\n\n  // ============ Tenant-Local",
  );
}

/** Admin-only settings/secret staging tables. */
export function stripAdminSettingsTables(content) {
  return content.replace(
    /\n\s+\/\/ Admin-only global ops settings panel[\s\S]*?\n\s+crystalUserProfiles:/,
    "\n\n  crystalUserProfiles:",
  );
}

// ── Hosted billing code in shipped modules ────────────────────────────────────

const PRODUCT_ID_CONSTANT = /^(const (\w*PRODUCT_ID)) = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";$/gm;

/**
 * Replace hosted billing product IDs with deterministic, non-secret placeholders.
 * Shape-based on purpose: this module must not carry the private IDs. The
 * placeholder is derived from the constant name so distinct constants stay
 * distinct and tier comparisons against them can never match a real plan.
 */
export function stripHostedBillingProductIds(content, { expectedCount = 2, label = "hosted billing product ID constant" } = {}) {
  return replaceRequired(
    content,
    PRODUCT_ID_CONSTANT,
    (_match, declaration, name) =>
      `${declaration} = "hosted-billing-product:${name.toLowerCase()}"; // hosted-only Polar product ID, scrubbed from public distributions`,
    label,
    expectedCount,
  );
}

/** userProfiles.ts functions that exist only for the hosted Polar billing flow. */
export const HOSTED_BILLING_FUNCTION_NAMES = [
  "getCurrentUserBillingInfo",
  "getCurrentUserCheckoutContext",
  "getByPolarCustomerInternal",
  "getByPolarSubscriptionInternal",
  "updateSubscriptionInternal",
];

export function stripHostedBillingFunctions(content) {
  for (const name of HOSTED_BILLING_FUNCTION_NAMES) {
    content = replaceRequired(
      content,
      new RegExp(
        String.raw`\n(?:\/\/[^\n]*\n)*export const ${name} = (?:query|internalQuery|internalMutation)\(\{[\s\S]*?\n\}\);\n`,
        "g",
      ),
      "\n",
      `hosted billing function ${name}`,
      1,
    );
  }
  return content;
}

// ── Private client terms (data file, never inline) ────────────────────────────

/**
 * Load the private scrub terms file. Returns null when the file is absent,
 * which is the expected state on a public checkout: the mirrored source is
 * already sanitized, so there is nothing to substitute.
 */
export function loadPrivateScrubTerms(filePath) {
  if (!existsSync(filePath)) return null;
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  const substitutions = Array.isArray(parsed.substitutions) ? parsed.substitutions : [];
  for (const pair of substitutions) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((v) => typeof v !== "string" || !v)) {
      throw new Error(`${filePath}: every substitution must be a [from, to] pair of non-empty strings`);
    }
  }
  const stemSources = Array.isArray(parsed.stems) ? parsed.stems : [];
  const stems = stemSources.map((source) => {
    if (typeof source !== "string" || !source) throw new Error(`${filePath}: stems must be regex sources`);
    return new RegExp(source, "i");
  });
  return { substitutions, stems };
}

export function applySubstitutions(content, substitutions) {
  for (const [from, to] of substitutions) content = content.split(from).join(to);
  return content;
}

// ── Scans over an output tree ─────────────────────────────────────────────────

export function isProbablyText(buffer) {
  const head = buffer.subarray(0, 8000);
  return !head.includes(0);
}

/** Decode every byte of binary files, including both UTF-16 byte orders. */
export function publicScanTexts(buffer) {
  if (!buffer.includes(0)) return [buffer.toString("utf8")];
  const evenBytes = buffer.subarray(0, buffer.length - (buffer.length % 2));
  return [...new Set([
    buffer.toString("latin1"),
    evenBytes.toString("utf16le"),
    Buffer.from(evenBytes).swap16().toString("utf16le"),
  ])];
}

/** Platform metadata is never intentional archive content. */
export function findMetadataJunk(root) {
  return walkFiles(root).flatMap((file) => {
    const rel = relative(root, file).replaceAll("\\", "/");
    const parts = rel.split("/");
    return parts.some((part) => /^(?:\.DS_Store|__MACOSX|\._.*|Thumbs\.db|desktop\.ini)$/i.test(part))
      ? [`${rel} is platform metadata junk`]
      : [];
  });
}

export function walkFiles(root, dir = root, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git" || name === "node_modules") continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walkFiles(root, full, out);
    else if (stat.isFile()) out.push(full);
  }
  return out;
}

/**
 * Case-insensitive stem hits: `rel` for a stem in a file or directory name
 * (the path ships too, binary files included), then `rel:line` for every decoded
 * line that matches (binary content included).
 */
export function findCaseInsensitiveStemLeaks(root, stems) {
  const hits = [];
  if (!stems.length) return hits;
  for (const file of walkFiles(root)) {
    const rel = relative(root, file);
    const pathStem = stems.find((stem) => stem.test(rel));
    if (pathStem) hits.push(`${rel} path matches client stem /${pathStem.source}/i`);
    const buffer = readFileSync(file);
    for (const text of publicScanTexts(buffer)) {
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        for (const stem of stems) {
          if (stem.test(line)) {
            hits.push(`${relative(root, file)}:${index + 1} matches client stem /${stem.source}/i`);
            break;
          }
        }
      });
    }
  }
  return [...new Set(hits)];
}

/** Key-shaped secrets and private key blocks; env files other than templates. */
export const SECRET_LIKE_PATTERNS = [
  { label: "OpenAI/OpenRouter-style key", pattern: /\bsk-(?:[a-z]{1,8}-)?[A-Za-z0-9_-]{20,}/ },
  { label: "PEM private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "PEM block", pattern: /-----BEGIN /, },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

export function findSecretLikeLeaks(root) {
  const hits = [];
  for (const file of walkFiles(root)) {
    const rel = relative(root, file);
    const base = rel.split("/").pop();
    if (/^\.env(?:\..+)?$/.test(base) && !base.endsWith(".template") && !base.endsWith(".example")) {
      hits.push(`${rel} is an environment file`);
    }
    const buffer = readFileSync(file);
    if (!isProbablyText(buffer)) continue;
    const text = buffer.toString("utf8");
    for (const { label, pattern } of SECRET_LIKE_PATTERNS) {
      if (pattern.test(text)) hits.push(`${rel} contains a ${label}`);
    }
  }
  return hits;
}

/**
 * Hosted-only paths that must never ship in the self-hosted archive, plus the
 * admin backend modules. The self-hosted overrides that ship by design are the
 * only allowed `convex/crystal/admin*` entries; each is a copy of the matching
 * file under convex/selfHosted/.
 */
export const SELF_HOSTED_ADMIN_OVERRIDE_ALLOWLIST = [
  "convex/crystal/adminEmails.ts",
  "convex/crystal/adminSupport.ts",
  "convex/crystal/adminSettings/resolvers.ts",
];

export const HOSTED_ONLY_PATH_PREFIXES = ["convex/cloud/", "apps/", "infra/cloudflare/", "docs/"];

export function findHostedOnlyPaths(root, { allowlist = SELF_HOSTED_ADMIN_OVERRIDE_ALLOWLIST } = {}) {
  const hits = [];
  for (const file of walkFiles(root)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (HOSTED_ONLY_PATH_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
      hits.push(`${rel} is a hosted-only path`);
      continue;
    }
    if (/^convex\/crystal\/admin[^/]*(?:\/|\.ts$)/.test(rel) && !allowlist.includes(rel)) {
      hits.push(`${rel} is an admin backend module outside the self-hosted override allowlist`);
    }
  }
  return hits;
}

/** The mirror's own needle-based leak finder, when this checkout has it. */
export async function loadPublicMirrorLeakFinder(repoRoot) {
  const syncPublic = join(repoRoot, "scripts/sync-public.mjs");
  if (!existsSync(syncPublic)) return null;
  const mod = await import(pathToFileURL(syncPublic).href);
  return typeof mod.findPublicMirrorLeaks === "function" ? mod.findPublicMirrorLeaks : null;
}

/**
 * Full privacy gate for an unpacked public archive. Returns a list of failures
 * (empty when clean). Reuses the mirror needles and the private stems when the
 * checkout has them; the structural scans always run.
 */
export async function findPublicArchiveLeaks(root, { repoRoot, termsFile, allowlist, legacyMetadata = false } = {}) {
  const failures = [];
  const findPublicMirrorLeaks = repoRoot ? await loadPublicMirrorLeakFinder(repoRoot) : null;
  if (findPublicMirrorLeaks) failures.push(...findPublicMirrorLeaks(root, { decodeBinary: true }));
  const terms = termsFile ? loadPrivateScrubTerms(termsFile) : null;
  if (terms) failures.push(...findCaseInsensitiveStemLeaks(root, terms.stems));
  failures.push(...findSecretLikeLeaks(root));
  failures.push(...findHostedOnlyPaths(root, allowlist ? { allowlist } : {}));
  const metadata = findMetadataJunk(root);
  if (!legacyMetadata) failures.push(...metadata);
  return {
    failures,
    warnings: legacyMetadata ? metadata : [],
    coverage: {
      mirrorNeedles: Boolean(findPublicMirrorLeaks),
      clientStems: terms ? terms.stems.length : 0,
    },
  };
}
