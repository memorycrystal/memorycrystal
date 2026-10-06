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
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function identifierForm(to, matched) {
  const words = to.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());
  if (!words.length) return matched;
  const cap = (word) => word[0].toUpperCase() + word.slice(1);
  if (matched.length > 1 && matched === matched.toUpperCase()) return words.map((word) => word.toUpperCase()).join("_");
  if (/^[A-Z]/.test(matched)) return words.map(cap).join("");
  return words[0] + words.slice(1).map(cap).join("");
}

/** Words of a substitution source, in order, for identifier-segment matching. */
export function substitutionSourceWords(from) {
  return String(from).split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());
}

/** Split one alphanumeric run at camelCase humps. Digits stay with the run they follow. */
export function splitCamelHumps(token) {
  return String(token).split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);
}

/**
 * Segments of one identifier. `_` is a boundary, not a segment. CamelCase humps
 * are boundaries too. The returned text keeps each segment's original case.
 */
export function identifierSegments(ident) {
  const segments = [];
  const re = /_+|[A-Za-z0-9]+/g;
  let match;
  while ((match = re.exec(ident))) {
    if (match[0].startsWith("_")) continue;
    segments.push(...splitCamelHumps(match[0]));
  }
  return segments;
}

function identifierFormForSegments(to, segments) {
  const allCaps = segments.length > 0 && segments.every((segment) => segment.length > 1 && segment === segment.toUpperCase() && /[A-Za-z]/.test(segment));
  if (allCaps) return identifierForm(to, segments.join("_"));
  return identifierForm(to, segments[0]);
}

/**
 * Replace a substitution source that occupies one or more consecutive segments
 * of an identifier. The replacement uses that segment's case: UPPER_SNAKE when
 * every matched segment is all-caps, PascalCase when the first is capitalised,
 * camelCase otherwise. Separators outside the match stay, so the surrounding
 * identifier remains valid. Longest source first.
 */
function rewriteIdentifierSegments(content, substitutions) {
  const ordered = [...substitutions].sort((a, b) => substitutionSourceWords(b[0]).length - substitutionSourceWords(a[0]).length || b[0].length - a[0].length);
  return content.replace(/[A-Za-z0-9_]+/g, (ident) => {
    const pieces = [];
    const re = /_+|[A-Za-z0-9]+/g;
    let match;
    while ((match = re.exec(ident))) {
      if (match[0].startsWith("_")) pieces.push({ kind: "sep", text: match[0] });
      else for (const segment of splitCamelHumps(match[0])) pieces.push({ kind: "seg", text: segment });
    }
    const segAt = [];
    pieces.forEach((piece, index) => {
      if (piece.kind === "seg") segAt.push(index);
    });
    const consumed = new Set();
    const replacements = new Map();
    for (let start = 0; start < segAt.length; start += 1) {
      if (consumed.has(start)) continue;
      for (const [from, to] of ordered) {
        const words = substitutionSourceWords(from);
        if (!words.length || start + words.length > segAt.length) continue;
        let matches = true;
        for (let index = 0; index < words.length; index += 1) {
          if (pieces[segAt[start + index]].text.toLowerCase() !== words[index]) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
        const matched = words.map((_, index) => pieces[segAt[start + index]].text);
        replacements.set(segAt[start], { end: segAt[start + words.length - 1], text: identifierFormForSegments(to, matched) });
        for (let index = 0; index < words.length; index += 1) consumed.add(start + index);
        start += words.length - 1;
        break;
      }
    }
    let out = "";
    for (let index = 0; index < pieces.length;) {
      const replacement = replacements.get(index);
      if (replacement) {
        out += replacement.text;
        index = replacement.end + 1;
        continue;
      }
      let covered = false;
      for (const [start, replacement] of replacements) {
        if (index > start && index <= replacement.end) covered = true;
      }
      if (!covered) out += pieces[index].text;
      index += 1;
    }
    return out;
  });
}

/**
 * Whole-word, case-insensitive form of the same pairs, then the same pairs
 * across `_` and camelCase segment boundaries. Longest source first.
 * Every match takes the identifier form of its replacement, so a hyphenated
 * phrase cannot land in a property name and a string compared with that
 * property stays equal to it. The exact pass then covers a source that is
 * not a whole word and not an identifier-segment sequence.
 *
 * This pass also rewrites matches inside string and regex literals. The
 * identifier form can make a regex alternative unreachable. The public
 * mirror can therefore differ from the local-backend archive, which applies
 * the exact substitution pass only. Those differences are anonymized
 * placeholders and are accepted.
 */
export function applyCaseFoldedWholeWords(content, substitutions) {
  const ordered = [...substitutions].sort((a, b) => b[0].length - a[0].length);
  let out = content;
  for (const [from, to] of ordered) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi"),
      (matched) => identifierForm(to, matched),
    );
  }
  return rewriteIdentifierSegments(out, substitutions);
}

/**
 * True when any consecutive identifier-segment sequence equals a substitution
 * source's words, case-insensitively. The match text is not returned.
 */
export function textHasIdentifierSegmentLeak(text, substitutions) {
  if (!substitutions?.length || !text) return false;
  const ordered = [...substitutions].sort((a, b) => substitutionSourceWords(b[0]).length - substitutionSourceWords(a[0]).length || b[0].length - a[0].length);
  const re = /[A-Za-z0-9_]+/g;
  let match;
  while ((match = re.exec(text))) {
    const segments = identifierSegments(match[0]);
    for (let start = 0; start < segments.length; start += 1) {
      for (const [from] of ordered) {
        const words = substitutionSourceWords(from);
        if (!words.length || start + words.length > segments.length) continue;
        if (words.every((word, index) => segments[start + index].toLowerCase() === word)) return true;
      }
    }
  }
  return false;
}

/**
 * Replace a printed path with a stable placeholder when it carries a leak
 * needle, a substitution source (as a substring or as identifier segments),
 * or a client stem. Numbering follows the sorted unsafe paths in this call.
 */
export function redactPrintedPaths(paths, { needles = [], substitutions = [], stems = [] } = {}) {
  const sources = substitutions.map(([from]) => from).filter((source) => typeof source === "string" && source);
  const unsafe = (value) => {
    const text = String(value);
    if (needles.some((needle) => needle && text.includes(needle))) return true;
    if (sources.some((source) => text.toLowerCase().includes(source.toLowerCase()))) return true;
    if (stems.some((stem) => stem.test(text))) return true;
    return textHasIdentifierSegmentLeak(text, substitutions);
  };
  const flagged = [...new Set(paths.filter((path) => path && unsafe(path)))].sort();
  const placeholders = new Map(flagged.map((path, index) => [path, `<redacted path ${index + 1}>`]));
  const mapped = new Map();
  for (const path of paths) mapped.set(path, placeholders.get(path) ?? path);
  return mapped;
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
 * Apply substitutions to every probably-text file under root. Writes only when
 * the bytes change, and restores the file mode afterwards so an executable
 * stays executable. Returns how many files changed.
 */
export function sanitizeTextTree(root, substitutions) {
  let changed = 0;
  if (!substitutions?.length || !existsSync(root)) return changed;
  for (const file of walkFiles(root)) {
    const buffer = readFileSync(file);
    if (!isProbablyText(buffer)) continue;
    const before = buffer.toString("utf8");
    // The case-folded pass runs first so a match inside an identifier takes the
    // identifier form. The exact pass then covers a source that is not a whole
    // word, which the case-folded pass leaves alone.
    const after = applySubstitutions(applyCaseFoldedWholeWords(before, substitutions), substitutions);
    if (after === before) continue;
    const mode = statSync(file).mode;
    writeFileSync(file, after);
    chmodSync(file, mode);
    changed += 1;
  }
  return changed;
}

/**
 * Load the private scrub terms and fail closed on a private checkout (one that
 * has scripts/sync-public.mjs). A public checkout has neither file and returns
 * null: the mirrored source is already sanitized.
 *
 * Resolution matches the local-backend packager: CRYSTAL_CLIENT_TERMS_FILE, or
 * scripts/client-terms.private.json under repoRoot.
 */
export function loadPrivateScrubTermsForCheckout(repoRoot, env = process.env) {
  const termsFile = env.CRYSTAL_CLIENT_TERMS_FILE || join(repoRoot, "scripts/client-terms.private.json");
  const terms = loadPrivateScrubTerms(termsFile);
  const privateCheckout = existsSync(join(repoRoot, "scripts/sync-public.mjs"));
  if (!privateCheckout) return terms;
  if (!terms) {
    throw new Error("private checkout without a client terms file");
  }
  if (terms.substitutions.length === 0) {
    throw new Error("private checkout with no client substitutions");
  }
  if (terms.stems.length === 0) {
    throw new Error("private checkout with no client stems");
  }
  return terms;
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

/**
 * Identifier-segment hits for substitution sources. Text files and relative
 * paths only: decoded binary payloads are not scanned. Each hit is a path and
 * a line number (0 when the path itself matches). The matched text is omitted.
 */
export function findIdentifierSegmentLeaks(root, terms) {
  const substitutions = terms?.substitutions ?? [];
  const hits = [];
  if (!substitutions.length || !existsSync(root)) return hits;
  const seen = new Set();
  const add = (path, line) => {
    const key = `${path}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ path, line });
  };
  for (const file of walkFiles(root)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (textHasIdentifierSegmentLeak(rel, substitutions)) add(rel, 0);
    const buffer = readFileSync(file);
    if (!isProbablyText(buffer)) continue;
    const lines = buffer.toString("utf8").split("\n");
    lines.forEach((line, index) => {
      if (textHasIdentifierSegmentLeak(line, substitutions)) add(rel, index + 1);
    });
  }
  return hits;
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
async function publicLeakNeedles(repoRoot) {
  if (!repoRoot) return [];
  const syncPublic = join(repoRoot, "scripts/sync-public.mjs");
  if (!existsSync(syncPublic)) return [];
  const mod = await import(pathToFileURL(syncPublic).href);
  if (!Array.isArray(mod.PUBLIC_LEAK_CHECKS)) return [];
  return mod.PUBLIC_LEAK_CHECKS.map((check) => check.needle).filter((needle) => typeof needle === "string");
}

/**
 * Versions already published before the identifier-segment gate. Hits there are
 * warnings, the same way platform metadata is grandfathered, and the archives
 * are not rewritten.
 */
export function legacyIdentifierSegmentArchive(version) {
  const match = /^(\d+)\.(\d+)\./.exec(String(version));
  if (!match) return true;
  return Number(match[1]) === 0 && Number(match[2]) < 10;
}

export async function findPublicArchiveLeaks(root, { repoRoot, termsFile, allowlist, legacyMetadata = false, legacyIdentifierSegments = false } = {}) {
  const failures = [];
  const findPublicMirrorLeaks = repoRoot ? await loadPublicMirrorLeakFinder(repoRoot) : null;
  if (findPublicMirrorLeaks) failures.push(...findPublicMirrorLeaks(root, { decodeBinary: true }));
  const terms = termsFile ? loadPrivateScrubTerms(termsFile) : null;
  if (terms) failures.push(...findCaseInsensitiveStemLeaks(root, terms.stems));
  const segmentHits = terms ? findIdentifierSegmentLeaks(root, terms) : [];
  const warnings = [];
  if (segmentHits.length && legacyIdentifierSegments) {
    const files = new Set(segmentHits.map((hit) => hit.path)).size;
    warnings.push(`identifier segment hits ${segmentHits.length} in ${files} files`);
  } else if (segmentHits.length) {
    const needles = await publicLeakNeedles(repoRoot);
    const mapped = redactPrintedPaths(segmentHits.map((hit) => hit.path), {
      needles,
      substitutions: terms.substitutions,
      stems: terms.stems,
    });
    for (const hit of segmentHits) {
      const path = mapped.get(hit.path) ?? hit.path;
      failures.push(hit.line ? `${path}:${hit.line} matches an identifier segment` : `${path} matches an identifier segment`);
    }
  }
  failures.push(...findSecretLikeLeaks(root));
  failures.push(...findHostedOnlyPaths(root, allowlist ? { allowlist } : {}));
  const metadata = findMetadataJunk(root);
  if (!legacyMetadata) failures.push(...metadata);
  if (legacyMetadata) warnings.push(...metadata);
  return {
    failures,
    warnings,
    coverage: {
      mirrorNeedles: Boolean(findPublicMirrorLeaks),
      clientStems: terms ? terms.stems.length : 0,
      identifierSegments: segmentHits.length,
    },
  };
}
