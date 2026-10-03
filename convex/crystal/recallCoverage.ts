// ILL-245: Recall coverage diagnostics and promotion helpers
// Extracted from mcp.ts to make testable

import { RECALL_V2_CALIBRATION, computeRelevance, PROMOTION_MESSAGE_SCORE } from "./recallRanking";
import { analyzeQuery, STOPWORDS } from "./recallEngine/queryAnalysis";
import type { RecallIntent } from "./recallRanking";

export interface MemoryHit {
  memoryId: string;
  score: number;
  relevance?: number;
  [key: string]: any;
}

export interface MessageHit {
  messageId: string;
  score: number;
  relevance?: number;
  subjects?: string[];
  content: string;
  channel?: string;
  sessionKey?: string;
  [key: string]: any;
}

export interface CoverageDiagnostics {
  quality: "strong" | "weak" | "none";
  memoryRelevanceMax: number;
  messageRelevanceMax: number;
  padded: boolean;
  note: string;
  relevanceFloor: number;
  strongThreshold: number;
  injectScoreThreshold: number;
}

export interface PromotionCandidate {
  messageId: string;
  score: number;
  reason: "no_memory_for_attribute" | "weak_memory_stronger_message";
  suggestedCategory: "person" | "fact";
  attribute: string;
}

/** First-name tokens from at most the caller's bounded person-memory titles. */
export function firstNameTokensFromPersonTitles(
  titles: readonly string[],
  accountHolderName = "",
): string[] {
  const holderTokens = new Set(accountHolderName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const titlePrefixes = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "person", "profile", "client", "contact"]);
  const personMarkers = new Set([
    ...titlePrefixes, "wife", "husband", "spouse", "partner", "coach", "friend", "daughter", "son",
    "mother", "father", "brother", "sister", "therapist", "doctor", "colleague", "of",
  ]);
  const nonNameTokens = new Set([
    ...STOPWORDS, "user", "preferred", "name", "birthday", "birth", "date", "personal", "fact", "facts",
    "memory", "memories", "profile", "notes", "note", "details", "information", "info", "contact",
  ]);
  const names = new Set<string>();
  for (const title of titles.slice(0, 200)) {
    const tokens = (title.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [])
      .map((token) => token.replace(/'s$/, ""));
    const plausibleName = (token: string | undefined) => Boolean(token && token.length > 1 &&
      /^[a-z]+$/.test(token) && !nonNameTokens.has(token) && !personMarkers.has(token));
    const addName = (token: string | undefined) => {
      if (plausibleName(token) && !holderTokens.has(token!)) names.add(token!);
    };

    // Plain person titles start with a first name; explicit relationship/title
    // markers permit the first name in the immediately following position.
    if (personMarkers.has(tokens[0] ?? "")) addName(tokens[1]);
    else addName(tokens[0]);
    for (let index = 0; index < tokens.length - 1; index += 1) {
      if (personMarkers.has(tokens[index])) addName(tokens[index + 1]);
    }
  }
  return [...names];
}

/**
 * Build coverage diagnostics for recall response.
 * Reports quality (strong/weak/none), max relevance scores, and promotion note.
 */
export function buildCoverageDiagnostics(
  memories: MemoryHit[],
  messages: MessageHit[],
  options: {
    recallIntent: RecallIntent;
    requestedLimit: number;
    query?: string;
  }
): CoverageDiagnostics {
  const memoryRelevanceMax =
    memories.length > 0 && memories.some((m) => typeof m.relevance === "number")
      ? Math.max(...memories.map((m) => m.relevance ?? 0))
      : 0;

  const messageRelevanceMax =
    messages.length > 0 && messages.some((m) => typeof m.relevance === "number")
      ? Math.max(...messages.map((m) => m.relevance ?? 0))
      : 0;

  const padded = false; // ILL-245: we do not pad to limit

  let quality: "strong" | "weak" | "none";
  let note: string;

  const top = memories[0];
  const topRelevance = top?.relevance ?? 0;
  const topVector = top?.vectorScore ?? top?.rankingSignals?.vectorScore ?? 0;
  const topLexical = top?.textMatchScore ?? top?.rankingSignals?.textMatchScore ?? 0;
  const decisive = Boolean(top?.decisiveIdentifierMatch ?? top?.rankingSignals?.decisiveIdentifierMatch);
  const requestedIdentifiers = analyzeQuery(options.query ?? "");
  const requiresRequestedIdentifier = requestedIdentifiers.prNumbers.size > 0 || requestedIdentifiers.ticketIds.size > 0;
  const requestedIdentifierMatched = Boolean(top?.requestedPrTicketMatch ?? top?.rankingSignals?.requestedPrTicketMatch);
  const hasStrongMemory = Boolean(top) &&
    topRelevance >= RECALL_V2_CALIBRATION.strongThreshold &&
    (!requiresRequestedIdentifier || requestedIdentifierMatched) &&
    ((topLexical >= RECALL_V2_CALIBRATION.strongLexicalMinimum &&
      topVector >= RECALL_V2_CALIBRATION.strongVectorMinimum) || decisive);
  const hasAnyMemory = memories.length > 0;

  if (hasStrongMemory) {
    quality = "strong";
    note = `${memories.length} ${memories.length === 1 ? "memory" : "memories"}; max relevance ${memoryRelevanceMax.toFixed(2)}`;
  } else if (hasAnyMemory) {
    quality = "weak";
    note = `${memories.length} ${memories.length === 1 ? "memory" : "memories"} below calibrated strong criteria; max relevance ${memoryRelevanceMax.toFixed(2)}`;
    if (messages.length > 0) {
      note += `; ${messages.length} message ${messages.length === 1 ? "match" : "matches"} at ${messageRelevanceMax.toFixed(2)} — consider promoting`;
    }
  } else {
    quality = "none";
    note = messages.length > 0
      ? `No memory; ${messages.length} message ${messages.length === 1 ? "match" : "matches"} (max ${messageRelevanceMax.toFixed(2)})`
      : "No memory; no message matches";
  }

  return {
    quality,
    memoryRelevanceMax,
    messageRelevanceMax,
    padded,
    note,
    relevanceFloor: RECALL_V2_CALIBRATION.relevanceFloor,
    strongThreshold: RECALL_V2_CALIBRATION.strongThreshold,
    injectScoreThreshold: RECALL_V2_CALIBRATION.injectScoreThreshold,
  };
}

/**
 * Build promotion candidates from message matches.
 * Emits candidates when:
 * - message score >= PROMOTION_MESSAGE_SCORE (0.70)
 * - no kept memory has relevance >= 0.50 for that attribute
 */
export function buildPromotionCandidates(
  memories: MemoryHit[],
  messages: MessageHit[],
  options: {
    recallIntent: RecallIntent;
    query: string;
  }
): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];

  // Only promote on personal_attribute intent
  if (options.recallIntent !== "personal_attribute") {
    return candidates;
  }

  // AC5: If any memory is strong (relevance >= 0.5), suppress all promotions
  // The assumption is that a strong memory covers the query adequately
  const hasStrongMemory = memories.some((m) => (m.relevance ?? 0) >= 0.5);
  if (hasStrongMemory) {
    return candidates;
  }

  for (const message of messages) {
    if (message.score < PROMOTION_MESSAGE_SCORE) {
      continue;
    }

    // Extract attributes from subjects
    const attributes = message.subjects ?? [];
    if (attributes.length === 0) {
      continue;
    }

    for (const attribute of attributes) {
      // If we reach here, hasStrongMemory is false, so reason is no_memory_for_attribute
      const reason = "no_memory_for_attribute";

      // Heuristic: if attribute is BMR, age, height, weight → person, else fact
      const suggestedCategory = ["bmr", "age", "height", "weight", "birthday"].includes(
        attribute.toLowerCase()
      )
        ? "person"
        : "fact";

      candidates.push({
        messageId: message.messageId,
        score: message.score,
        reason,
        suggestedCategory,
        attribute,
      });
    }
  }

  return candidates.slice(0, 5); // Limit to 5 candidates
}

/**
 * Apply cross-person filter for personal_attribute intent.
 * Drops messages that mismatch the account holder unless query names that person.
 * Returns filtered messages and count of dropped messages.
 */
export function applyCrossPersonFilter(
  messages: MessageHit[],
  options: {
    recallIntent: RecallIntent;
    query: string;
    accountHolderName?: string;
    knownPersonNames?: readonly string[];
  }
): { filtered: MessageHit[]; suppressedCount: number } {
  // Only apply on personal_attribute intent
  if (options.recallIntent !== "personal_attribute") {
    return { filtered: messages, suppressedCount: 0 };
  }
  if (!options.accountHolderName?.trim()) return { filtered: messages, suppressedCount: 0 };

  const query = options.query.toLowerCase();
  const holderTokens = new Set((options.accountHolderName ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const otherPersons = [...new Set((options.knownPersonNames ?? [])
    .map((name) => name.trim().toLowerCase())
    .filter((name) => /^[a-z][a-z'-]*$/.test(name) && !holderTokens.has(name)))];
  if (otherPersons.length === 0) return { filtered: messages, suppressedCount: 0 };

  const queryNames = otherPersons.filter((name) => containsPersonToken(query, name));

  // If query names someone specific, keep messages about them
  if (queryNames.length > 0) {
    const filtered = messages.filter((msg) => {
      return queryNames.some((person) => containsPersonToken(msg.content, person));
    });
    return { filtered, suppressedCount: messages.length - filtered.length };
  }

  const filtered = messages.filter((msg) => {
    return !otherPersons.some((person) => containsPersonToken(msg.content, person));
  });

  return { filtered, suppressedCount: messages.length - filtered.length };
}

function containsPersonToken(text: string, person: string): boolean {
  const escaped = person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
}
