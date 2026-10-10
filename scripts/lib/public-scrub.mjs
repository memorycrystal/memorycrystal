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
  return applySubstitutionsCounted(content, substitutions).text;
}

function identifierForm(to, matched) {
  const words = to.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());
  if (!words.length) return matched;
  const cap = (word) => word[0].toUpperCase() + word.slice(1);
  if (matched.length > 1 && matched === matched.toUpperCase()) return words.map((word) => word.toUpperCase()).join("_");
  if (/^[A-Z]/.test(matched)) return words.map(cap).join("");
  return words[0] + words.slice(1).map(cap).join("");
}

/**
 * Split one alphanumeric run at camelCase humps and at letter-digit transitions
 * in both directions. A digit is its own segment, so a term glued to a digit is
 * still a whole segment. Substitution sources do not use this: humps are
 * case-dependent, and a source key must not depend on case.
 */
export function splitCamelHumps(token) {
  return String(token).split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/).filter(Boolean);
}

/**
 * Identifier segments: non-alphanumerics, camelCase humps, and letter-digit
 * transitions in both directions. The returned text keeps each segment's case.
 */
export function segmentToken(text) {
  const segments = [];
  const re = /[^A-Za-z0-9]+|[A-Za-z0-9]+/g;
  let match;
  while ((match = re.exec(String(text)))) {
    if (/[^A-Za-z0-9]/.test(match[0][0])) continue;
    segments.push(...splitCamelHumps(match[0]));
  }
  return segments;
}

/**
 * Segments of one identifier. `_` is a boundary, not a segment. CamelCase humps
 * and letter-digit transitions are boundaries too. Matching stays on whole segments.
 */
export function identifierSegments(ident) {
  return segmentToken(ident);
}

/**
 * Pieces of a substitution source at case-independent boundaries only:
 * non-alphanumerics, and letter-digit transitions in both directions.
 * Internal capitals stay inside a piece, so `ZorbLax` is one piece.
 */
export function substitutionSourceWords(from) {
  return String(from).match(/[A-Za-z]+|[0-9]+/g)?.map((word) => word.toLowerCase()) ?? [];
}

/** Lowercase concatenation of a source's case-independent pieces. `Web3 Vexa` → `web3vexa`. */
export function substitutionSourceKey(from) {
  return substitutionSourceWords(from).join("");
}

function orderedSourceKeys(substitutions) {
  return [...substitutions]
    .map(([from, to]) => ({ from, to, key: substitutionSourceKey(from) }))
    .filter((entry) => entry.key)
    .sort((a, b) => b.key.length - a.key.length || b.from.length - a.from.length);
}

function identifierPieces(ident) {
  const pieces = [];
  const re = /_+|[A-Za-z0-9]+/g;
  let match;
  while ((match = re.exec(ident))) {
    if (match[0].startsWith("_")) pieces.push({ kind: "sep", text: match[0] });
    else for (const segment of splitCamelHumps(match[0])) pieces.push({ kind: "seg", text: segment });
  }
  return pieces;
}

/** Inclusive end index in `segments`, or -1. The key must end on a segment boundary. */
function matchKeyEnd(segments, start, key) {
  let acc = "";
  for (let end = start; end < segments.length; end += 1) {
    acc += segments[end].toLowerCase();
    if (acc.length > key.length) return -1;
    if (acc === key) return end;
    if (!key.startsWith(acc)) return -1;
  }
  return -1;
}

/**
 * Spans the segment rewrite would replace. One or more consecutive identifier
 * segments whose lowercase concatenation equals a source key, aligned to
 * segment boundaries at both ends. A segment that merely contains the key
 * does not match. Longest key first. Shared by the rewrite and the scan.
 */
function identifierSourceSpans(ident, ordered) {
  const pieces = identifierPieces(ident);
  const segAt = [];
  pieces.forEach((piece, index) => {
    if (piece.kind === "seg") segAt.push(index);
  });
  const segments = segAt.map((index) => pieces[index].text);
  const spans = [];
  const consumed = new Set();
  for (let start = 0; start < segments.length; start += 1) {
    if (consumed.has(start)) continue;
    for (const entry of ordered) {
      const end = matchKeyEnd(segments, start, entry.key);
      if (end < 0) continue;
      const pieceStart = segAt[start];
      const pieceEnd = segAt[end];
      let span = "";
      for (let index = pieceStart; index <= pieceEnd; index += 1) span += pieces[index].text;
      spans.push({ pieceStart, pieceEnd, text: identifierForm(entry.to, span) });
      for (let index = start; index <= end; index += 1) consumed.add(index);
      start = end;
      break;
    }
  }
  return { pieces, spans };
}

/**
 * Replace a source key that occupies one or more consecutive segments of an
 * identifier. The replacement uses the matched span's case: UPPER_SNAKE when
 * every letter of the span is uppercase, PascalCase when the span starts with
 * an uppercase letter, camelCase otherwise. Separators outside the span stay.
 * Longest source first.
 */
function rewriteIdentifierSegments(content, substitutions, counter = null) {
  const ordered = orderedSourceKeys(substitutions);
  if (!ordered.length) return content;
  return content.replace(/[A-Za-z0-9_]+/g, (ident) => {
    const { pieces, spans } = identifierSourceSpans(ident, ordered);
    if (!spans.length) return ident;
    if (counter) counter.n += spans.length;
    const replacements = new Map(spans.map((span) => [span.pieceStart, span]));
    let out = "";
    for (let index = 0; index < pieces.length;) {
      const replacement = replacements.get(index);
      if (replacement) {
        out += replacement.text;
        index = replacement.pieceEnd + 1;
        continue;
      }
      out += pieces[index].text;
      index += 1;
    }
    return out;
  });
}

/**
 * Whole-word, case-insensitive form of the same pairs, then the same pairs
 * across `_`, camelCase, and letter-digit segment boundaries in both directions.
 * Longest source first.
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
function applyCaseFoldedWholeWordsCounted(content, substitutions) {
  const counter = { n: 0 };
  const ordered = [...substitutions].sort((a, b) => b[0].length - a[0].length);
  let out = content;
  for (const [from, to] of ordered) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi"),
      (matched) => {
        counter.n += 1;
        return identifierForm(to, matched);
      },
    );
  }
  return { text: rewriteIdentifierSegments(out, substitutions, counter), count: counter.n };
}

export function applyCaseFoldedWholeWords(content, substitutions) {
  return applyCaseFoldedWholeWordsCounted(content, substitutions).text;
}

/** Exact substitutions plus how many spans they replaced. Same bytes as applySubstitutions. */
export function applySubstitutionsCounted(content, substitutions) {
  let count = 0;
  let out = content;
  for (const [from, to] of substitutions ?? []) {
    const parts = out.split(from);
    count += parts.length - 1;
    out = parts.join(to);
  }
  return { text: out, count };
}

/**
 * True when the segment rewrite would replace any span in this text.
 * The match text is not returned.
 */
export function textHasIdentifierSegmentLeak(text, substitutions) {
  if (!substitutions?.length || !text) return false;
  const ordered = orderedSourceKeys(substitutions);
  if (!ordered.length) return false;
  const re = /[A-Za-z0-9_]+/g;
  let match;
  while ((match = re.exec(text))) {
    if (identifierSourceSpans(match[0], ordered).spans.length) return true;
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
    // Case-insensitive on purpose: a printed path should over-redact.
    // The needle scan stays case-sensitive.
    if (needles.some((needle) => needle && text.toLowerCase().includes(String(needle).toLowerCase()))) return true;
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

/**
 * Mask needle text and stem regex sources in a message. Same rules the archive
 * sanitizer prints with: the needle is replaced as written, then the stem
 * source, then the stem's letters. Does not change scan matching.
 */
export function redactLeakMessage(message, inputs = {}) {
  let out = String(message);
  for (const entry of inputs.needles ?? []) {
    const needle = typeof entry === "string" ? entry : entry?.needle;
    if (needle) out = out.split(needle).join("<redacted>");
  }
  for (const stem of inputs.stems ?? []) {
    if (stem?.source) out = out.split(`/${stem.source}/i`).join("/<stem>/i");
  }
  for (const stem of inputs.stems ?? []) {
    if (stem?.source) out = out.replace(new RegExp(stem.source.replaceAll("\\b", ""), "gi"), "<stem>");
  }
  return out;
}

function archiveFailureKind(failure) {
  if (failure.includes(" references ")) return "needle";
  if (failure.includes("client stem")) return "stem";
  if (failure.includes("identifier segment")) return "segment";
  if (failure.includes("environment file") || failure.includes(" contains a ")) return "secret";
  if (failure.includes("hosted-only") || failure.includes("admin backend")) return "hosted";
  if (failure.includes("platform metadata")) return "metadata";
  return "other";
}

function archiveFailurePath(failure) {
  const line = /^(.*?):\d+ /.exec(failure);
  if (line) return line[1];
  const word = /^(.*?) (?:references|is|path matches|matches|contains) /.exec(failure);
  if (word) return word[1];
  return failure;
}

const REDACTED_PATH_PLACEHOLDER = /^<redacted path \d+>$/;

/**
 * One number per distinct file, including paths an earlier pass already
 * replaced with `<redacted path N>`. Numbering is a single sort of those
 * identities, so a later redaction cannot reuse a number.
 */
function numberedFailurePaths(paths, inputs = {}) {
  const needles = (inputs.needles ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.needle))
    .filter((needle) => typeof needle === "string" && needle);
  const mapped = redactPrintedPaths(paths, {
    needles,
    substitutions: inputs.substitutions ?? [],
    stems: inputs.stems ?? [],
  });
  const unsafe = [];
  const seen = new Set();
  for (const path of paths) {
    const shown = mapped.get(path) ?? path;
    const needs = shown !== path || REDACTED_PATH_PLACEHOLDER.test(path) || REDACTED_PATH_PLACEHOLDER.test(shown);
    if (!needs || seen.has(path)) continue;
    seen.add(path);
    unsafe.push(path);
  }
  unsafe.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const numbers = new Map(unsafe.map((path, index) => [path, `<redacted path ${index + 1}>`]));
  const display = new Map();
  for (const path of paths) display.set(path, numbers.get(path) ?? mapped.get(path) ?? path);
  return display;
}

/**
 * Printable gate failures: kind, redacted path, and count. Placeholders are
 * numbered once across every failure, so two files never share a number.
 * The line then passes through redactLeakMessage so a needle or a stem source
 * left in an unparsed failure cannot be printed.
 */
export function formatRedactedGateFailures(failures, inputs = {}) {
  const parsed = failures.map((failure) => ({
    kind: archiveFailureKind(failure),
    path: archiveFailurePath(failure),
  }));
  const display = numberedFailurePaths(parsed.map((item) => item.path), inputs);
  const counts = new Map();
  for (const item of parsed) {
    const path = display.get(item.path) ?? item.path;
    const key = `${item.kind} ${path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, count]) => redactLeakMessage(`${key} ${count}`, inputs));
}

// ── Scans over an output tree ─────────────────────────────────────────────────

export function isProbablyText(buffer) {
  const head = buffer.subarray(0, 8000);
  return !head.includes(0);
}

/** npm lockfiles whose `"integrity"` values are public registry hashes. */
export function isNpmLockfileName(filePath) {
  const base = String(filePath).replaceAll("\\", "/").split("/").pop();
  return base === "package-lock.json" || base === "npm-shrinkwrap.json";
}

const INTEGRITY_PAIR = /("integrity"\s*:\s*")([^"]*)(")/g;
const SRI_INTEGRITY_VALUE = /^(?:(?:sha1|sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2})(?: (?:sha1|sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2})*$/;

/** True when the whole value is one or more space-separated SRI tokens and nothing else. */
export function isSriIntegrityValue(value) {
  return SRI_INTEGRITY_VALUE.test(String(value));
}

/**
 * Mask lockfile `"integrity"` values that match the SRI grammar before the
 * scrub passes, and skip those same values in the scans. Any other value
 * under an `integrity` key, including a dependency spec, is left in place.
 * Returns the masked text and the original SRI values, in order.
 */
export function maskIntegrityValues(text) {
  const values = [];
  const masked = String(text).replace(INTEGRITY_PAIR, (full, open, value, close) => {
    if (!isSriIntegrityValue(value)) return full;
    values.push(value);
    return `${open}\u0000integrity${values.length}\u0000${close}`;
  });
  return { masked, values };
}

export function restoreIntegrityValues(text, values) {
  return String(text).replace(/\u0000integrity(\d+)\u0000/g, (_match, index) => values[Number(index) - 1] ?? "");
}

/** Text with lockfile SRI integrity values removed, for the segment and stem scans. */
export function textWithoutIntegrityValues(text, filePath) {
  if (!isNpmLockfileName(filePath)) return text;
  return String(text).replace(INTEGRITY_PAIR, (full, open, value, close) => (
    isSriIntegrityValue(value) ? `${open}${close}` : full
  ));
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

function sortScrubFiles(files) {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Apply substitutions to every probably-text file under root. Writes only when
 * the bytes change, and restores the file mode afterwards so an executable
 * stays executable.
 *
 * Returns `{ fileCount, files }`. `fileCount` is how many files changed.
 * `files` is the changed paths relative to root, each with the number of
 * replacements across the case-folded pass and the exact pass.
 */
export function sanitizeTextTree(root, substitutions) {
  const files = [];
  if (!substitutions?.length || !existsSync(root)) return { fileCount: 0, files };
  for (const file of walkFiles(root)) {
    const buffer = readFileSync(file);
    if (!isProbablyText(buffer)) continue;
    const before = buffer.toString("utf8");
    // Lockfile SRI integrity values are public registry hashes. Mask only those
    // before both passes and restore them unchanged afterwards.
    const lockfile = isNpmLockfileName(file);
    const { masked, values } = lockfile ? maskIntegrityValues(before) : { masked: before, values: null };
    // The case-folded pass runs first so a match inside an identifier takes the
    // identifier form. The exact pass then covers a source that is not a whole
    // word, which the case-folded pass leaves alone.
    const folded = applyCaseFoldedWholeWordsCounted(masked, substitutions);
    const exact = applySubstitutionsCounted(folded.text, substitutions);
    const after = lockfile ? restoreIntegrityValues(exact.text, values) : exact.text;
    if (after === before) continue;
    const mode = statSync(file).mode;
    writeFileSync(file, after);
    chmodSync(file, mode);
    files.push({
      path: relative(root, file).replaceAll("\\", "/"),
      count: folded.count + exact.count,
    });
  }
  const sorted = sortScrubFiles(files);
  return { fileCount: sorted.length, files: sorted };
}

export const PUBLIC_SCRUB_EXPECTATION_REL = "scripts/public-scrub-expected.private.json";
export const PUBLIC_SCRUB_EXPECTATIONS_MISSING = "public scrub expectations missing";
export const PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE = "public scrub expectations unreadable";
export const PUBLIC_SCRUB_EXPECTATIONS_OVERRIDE_REFUSED = "public scrub expectations override refused";
export const PUBLIC_SCRUB_REWRITE_SET_MISMATCH = "public scrub rewrite set mismatch";
const EXPECTATION_TOP_KEYS = new Set(["_comment", "publicTree", "localBackendArchive"]);
const EXPECTATION_ENTRY_KEYS = new Set(["path", "count"]);

function scrubFailure(message, lines = [message]) {
  const error = new Error(message);
  error.lines = lines;
  return error;
}

function parseScrubExpectationSet(value) {
  if (!Array.isArray(value)) throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
  const files = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
    }
    if (Object.keys(entry).some((key) => !EXPECTATION_ENTRY_KEYS.has(key))) {
      throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
    }
    const path = entry.path;
    const count = entry.count;
    const parts = typeof path === "string" ? path.split("/") : [];
    if (
      typeof path !== "string"
      || path.length === 0
      || path.startsWith("/")
      || path.includes("\\")
      || parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
    }
    if (!Number.isInteger(count) || count < 1) throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
    if (seen.has(path)) throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
    seen.add(path);
    files.push({ path, count });
  }
  return files;
}

/**
 * The Node test runner sets NODE_TEST_CONTEXT in the test process. Callers
 * that pass a partial env still count when this process is that test.
 * Outside a test, a set override fails closed instead of selecting a file.
 */
function scrubExpectationOverrideAllowed(env = process.env) {
  return Boolean(env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT);
}

export function expectationFilePath(repoRoot, env = process.env) {
  if (env.CRYSTAL_PUBLIC_SCRUB_EXPECTED_FILE) {
    if (!scrubExpectationOverrideAllowed(env)) {
      throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_OVERRIDE_REFUSED);
    }
    return env.CRYSTAL_PUBLIC_SCRUB_EXPECTED_FILE;
  }
  return join(repoRoot, PUBLIC_SCRUB_EXPECTATION_REL);
}

/**
 * Load the rewrite-set expectation for a private checkout (one that has
 * scripts/sync-public.mjs). A public checkout returns null and the caller
 * skips the guard. A missing or malformed file throws a fixed message; the
 * parser error is not forwarded, because it can echo file text.
 */
export function loadCheckoutScrubExpectations(repoRoot, env = process.env) {
  if (!existsSync(join(repoRoot, "scripts/sync-public.mjs"))) return null;
  const filePath = expectationFilePath(repoRoot, env);
  if (!existsSync(filePath)) throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_MISSING);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
  }
  if (Object.keys(parsed).some((key) => !EXPECTATION_TOP_KEYS.has(key))) {
    throw scrubFailure(PUBLIC_SCRUB_EXPECTATIONS_UNREADABLE);
  }
  return {
    publicTree: parseScrubExpectationSet(parsed.publicTree),
    localBackendArchive: parseScrubExpectationSet(parsed.localBackendArchive),
  };
}

/** unexpected, missing, or count. expected and actual are replacement counts. */
export function diffScrubRewriteSet(expectedFiles, actualFiles) {
  const expected = new Map((expectedFiles ?? []).map((file) => [file.path, file.count]));
  const actual = new Map((actualFiles ?? []).map((file) => [file.path, file.count]));
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const differences = [];
  for (const path of paths) {
    const hasExpected = expected.has(path);
    const hasActual = actual.has(path);
    if (!hasExpected && hasActual) {
      differences.push({ kind: "unexpected", path, expected: 0, actual: actual.get(path) });
    } else if (hasExpected && !hasActual) {
      differences.push({ kind: "missing", path, expected: expected.get(path), actual: 0 });
    } else if (expected.get(path) !== actual.get(path)) {
      differences.push({ kind: "count", path, expected: expected.get(path), actual: actual.get(path) });
    }
  }
  return differences;
}

export function formatScrubRewriteMismatch(differences, inputs = {}) {
  const display = numberedFailurePaths(differences.map((item) => item.path), inputs);
  return differences.map((item) => redactLeakMessage(
    `${item.kind} ${display.get(item.path) ?? item.path} expected ${item.expected} actual ${item.actual}`,
    inputs,
  ));
}

export function assertScrubRewriteSet(actualFiles, expectedFiles, inputs = {}) {
  const differences = diffScrubRewriteSet(expectedFiles, actualFiles);
  if (differences.length === 0) return;
  throw scrubFailure(PUBLIC_SCRUB_REWRITE_SET_MISMATCH, formatScrubRewriteMismatch(differences, inputs));
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
      const lines = textWithoutIntegrityValues(text, file).split("\n");
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
    const lines = textWithoutIntegrityValues(buffer.toString("utf8"), file).split("\n");
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
export async function loadPublicLeakNeedles(repoRoot) {
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
 * are not rewritten. A version without two leading numeric components is not
 * legacy.
 */
export function legacyIdentifierSegmentArchive(version) {
  const match = /^(\d+)\.(\d+)\./.exec(String(version));
  if (!match) return false;
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
    const needles = await loadPublicLeakNeedles(repoRoot);
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
