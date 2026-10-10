/**
 * Pure tie-, ANN- and hydration-aware classification for the vector cutover
 * parity gate (ILL-346). No Convex imports: both parity actions in
 * `memoryVectorAudit.ts` call these functions, and the unit tests exercise them
 * directly.
 *
 * Strict ordered top-K equality fails on large owners even with complete
 * coverage: exact score ties (duplicate vectors) and approximate-search
 * variance both reorder or swap boundary hits. The gate instead rescores both
 * lists exactly, compares tie-aware recall against the exact top-K of the
 * union, and hard-fails any coverage gap. The legacy ordered-equality count is
 * still reported, but it never decides.
 */

/** Scores closer than this are one equal-score group (Requirement 5). */
export const PARITY_SCORE_EPSILON = 1e-6;
/** Extra raw hits fetched from each index before hydration (Requirement 1). */
export const PARITY_OVERFETCH = 10;
/** Largest per-query top-K either action accepts. */
export const PARITY_MAX_LIMIT = 20;

/**
 * Verdict thresholds (Requirement 7). PROVISIONAL: retune from the recorded
 * post-deploy production distribution; never waive them.
 */
/** (b) mean side recall may trail mean inline recall by at most this. */
export const PARITY_MEAN_RECALL_TOLERANCE = 0.01;
/** (c) a query whose side recall is below this counts as low recall. */
export const PARITY_LOW_RECALL_THRESHOLD = 0.8;
/** (c)/(d) outlier caps are max(floor, ceil(fraction × checked)). */
export const PARITY_OUTLIER_FLOOR = 2;
export const PARITY_OUTLIER_FRACTION = 0.05;
/** (e) mean side exact cosine may trail the inline value by at most this. */
export const PARITY_MEAN_COSINE_TOLERANCE = 0.002;
/** Guard against float rounding when a mean sits exactly on a tolerance. */
const FLOAT_GUARD = 1e-12;

export const PARITY_CLASSES = [
  "exact_match",
  "tie_equivalent",
  "side_better_or_equal",
  "side_worse",
  "coverage_gap",
] as const;
export type ParityClass = (typeof PARITY_CLASSES)[number];

/** Hydration drop reasons (Requirement 1). Only `archived` is not a gap. */
export const PARITY_DROP_REASONS = ["archived", "owner", "missing_side", "missing_memory"] as const;
export type ParityDropReason = (typeof PARITY_DROP_REASONS)[number];

/** Coverage-gap sub-reasons from hydration drops and exact rescoring (Requirements 1–3). */
export const PARITY_GAP_REASONS = [
  "owner",
  "missing_side",
  "missing_memory",
  "duplicate_side",
  "invalid_side",
  "archived_memory",
  "missing_inline",
  "vector_drift",
  "empty_union",
  "self_missing_both",
] as const;
export type ParityGapReason = (typeof PARITY_GAP_REASONS)[number];

export const PARITY_QUALITY_CHECKS = [
  "coverage_gap",
  "mean_recall",
  "low_recall_count",
  "side_worse_count",
  "mean_cosine",
] as const;
export type ParityQualityCheck = (typeof PARITY_QUALITY_CHECKS)[number];

export type ParityQueryInput = {
  /** Requested top-K for this query. */
  limit: number;
  /** Inline-index memory IDs after hydration and truncation to `limit`. */
  inlineIds: string[];
  /** Side-index memory IDs after hydration and truncation to `limit`. */
  sideIds: string[];
  /** Exact cosine (query vector · side vector) for every ID in inlineIds ∪ sideIds. */
  scores: Record<string, number>;
  /** Set for sampled queries whose vector is a memory's own vector (Requirement 4). */
  selfMemoryId?: string;
  /** Coverage-gap sub-reasons already established by hydration or rescoring. */
  gapReasons?: ParityGapReason[];
};

export type ParityQueryResult = {
  class: ParityClass;
  /** Sampled self-hit present on the inline list but absent on the side list. */
  selfMissingSide: boolean;
  /** Informational: the old strict ordered-equality rule on the raw lists. */
  legacyMatched: boolean;
  gapReasons: ParityGapReason[];
  /** Number of self-group IDs removed from the metrics. */
  excluded: number;
  /** |T|, the tie-aware ideal set size after exclusions. */
  idealSize: number;
  inlineRecall: number | null;
  sideRecall: number | null;
  inlineMeanCosine: number | null;
  sideMeanCosine: number | null;
};

export type ParityStats = { mean: number | null; min: number | null; p5: number | null; p50: number | null };

export type ParityVerdict = {
  ok: boolean;
  code: "ok" | "coverage_gap" | "quality_regression" | "no_queries";
  checked: number;
  classes: Record<ParityClass, number>;
  gapReasons: Record<ParityGapReason, number>;
  selfMissingSide: number;
  recall: { side: ParityStats; inline: ParityStats };
  meanCosine: { side: number | null; inline: number | null };
  lowSideRecall: number;
  outlierCap: number;
  failedChecks: ParityQualityCheck[];
  thresholds: {
    scoreEpsilon: number;
    meanRecallTolerance: number;
    lowRecallThreshold: number;
    outlierFloor: number;
    outlierFraction: number;
    meanCosineTolerance: number;
    provisional: true;
  };
  /** Informational: queries whose raw lists were ordered-equal. Never decides. */
  legacyMatched: number;
};

export function parityOutlierCap(checked: number): number {
  return Math.max(PARITY_OUTLIER_FLOOR, Math.ceil(checked * PARITY_OUTLIER_FRACTION));
}

export function exactCosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("exact cosine requires equal-length vectors");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

export function orderedIdsMatch(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank percentile over ascending values. */
function percentile(sortedAscending: number[], fraction: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length) - 1;
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank))];
}

export function parityStats(values: number[]): ParityStats {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    mean: mean(sorted),
    min: sorted.length ? sorted[0] : null,
    p5: percentile(sorted, 0.05),
    p50: percentile(sorted, 0.5),
  };
}

/**
 * Classify exact scores with a per-list self-slot budget (A1) and capped
 * boundary-group credit (A2). Empty results and missing sampled self hits
 * fail closed (A3). Scores in a tie group form a maximal adjacent ε run.
 */
export function classifyParityQuery(input: ParityQueryInput): ParityQueryResult {
  const gapReasons = [...(input.gapReasons ?? [])];
  const legacyMatched = orderedIdsMatch(input.inlineIds, input.sideIds);
  const base: Omit<ParityQueryResult, "class"> = {
    selfMissingSide: false,
    legacyMatched,
    gapReasons,
    excluded: 0,
    idealSize: 0,
    inlineRecall: null,
    sideRecall: null,
    inlineMeanCosine: null,
    sideMeanCosine: null,
  };
  const limit = Math.max(1, Math.trunc(input.limit));
  const inlineIds = dedupeIds(input.inlineIds);
  const sideIds = dedupeIds(input.sideIds);
  const union = dedupeIds([...inlineIds, ...sideIds]);
  if (union.length === 0) gapReasons.push("empty_union");
  if (input.selfMemoryId !== undefined &&
      !inlineIds.includes(input.selfMemoryId) && !sideIds.includes(input.selfMemoryId)) {
    gapReasons.push("self_missing_both");
  }
  if (gapReasons.length > 0) return { ...base, class: "coverage_gap" };
  const score = (id: string) => {
    const value = input.scores[id];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("parity classification requires an exact score for every hydrated hit");
    }
    return value;
  };
  for (const id of union) score(id);

  const excluded = new Set<string>();
  let selfMissingSide = false;
  if (input.selfMemoryId !== undefined) {
    const self = input.selfMemoryId;
    selfMissingSide = inlineIds.includes(self) && !sideIds.includes(self);
    for (const id of union) if (score(id) >= 1 - PARITY_SCORE_EPSILON) excluded.add(id);
  }
  const keep = (id: string) => !excluded.has(id);
  const inlineKept = inlineIds.filter(keep);
  const sideKept = sideIds.filter(keep);
  const unionKept = union.filter(keep);
  const selfSlots = (ids: string[]) => ids.filter((id) => excluded.has(id)).length;
  const k = Math.max(0, limit - Math.max(selfSlots(inlineIds), selfSlots(sideIds)));

  const sorted = unionKept.slice().sort((a, b) => score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0));
  const groupOf = new Map<string, number>();
  let group = 0;
  sorted.forEach((id, index) => {
    if (index > 0 && score(sorted[index - 1]) - score(id) > PARITY_SCORE_EPSILON) group += 1;
    groupOf.set(id, group);
  });

  let inlineRecall: number | null = null;
  let sideRecall: number | null = null;
  let idealSize = 0;
  const kEff = Math.min(k, sorted.length);
  if (kEff > 0) {
    const boundaryGroup = groupOf.get(sorted[kEff - 1])!;
    const above = new Set(sorted.filter((id) => groupOf.get(id)! < boundaryGroup));
    const boundary = new Set(sorted.filter((id) => groupOf.get(id) === boundaryGroup));
    const boundarySlots = kEff - above.size;
    idealSize = above.size + boundary.size;
    const hits = (ids: string[], group: Set<string>) => ids.filter((id) => group.has(id)).length;
    const recall = (ids: string[]) => (hits(ids, above) + Math.min(hits(ids, boundary), boundarySlots)) / kEff;
    inlineRecall = recall(inlineKept);
    sideRecall = recall(sideKept);
  }
  const meanCosine = (ids: string[]) => mean(ids.slice(0, Math.min(k, ids.length)).map(score));

  let cls: ParityClass;
  if (selfMissingSide || inlineIds.length === 0 || sideIds.length === 0) cls = "side_worse";
  else if (orderedIdsMatch(inlineKept, sideKept) && legacyMatched) cls = "exact_match";
  else if (
    inlineKept.length === sideKept.length &&
    new Set(inlineKept).size === new Set([...inlineKept, ...sideKept]).size &&
    inlineKept.every((id, index) => groupOf.get(id) === groupOf.get(sideKept[index]))
  ) cls = "tie_equivalent";
  else if (kEff === 0 || (sideRecall !== null && inlineRecall !== null && sideRecall >= inlineRecall)) cls = "side_better_or_equal";
  else cls = "side_worse";

  return {
    ...base,
    class: cls,
    selfMissingSide,
    excluded: excluded.size,
    idealSize,
    inlineRecall,
    sideRecall,
    inlineMeanCosine: meanCosine(inlineKept),
    sideMeanCosine: meanCosine(sideKept),
  };
}

/** Aggregate per-query results into the gate verdict (Requirement 7). */
export function parityVerdict(results: ParityQueryResult[]): ParityVerdict {
  const checked = results.length;
  const classes = emptyCounts(PARITY_CLASSES);
  const gapReasons = emptyCounts(PARITY_GAP_REASONS);
  let selfMissingSide = 0;
  let legacyMatched = 0;
  for (const result of results) {
    classes[result.class] += 1;
    for (const reason of result.gapReasons) gapReasons[reason] += 1;
    if (result.selfMissingSide) selfMissingSide += 1;
    if (result.legacyMatched) legacyMatched += 1;
  }
  const scored = results.filter((result) => result.class !== "coverage_gap");
  const sideRecalls = scored.flatMap((result) => result.sideRecall === null ? [] : [result.sideRecall]);
  const inlineRecalls = scored.flatMap((result) => result.inlineRecall === null ? [] : [result.inlineRecall]);
  const sideCosine = mean(scored.flatMap((result) => (result.sideMeanCosine === null ? [] : [result.sideMeanCosine])));
  const inlineCosine = mean(scored.flatMap((result) => (result.inlineMeanCosine === null ? [] : [result.inlineMeanCosine])));
  const recall = { side: parityStats(sideRecalls), inline: parityStats(inlineRecalls) };
  const lowSideRecall = sideRecalls.filter((value) => value < PARITY_LOW_RECALL_THRESHOLD).length;
  const outlierCap = parityOutlierCap(checked);

  const failedChecks: ParityQualityCheck[] = [];
  if (classes.coverage_gap > 0) failedChecks.push("coverage_gap");
  if (
    recall.side.mean !== null && recall.inline.mean !== null &&
    recall.side.mean + FLOAT_GUARD < recall.inline.mean - PARITY_MEAN_RECALL_TOLERANCE
  ) failedChecks.push("mean_recall");
  if (lowSideRecall > outlierCap) failedChecks.push("low_recall_count");
  if (classes.side_worse > outlierCap) failedChecks.push("side_worse_count");
  if (
    sideCosine !== null && inlineCosine !== null &&
    sideCosine + FLOAT_GUARD < inlineCosine - PARITY_MEAN_COSINE_TOLERANCE
  ) failedChecks.push("mean_cosine");

  const code: ParityVerdict["code"] = checked === 0
    ? "no_queries"
    : classes.coverage_gap > 0
      ? "coverage_gap"
      : failedChecks.length > 0
        ? "quality_regression"
        : "ok";
  return {
    ok: checked > 0 && failedChecks.length === 0,
    code,
    checked,
    classes,
    gapReasons,
    selfMissingSide,
    recall,
    meanCosine: { side: sideCosine, inline: inlineCosine },
    lowSideRecall,
    outlierCap,
    failedChecks,
    thresholds: {
      scoreEpsilon: PARITY_SCORE_EPSILON,
      meanRecallTolerance: PARITY_MEAN_RECALL_TOLERANCE,
      lowRecallThreshold: PARITY_LOW_RECALL_THRESHOLD,
      outlierFloor: PARITY_OUTLIER_FLOOR,
      outlierFraction: PARITY_OUTLIER_FRACTION,
      meanCosineTolerance: PARITY_MEAN_COSINE_TOLERANCE,
      provisional: true,
    },
    legacyMatched,
  };
}
