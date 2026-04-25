const millisecondsPerDay = 24 * 60 * 60 * 1000;
const freshnessDecayFactor = 0.12;
const accessRecencyDecayFactor = 0.08;

export type RecallRankingCandidate = {
  memoryId: string;
  title: string;
  content: string;
  store: string;
  category: string;
  tags: string[];
  knowledgeBaseId?: string;
  strength: number;
  confidence: number;
  accessCount?: number;
  lastAccessedAt?: number;
  createdAt?: number;
  salienceScore?: number;
  channel?: string;
  vectorScore?: number;
  textMatchScore?: number;
};

export type RecallRankingWeights = {
  vectorWeight: number;
  strengthWeight: number;
  freshnessWeight: number;
  accessWeight: number;
  salienceWeight: number;
  continuityWeight: number;
  textMatchWeight: number;
  knowledgeBaseWeight?: number;
};

export type RecallRankingOptions = {
  now?: number;
  query?: string;
  channel?: string;
  weights?: Partial<RecallRankingWeights>;
};

export type RankedRecallCandidate<T extends RecallRankingCandidate = RecallRankingCandidate> = T & {
  scoreValue: number;
  rankingSignals: {
    vectorScore: number;
    strengthScore: number;
    freshnessScore: number;
    accessScore: number;
    salienceScore: number;
    continuityScore: number;
    textMatchScore: number;
    knowledgeBaseScore: number;
  };
};

export type DiversityFilterOptions = {
  similarityThreshold?: number;
  minDiversity?: number;
};

export const defaultRecallRankingWeights: RecallRankingWeights = {
  vectorWeight: 0.3,
  strengthWeight: 0.22,
  freshnessWeight: 0.15,
  accessWeight: 0.06,
  salienceWeight: 0.14,
  continuityWeight: 0.08,
  textMatchWeight: 0.12,
  knowledgeBaseWeight: 0.25,
};

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
};

const normalizeText = (value: string | undefined | null) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const normalizeWhitespace = (value: string | undefined | null) =>
  normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();

const candidateText = (candidate: Pick<RecallRankingCandidate, "title" | "content">) =>
  normalizeWhitespace(`${candidate.title} ${candidate.content}`);

const tokenizeQuery = (query: string) =>
  normalizeText(query)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

const estimateSalienceScore = ({ title, content, store, category, tags }: Pick<RecallRankingCandidate, "title" | "content" | "store" | "category" | "tags">) => {
  const text = `${title ?? ""} ${content ?? ""}`.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const lengthBonus = Math.min(words / 200, 0.15);
  const combined = text.toLowerCase();
  const decisionBonus = /decided|decision|chose|agreed|confirmed|going with/i.test(combined) ? 0.15 : 0;
  const lessonBonus = /learned|lesson|mistake|should have|next time|always|never|pattern/i.test(combined) ? 0.12 : 0;
  const goalBonus = /goal|target|milestone|deadline|must|need to|plan to|will build/i.test(combined) ? 0.12 : 0;

  const categoryBonus =
    {
      decision: 0.2,
      lesson: 0.18,
      goal: 0.15,
      person: 0.12,
      rule: 0.12,
      skill: 0.14,
      workflow: 0.1,
      fact: 0.08,
      event: 0.05,
      conversation: 0,
    }[category] ?? 0;

  const storeBonus =
    {
      semantic: 0.15,
      procedural: 0.12,
      episodic: 0.08,
      prospective: 0.1,
      sensory: 0,
    }[store] ?? 0;

  const entityBonus = Math.min(((content ?? "").match(/\b[A-Z][a-z]+\b/g) || []).length / 20, 0.08);
  const tagBonus = Math.min((tags ?? []).length * 0.02, 0.08);

  return clamp01(0.3 + lengthBonus + decisionBonus + lessonBonus + goalBonus + categoryBonus + storeBonus + entityBonus + tagBonus);
};

export const recencyScore = (ageDays: number, decayFactor = freshnessDecayFactor) =>
  clamp01(Math.exp(-Math.max(0, ageDays) * decayFactor));

export const deriveTextMatchScore = (query: string, title: string, content: string, tags: string[] = []) => {
  const normalizedQuery = normalizeWhitespace(query);
  if (!normalizedQuery) {
    return 0;
  }

  const haystack = normalizeWhitespace(`${title} ${content} ${tags.join(" ")}`);
  if (!haystack) {
    return 0;
  }

  const exactMatch = haystack.includes(normalizedQuery) ? 1 : 0;
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return exactMatch;
  }

  const uniqueMatches = new Set(tokens.filter((token) => haystack.includes(token))).size;
  const tokenCoverage = uniqueMatches / tokens.length;
  return clamp01(Math.max(exactMatch, tokenCoverage));
};

export const memoryDedupKey = (candidate: Pick<RecallRankingCandidate, "title" | "content">) => {
  const title = normalizeWhitespace(candidate.title);
  const content = normalizeWhitespace(candidate.content);
  return `${title}::${content}`;
};

export const getBigrams = (text: string): string[] => {
  const tokens = normalizeWhitespace(text)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 2) {
    return tokens;
  }

  const bigrams: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    bigrams.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return bigrams;
};

export const textSimilarity = (
  a: Pick<RecallRankingCandidate, "title" | "content">,
  b: Pick<RecallRankingCandidate, "title" | "content">
): number => {
  const aBigrams = new Set(getBigrams(candidateText(a)));
  const bBigrams = new Set(getBigrams(candidateText(b)));

  if (aBigrams.size === 0 && bBigrams.size === 0) {
    return 1;
  }

  const intersectionSize = Array.from(aBigrams).filter((entry) => bBigrams.has(entry)).length;
  const unionSize = new Set([...aBigrams, ...bBigrams]).size;

  return unionSize === 0 ? 0 : intersectionSize / unionSize;
};

export const diversityFilter = <T extends RankedRecallCandidate>(
  candidates: T[],
  limit: number,
  options: DiversityFilterOptions = {}
): T[] => {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0 || candidates.length <= 1) {
    return candidates.slice(0, normalizedLimit);
  }

  const similarityThreshold = options.similarityThreshold ?? 0.85;
  const minDiversity = Math.max(1, Math.min(options.minDiversity ?? 3, normalizedLimit));
  const selected: T[] = [];
  const skipped: T[] = [];

  for (const candidate of candidates) {
    if (selected.length >= normalizedLimit) {
      break;
    }

    const overlapsExisting = selected.some(
      (existing) => textSimilarity(candidate, existing) >= similarityThreshold
    );

    if (!overlapsExisting) {
      selected.push(candidate);
      continue;
    }

    skipped.push(candidate);
  }

  // Prefer candidates that expand lexical coverage first when the initial
  // greedy pass found fewer distinct clusters than the caller asked for.
  if (selected.length < minDiversity) {
    for (const candidate of skipped) {
      if (selected.length >= normalizedLimit) {
        break;
      }
      const expandsCoverage = selected.every(
        (existing) => textSimilarity(candidate, existing) < similarityThreshold
      );
      if (expandsCoverage) {
        selected.push(candidate);
      }
    }
  }

  // Backfill from skipped candidates so the caller still gets enough recall context
  // even when every candidate lands in the same lexical cluster.
  for (const candidate of skipped) {
    if (selected.length >= normalizedLimit) {
      break;
    }
    if (selected.some((existing) => existing.memoryId === candidate.memoryId)) {
      continue;
    }
    selected.push(candidate);
  }

  return selected;
};

export const scoreRecallCandidate = <T extends RecallRankingCandidate>(
  candidate: T,
  options: RecallRankingOptions = {}
): RankedRecallCandidate<T> => {
  const now = options.now ?? Date.now();
  const weights = { ...defaultRecallRankingWeights, ...(options.weights ?? {}) };
  const createdAt = Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : now;
  const lastAccessedAt = Number.isFinite(candidate.lastAccessedAt) ? Number(candidate.lastAccessedAt) : createdAt;
  const freshnessScore = recencyScore((now - createdAt) / millisecondsPerDay, freshnessDecayFactor);
  const accessRecencyScore = recencyScore((now - lastAccessedAt) / millisecondsPerDay, accessRecencyDecayFactor);
  const accessCountScore = clamp01((candidate.accessCount ?? 0) / 20);
  const accessScore = clamp01(accessCountScore * 0.55 + accessRecencyScore * 0.45);
  const salienceScore = clamp01(
    candidate.salienceScore ??
      estimateSalienceScore({
        title: candidate.title,
        content: candidate.content,
        store: candidate.store,
        category: candidate.category,
        tags: candidate.tags ?? [],
      })
  );
  const normalizedChannel = normalizeText(options.channel);
  const continuityScore =
    normalizedChannel.length > 0 && normalizeText(candidate.channel) === normalizedChannel ? 1 : 0;
  const textMatchScore = clamp01(
    candidate.textMatchScore ?? deriveTextMatchScore(options.query ?? "", candidate.title, candidate.content, candidate.tags)
  );
  const vectorScore = clamp01(candidate.vectorScore ?? 0);
  const strengthScore = clamp01(candidate.strength ?? 0);
  const knowledgeBaseScore = candidate.knowledgeBaseId ? 1 : 0;

  const scoreValue =
    vectorScore * weights.vectorWeight +
    strengthScore * weights.strengthWeight +
    freshnessScore * weights.freshnessWeight +
    accessScore * weights.accessWeight +
    salienceScore * weights.salienceWeight +
    continuityScore * weights.continuityWeight +
    textMatchScore * weights.textMatchWeight +
    knowledgeBaseScore * (weights.knowledgeBaseWeight ?? 0);

  return {
    ...candidate,
    scoreValue,
    rankingSignals: {
      vectorScore,
      strengthScore,
      freshnessScore,
      accessScore,
      salienceScore,
      continuityScore,
      textMatchScore,
      knowledgeBaseScore,
    },
  };
};

export const rankRecallCandidates = <T extends RecallRankingCandidate>(
  candidates: T[],
  options: RecallRankingOptions = {}
): Array<RankedRecallCandidate<T>> => {
  const dedupedBySignature = new Map<string, RankedRecallCandidate<T>>();

  for (const candidate of candidates) {
    const ranked = scoreRecallCandidate(candidate, options);
    const dedupeKey = memoryDedupKey(candidate);
    const existing = dedupedBySignature.get(dedupeKey);
    if (!existing || ranked.scoreValue > existing.scoreValue) {
      dedupedBySignature.set(dedupeKey, ranked);
    }
  }

  return Array.from(dedupedBySignature.values()).sort((a, b) => {
    return b.scoreValue - a.scoreValue || b.rankingSignals.textMatchScore - a.rankingSignals.textMatchScore;
  });
};
