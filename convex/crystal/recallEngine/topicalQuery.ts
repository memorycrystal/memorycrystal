import { PR_PATTERNS, ticketPattern } from "./identifierPatterns";
import { analyzeQuery, normalizeQueryText, URL_PATTERN, URL_TOKEN_MAX_LENGTH } from "./queryAnalysis";

const MIN_TOPICAL_TERMS = 2;

/**
 * The query with its decisive identifiers removed (ILL-509): PR forms, tickets with a configured prefix and full
 * SHAs, matched by the same patterns analyzeQuery extracts them with, outside URLs. Null when the query has no
 * decisive identifier, when fewer than 2 informative terms remain, or when the query is too long to split safely.
 */
export function stripDecisiveIdentifiers(
  query: string,
  options?: { ticketPrefixes?: readonly string[] },
): string | null {
  const normalized = normalizeQueryText(query);
  if (normalized.length > URL_TOKEN_MAX_LENGTH) return null;
  const analyzed = analyzeQuery(query, options);
  const decisiveShas = analyzed.shas.filter((sha) => sha.length >= 12);
  if (!analyzed.prNumbers.size && !analyzed.ticketIds.size && !decisiveShas.length) return null;
  const patterns = [
    ...PR_PATTERNS,
    ...[...analyzed.ticketIds.keys()].map(ticketPattern),
    ...decisiveShas.map((sha) => new RegExp(`\\b${sha}\\b`, "gi")),
  ];
  // Odd segments are URLs (the one capture group), which extraction ignores and stripping keeps.
  const segments = normalized.split(new RegExp(`(${URL_PATTERN.source})`, "gi"));
  const stripped = segments
    .map((segment, index) => index % 2 === 1
      ? segment
      : patterns.reduce((text, pattern) => text.replace(pattern, " "), segment))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped === normalized) return null;
  return analyzeQuery(stripped, options).informativeTerms.length >= MIN_TOPICAL_TERMS ? stripped : null;
}
