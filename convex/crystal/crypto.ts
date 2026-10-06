export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9.-]{1,253}/gi;
// The longest text EMAIL_PATTERN can match: 64 + "@" + 253.
const EMAIL_MAX_LENGTH = 318;
// The longest replacement: logLabel's "h:" plus eight hex characters.
const LABEL_MAX_LENGTH = 10;
export const LOG_TEXT_LIMIT = 2_000;
const IDENTIFIER_FIELDS = new Set(["userId", "actorUserId", "stageActorId", "channel", "sessionKey", "windowKey"]);

export async function logLabel(value: string | null | undefined): Promise<string> {
  return value ? `h:${(await sha256Hex(value)).slice(0, 8)}` : "none";
}

function failureTable(pattern: string): Int32Array {
  const table = new Int32Array(pattern.length);
  let prefix = 0;
  for (let index = 1; index < pattern.length; index++) {
    while (prefix > 0 && pattern[index] !== pattern[prefix]) prefix = table[prefix - 1];
    if (pattern[index] === pattern[prefix]) table[index] = ++prefix;
  }
  return table;
}

function recordLongestStarts(text: string, pattern: string, index: number,
  identifiers: string[], starts: Int32Array): void {
  const table = failureTable(pattern);
  let matched = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    while (matched > 0 && text[cursor] !== pattern[matched]) matched = table[matched - 1];
    if (text[cursor] === pattern[matched]) matched++;
    if (matched !== pattern.length) continue;
    const at = cursor - matched + 1;
    const current = starts[at];
    if (current === 0 || pattern.length > identifiers[current - 1].length) starts[at] = index + 1;
    // Resume from the failure link so a later, overlapping occurrence is still recorded.
    matched = table[matched - 1];
  }
}

function applyStarts(text: string, identifiers: string[], replacements: string[], starts: Int32Array): string {
  const parts: string[] = [];
  let raw = 0;
  for (let cursor = 0; cursor < text.length;) {
    const slot = starts[cursor];
    if (slot === 0) {
      cursor++;
      continue;
    }
    if (raw < cursor) parts.push(text.slice(raw, cursor));
    parts.push(replacements[slot - 1]);
    cursor += identifiers[slot - 1].length;
    raw = cursor;
  }
  if (raw < text.length) parts.push(text.slice(raw));
  return parts.join("");
}

function redactWindow(text: string, labels: Map<string, string>): string {
  const identifiers: string[] = [];
  const replacements: string[] = [];
  for (const [identifier, label] of labels) {
    // Defensive: the map already excludes them, and an empty pattern never advances.
    if (!identifier) continue;
    identifiers.push(identifier);
    replacements.push(label);
  }
  if (identifiers.length === 0) return text.replace(EMAIL_PATTERN, "[email]");
  const starts = new Int32Array(text.length);
  for (let index = 0; index < identifiers.length; index++) {
    recordLongestStarts(text, identifiers[index], index, identifiers, starts);
  }
  return applyStarts(text, identifiers, replacements, starts).replace(EMAIL_PATTERN, "[email]");
}

// Logs keep LOG_TEXT_LIMIT characters. Redact a prefix, doubling it until the redacted form
// reaches the margin, so the work stays linear. With L the longest identifier length, a pass
// decision reads at most L characters, so the window's pass and the full text's pass agree up
// to the first walk position past end - L, and the window's remaining pass output is at most
// LABEL_MAX_LENGTH * (L - 1) characters (a one-character identifier becomes a ten-character
// label). An email decision reads at most EMAIL_MAX_LENGTH characters, which leaves a band of
// at most 317 characters where the two email scans can differ. Each match spans at least 3
// characters, so at most 106 matches have their "@" in the band, each lengthening the text by
// at most 4 ("[email]" replaces at least 3 characters). Labels contain no "@", so a match with
// its "@" in the tail uses a raw tail character and stays within the tail's bound of 10 output
// characters per input character. The window's redaction exceeds the part that agrees
// by at most 10L + 731, and once it reaches the margin at least 4,449 characters agree. With
// no identifiers the pass changes nothing, the excess is at most 741, and at least 4,439
// characters agree. A window costs O(window + identifier length) per identifier, and doubling
// keeps the total within twice the last window. Identifiers that only partly overlap are out
// of scope: "ab" and "bcd" in "abcd" give label(ab) + "cd", in the full text as well.
function redactText(value: string, labels: Map<string, string>): string {
  let longest = 0;
  for (const identifier of labels.keys()) longest = Math.max(longest, identifier.length);
  const reach = LOG_TEXT_LIMIT + LABEL_MAX_LENGTH * (longest + EMAIL_MAX_LENGTH);
  for (let end = reach; ; end *= 2) {
    const safe = redactWindow(value.slice(0, end), labels);
    if (end >= value.length || safe.length >= reach) return safe.slice(0, LOG_TEXT_LIMIT);
  }
}

function currentUserFromData(value: unknown, seen = new Set<object>()): string | undefined {
  if (typeof value === "string") {
    // Catch only a bad parse. Walking stays outside so a collection failure reaches logError.
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return undefined;
    }
    return currentUserFromData(parsed, seen);
  }
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (key === "userId" && typeof item === "string" && item) return item;
    const nested = currentUserFromData(item, seen);
    if (nested) return nested;
  }
  return undefined;
}

function identifiersFromData(value: unknown, parentKey?: string,
  seen = new Set<object>(), seenAsWindow = new Set<object>()): string[] {
  if (typeof value === "string") {
    // Catch only a bad parse. Walking stays outside so a collection failure reaches logError.
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return [];
    }
    return identifiersFromData(parsed, parentKey, seen, seenAsWindow);
  }
  if (!value || typeof value !== "object") return [];
  const visited = parentKey === "window" ? seenAsWindow : seen;
  if (visited.has(value)) return [];
  visited.add(value);
  const identifiers: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if ((IDENTIFIER_FIELDS.has(key) || (key === "key" && parentKey === "window"))
      && typeof item === "string" && item) identifiers.push(item);
    else identifiers.push(...identifiersFromData(item, key, seen, seenAsWindow));
  }
  return identifiers;
}

type RedactMemo = { plain: Map<object, unknown>; window: Map<object, unknown> };

type Redacted = { value: unknown; pathIndependent: boolean };

// A shared object is copied once for the context it was reached in (under "window", or not)
// and reused. A copy that met "[circular]" is not stored: that marker depends on the ancestors
// on this path, so a later path walks the object again.
async function redactWalk(value: unknown, labels: Map<string, string>,
  key: string | undefined, parentKey: string | undefined, seen: Set<object>,
  memo: RedactMemo): Promise<Redacted> {
  if ((IDENTIFIER_FIELDS.has(key ?? "") || (key === "key" && parentKey === "window"))
    && typeof value === "string") {
    return { value: labels.get(value) ?? await logLabel(value), pathIndependent: true };
  }
  if (typeof value === "string") {
    if (key === "data") {
      // Not awaited, as before: a failure while walking the parsed data still reaches logError's
      // fixed shape. Collection fails closed first, so the walk runs only after it succeeded.
      try { return redactWalk(JSON.parse(value), labels, undefined, undefined, seen, memo); } catch {}
    }
    return { value: redactText(value, labels), pathIndependent: true };
  }
  if (!value || typeof value !== "object") return { value, pathIndependent: true };
  if (seen.has(value)) return { value: "[circular]", pathIndependent: false };
  const copies = key === "window" ? memo.window : memo.plain;
  const cached = copies.get(value);
  if (cached !== undefined) return { value: cached, pathIndependent: true };
  seen.add(value);
  let pathIndependent = true;
  let redacted: unknown;
  if (Array.isArray(value)) {
    const safe: unknown[] = [];
    for (const item of value) {
      const walked = await redactWalk(item, labels, undefined, key, seen, memo);
      safe.push(walked.value);
      if (!walked.pathIndependent) pathIndependent = false;
    }
    redacted = safe;
  } else {
    const safe: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(value)) {
      const walked = await redactWalk(item, labels, field, key, seen, memo);
      safe[field] = walked.value;
      if (!walked.pathIndependent) pathIndependent = false;
    }
    redacted = safe;
  }
  seen.delete(value);
  if (pathIndependent) copies.set(value, redacted);
  return { value: redacted, pathIndependent };
}

async function redactData(value: unknown, labels: Map<string, string>,
  key?: string, parentKey?: string, seen = new Set<object>(),
  memo: RedactMemo = { plain: new Map(), window: new Map() }): Promise<unknown> {
  return (await redactWalk(value, labels, key, parentKey, seen, memo)).value;
}

// Diagnostics must never turn a handled failure into a new one: an error that cannot be read
// or walked (a throwing getter, data nested past the stack limit) logs a fixed shape instead.
export async function logError(error: unknown, currentUserId?: string,
  sensitiveValues: Array<string | undefined> = []): Promise<Record<string, unknown>> {
  try {
    return await redactError(error, currentUserId, sensitiveValues);
  } catch {
    return { name: "Error", message: "unloggable error" };
  }
}

function hexUnit(code: number, upper: boolean): string {
  const hex = code.toString(16).padStart(4, "0");
  return "\\u" + (upper ? hex.toUpperCase() : hex);
}

function rewriteCodes(text: string, encode: (code: number) => boolean, upper: boolean): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    out += encode(code) ? hexUnit(code, upper) : text[index];
  }
  return out;
}

function addForm(forms: string[], form: string): void {
  if (!forms.includes(form)) forms.push(form);
}

function goRailsCode(code: number): boolean {
  return code === 0x26 || code === 0x3c || code === 0x3e || code === 0x2028 || code === 0x2029;
}

function gsonCode(code: number): boolean {
  return code === 0x26 || code === 0x3c || code === 0x3e || code === 0x3d || code === 0x27;
}

function dotNetCode(code: number): boolean {
  return code >= 0x80 || code === 0x26 || code === 0x27 || code === 0x3c || code === 0x3e
    || code === 0x2b || code === 0x60;
}

// \" in the string-literal body is the quote. .NET spells that quote as uppercase \u0022.
function dotNetForm(body: string): string {
  return rewriteCodes(body.replaceAll("\\\"", "\\u0022"), dotNetCode, true);
}

// Spellings covered, through two nestings: string literals, \u hex for non-ASCII in either
// case, escaped slashes, and the Go/Rails, .NET and Gson defaults. Three nestings, uppercase
// hex of controls or DEL or lone surrogates, and mixed encoders across levels are out of scope.
function escapedForms(identifier: string): string[] {
  const body = JSON.stringify(identifier).slice(1, -1);
  const lower = rewriteCodes(body, (code) => code >= 0x80, false);
  const upper = rewriteCodes(body, (code) => code >= 0x80, true);
  const level1 = [body];
  addForm(level1, lower);
  addForm(level1, upper);
  for (const form of [body, lower, upper]) addForm(level1, form.replaceAll("/", "\\/"));
  addForm(level1, rewriteCodes(body, goRailsCode, false));
  addForm(level1, rewriteCodes(body, gsonCode, false));
  addForm(level1, dotNetForm(body));
  const level2: string[] = [];
  for (const form of level1) {
    const escaped = JSON.stringify(form).slice(1, -1);
    addForm(level2, escaped);
    addForm(level2, escaped.replaceAll("/", "\\/"));
  }
  const forms: string[] = [];
  const seen = new Set<string>();
  for (const form of [...level1, ...level2]) {
    if (form === identifier || seen.has(form)) continue;
    seen.add(form);
    forms.push(form);
    if (forms.length === 64) break;
  }
  return forms;
}

async function redactError(error: unknown, currentUserId: string | undefined,
  sensitiveValues: Array<string | undefined>): Promise<Record<string, unknown>> {
  const value = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; data?: unknown } : {};
  const name = typeof value.name === "string" ? value.name : "Error";
  const message = typeof value.message === "string" ? value.message : String(error);
  const resolvedUserId = currentUserId ?? currentUserFromData(value.data);
  const labels = new Map<string, string>();
  const identifiers = [resolvedUserId, ...sensitiveValues, ...identifiersFromData(value.data)];
  for (const identifier of new Set(identifiers.filter((item): item is string => Boolean(item)))) {
    labels.set(identifier, await logLabel(identifier));
  }
  for (const [identifier, label] of [...labels]) {
    for (const form of escapedForms(identifier)) {
      if (form !== identifier && !labels.has(form)) labels.set(form, label);
    }
  }
  const result: Record<string, unknown> = {
    name: redactText(name, labels),
    message: redactText(message, labels),
  };
  if ("data" in value) {
    result.data = await redactData(value.data, labels, "data");
  }
  return result;
}

export function generateKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
