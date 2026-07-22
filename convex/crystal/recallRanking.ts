const millisecondsPerDay = 24 * 60 * 60 * 1000;
const freshnessDecayFactor = 0.12;
const accessRecencyDecayFactor = 0.08;

export type RecallRankingCandidate = {
  memoryId: string;
  title: string;
  content: string;
  // Optional untouched full text used solely for dedup identity. Callers that
  // inject a compacted recallText into `content` for display/ranking pass the
  // original content here so two distinct memories with colliding telegraphic
  // recallText but different full content are not wrongly deduped. Falls back
  // to `content` when absent.
  dedupeText?: string;
  store: string;
  category: string;
  tags: string[];
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  // ILL-79 — per-agent KB priority multiplier resolved by the caller (see
  // resolveKnowledgeBaseAgentPriority). Only meaningful for KB candidates.
  kbAgentPriority?: number;
  sourceRole?: SourceRole;
  sourceRoleSource?: SourceRoleSource;
  projectId?: string;
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
  sourceRoleWeight?: number;
  projectWeight?: number;
  personalWeight?: number;
};

export type RecallRankingOptions = {
  now?: number;
  query?: string;
  channel?: string;
  recallIntent?: RecallIntent;
  projectId?: string;
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
    kbAgentPriority: number;
    sourceRoleScore: number;
    projectScore: number;
    personalScore: number;
    exactLexicalMatchBoost: number;
    ordinalFrameworkMatchBoost: number;
    frameworkAnswerMatchBoost: number;
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
  sourceRoleWeight: 0.32,
  projectWeight: 0.18,
  // Boost the user's own memories (no knowledgeBaseId) for general "what do I
  // know about X" recall, counterbalancing the knowledgeBaseScore (0.25) +
  // canonical_reference sourceRole (0.72*0.32) advantage that large imported
  // reference corpora otherwise get — so a terse personal fact edges out a KB
  // doc at comparable vector relevance, while a high-vector KB match still wins.
  // Scoped to the general intent so framework/voice/project/client recalls still
  // favor their KBs.
  personalWeight: 0.4,
};

export const sourceRoles = [
  "canonical_reference",
  "client_context",
  "voice_style",
  "persona_guardrail",
  "message_history",
  "project_context",
  "user_preference",
  "unknown",
] as const;

export type SourceRole = (typeof sourceRoles)[number];
export type SourceRoleSource = "metadata" | "heuristic" | "default";
export type RecallIntent =
  | "factual_framework"
  | "voice_style"
  | "message_history"
  | "coding_project"
  | "client_specific"
  | "general";

const sourceRoleSet = new Set<string>(sourceRoles);

export const normalizeSourceRole = (value: unknown): SourceRole | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return sourceRoleSet.has(normalized) ? (normalized as SourceRole) : undefined;
};

const extractKnowledgeBaseText = (input: { name?: string; tags?: string[] } | string | undefined) => {
  if (typeof input === "string") return input;
  if (!input) return "";
  return `${input.name ?? ""} ${(input.tags ?? []).join(" ")}`;
};

export const inferSourceRoleFromKnowledgeBase = (
  input: { name?: string; tags?: string[] } | string | undefined,
): SourceRole => {
  const text = normalizeWhitespace(extractKnowledgeBaseText(input));
  if (!text) return "unknown";
  if (/(cass dm voice|cass voice|dm voice|voice guide|voice style|tone guide)/.test(text)) {
    return "voice_style";
  }
  if (/(cass persona|persona|guardrail|system prompt|identity guide)/.test(text)) {
    return "persona_guardrail";
  }
  if (/(client notes|client context|client profile|case notes|peer notes)/.test(text)) {
    return "client_context";
  }
  if (/(message history|conversation log|chat transcript|raw messages)/.test(text)) {
    return "message_history";
  }
  if (/(project context|repo context|repository|codebase|codex|claude code)/.test(text)) {
    return "project_context";
  }
  if (/(user preference|preferences|working agreements|operator preferences)/.test(text)) {
    return "user_preference";
  }
  if (
    /(disrupting divorce|marriage reset|podcast library|lookup index|social posts|zoom calls|course|curriculum|framework|playbook|reference|knowledge base|kb)/.test(
      text,
    )
  ) {
    return "canonical_reference";
  }
  return "unknown";
};

export const resolveCandidateSourceRole = (
  candidate: Pick<RecallRankingCandidate, "sourceRole" | "knowledgeBaseName" | "tags" | "knowledgeBaseId">,
): { sourceRole: SourceRole; sourceRoleSource: SourceRoleSource } => {
  const explicit = normalizeSourceRole(candidate.sourceRole);
  if (explicit) return { sourceRole: explicit, sourceRoleSource: "metadata" };
  if (candidate.knowledgeBaseId || candidate.knowledgeBaseName) {
    return {
      sourceRole: inferSourceRoleFromKnowledgeBase({
        name: candidate.knowledgeBaseName,
        tags: candidate.tags ?? [],
      }),
      sourceRoleSource: "heuristic",
    };
  }
  return { sourceRole: "unknown", sourceRoleSource: "default" };
};

export const classifyRecallIntent = (
  query: string,
  options: { channel?: string; projectId?: string } = {},
): RecallIntent => {
  const text = normalizeWhitespace(query);
  const channel = normalizeWhitespace(options.channel);
  if (options.projectId || /^(codex|claude|cursor|windsurf|vscode|repo|project)(:|$)/.test(channel)) {
    if (/\b(repo|repository|code|codebase|typescript|python|bug|test|build|deploy|branch|commit|pr|pull request)\b/.test(text)) {
      return "coding_project";
    }
  }
  if (/\b(voice|tone|sound like|say this|rewrite|dm voice|cass say|style)\b/.test(text)) {
    return "voice_style";
  }
  if (/\b(last time|previously|earlier|conversation|message|chat|transcript|what did i say|what did we say)\b/.test(text)) {
    return "message_history";
  }
  if (/\b(my|me|wife|husband|client|coach|coaching|situation|case|marriage)\b/.test(text) && /\b(what should i|what did|where am i|next step|profile|notes)\b/.test(text)) {
    return "client_specific";
  }
  if (
    /\b(what is|what's|define|definition|framework|ladder|rung|step|stage|course|curriculum|how do i get there|how to get there|3rd|third|2nd|second|1st|first)\b/.test(
      text,
    )
  ) {
    return "factual_framework";
  }
  return "general";
};

export const sourceRoleScoreForIntent = (sourceRole: SourceRole, intent: RecallIntent): number => {
  const role = normalizeSourceRole(sourceRole) ?? "unknown";
  const matrix: Record<RecallIntent, Record<SourceRole, number>> = {
    factual_framework: {
      canonical_reference: 1,
      unknown: 0.42,
      project_context: 0.32,
      user_preference: 0.2,
      client_context: 0.05,
      message_history: -0.12,
      persona_guardrail: -0.45,
      voice_style: -0.6,
    },
    voice_style: {
      voice_style: 1,
      persona_guardrail: 0.66,
      user_preference: 0.45,
      canonical_reference: 0.28,
      client_context: 0.18,
      message_history: 0.18,
      project_context: 0.12,
      unknown: 0.2,
    },
    message_history: {
      message_history: 1,
      client_context: 0.74,
      user_preference: 0.42,
      canonical_reference: 0.22,
      project_context: 0.2,
      unknown: 0.2,
      persona_guardrail: 0.1,
      voice_style: 0.08,
    },
    coding_project: {
      project_context: 1,
      user_preference: 0.48,
      message_history: 0.34,
      unknown: 0.3,
      canonical_reference: 0.24,
      client_context: 0.12,
      persona_guardrail: 0.08,
      voice_style: 0.06,
    },
    client_specific: {
      client_context: 1,
      message_history: 0.76,
      canonical_reference: 0.62,
      user_preference: 0.34,
      unknown: 0.28,
      persona_guardrail: 0.18,
      voice_style: 0.14,
      project_context: 0.1,
    },
    general: {
      canonical_reference: 0.72,
      client_context: 0.58,
      project_context: 0.54,
      user_preference: 0.48,
      message_history: 0.4,
      unknown: 0.38,
      persona_guardrail: 0.24,
      voice_style: 0.22,
    },
  };
  return matrix[intent][role] ?? matrix[intent].unknown;
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
  normalizeOrdinalTokens(normalizeText(query))
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

const normalizeOrdinalTokens = (value: string) =>
  value
    .replace(/\b1st\b/g, "first")
    .replace(/\b2nd\b/g, "second")
    .replace(/\b3rd\b/g, "third")
    .replace(/\b4th\b/g, "fourth")
    .replace(/\b5th\b/g, "fifth")
    .replace(/\b6th\b/g, "sixth")
    .replace(/\b7th\b/g, "seventh")
    .replace(/\b8th\b/g, "eighth")
    .replace(/\b9th\b/g, "ninth")
    .replace(/\b10th\b/g, "tenth");

const hasExactTokenPhrase = (haystackTokens: string[], queryTokens: string[]) => {
  if (queryTokens.length === 0 || haystackTokens.length < queryTokens.length) {
    return false;
  }

  for (let index = 0; index <= haystackTokens.length - queryTokens.length; index += 1) {
    const matchesAtIndex = queryTokens.every((token, offset) => haystackTokens[index + offset] === token);
    if (matchesAtIndex) {
      return true;
    }
  }

  return false;
};

const extractOrdinalRung = (text: string): string | undefined => {
  const normalized = normalizeOrdinalTokens(normalizeWhitespace(text));
  const match = normalized.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+rung\b/);
  return match?.[1];
};

const hasFrameworkAnswerSignal = (
  candidate: Pick<RecallRankingCandidate, "title" | "content" | "knowledgeBaseId">,
  options: {
    query?: string;
    recallIntent: RecallIntent;
    sourceRole: SourceRole;
    textMatchScore: number;
    queryOrdinalRung?: string;
    candidateOrdinalRung?: string;
  },
) => {
  if (options.recallIntent !== "factual_framework" || !candidate.knowledgeBaseId) {
    return false;
  }
  if (!["canonical_reference", "voice_style", "unknown"].includes(options.sourceRole)) {
    return false;
  }
  if (options.queryOrdinalRung && options.candidateOrdinalRung === options.queryOrdinalRung) {
    return true;
  }

  const queryText = normalizeWhitespace(options.query);
  const text = candidateText(candidate);
  const namedFrameworkPhrases = [
    "rejection ladder",
    "covert contract",
    "covert contracts",
    "race car",
    "nice guy",
    "type 1",
    "type 2",
    "type 3",
  ];
  const queriedFrameworkPhrases = namedFrameworkPhrases.filter((phrase) => queryText.includes(phrase));
  const namesQueriedFramework =
    queriedFrameworkPhrases.length > 0 &&
    queriedFrameworkPhrases.some((phrase) => text.includes(phrase));
  const queryNamesFramework =
    /\b(rejection ladder|covert contract|covert contracts|race car|rung|ladder|framework|course|curriculum|stage|step)\b/.test(queryText);
  const candidateLooksLikeFramework =
    /\b(framework index|framework|doctrine|playbook|curriculum|course|rung|rungs|step|stage)\b/.test(text);

  if (queriedFrameworkPhrases.length > 0) {
    return namesQueriedFramework && candidateLooksLikeFramework && options.textMatchScore >= 0.25;
  }

  return queryNamesFramework && candidateLooksLikeFramework && options.textMatchScore >= 0.65;
};

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

  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return 0;
  }

  const haystackTokenList = tokenizeQuery(haystack);
  const haystackTokens = new Set(haystackTokenList);
  const exactMatch = hasExactTokenPhrase(haystackTokenList, tokens) ? 1 : 0;
  const uniqueMatches = new Set(tokens.filter((token) => haystackTokens.has(token))).size;
  const tokenCoverage = uniqueMatches / tokens.length;
  const ordinalRung = extractOrdinalRung(query);
  const ordinalRungMatch =
    ordinalRung && new RegExp(`\\b(?:the\\s+)?${ordinalRung}\\s+rung\\b`).test(normalizeOrdinalTokens(haystack))
      ? 0.98
      : 0;
  return clamp01(Math.max(exactMatch, ordinalRungMatch, tokenCoverage));
};

export const memoryDedupKey = (candidate: Pick<RecallRankingCandidate, "title" | "content" | "dedupeText">) => {
  const title = normalizeWhitespace(candidate.title);
  // Prefer the untouched dedupeText when present so a compacted recallText
  // injected into `content` for display/ranking cannot collapse two distinct
  // memories whose full content differs.
  const content = normalizeWhitespace(candidate.dedupeText ?? candidate.content);
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
  const derivedTextMatchScore = deriveTextMatchScore(options.query ?? "", candidate.title, candidate.content, candidate.tags);
  const textMatchScore = clamp01(Math.max(candidate.textMatchScore ?? 0, derivedTextMatchScore));
  const exactLexicalMatchBoost = derivedTextMatchScore === 1 ? 0.9 : 0;
  const vectorScore = clamp01(candidate.vectorScore ?? 0);
  const strengthScore = clamp01(candidate.strength ?? 0);
  // ILL-79 — per-agent KB priority multiplier ([0.05, 1], default 1). Resolved
  // by the caller against the SAME effective agentId as the visibility gate;
  // scales the KB membership signal so a down-weighted corpus contributes less
  // to ambient ranking without ever being hidden. Non-KB candidates unaffected.
  const kbAgentPriority = candidate.knowledgeBaseId
    ? Math.min(Math.max(candidate.kbAgentPriority ?? 1, 0.05), 1)
    : 1;
  const knowledgeBaseScore = (candidate.knowledgeBaseId ? 1 : 0) * kbAgentPriority;
  const recallIntent =
    options.recallIntent ?? classifyRecallIntent(options.query ?? "", {
      channel: options.channel,
      projectId: options.projectId,
    });
  const { sourceRole, sourceRoleSource } = resolveCandidateSourceRole(candidate);
  const queryOrdinalRung = extractOrdinalRung(options.query ?? "");
  const candidateOrdinalRung = extractOrdinalRung(`${candidate.title} ${candidate.content}`);
  const frameworkAnswerMatch = hasFrameworkAnswerSignal(candidate, {
    query: options.query,
    recallIntent,
    sourceRole,
    textMatchScore,
    queryOrdinalRung,
    candidateOrdinalRung,
  });
  const baseSourceRoleScore = sourceRoleScoreForIntent(sourceRole, recallIntent);
  const sourceRoleScore = frameworkAnswerMatch
    ? Math.max(baseSourceRoleScore, sourceRole === "canonical_reference" ? 1 : 0.86)
    : baseSourceRoleScore;
  const exactFrameworkMatchBoost =
    recallIntent === "factual_framework" &&
    (sourceRole === "canonical_reference" || frameworkAnswerMatch) &&
    textMatchScore >= 0.95
      ? 0.24
      : 0;
  const ordinalFrameworkMatchBoost =
    recallIntent === "factual_framework" &&
    queryOrdinalRung !== undefined &&
    candidateOrdinalRung === queryOrdinalRung
      ? sourceRole === "canonical_reference" || frameworkAnswerMatch
        ? 0.18
        : 0.08
      : 0;
  const frameworkAnswerMatchBoost = frameworkAnswerMatch
    ? sourceRole === "canonical_reference"
      ? 0.1
      : 0.22
    : 0;
  const normalizedProjectId = normalizeText(options.projectId);
  const projectScore =
    normalizedProjectId && normalizeText(candidate.projectId) === normalizedProjectId
      ? 1
      : normalizedProjectId && sourceRole === "project_context"
        ? 0.35
        : 0;

  // DISABLED 2026-07-02 (cross-tenant recall leak incident): this boost surfaced
  // non-KB conversation memories to the top of general recall, which on a
  // multi-tenant/peer account (e.g. the coach) prominently exposed cross-channel
  // private content. Kept at 0 until channel isolation for non-KB memories is
  // hardened so scoped/unscoped recall cannot cross channels. Do NOT re-enable
  // the boost before that fix lands.
  const personalScore = 0;

  const scoreValue =
    vectorScore * weights.vectorWeight +
    strengthScore * weights.strengthWeight +
    freshnessScore * weights.freshnessWeight +
    accessScore * weights.accessWeight +
    salienceScore * weights.salienceWeight +
    continuityScore * weights.continuityWeight +
    textMatchScore * weights.textMatchWeight +
    knowledgeBaseScore * (weights.knowledgeBaseWeight ?? 0) +
    sourceRoleScore * (weights.sourceRoleWeight ?? 0) +
    projectScore * (weights.projectWeight ?? 0) +
    personalScore * (weights.personalWeight ?? 0) +
    exactFrameworkMatchBoost +
    ordinalFrameworkMatchBoost +
    frameworkAnswerMatchBoost +
    exactLexicalMatchBoost;

  return {
    ...candidate,
    sourceRole,
    sourceRoleSource: candidate.sourceRoleSource ?? sourceRoleSource,
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
      kbAgentPriority,
      sourceRoleScore,
      projectScore,
      personalScore,
      exactLexicalMatchBoost,
      ordinalFrameworkMatchBoost,
      frameworkAnswerMatchBoost,
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
