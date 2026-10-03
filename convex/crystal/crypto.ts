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

function redactWindow(text: string, labels: Map<string, string>): string {
  let safe = text;
  for (const [identifier, label] of labels) safe = safe.split(identifier).join(label);
  return safe.replace(EMAIL_PATTERN, "[email]");
}

// Logs keep LOG_TEXT_LIMIT characters. Redact a prefix instead of the whole string to bound
// the work, growing it until its redacted form reaches far enough past the cut. A value split
// at the prefix's end is shorter than the longest value, and redaction lengthens text at most
// LABEL_MAX_LENGTH times (a one-character identifier becomes a label), so once the redacted
// prefix reaches LABEL_MAX_LENGTH * longest past the cut, the split value lies beyond it.
function redactText(value: string, labels: Map<string, string>): string {
  let longest = EMAIL_MAX_LENGTH;
  for (const identifier of labels.keys()) longest = Math.max(longest, identifier.length);
  const reach = LOG_TEXT_LIMIT + LABEL_MAX_LENGTH * longest;
  for (let end = reach; ; end *= 2) {
    const safe = redactWindow(value.slice(0, end), labels);
    if (end >= value.length || safe.length >= reach) return safe.slice(0, LOG_TEXT_LIMIT);
  }
}

function currentUserFromData(value: unknown, seen = new Set<object>()): string | undefined {
  if (typeof value === "string") {
    try { return currentUserFromData(JSON.parse(value), seen); } catch { return undefined; }
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

function identifiersFromData(value: unknown, parentKey?: string, seen = new Set<object>()): string[] {
  if (typeof value === "string") {
    try { return identifiersFromData(JSON.parse(value), parentKey, seen); } catch { return []; }
  }
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const identifiers: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if ((IDENTIFIER_FIELDS.has(key) || (key === "key" && parentKey === "window"))
      && typeof item === "string" && item) identifiers.push(item);
    else identifiers.push(...identifiersFromData(item, key, seen));
  }
  return identifiers;
}

async function redactData(value: unknown, labels: Map<string, string>,
  key?: string, parentKey?: string, seen = new Set<object>()): Promise<unknown> {
  if ((IDENTIFIER_FIELDS.has(key ?? "") || (key === "key" && parentKey === "window"))
    && typeof value === "string") return labels.get(value) ?? logLabel(value);
  if (typeof value === "string") {
    if (key === "data") {
      try { return redactData(JSON.parse(value), labels, undefined, undefined, seen); } catch {}
    }
    return redactText(value, labels);
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const safe: unknown[] = [];
    for (const item of value) safe.push(await redactData(item, labels, undefined, key, seen));
    seen.delete(value);
    return safe;
  }
  const safe: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    safe[field] = await redactData(item, labels, field, key, seen);
  }
  seen.delete(value);
  return safe;
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
