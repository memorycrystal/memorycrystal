import type { NormalizedRecallRequest } from "./types";
import { analyzeQuery, hasConflictingIdentifier, scoreQueryMatch, type AnalyzedQuery } from "./queryAnalysis";

/**
 * Identifier lane. Req 2-3: Extracts PR / ticket / SHA / URL / semver from
 * the query. Identifiers feed exclusion and scoring; the lane itself returns
 * no memory IDs because there is no direct identifier→memory lookup path.
 */
export function identifierCandidates(
  _request: NormalizedRecallRequest,
): readonly string[] {
  return [];
}

/** Cache analyzed query on the request to avoid recomputation. */
const _analyzedCache = new WeakMap<NormalizedRecallRequest, AnalyzedQuery>();

export function getAnalyzedQuery(request: NormalizedRecallRequest): AnalyzedQuery {
  let cached = _analyzedCache.get(request);
  if (!cached) {
    cached = analyzeQuery(request.query);
    _analyzedCache.set(request, cached);
  }
  return cached;
}

/**
 * Req 3: Check if a candidate should be hard-excluded based on identifier conflict.
 * Only PR numbers and allowlisted tickets trigger hard exclusion.
 */
export function candidateHasConflict(
  analyzed: AnalyzedQuery,
  title: string,
  content: string,
  tags: string[] = [],
): boolean {
  return hasConflictingIdentifier(analyzed, `${title} ${content} ${tags.join(" ")}`);
}

/**
 * Req 3: Check if any analyzed identifier is "decisive".
 * Decisive = PR number, allowlisted ticket, or full SHA (≥ 12 hex).
 */
export function hasDecisiveIdentifier(analyzed: AnalyzedQuery, candidateText?: string): boolean {
  if (candidateText !== undefined) {
    return scoreQueryMatch(analyzed, "", candidateText).decisiveIdentifierMatch;
  }
  return analyzed.prNumbers.size > 0 || analyzed.ticketIds.size > 0 || analyzed.shas.some((sha) => sha.length >= 12);
}
