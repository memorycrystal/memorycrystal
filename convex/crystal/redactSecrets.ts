const SECRET_KEY_NAME = String.raw`(?!(?:[A-Za-z0-9_-]*token[A-Za-z0-9_-]*count[A-Za-z0-9_-]*)\b)(?:[A-Za-z0-9_-]*(?:api[_-]?key|apiKey|token|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|idToken|auth[_-]?token|authToken|secret|client[_-]?secret|clientSecret|password|passwd|private[_-]?key|privateKey)[A-Za-z0-9_-]*)`;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9+/_=.-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{10,}\b/g, "sk-[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, "ghp_[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [new RegExp(`([?&]${SECRET_KEY_NAME}=)[^&\\s]+`, "gi"), "$1[REDACTED]"],
  [new RegExp(`(\\b["']?${SECRET_KEY_NAME}["']?\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^"',\\s}\\n]+)`, "gi"), "$1[REDACTED]"],
  [new RegExp(`(\\b["']?${SECRET_KEY_NAME}["']?\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^,}\\n]+)`, "gi"), "$1[REDACTED]"],
];

export function redactSecrets(text: string): string {
  const normalizedText = typeof text === "string" ? text : "";
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), normalizedText);
}
