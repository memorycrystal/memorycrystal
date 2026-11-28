/**
 * Content scanner for memory write paths.
 * Detects prompt injection, exfiltration attempts, role hijacking,
 * invisible unicode characters, and suspicious encoded payloads.
 */

export type ScanResult =
  | { allowed: true }
  | { allowed: false; reason: string; threatId: string };

interface ThreatPattern {
  id: string;
  reason: string;
  test: (content: string) => boolean;
}

// Case-insensitive regex patterns for prompt injection
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(your\s+)?rules/i,
  /system\s+prompt\s+override/i,
  // 'you are now' only in imperative injection framing (start of content or after 'from now on')
  /(?:^|from\s+now\s+on[,:]?\s+)you\s+are\s+now\s+(?:a|an|in)\b/im,
  /act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i,
];

// Prefixes and suffixes advance independently, so repeated commands never
// rescan a line. A prefix's whitespace may cross lines; its following .* may not.
function commandHasSuffix(content: string, prefix: RegExp, suffix: RegExp): boolean {
  const suffixes = content.matchAll(suffix);
  let nextSuffix = suffixes.next();
  const lineEnds = content.matchAll(/[\r\n\u2028\u2029]/g);
  let nextLineEnd = lineEnds.next();
  for (const command of content.matchAll(prefix)) {
    const start = command.index! + command[0].length;
    while (!nextSuffix.done && nextSuffix.value.index! < start) nextSuffix = suffixes.next();
    if (nextSuffix.done) return false;
    while (!nextLineEnd.done && nextLineEnd.value.index! < start) nextLineEnd = lineEnds.next();
    if (nextLineEnd.done || nextSuffix.value.index! < nextLineEnd.value.index!) return true;
  }
  return false;
}

function hasExfiltrationCommand(content: string): boolean {
  // The former --data variant is a subset of this command/variable pattern.
  // Use the earliest .env in a path: later path segments can contain the suffix.
  return commandHasSuffix(content, /(?:curl|wget)\s+/gi,
    /\$\{?\w*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)\w*\}?/gi)
    || commandHasSuffix(content, /cat\s+(?:\/[\w./]*?)?\.env\b/gi,
      /\|\s*(?:curl|wget|nc|sendmail)/gi)
    || commandHasSuffix(content, /cat\s+(?:\/[\w./]*?)?\.env\b/gi,
      /(?:send|post|upload)\b/gi)
    || /cat\s+(?:\/[\w./]*)?credentials(?:\.json|\.yaml|\.yml|\.toml)?\b/i.test(content);
}

// Role hijacking patterns
const ROLE_HIJACKING_PATTERNS: RegExp[] = [
  // 'do not tell the user' only in direct instruction context (imperative, not reported speech)
  /(?:^|you\s+(?:must|should|will)\s+)do\s+not\s+tell\s+the\s+user/im,
  // 'pretend to be' only with imperative framing
  /(?:i\s+want\s+you\s+to|you\s+(?:must|should|will))\s+pretend\s+to\s+be\b/i,
  /override\s+your\s+personality/i,
];

// Invisible unicode characters
const INVISIBLE_UNICODE_RE =
  /[\u200B\u200C\u200D\u2060\uFEFF\u202A\u202B\u202C\u202D\u202E]/;

// Base64-encoded strings longer than 500 chars (suspicious in memory content)
const LONG_BASE64_RE = /[A-Za-z0-9+/=]{500,}/;

const THREAT_PATTERNS: ThreatPattern[] = [
  {
    id: "invisible_unicode",
    reason: "Content contains invisible unicode characters that may hide malicious instructions",
    test: (content) => INVISIBLE_UNICODE_RE.test(content),
  },
  {
    id: "prompt_injection",
    reason: "Content contains prompt injection attempt",
    test: (content) => PROMPT_INJECTION_PATTERNS.some((re) => re.test(content)),
  },
  {
    id: "exfiltration",
    reason: "Content contains potential data exfiltration command",
    test: hasExfiltrationCommand,
  },
  {
    id: "role_hijacking",
    reason: "Content contains role hijacking attempt",
    test: (content) => ROLE_HIJACKING_PATTERNS.some((re) => re.test(content)),
  },
  {
    id: "encoded_payload",
    reason: "Content contains suspicious long base64-encoded payload",
    test: (content) => LONG_BASE64_RE.test(content),
  },
];

export function scanMemoryContent(content: string): ScanResult {
  content = content.normalize('NFKC');
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return { allowed: false, reason: pattern.reason, threatId: pattern.id };
    }
  }
  return { allowed: true };
}
