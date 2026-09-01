// ILL-245: Recall coverage diagnostics and promotion helpers
// Extracted from mcp.ts to make testable

import { computeRelevance, PROMOTION_MESSAGE_SCORE } from "./recallRanking";
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
}

export interface PromotionCandidate {
  messageId: string;
  score: number;
  reason: "no_memory_for_attribute" | "weak_memory_stronger_message";
  suggestedCategory: "person" | "fact";
  attribute: string;
}

/**
 * Select memories for final recall based on relevance floor and coverage rules.
 * Currently a pass-through until compositor logic is integrated.
 */
export function selectMemoriesForCoverage(
  memories: MemoryHit[],
  options: {
    recallIntent: RecallIntent;
    limit: number;
  }
): MemoryHit[] {
  // For now, just slice to limit
  // Future: apply relevance-based filtering in compositor
  return memories.slice(0, options.limit);
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

  // Quality rules:
  // - strong: at least one memory with relevance >= 0.50
  // - weak: memories exist but all below 0.50, OR no memory but messageRelevanceMax >= 0.50
  // - none: no memories and messageRelevanceMax < 0.50

  const hasStrongMemory = memories.some((m) => (m.relevance ?? 0) >= 0.5);
  const hasAnyMemory = memories.length > 0;
  const hasStrongMessage = messageRelevanceMax >= 0.5;

  if (hasStrongMemory) {
    quality = "strong";
    note = `${memories.length} ${memories.length === 1 ? "memory" : "memories"}; max relevance ${memoryRelevanceMax.toFixed(2)}`;
  } else if (hasAnyMemory) {
    quality = "weak";
    note = `${memories.length} ${memories.length === 1 ? "memory" : "memories"} below 0.50; max relevance ${memoryRelevanceMax.toFixed(2)}`;
    if (messages.length > 0) {
      note += `; ${messages.length} message ${messages.length === 1 ? "match" : "matches"} at ${messageRelevanceMax.toFixed(2)} — consider promoting`;
    }
  } else if (hasStrongMessage) {
    quality = "weak";
    note = `No memory; ${messages.length} message ${messages.length === 1 ? "match" : "matches"} at ${messageRelevanceMax.toFixed(2)} — consider promoting`;
  } else {
    quality = "none";
    note = messages.length > 0
      ? `No memory; ${messages.length} weak message ${messages.length === 1 ? "match" : "matches"} (max ${messageRelevanceMax.toFixed(2)})`
      : "No memory; no message matches";
  }

  return {
    quality,
    memoryRelevanceMax,
    messageRelevanceMax,
    padded,
    note,
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
  }
): { filtered: MessageHit[]; suppressedCount: number } {
  // Only apply on personal_attribute intent
  if (options.recallIntent !== "personal_attribute") {
    return { filtered: messages, suppressedCount: 0 };
  }

  const query = options.query.toLowerCase();
  const accountName = (options.accountHolderName ?? "").toLowerCase();

  // Check if query names a specific person (other than account holder)
  const namedPersons = ["natasha", "kristen", "andy"].filter(
    (name) => name !== accountName && query.includes(name)
  );

  // If query names someone specific, keep messages about them
  if (namedPersons.length > 0) {
    const filtered = messages.filter((msg) => {
      const content = msg.content.toLowerCase();
      return namedPersons.some((person) => content.includes(person));
    });
    return { filtered, suppressedCount: messages.length - filtered.length };
  }

  // Otherwise, drop messages that mention other people
  const otherPersons = ["natasha", "kristen", "andy"].filter(
    (name) => name !== accountName
  );

  const filtered = messages.filter((msg) => {
    const content = msg.content.toLowerCase();
    // Drop if mentions another person
    return !otherPersons.some((person) => content.includes(person));
  });

  return { filtered, suppressedCount: messages.length - filtered.length };
}
