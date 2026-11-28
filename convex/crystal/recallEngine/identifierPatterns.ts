/**
 * Decisive identifier patterns shared by query analysis and topical stripping (ILL-509), so both agree on what an
 * identifier is.
 */

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Group 1 of every PR pattern is the number.
export const PR_PATTERNS: readonly RegExp[] = [
  /\bpull\s+requests?\s*#?\s*(\d+)\b/gi,
  /\bpulls?\/(\d+)\b/gi,
  /\bpr\s*#?\s*(\d+)\b/gi,
  // A #number is a PR form only when # is not embedded in a word/identifier.
  /(?:^|[^a-z0-9_])#(\d+)(?=$|[^a-z0-9_])/gi,
];

export function ticketPattern(prefix: string): RegExp {
  return new RegExp(`\\b${escaped(prefix)}-(\\d+)\\b`, "gi");
}
