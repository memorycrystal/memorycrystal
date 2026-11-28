const SECRET_KEY_NAME = String.raw`(?!(?:[A-Za-z0-9_-]{0,64}token[A-Za-z0-9_-]{0,64}count[A-Za-z0-9_-]{0,64})\b)(?:[A-Za-z0-9_-]{0,64}(?:api[_-]?key|apiKey|token|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|idToken|auth[_-]?token|authToken|secret|client[_-]?secret|clientSecret|password|passwd|private[_-]?key|privateKey)[A-Za-z0-9_-]{0,64})`;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9+/_=.-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{10,}\b/g, "sk-[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, "ghp_[REDACTED]"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [new RegExp(`([?&]${SECRET_KEY_NAME}=)[^&\\s]+`, "gi"), "$1[REDACTED]"],
  [new RegExp(`(\\b["']?${SECRET_KEY_NAME}["']?\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^"',\\s}\\n]+)`, "gi"), "$1[REDACTED]"],
  [new RegExp(`(\\b["']?${SECRET_KEY_NAME}["']?\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^,}\\n]+)`, "gi"), "$1[REDACTED]"],
];

export function redactSecrets(text: string): string {
  const normalizedText = typeof text === "string" ? text : "";
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), normalizedText);
}

// The literal text each rule writes in place of a secret, with capture-group
// references ($1) dropped: "Bearer [REDACTED]", "sk-[REDACTED]", "[REDACTED]", ...
const REDACTION_PLACEHOLDERS = Array.from(
  new Set(SECRET_PATTERNS.map(([, replacement]) => replacement.replace(/\$\d+/g, ""))),
);

// The value the key-name rules (`password=...`, `"apiKey": ...`) leave behind.
export const REDACTED_VALUE = "[REDACTED]";

/**
 * True when `text` contains a placeholder that redactSecrets writes. Agent
 * reads return redacted text, so a write carrying one is most likely a
 * read-modify-write that would overwrite the stored secret (ILL-328).
 */
export function containsRedactionPlaceholder(text: unknown): boolean {
  return typeof text === "string" && REDACTION_PLACEHOLDERS.some((placeholder) => text.includes(placeholder));
}

const SECRET_KEY_NAME_ONLY = new RegExp(String.raw`\b${SECRET_KEY_NAME}$`, "i");

/**
 * True when a structured key (a JSON object key) is one whose value the
 * key-name rules above redact in flat text, e.g. `password` or `apiKey`, but
 * not `tokenCount`.
 */
export function isSecretKeyName(name: string): boolean {
  return SECRET_KEY_NAME_ONLY.test(name);
}
