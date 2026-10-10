/**
 * Query parsing and deterministic lexical signals for Recall v2.
 * This module deliberately has no I/O; callers may pass ticket prefixes to
 * analyzeQuery or configure the account-independent default at startup.
 */

export const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "up", "about", "into", "through", "during",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "can", "shall", "i", "me", "my", "mine", "myself", "we", "us", "our",
  "ours", "ourselves", "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself", "it",
  "its", "itself", "they", "them", "their", "theirs", "themselves",
  "what", "which", "who", "whom", "this", "that", "these", "those",
  "how", "when", "where", "why", "if", "then", "than", "so", "no", "not",
  "nor", "too", "very", "just", "also", "now", "here", "there", "all", "any",
  "both", "each", "few", "more", "most", "other", "some", "such", "only",
  "own", "same", "again", "between", "over", "under", "above", "below", "after",
  "before", "as", "because", "until", "while", "get", "got", "gotten", "let",
  "make", "made", "say", "said", "see", "seen", "take", "took", "use", "used",
  "using", "tell", "told", "know", "knew", "known", "think", "thought", "want",
  "wanted", "need", "needed", "like", "liked", "really", "actually", "even", "still",
  "already", "yet", "ever", "never", "always", "one", "two", "three", "doesn",
  "didn", "wasn", "weren", "isn", "aren", "wouldn", "couldn", "shouldn", "mightn",
  "mustn", "haven", "hasn", "hadn", "don",
]);

const configuredTicketPrefixes = (globalThis as any).process?.env?.RECALL_TICKET_PREFIXES;
export let RECALL_TICKET_PREFIXES: readonly string[] = configuredTicketPrefixes
  ? String(configuredTicketPrefixes).split(",").map((prefix) => prefix.trim().toUpperCase()).filter(Boolean)
  : ["ILL"];

export function setRecallTicketPrefixes(prefixes: readonly string[]): void {
  RECALL_TICKET_PREFIXES = [...new Set(prefixes.map((prefix) => prefix.trim().toUpperCase()).filter(Boolean))];
}

export function getRecallTicketPrefixes(): readonly string[] {
  return RECALL_TICKET_PREFIXES;
}

export interface AnalyzedQuery {
  tokens: string[];
  informativeTerms: string[];
  /** Phrase made from informative words, with question/function words removed. */
  phrases: string[];
  prNumbers: Set<string>;
  ticketIds: Map<string, Set<string>>;
  shas: string[];
  urls: string[];
  semvers: string[];
}

export interface QueryMatchSignals {
  lexicalScore: number;
  identifierScore: number;
  identifierMatch: boolean;
  requestedPrTicketMatch: boolean;
  decisiveIdentifierMatch: boolean;
  exactPhraseMatch: boolean;
}

function normalizeQueryText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPRNumbers(text: string): Set<string> {
  const prs = new Set<string>();
  const nonUrlText = text.length <= URL_TOKEN_MAX_LENGTH ? text.replace(URL_PATTERN, " ") : stripUrls(text);
  for (const match of nonUrlText.matchAll(/\bpull\s+requests?\s*#?\s*(\d+)\b/gi)) prs.add(match[1]);
  for (const match of nonUrlText.matchAll(/\bpulls?\/(\d+)\b/gi)) prs.add(match[1]);
  for (const match of nonUrlText.matchAll(/\bpr\s*#?\s*(\d+)\b/gi)) prs.add(match[1]);
  // A #number is a PR form only when # is not embedded in a word/identifier.
  for (const match of nonUrlText.matchAll(/(?:^|[^a-z0-9_])#(\d+)(?=$|[^a-z0-9_])/gi)) prs.add(match[1]);
  return prs;
}

function extractTicketIds(text: string, prefixes: readonly string[]): Map<string, Set<string>> {
  const nonUrlText = text.length <= URL_TOKEN_MAX_LENGTH ? text.replace(URL_PATTERN, " ") : stripUrls(text);
  const result = new Map<string, Set<string>>();
  for (const rawPrefix of prefixes) {
    const prefix = rawPrefix.trim().toUpperCase();
    if (!prefix) continue;
    const matches = new Set<string>();
    const pattern = new RegExp(`\\b${escaped(prefix)}-(\\d+)\\b`, "gi");
    for (const match of nonUrlText.matchAll(pattern)) matches.add(match[1]);
    if (matches.size) result.set(prefix, matches);
  }
  return result;
}

function extractShas(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b[a-f0-9]{7,40}\b/gi)) {
    const sha = match[0].toLowerCase();
    if (/\d/.test(sha) && /[a-f]/.test(sha)) found.add(sha);
  }
  return [...found];
}

const URL_PATTERN = /\b(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?/gi;
const URL_TOKEN_MAX_LENGTH = 2_048;

function* urlMatches(text: string): IterableIterator<RegExpMatchArray> {
  if (!text.includes(".")) return;
  for (const tokenMatch of text.matchAll(/\S+/g)) {
    const token = tokenMatch[0];
    if (token.length > URL_TOKEN_MAX_LENGTH) continue;
    yield* token.matchAll(URL_PATTERN);
  }
}

function stripUrls(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/\S+/g, (token) => token.length <= URL_TOKEN_MAX_LENGTH
    ? token.replace(URL_PATTERN, " ")
    : token);
}

const SEMVER_PATTERN = /\bv?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?\b/gi;
const BARE_FILENAME_EXTENSIONS = new Set([
  "cjs", "css", "csv", "go", "html", "java", "js", "json", "jsx", "lock", "md", "mjs",
  "py", "rs", "ts", "tsx", "txt", "xml", "yaml", "yml",
]);

function trimUrlPunctuation(url: string): string {
  return url.replace(/[),.;!?\]}>'"]+$/g, "");
}

function extractUrls(text: string): string[] {
  const matches = text.length <= URL_TOKEN_MAX_LENGTH ? text.matchAll(URL_PATTERN) : urlMatches(text);
  return [...new Set([...matches]
    .map((match) => trimUrlPunctuation(match[0].toLowerCase()))
    .filter((url) => {
      if (/^https?:\/\//i.test(url) || url.includes("/")) return true;
      const extension = url.split(".").at(-1) ?? "";
      return !BARE_FILENAME_EXTENSIONS.has(extension);
    }))];
}

function extractSemvers(text: string): string[] {
  return [...new Set([...text.matchAll(SEMVER_PATTERN)].map((match) => match[0].toLowerCase().replace(/^v/, "")))];
}

const MAX_INFORMATIVE_TERMS = 128;

function informativeQueryTerms(tokens: string[]): string[] {
  const terms = new Set<string>();
  for (const token of tokens) {
    if (token.length > 1 && !STOPWORDS.has(token)) terms.add(token);
    if (terms.size === MAX_INFORMATIVE_TERMS) break;
  }
  return [...terms];
}

export function analyzeQuery(
  query: string,
  options?: { ticketPrefixes?: readonly string[] },
): AnalyzedQuery {
  const normalized = normalizeQueryText(query);
  const tokens = tokenize(normalized);
  // Later distinct terms do not contribute to lexical coverage or the phrase.
  const informativeTerms = informativeQueryTerms(tokens);
  const phrase = informativeTerms.join(" ");
  const prefixes = options?.ticketPrefixes ?? RECALL_TICKET_PREFIXES;
  return {
    tokens,
    informativeTerms,
    phrases: phrase.length > 0 && informativeTerms.length > 1 ? [phrase] : [],
    prNumbers: extractPRNumbers(normalized),
    ticketIds: extractTicketIds(normalized, prefixes),
    shas: extractShas(normalized),
    urls: extractUrls(normalized),
    semvers: extractSemvers(normalized),
  };
}

interface IndexedWord {
  value: string;
  start: number;
  end: number;
  index: number;
}

interface WordIndex {
  text: string;
  words: IndexedWord[];
  byWord: Map<string, IndexedWord[]>;
}

// A text whose word index is built on first use: most terms are absent and
// never need it.
interface IndexedText {
  text: string;
  index?: WordIndex;
}

// Longest first word checked with String.prototype.includes before indexing.
// That native search can degrade to about this many comparisons per character,
// so the bound keeps it linear; a longer first word goes straight to the index.
const LITERAL_PRECHECK_MAX = 16;

function buildWordIndex(text: string): WordIndex {
  const words: IndexedWord[] = [];
  const byWord = new Map<string, IndexedWord[]>();
  for (const match of text.matchAll(/[a-z0-9]+/g)) {
    const word = { value: match[0], start: match.index!, end: match.index! + match[0].length, index: words.length };
    words.push(word);
    const occurrences = byWord.get(word.value);
    if (occurrences) occurrences.push(word);
    else byWord.set(word.value, [word]);
  }
  return { text, words, byWord };
}

function includesWholeTerm(source: IndexedText, term: string): boolean {
  // Query terms, phrases, and SHAs contain only ASCII words and single spaces.
  const words = term.toLowerCase().split(" ");
  // Exact negative filter: every match contains its first word.
  if (words[0].length <= LITERAL_PRECHECK_MAX && !source.text.includes(words[0])) return false;
  const index = source.index ??= buildWordIndex(source.text);
  const firstWordOccurrences = index.byWord.get(words[0]);
  if (!firstWordOccurrences) return false;
  if (words.length === 1) return true;

  for (const first of firstWordOccurrences) {
    let matched = true;
    for (let offset = 1; offset < words.length; offset++) {
      const previous = index.words[first.index + offset - 1];
      const current = index.words[first.index + offset];
      if (!current || current.value !== words[offset] || current.start !== previous.end + 1
        || index.text.charAt(previous.end) !== " ") {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function normalizeUrl(url: string): string {
  const value = trimUrlPunctuation(url.toLowerCase());
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname.replace(/\/$/, "")}${parsed.search}${parsed.hash}`;
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

function exactIdentifierMatch(analyzed: AnalyzedQuery, candidateText: string, sources: IndexedText[]): {
  score: number;
  matched: boolean;
  decisive: boolean;
  requestedPrTicketMatch: boolean;
} {
  const candidate = normalizeQueryText(candidateText);
  const candidatePRs = extractPRNumbers(candidate);
  for (const pr of analyzed.prNumbers) {
    if (candidatePRs.has(pr)) return { score: 1, matched: true, decisive: true, requestedPrTicketMatch: true };
  }

  const candidateTickets = extractTicketIds(candidate, [...analyzed.ticketIds.keys()]);
  for (const [prefix, ids] of analyzed.ticketIds) {
    const found = candidateTickets.get(prefix);
    if (found && [...ids].some((id) => found.has(id))) return { score: 1, matched: true, decisive: true, requestedPrTicketMatch: true };
  }

  for (const sha of analyzed.shas) {
    // A SHA is one word, and the joined text's words are its parts' words.
    if (sources.some((source) => includesWholeTerm(source, sha))) {
      return { score: 1, matched: true, decisive: sha.length >= 12, requestedPrTicketMatch: false };
    }
  }

  const candidateUrls = new Set(extractUrls(candidate).map(normalizeUrl));
  for (const url of analyzed.urls) {
    if (candidateUrls.has(normalizeUrl(url))) return { score: 1, matched: true, decisive: false, requestedPrTicketMatch: false };
  }

  const candidateSemvers = new Set(extractSemvers(candidate));
  for (const version of analyzed.semvers) {
    if (candidateSemvers.has(version)) return { score: 1, matched: true, decisive: false, requestedPrTicketMatch: false };
  }
  return { score: 0, matched: false, decisive: false, requestedPrTicketMatch: false };
}

export function hasConflictingIdentifier(analyzed: AnalyzedQuery, candidateText: string): boolean {
  const candidate = normalizeQueryText(candidateText);
  if (analyzed.prNumbers.size) {
    const found = extractPRNumbers(candidate);
    if (found.size && ![...analyzed.prNumbers].some((number) => found.has(number))) return true;
  }
  for (const [prefix, requested] of analyzed.ticketIds) {
    const found = extractTicketIds(candidate, [prefix]).get(prefix);
    if (found?.size && ![...requested].some((number) => found.has(number))) return true;
  }
  return false;
}

export function scoreQueryMatch(
  analyzed: AnalyzedQuery,
  title: string,
  fullText: string,
  tags: string[] = [],
): QueryMatchSignals {
  const titleText = normalizeQueryText(title);
  const bodyText = normalizeQueryText(fullText);
  const tagText = normalizeQueryText(tags.join(" "));
  const allText = `${titleText} ${bodyText} ${tagText}`.trim();
  const titleIndex: IndexedText = { text: titleText };
  const bodyIndex: IndexedText = { text: bodyText };
  const tagIndex: IndexedText = { text: tagText };

  let termCoverage = 0;
  for (const term of analyzed.informativeTerms) {
    const weight = includesWholeTerm(titleIndex, term) ? 1
      : includesWholeTerm(tagIndex, term) ? 0.8
        : includesWholeTerm(bodyIndex, term) ? 0.6
          : 0;
    termCoverage += weight;
  }
  if (analyzed.informativeTerms.length) termCoverage /= analyzed.informativeTerms.length;

  let phraseScore = 0;
  let exactPhraseMatch = false;
  for (const phrase of analyzed.phrases) {
    const inTitle = includesWholeTerm(titleIndex, phrase);
    const inBody = includesWholeTerm(bodyIndex, phrase);
    const inTags = includesWholeTerm(tagIndex, phrase);
    if (inTitle || inBody || inTags) exactPhraseMatch = true;
    const exact = inTitle ? 1 : inBody ? 0.8 : inTags ? 0.7 : 0;
    phraseScore = Math.max(phraseScore, exact);
  }

  const identifier = exactIdentifierMatch(analyzed, allText, [titleIndex, bodyIndex, tagIndex]);
  return {
    lexicalScore: clamp01(termCoverage * 0.75 + phraseScore * 0.25),
    identifierScore: identifier.score,
    identifierMatch: identifier.matched,
    requestedPrTicketMatch: identifier.requestedPrTicketMatch,
    decisiveIdentifierMatch: identifier.decisive,
    exactPhraseMatch,
  };
}

/** Compatibility helper for focused callers that need only lexical relevance. */
export function computeLexicalScore(
  analyzed: AnalyzedQuery,
  title: string,
  fullText: string,
  tags: string[] = [],
): number {
  return scoreQueryMatch(analyzed, title, fullText, tags).lexicalScore;
}

/**
 * Scoring uses full surviving text; recallText is only the display fallback
 * after raw content was wiped/tombstoned and no summary survives.
 */
export function scoringText(memory: {
  title?: string | null;
  content?: string | null;
  summary?: string | null;
  recallText?: string | null;
  tags?: string[] | null;
  rawContentWipedAt?: number | null;
}): { title: string; fullText: string; tags: string[] } {
  const title = String(memory.title ?? "").trim();
  const tags = (memory.tags ?? []).map(String).filter(Boolean);
  const rawContent = String(memory.content ?? "").trim();
  const wiped = Boolean(memory.rawContentWipedAt) || /^\[raw sensory content wiped by retention policy\]$/i.test(rawContent);
  const fullText = rawContent && !wiped
    ? rawContent
    : String(memory.summary ?? "").trim() || String(memory.recallText ?? "").trim();
  return { title, fullText, tags };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
