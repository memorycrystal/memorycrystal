const millisecondsPerDay = 24 * 60 * 60 * 1000;
const freshnessDecayFactor = 0.12;
const accessRecencyDecayFactor = 0.08;
import { analyzeQuery, scoreQueryMatch } from "./recallEngine/queryAnalysis";

export type RecallRankingCandidate = {
  memoryId: string;
  title: string;
  content: string;
  /** Full surviving text used only for query and topic scoring; stripped before response. */
  topicText?: string;
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
  /** Set by the memory visibility path when the candidate shares the request project. */
  sameProject?: boolean;
  /** When set, replaces the legacy project/channel scope adjustment for this candidate. */
  scopeAdjustmentOverride?: number;
  vectorScore?: number;
  textMatchScore?: number;
  identifierMatchScore?: number;
  identifierMatch?: boolean;
  requestedPrTicketMatch?: boolean;
  decisiveIdentifierMatch?: boolean;
  exactPhraseMatch?: boolean;
  // ILL-104 — provenance travels with the candidate so recall output builders
  // can surface age/source/supersession. Optional; ranking ignores them.
  source?: string;
  supersededByMemoryId?: string;
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
  // ILL-105 (A) — ids of candidates that are the older/lower-confidence side of
  // an unresolved contradiction; their final score is faded (bounded) so the
  // newer/higher-confidence side ranks above them. No recall path passes this
  // since ILL-305 (the pre-engine recallMemories passed an always-empty set).
  contradictedOlderSideIds?: Set<string>;
  // ILL-105 (A) — a caller's score floor. When set, the fade never pushes a
  // candidate that clears the floor unaided below it (it is clamped to the
  // floor instead), so the fade demotes without ever excluding. No recall path
  // passes this since ILL-305.
  scoreFloor?: number;
  /** Keeps the standalone KB scorer pinned while recall adopts R3 signals. */
  scoringMode?: "legacy" | "recall-v2";
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
    identifierMatchScore: number;
    identifierMatch: boolean;
    requestedPrTicketMatch: boolean;
    decisiveIdentifierMatch: boolean;
    exactPhraseMatch: boolean;
    knowledgeBaseScore: number;
    kbAgentPriority: number;
    sourceRoleScore: number;
    projectScore: number;
    personalScore: number;
    exactLexicalMatchBoost: number;
    ordinalFrameworkMatchBoost: number;
    frameworkAnswerMatchBoost: number;
    contradictionFade: number;
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

// ILL-105 (A) — bounded fade applied to the older/lower-confidence side of an
// unresolved contradiction. 0.7 = a ~30% score cut: enough to demote the stale
// claim below its fresher counterpart at comparable relevance, but it never
// excludes the memory (still surfaced with the ILL-104 contradiction flag).
export const CONTRADICTION_FADE_MULTIPLIER = 0.7;

// The pre-ILL-305 recallMemories score floor: that action dropped candidates
// with scoreValue below this. Since ILL-305 recallMemories ranks through the
// shared engine (as mcpRecall does) and no recall path applies a score floor;
// relevance is gated by DROP_MEMORY_RELEVANCE below. Kept for the scoreFloor
// option, which lets a caller make the contradiction fade floor-aware: fading
// must demote, never exclude (ILL-105).
export const RECALL_SCORE_FLOOR = 0.25;

// ILL-245: relevance thresholds for weak-hit honesty. A memory's relevance is
// the topical signal (vectorScore primarily, plus textMatchScore contribution),
// distinct from its final composite score. Weak memories pad noise; drop them.
export const DROP_MEMORY_RELEVANCE = 0.35;
export const WEAK_MEMORY_RELEVANCE = 0.50;
export const PERSONAL_KEEP_RELEVANCE = 0.45;
export const PROMOTION_MESSAGE_SCORE = 0.70;

// ILL-105 (B) — a small, documented set of "current-intent" query tokens. When a
// query asks for the *current* state, recency should dominate. The pre-ILL-305
// recallMemories widened the freshness weight for such queries; since ILL-305 no
// recall path does. Recall v2 R3 (ILL-306 §6) reuses this pattern for recency
// intent. Kept deliberately conservative to avoid false positives.
// Deliberately CONSERVATIVE: only phrases that unambiguously ask for the present
// state. Ambiguous everyday words ("now", "today", "still", "latest", "most
// recent") are excluded because they false-positive on general questions and
// would over-weight recency there — regressing general recall (ILL-105 AC-5).
const CURRENT_INTENT_PATTERN =
  /\b(current|currently|right now|as of now|at the moment|these days|nowadays|up to date|up-to-date)\b/i;

/** True when the query signals it wants the current/latest state of something. */
export const hasCurrentIntent = (query: string | undefined): boolean =>
  typeof query === "string" && CURRENT_INTENT_PATTERN.test(query);

const RECENCY_INTENT_PATTERN = /\b(latest|most recent|newest)\b/i;
const PAST_REFERENCE_PATTERN = /\b(last time|originally|initially|previous(?:ly)?|at first|first time|used to)\b/i;

export const hasRecencyIntent = (query: string | undefined): boolean =>
  typeof query === "string" && (hasCurrentIntent(query) || RECENCY_INTENT_PATTERN.test(query));

export const hasPastReferenceIntent = (query: string | undefined): boolean =>
  typeof query === "string" && PAST_REFERENCE_PATTERN.test(query);

// The multiplier the pre-ILL-305 recallMemories applied to freshnessWeight on a
// current-intent query, and the ceiling it was clamped to so it could not swamp
// the other signals. No recall path applies them since ILL-305.
export const CURRENT_INTENT_FRESHNESS_BOOST = 2.2;
export const CURRENT_INTENT_FRESHNESS_CEIL = 0.45;

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
  | "personal_attribute"
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
  options: { channel?: string; projectId?: string; knownPersonNames?: readonly string[] } = {},
): RecallIntent => {
  const text = normalizeWhitespace(query);
  const channel = normalizeWhitespace(options.channel);
  
  // ILL-245: personal_attribute intent evaluated BEFORE factual_framework.
  // Matches personal physical/biographical attributes: height, weight, age,
  // birthday, BMR, and "on file" queries that imply personal data lookup.
  // Must NOT match technical terms in coding contexts (CSS height, refactor weight).
  const hasAttributeKeyword = /\b(height|weight|age|old|birthday|birth ?date|bmr|basal metabolic rate)\b/i.test(text);
  const hasOnFileKeyword = /\bon file\b/i.test(text);
  const questionWords = new Set(["what", "which", "who", "whom", "when", "where", "why", "how", "does", "did", "can", "could", "is", "are", "do", "have", "tell", "the", "my"]);
  const hasNamedEntity = (query.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
    .some((name) => !questionWords.has(name.toLowerCase()));
  const hasKnownPerson = (options.knownPersonNames ?? [])
    .some((name) => name.trim().length > 0 && includesWholeWord(text, name.trim()));
  const hasPersonalContext = /\b(my|me|i|user|person|client|his|her|their|we|do|email|phone|number|address|bmr)\b/i.test(text) ||
    hasNamedEntity || hasKnownPerson;
  const hasTechnicalExclusion = /\b(css|style|refactor|mountain|limit|luggage|code|repository|deploy|deployment|service|app|system|database|software|server|model)\b/i.test(text);
  
  // "on file" queries are personal_attribute even without explicit names
  if (hasOnFileKeyword && !hasTechnicalExclusion) {
    return "personal_attribute";
  }
  
  if (hasAttributeKeyword && hasPersonalContext && !hasTechnicalExclusion) {
    return "personal_attribute";
  }

  if (options.projectId || /^(codex|claude|cursor|windsurf|vscode|repo|project)(:|$)/.test(channel)) {
    if (/\b(set|css|style|repo|repository|code|codebase|typescript|python|bug|test|build|deploy|branch|commit|pr|pull request)\b/.test(text)) {
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
    personal_attribute: {
      unknown: 0.88,
      client_context: 0.76,
      user_preference: 0.68,
      message_history: 0.58,
      canonical_reference: 0.32,
      project_context: 0.18,
      persona_guardrail: 0.08,
      voice_style: 0.05,
    },
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

// ILL-245: compute topical relevance (0-1) distinct from the composite score.
// Relevance captures "does this memory answer the query" — primarily vector
// similarity, with lexical text match as a secondary signal. Used for weak-hit
// honesty filtering: a memory with high strength + salience but low relevance
// is a distractor, not a helpful answer. The threshold varies by intent.
export const computeRelevance = (
  vectorScore: number,
  textMatchScore: number,
  weights = { vectorWeight: 0.75, textMatchWeight: 0.25 }
): number => {
  // If either signal is strong (>= 0.85), consider it relevant regardless
  // of the other signal. This handles exact lexical matches (high text, low
  // vector) and pure semantic matches (high vector, low text).
  if (vectorScore >= 0.85 || textMatchScore >= 0.85) {
    return Math.max(vectorScore, textMatchScore);
  }
  
  return clamp01(
    vectorScore * weights.vectorWeight +
    textMatchScore * weights.textMatchWeight
  );
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

/**
 * Greedy lexical-diversity pick over ranked candidates. Pure helper: the
 * pre-ILL-305 recallMemories applied it before its final slice; since ILL-305
 * no recall path calls it.
 */
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
  const queryMatch = options.scoringMode === "recall-v2"
    ? scoreQueryMatch(analyzeQuery(options.query ?? ""), candidate.title, candidate.content, candidate.tags)
    : null;
  const derivedTextMatchScore = options.scoringMode === "recall-v2"
    ? queryMatch?.lexicalScore ?? 0
    : deriveTextMatchScore(options.query ?? "", candidate.title, candidate.content, candidate.tags);
  const textMatchScore = clamp01(Math.max(candidate.textMatchScore ?? 0, derivedTextMatchScore));
  const identifierMatchScore = clamp01(Math.max(candidate.identifierMatchScore ?? 0, queryMatch?.identifierScore ?? 0));
  const identifierMatch = Boolean(candidate.identifierMatch || queryMatch?.identifierMatch);
  const requestedPrTicketMatch = Boolean(candidate.requestedPrTicketMatch || queryMatch?.requestedPrTicketMatch);
  const decisiveIdentifierMatch = Boolean(candidate.decisiveIdentifierMatch || queryMatch?.decisiveIdentifierMatch);
  const exactPhraseMatch = Boolean(candidate.exactPhraseMatch || queryMatch?.exactPhraseMatch);
  const exactLexicalMatchBoost = options.scoringMode === "recall-v2" ? 0 : derivedTextMatchScore === 1 ? 0.9 : 0;
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

  const baseScoreValue =
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

  // ILL-105 (A) — reverse-fade the older / lower-confidence side of an
  // UNRESOLVED contradiction so a stale claim steps back until a human resolves
  // it. Bounded (never zero): the faded memory still appears, just lower, and
  // the contradiction is still surfaced (ILL-104 flag) so the model sees both.
  const contradictionFade =
    options.contradictedOlderSideIds && options.contradictedOlderSideIds.has(candidate.memoryId)
      ? CONTRADICTION_FADE_MULTIPLIER
      : 1;
  const fadedScore = baseScoreValue * contradictionFade;
  // Never exclude: if the candidate cleared the recall floor on its own merits,
  // a fade that would drop it below the floor is clamped to the floor — it still
  // appears, just below every un-faded candidate (whose score is strictly above).
  const scoreValue =
    options.scoreFloor !== undefined && baseScoreValue >= options.scoreFloor && fadedScore < options.scoreFloor
      ? options.scoreFloor
      : fadedScore;

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
      identifierMatchScore,
      identifierMatch,
      requestedPrTicketMatch,
      decisiveIdentifierMatch,
      exactPhraseMatch,
      knowledgeBaseScore,
      kbAgentPriority,
      sourceRoleScore,
      projectScore,
      personalScore,
      exactLexicalMatchBoost,
      ordinalFrameworkMatchBoost,
      frameworkAnswerMatchBoost,
      contradictionFade,
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

  const allRanked = Array.from(dedupedBySignature.values()).sort((a, b) => {
    return b.scoreValue - a.scoreValue || b.rankingSignals.textMatchScore - a.rankingSignals.textMatchScore;
  });

  // ILL-245 weak-hit honesty: filter memories below relevance threshold. A
  // memory with strong metadata (salience, freshness) but weak topical relevance
  // is a distractor. The threshold varies by intent: personal_attribute requires
  // higher topicality (0.45), general recall accepts broader context (0.35).
  const recallIntent = options.recallIntent ?? classifyRecallIntent(options.query ?? "", {
    channel: options.channel,
    projectId: options.projectId,
  });
  const relevanceFloor = recallIntent === "personal_attribute"
    ? PERSONAL_KEEP_RELEVANCE
    : DROP_MEMORY_RELEVANCE;

  const filtered = allRanked.filter((ranked) => {
    const relevance = computeRelevance(
      ranked.rankingSignals.vectorScore,
      ranked.rankingSignals.textMatchScore
    );
    return relevance >= relevanceFloor;
  });

  return filtered;
};

/** Calibration values measured and committed against goldset-v2 calibration only. */
export const RECALL_V2_CALIBRATION = {
  version: "ILL-306-r4",
  split: "calibration",
  vectorWeight: 0.70,
  lexicalWeight: 0.30,
  identifierMatchBoost: 0.08,
  decisiveIdentifierBoost: 0.40,
  kbAgentPriorityWeight: 0.02,
  relevanceFloor: 0.10,
  strongThreshold: 0.45,
  strongLexicalMinimum: 0.40,
  strongVectorMinimum: 0.35,
  injectRankThreshold: 0.62,
  injectScoreThreshold: 0.35,
  lowContentWeakMaximum: 0.11,
} as const;

export type RecallV2RankingOptions = {
  now?: number;
  query: string;
  /** Requested result count; same-topic work is bounded to twice this many. */
  limit?: number;
  channel?: string;
  projectId?: string;
  recallIntent?: RecallIntent;
  mode?: string;
  knownPersonNames?: readonly string[];
};

export type RecallV2RankedCandidate<T extends RecallRankingCandidate = RecallRankingCandidate> = T & {
  scoreValue: number;
  relevance: number;
  rankScore: number;
  adjustment: number;
  possiblyOutdatedBy?: string;
  rankingSignals: {
    vectorScore: number;
    textMatchScore: number;
    identifierMatchScore: number;
    identifierMatch: boolean;
    identifierBoost: number;
    kbAgentPriority: number;
    knowledgeBaseAdjustment: number;
    requestedPrTicketMatch: boolean;
    decisiveIdentifierMatch: boolean;
    exactPhraseMatch: boolean;
    strengthAdjustment: number;
    salienceAdjustment: number;
    sourceRoleAdjustment: number;
    accessAdjustment: number;
    freshnessAdjustment: number;
    scopeAdjustment: number;
    modeAdjustment: number;
    sameTopicAdjustment: number;
    lowContentDistilled: boolean;
  };
};

type V2Scored<T extends RecallRankingCandidate> = RecallV2RankedCandidate<T>;

function lowContentDistilled(candidate: RecallRankingCandidate): boolean {
  if (candidate.source !== "inference") return false;
  if (!(candidate.tags ?? []).some((tag) => /^(distilled|reflection)$/i.test(tag))) return false;
  const words = (candidate.topicText ?? candidate.content).trim().split(/\s+/).filter(Boolean);
  return words.length < 15;
}

function relevantBigramSet(text: string): Set<string> {
  const tokens = normalizeText(text).split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length < 2) return new Set();
  return new Set(tokens.slice(1).map((token, index) => `${tokens[index]} ${token}`));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

type TopicBigrams = { title: Set<string>; text: Set<string> };

function sameTopic(a: TopicBigrams, b: TopicBigrams): boolean {
  return jaccard(a.title, b.title) >= 0.6 || jaccard(a.text, b.text) >= 0.5;
}

function clampAdjustment(value: number): number {
  return Math.max(-0.05, Math.min(0.05, Number.isFinite(value) ? value : 0));
}

export function mapRecallRankScoreToClientScore(rankScore: number): number {
  const { injectRankThreshold, injectScoreThreshold } = RECALL_V2_CALIBRATION;
  const bounded = Math.max(-0.05, Math.min(1.05, Number.isFinite(rankScore) ? rankScore : -0.05));
  const mapped = bounded <= injectRankThreshold
    ? ((bounded + 0.05) / (injectRankThreshold + 0.05)) * injectScoreThreshold
    : injectScoreThreshold + ((bounded - injectRankThreshold) / (1.05 - injectRankThreshold)) * (1 - injectScoreThreshold);
  return clamp01(mapped);
}

/**
 * Recall v2's only memory-ordering pass. The index/vector lanes return raw
 * candidates; this function computes relevance, applies bounded preferences,
 * then sorts once by rankScore.
 */
export function rankRecallV2Candidates<T extends RecallRankingCandidate>(
  candidates: readonly T[],
  options: RecallV2RankingOptions,
): Array<RecallV2RankedCandidate<T>> {
  const now = options.now ?? Date.now();
  const analyzed = analyzeQuery(options.query);
  const intent = options.recallIntent ?? classifyRecallIntent(options.query, {
    channel: options.channel,
    projectId: options.projectId,
  });
  const recencyIntent = hasRecencyIntent(options.query);
  const pastReference = hasPastReferenceIntent(options.query);
  const eligibleCandidates = candidates.filter((candidate) =>
    !(options.mode === "preflight" && candidate.source === "inference" &&
      (candidate.store === "episodic" || candidate.category === "decision")),
  );
  const scored: V2Scored<T>[] = [];
  for (const candidate of eligibleCandidates) {
    const queryMatch = scoreQueryMatch(analyzed, candidate.title, candidate.topicText ?? candidate.content, candidate.tags);
    const vectorScore = clamp01(candidate.vectorScore ?? 0);
    const textMatchScore = clamp01(Math.max(candidate.textMatchScore ?? 0, queryMatch.lexicalScore));
    const identifierMatchScore = clamp01(Math.max(candidate.identifierMatchScore ?? 0, queryMatch.identifierScore));
    const identifierMatch = Boolean(candidate.identifierMatch || queryMatch.identifierMatch);
    const requestedPrTicketMatch = Boolean(candidate.requestedPrTicketMatch || queryMatch.requestedPrTicketMatch);
    const decisiveIdentifierMatch = Boolean(candidate.decisiveIdentifierMatch || queryMatch.decisiveIdentifierMatch);
    const identifierBoost = decisiveIdentifierMatch
      ? RECALL_V2_CALIBRATION.decisiveIdentifierBoost
      : identifierMatch ? RECALL_V2_CALIBRATION.identifierMatchBoost : 0;
    const kbAgentPriority = Math.min(1, Math.max(0.05, candidate.kbAgentPriority ?? 1));
    const knowledgeBaseAdjustment = candidate.knowledgeBaseId
      ? kbAgentPriority * RECALL_V2_CALIBRATION.kbAgentPriorityWeight
      : 0;
    const exactPhraseMatch = Boolean(candidate.exactPhraseMatch || queryMatch.exactPhraseMatch);
    const baseRelevance = vectorScore * RECALL_V2_CALIBRATION.vectorWeight +
      textMatchScore * RECALL_V2_CALIBRATION.lexicalWeight;
    let relevance = clamp01(baseRelevance + identifierBoost);
    const isLowContent = lowContentDistilled(candidate);
    if (isLowContent && !exactPhraseMatch) {
      relevance = Math.min(relevance, RECALL_V2_CALIBRATION.lowContentWeakMaximum);
    }
    if (relevance < RECALL_V2_CALIBRATION.relevanceFloor) continue;

    const strength = clamp01(candidate.strength ?? 0.5);
    const salience = clamp01(candidate.salienceScore ?? estimateSalienceScore({
      title: candidate.title,
      content: candidate.topicText ?? candidate.content,
      store: candidate.store,
      category: candidate.category,
      tags: candidate.tags,
    }));
    const accessCount = Math.min(100, Math.max(0, candidate.accessCount ?? 0));
    const source = resolveCandidateSourceRole(candidate).sourceRole;
    const sourceRoleScore = sourceRoleScoreForIntent(source, intent);
    const createdAt = Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : now;
    const freshness = Math.exp(-Math.LN2 * Math.max(0, now - createdAt) / (90 * millisecondsPerDay));
    const freshnessAdjustment = recencyIntent
      // Anchor recency to a fixed half-life so unrelated old candidates cannot
      // compress the difference between a newer/older same-topic pair.
      ? (Math.exp(-Math.LN2 * Math.max(0, now - createdAt) / (30 * millisecondsPerDay)) - 0.5) * 0.10
      : (freshness - 0.5) * 0.02;
    const strengthAdjustment = (strength - 0.5) * 0.01;
    const salienceAdjustment = (salience - 0.5) * 0.01;
    const sourceRoleAdjustment = (sourceRoleScore - 0.5) * 0.01;
    const accessAdjustment = (Math.log1p(accessCount) / Math.log(101)) * 0.02;
    const scopeAdjustment = typeof candidate.scopeAdjustmentOverride === "number"
      ? candidate.scopeAdjustmentOverride
      : (options.projectId && candidate.projectId === options.projectId ? 0.005 : 0) +
        (options.channel && normalizeText(candidate.channel) === normalizeText(options.channel) ? 0.005 : 0);
    let modeAdjustment = 0;
    if (options.mode === "decision") {
      if (candidate.category === "decision") modeAdjustment += 0.014;
      else if (["lesson", "rule"].includes(candidate.category)) modeAdjustment += 0.010;
      if (candidate.store === "procedural") modeAdjustment += 0.004;
    } else if (options.mode === "project") {
      if (["goal", "workflow", "skill", "decision", "fact"].includes(candidate.category)) modeAdjustment += 0.010;
    } else if (options.mode === "people") {
      if (candidate.category === "person") modeAdjustment += 0.015;
      else if (candidate.category === "fact") modeAdjustment += 0.010;
      else if (["decision", "event"].includes(candidate.category)) modeAdjustment += 0.004;
      const names = (options.knownPersonNames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
      if (names.some((name) => includesWholeWord(`${candidate.title} ${candidate.topicText ?? candidate.content}`, name))) {
        modeAdjustment = Math.min(0.02, modeAdjustment + 0.005);
      }
    } else if (options.mode === "preflight") {
      if (["rule", "lesson", "workflow", "skill"].includes(candidate.category)) modeAdjustment += 0.025;
      if (candidate.store === "procedural") modeAdjustment += 0.012;
      if (candidate.category === "decision" && candidate.source !== "inference") modeAdjustment += 0.004;
    } else if (options.mode === "workflow") {
      if (["workflow", "skill", "rule", "lesson"].includes(candidate.category)) modeAdjustment += 0.012;
      if (candidate.store === "procedural") modeAdjustment += 0.006;
    } else if (options.mode === "conversation") {
      if (["conversation", "event"].includes(candidate.category)) modeAdjustment += 0.010;
      if (["sensory", "episodic"].includes(candidate.store)) modeAdjustment += 0.004;
    }

    scored.push({
      ...candidate,
      scoreValue: 0,
      relevance,
      rankScore: relevance,
      adjustment: 0,
      rankingSignals: {
        vectorScore,
        textMatchScore,
        identifierMatchScore,
        identifierMatch,
        identifierBoost,
        kbAgentPriority,
        knowledgeBaseAdjustment,
        requestedPrTicketMatch,
        decisiveIdentifierMatch,
        exactPhraseMatch,
        strengthAdjustment,
        salienceAdjustment,
        sourceRoleAdjustment,
        accessAdjustment,
        freshnessAdjustment,
        scopeAdjustment,
        modeAdjustment,
        sameTopicAdjustment: 0,
        lowContentDistilled: isLowContent,
      },
    });
  }

  if (!pastReference) {
    const topicLimitPerLane = Math.max(1, options.limit ?? 20) * 2;
    const candidatesByLane = new Map<string, Array<{ candidate: V2Scored<T>; index: number }>>();
    scored.forEach((candidate, index) => {
      const lane = candidate.knowledgeBaseId ?? "";
      const laneCandidates = candidatesByLane.get(lane) ?? [];
      laneCandidates.push({ candidate, index });
      candidatesByLane.set(lane, laneCandidates);
    });
    const topicCandidatesByLane = [...candidatesByLane.values()].map((laneCandidates) =>
      laneCandidates
        .sort((left, right) => right.candidate.relevance - left.candidate.relevance ||
          left.candidate.memoryId.localeCompare(right.candidate.memoryId))
        .slice(0, topicLimitPerLane)
        .map(({ candidate, index }) => ({
          index,
          title: relevantBigramSet(candidate.title),
          text: relevantBigramSet(candidate.topicText ?? candidate.content),
        })),
    );
    const topicCandidates = topicCandidatesByLane.flat();
    const parent = scored.map((_, index) => index);
    const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
    const union = (left: number, right: number): void => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[b] = a;
    };
    for (const laneCandidates of topicCandidatesByLane) {
      for (let left = 0; left < laneCandidates.length; left += 1) {
        for (let right = left + 1; right < laneCandidates.length; right += 1) {
          if (sameTopic(laneCandidates[left], laneCandidates[right])) {
            union(laneCandidates[left].index, laneCandidates[right].index);
          }
        }
      }
    }
    const clusters = new Map<number, number[]>();
    for (const candidate of topicCandidates) {
      const root = find(candidate.index);
      const cluster = clusters.get(root) ?? [];
      cluster.push(candidate.index);
      clusters.set(root, cluster);
    }
    for (const indices of clusters.values()) {
      if (indices.length < 2) continue;
      const chronological = [...indices].sort((left, right) =>
        (scored[left].createdAt ?? now) - (scored[right].createdAt ?? now) ||
        scored[left].memoryId.localeCompare(scored[right].memoryId),
      );
      const newest = scored[chronological[chronological.length - 1]].memoryId;
      chronological.forEach((index, position) => {
        const adjustment = ((position / (chronological.length - 1)) - 0.5) * 0.10;
        scored[index].rankingSignals.sameTopicAdjustment = adjustment;
        if (position < chronological.length - 1) scored[index].possiblyOutdatedBy = newest;
      });
    }
  }

  for (const candidate of scored) {
    const signals = candidate.rankingSignals;
    candidate.adjustment = clampAdjustment(
      signals.strengthAdjustment + signals.salienceAdjustment + signals.sourceRoleAdjustment +
      signals.accessAdjustment + signals.freshnessAdjustment + signals.scopeAdjustment +
      signals.modeAdjustment + signals.sameTopicAdjustment + signals.knowledgeBaseAdjustment,
    );
    candidate.rankScore = candidate.relevance + candidate.adjustment;
    candidate.scoreValue = mapRecallRankScoreToClientScore(candidate.rankScore);
  }

  // The only ordering operation in recall v2. Subsequent filters preserve it.
  scored.sort((left, right) => right.rankScore - left.rankScore || left.memoryId.localeCompare(right.memoryId));

  // Collapse duplicate text before the top-five low-content limit. When an
  // inference clone duplicates a substantive source row, preserve the source
  // row so a synthetic clone cannot hide the original gold memory.
  const uniqueByText = new Map<string, V2Scored<T>>();
  for (const candidate of scored) {
    const signature = memoryDedupKey(candidate);
    const existing = uniqueByText.get(signature);
    if (!existing ||
      (existing.source === "inference" && candidate.source !== "inference") ||
      ((existing.source === "inference") === (candidate.source === "inference") &&
        candidate.rankScore > existing.rankScore)) {
      uniqueByText.set(signature, candidate);
    }
  }

  const output: RecallV2RankedCandidate<T>[] = [];
  let lowContentCountInTopFive = 0;
  const uniqueScored = [...uniqueByText.values()].sort((left, right) =>
    right.rankScore - left.rankScore || left.memoryId.localeCompare(right.memoryId),
  );
  for (const candidate of uniqueScored) {
    if (output.length < 5 && candidate.rankingSignals.lowContentDistilled && !candidate.rankingSignals.exactPhraseMatch) {
      if (lowContentCountInTopFive >= 1) continue;
      lowContentCountInTopFive += 1;
    }
    output.push(candidate);
  }
  return output;
}

function includesWholeWord(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
}
