/**
 * enrichmentEligibility.ts
 *
 * Determines whether a memory is eligible for graph enrichment.
 * M1 — Sensory-tier skip: memories with store === "sensory" are excluded.
 * M2 — Attempt cap: memories with enrichmentAttempts >= MAX_ATTEMPTS are excluded;
 *       memories with enrichmentSkippedReason set are excluded.
 * M4 — KB chunk gate: non-parent KB chunks (isKbParent === false) are excluded;
 *       only the parent chunk (isKbParent === true or undefined for legacy rows)
 *       receives enrichment.
 * M5 — Strength floor: memories with strength < STRENGTH_FLOOR and accessCount === 0
 *       are skipped (with reason "below_strength_floor"). KB parents bypass the floor.
 *       The skip is reversible — recall.ts/decay.ts clear the reason once strength
 *       climbs back to ≥STRENGTH_FLOOR (Option (b) per the cost-reduction plan).
 */

export interface EnrichmentEligibilityResult {
  ok: boolean;
  reason?: string;
}

export interface EnrichmentCandidateMemory {
  store?: string;
  tier?: string;
  // M2 fields
  enrichmentSkippedReason?: string;
  attempts?: number;
  // M4 fields
  isKbParent?: boolean;
  knowledgeBaseId?: string;
  // M5 fields
  strength?: number;
  accessCount?: number;
}

/** Maximum enrichment attempts before a memory is permanently skipped. */
export const MAX_ENRICHMENT_ATTEMPTS = 5;

/**
 * M5 strength floor. Memories below this threshold with no recall hits are
 * presumed not worth graph enrichment until re-recalled or strengthened.
 */
export const STRENGTH_FLOOR = 0.3;

/**
 * shouldEnrich — returns { ok: false, reason } if the memory should be skipped
 * for graph enrichment, or { ok: true } if it is eligible.
 *
 * M1 rule: skip when store === "sensory" (OR tier === "sensory" for
 * forward-compatibility with any future schema aliasing).
 *
 * M2 rules (evaluated after M1):
 *   - skip when enrichmentSkippedReason is set (permanent skip persisted in DB)
 *   - skip when attempts >= MAX_ENRICHMENT_ATTEMPTS
 *
 * M4 rule: skip KB non-parent chunks.
 *   - when isKbParent === false AND knowledgeBaseId is set → skip (kb_chunk)
 *   - when isKbParent === undefined (legacy rows) → treat as parent (backwards-compat)
 *   - when isKbParent === true → eligible for enrichment
 *
 * M5 rule: skip cold low-strength memories.
 *   - when strength < STRENGTH_FLOOR AND accessCount === 0 AND !isKbParent → skip
 *     (reason "below_strength_floor"). KB parents always enrich regardless of strength.
 *   - reversible: recall and decay paths clear the skip reason when strength climbs
 *     back to ≥STRENGTH_FLOOR (see recall.ts/memories.ts/decay.ts).
 */
export function shouldEnrich(memory: EnrichmentCandidateMemory): EnrichmentEligibilityResult {
  // M1: sensory skip (checked first — highest priority)
  if (memory.store === "sensory" || memory.tier === "sensory") {
    return { ok: false, reason: "sensory_skip" };
  }

  // M2: permanent skip reason already persisted in DB
  if (memory.enrichmentSkippedReason) {
    return { ok: false, reason: memory.enrichmentSkippedReason };
  }

  // M2: attempt cap
  if (memory.attempts !== undefined && memory.attempts >= MAX_ENRICHMENT_ATTEMPTS) {
    return { ok: false, reason: "max_attempts_exceeded" };
  }

  // M4: KB non-parent chunks are never enriched individually.
  // isKbParent === false (explicitly marked) + knowledgeBaseId set → skip.
  // isKbParent === undefined (legacy pre-M4 rows) → treated as parent (no regression).
  if (memory.isKbParent === false && memory.knowledgeBaseId !== undefined) {
    return { ok: false, reason: "kb_chunk" };
  }

  // M5: strength floor — only skip when we have a strength signal and the
  // memory has never been recalled. KB parents always enrich (the parent is
  // the canonical representative for an entire knowledge base).
  if (
    memory.strength !== undefined &&
    memory.strength < STRENGTH_FLOOR &&
    (memory.accessCount ?? 0) === 0 &&
    memory.isKbParent !== true
  ) {
    return { ok: false, reason: "below_strength_floor" };
  }

  return { ok: true };
}
