/**
 * Pure strength-dynamics model for Memory Crystal (ILL-103).
 *
 * `strength` lives in [0, 1]. Two forces act on it:
 *
 *  - **Lazy decay** (`computeDecay`): a gradual, time-based fade applied at
 *    access time for the days elapsed since a memory was last touched. This is
 *    the previously-dead helper (was `decay.ts:computeDecay`, "kept for
 *    potential future use") now given a real job as the decay half of
 *    reinforcement-on-recall. NB: this is distinct from `decay.ts:applyDecay`,
 *    which is capacity-pressure *archival* (halves + archives the weakest
 *    memories only when a user is near their tier memory limit) and is left
 *    untouched.
 *  - **Reinforcement** (`reinforceStrength`): a bounded, diminishing increment
 *    applied when a memory is actually recalled/used, so `strength` tracks
 *    usefulness rather than mere recency-of-write.
 *
 * `reinforceOnRecall` composes them into the single per-recall transition:
 * first decay for the elapsed idle time, then reinforce. This yields a real
 * equilibrium — frequent use holds strength in a high band, a steady cadence
 * settles at a mid band (where the per-recall increment equals the accumulated
 * idle decay), and a long-cold memory decays before it reinforces.
 *
 * Everything here is pure (no clock, no I/O), so the trajectory is unit-testable
 * and the `scripts/bench-strength-trajectory.mjs` simulation is deterministic.
 */

/** Clamp a strength value into the valid [0, 1] range. */
export const clampStrength = (value: number): number =>
  Math.max(0, Math.min(1, value));

/**
 * Base reinforcement rate. The per-recall increment is
 * `alpha * confidenceWeight * (1 - strength)`, so it shrinks as strength
 * approaches the 1.0 ceiling (diminishing returns) and can never exceed it.
 * 0.10 balances the ~0.01-0.02/day idle decay below so that equilibrium
 * strength reflects recall cadence: daily recall settles high (~0.9), a
 * few-day cadence mid (~0.6-0.7), weekly low (~0.2). Demonstrated by
 * scripts/bench-strength-trajectory.mjs.
 */
export const DEFAULT_REINFORCE_ALPHA = 0.1;

/**
 * Maximum strength a single recall may shed to idle decay. Without this, the
 * first recall of a long-dormant memory (large `ageDays`) would apply the whole
 * accumulated decay at once and crater the strength of a memory just judged
 * relevant enough to surface. Capping the per-access decay keeps everyday
 * cadences (idle decay ~0.02-0.07, up to weekly) intact while bounding the
 * cold-start hit, so recalling a long-dormant memory never craters its strength
 * in one shot.
 */
export const MAX_ACCESS_DECAY = 0.1;

/**
 * Gradual, time-based decay for a memory idle for `ageDays` days. Emotionally
 * salient memories (high |valence| + arousal) and frequently-accessed memories
 * fade more slowly. Returns the decayed strength, clamped to [0, 1].
 *
 * (Moved verbatim from decay.ts; re-exported there for back-compat.)
 */
export const computeDecay = (
  strength: number,
  ageDays: number,
  accessCount: number,
  valence: number,
  arousal: number,
): number => {
  const isHighEmotion = Math.abs(valence) > 0.7 && arousal > 0.7;
  const baseDecay = isHighEmotion ? 0.01 : 0.02;
  const recallBoost = Math.min(accessCount * 0.002, 0.01);
  const adjustedDecay = Math.max(0.005, baseDecay - recallBoost);
  const amount = adjustedDecay * Math.max(0, ageDays);
  return clampStrength(strength - amount);
};

/**
 * Bounded, diminishing reinforcement increment applied when a memory is used.
 * `confidence` (0..1) scales the rate so well-grounded memories reinforce a
 * little faster; it is clamped defensively. Never exceeds the 1.0 ceiling.
 */
export const reinforceStrength = (
  strength: number,
  confidence: number,
  alpha: number = DEFAULT_REINFORCE_ALPHA,
): number => {
  const confidenceWeight = Math.max(0, Math.min(1, confidence));
  const increment = alpha * confidenceWeight * (1 - strength);
  return clampStrength(strength + increment);
};

/**
 * The full per-recall strength transition: decay for the idle interval since
 * last access, then reinforce for the use. This is the single source of truth
 * for reinforcement-on-recall — `updateMemoryAccessInternal` calls exactly this,
 * and the unit tests / trajectory bench exercise the same function.
 */
export const reinforceOnRecall = (params: {
  strength: number;
  ageDays: number;
  accessCount: number;
  valence: number;
  arousal: number;
  confidence: number;
  alpha?: number;
}): number => {
  const fullyDecayed = computeDecay(
    params.strength,
    params.ageDays,
    params.accessCount,
    params.valence,
    params.arousal,
  );
  // Bound the idle-decay applied by a single access (see MAX_ACCESS_DECAY).
  const decayAmount = Math.min(params.strength - fullyDecayed, MAX_ACCESS_DECAY);
  const decayed = clampStrength(params.strength - decayAmount);
  return reinforceStrength(decayed, params.confidence, params.alpha ?? DEFAULT_REINFORCE_ALPHA);
};
