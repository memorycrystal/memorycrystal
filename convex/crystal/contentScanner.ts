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

// Exfiltration patterns
const EXFILTRATION_PATTERNS: RegExp[] = [
  /(?:curl|wget)\s+.*\$\{?\w*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)\w*\}?/i,
  /(?:curl|wget)\s+.*--data.*\$\{?\w*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)\w*\}?/i,
  // 'cat .env' only when combined with exfiltration (pipe to curl/wget/send/post)
  /cat\s+(?:\/[\w./]*)?\.env\b.*\|\s*(?:curl|wget|nc|sendmail)/i,
  /cat\s+(?:\/[\w./]*)?\.env\b.*(?:send|post|upload)\b/i,
  /cat\s+(?:\/[\w./]*)?credentials(?:\.json|\.yaml|\.yml|\.toml)?\b/i,
];

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
    test: (content) => EXFILTRATION_PATTERNS.some((re) => re.test(content)),
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
