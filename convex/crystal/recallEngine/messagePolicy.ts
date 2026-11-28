import { classifyChannel } from "../channelClassifier";
import { analyzeQuery } from "./queryAnalysis";
import type { RecallIntent } from "../recallRanking";

/** Search-time exclusions only; capture and standalone transcript reads keep these rows. */
export const NON_CONVERSATIONAL_PATTERNS = [
  // A real injected notification or reminder always has an opening tag and its closing tag;
  // a sentence that merely starts with a literal tag and asks about it has no closing tag.
  /^\s*<(task-notification|system-reminder|command-name)\b[^>]*>[\s\S]*?<\/\1>/i,
  // Title generators: "<thread|conversation|chat|session> title", or "title ... this/the following/the above ... <thread|conversation|chat|session>"
  // within a few words each, so a request to title a document that merely mentions a chat stays conversation.
  /^\s*(?:generate|write|create)\s+(?:a\s+|the\s+)?(?:short\s+|concise\s+)?(?:(?:thread|conversation|chat|session)\s+title\b|title(?:\s+\S+){0,3}?\s+(?:this|the\s+following|the\s+above)(?:\s+\S+){0,3}?\s+(?:thread|conversation|chat|session)\b)/i,
  /^\s*return json with keys?\s+["'`]?title\b/i,
  // Scheduled digest and cron prompts are headers: the phrase is followed by a colon, a dash or a newline.
  /^\s*(?:scheduled\s+(?:digest|task|cron)|cron\s+(?:job|prompt|task)|daily\s+digest)(?:\s+prompt)?\s*(?:[:\-\u2013\u2014]|\n)/i,
  // A question about a background task ("finished?") is conversation; a declarative first-line notice is not.
  /^\s*background[- ](?:process|task|command)\b[^\n]*\b(?:(?:completed|finished|exited)\b(?!\s*\?)|notification\b)/i,
];

/** Shared leading-channel envelope rule; do not strip notification tags here. */
export function stripLeadingChannelTag(value: string): string {
  return value.replace(/^\s*\[([^\]\n]+)\]\s*/i, (wrapper, label: string) =>
    /^channel\s*:/i.test(label) || classifyChannel(label, []) === "work" ? "" : wrapper);
}

export function isNonConversationalMessage(role: string, content: string): boolean {
  return role === "system" || NON_CONVERSATIONAL_PATTERNS.some(pattern => pattern.test(stripLeadingChannelTag(content)));
}

export function normalizeEchoText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Only known capture envelopes. Unknown markup and substantive quoted text stay evidence. */
export function stripCaptureWrappers(value: string): string {
  const names = ["system-reminder", "command-name", "command-message"] as const;
  const openers = /<(system-reminder|command-name|command-message)>/gi;
  const closerPatterns = names.map((name) => new RegExp(`</${name}>`, "gi"));
  const closers = closerPatterns.map((pattern) => Array.from(value.matchAll(pattern), (match) => match.index!));
  const closerIndexes = [0, 0, 0];
  const failed = [false, false, false];
  const output: string[] = [];
  let cursor = 0;
  for (const opener of value.matchAll(openers)) {
    const start = opener.index!;
    if (start < cursor) continue;
    const nameIndex = names.indexOf(opener[1].toLowerCase() as typeof names[number]);
    if (failed[nameIndex]) continue;
    const positions = closers[nameIndex];
    while (closerIndexes[nameIndex] < positions.length
      && positions[closerIndexes[nameIndex]] < start + opener[0].length) closerIndexes[nameIndex]++;
    const close = positions[closerIndexes[nameIndex]];
    if (close === undefined) {
      failed[nameIndex] = true;
      continue;
    }
    output.push(value.slice(cursor, start), " ");
    const closerLength = `</${names[nameIndex]}>`.length;
    cursor = close + closerLength;
    while (closerIndexes[nameIndex] < positions.length && positions[closerIndexes[nameIndex]] < cursor) {
      closerIndexes[nameIndex]++;
    }
  }
  const wrapped = output.join("") + value.slice(cursor);
  const argsOpeners = /<command-args>/gi;
  const argsClosers = Array.from(wrapped.matchAll(/<\/command-args>/gi), (match) => match.index!);
  let argsCloserIndex = 0;
  let argsCursor = 0;
  const unwrapped: string[] = [];
  let argsFailed = false;
  for (const opener of wrapped.matchAll(argsOpeners)) {
    const start = opener.index!;
    if (start < argsCursor || argsFailed) continue;
    while (argsCloserIndex < argsClosers.length && argsClosers[argsCloserIndex] < start + opener[0].length) {
      argsCloserIndex++;
    }
    const close = argsClosers[argsCloserIndex];
    if (close === undefined) {
      argsFailed = true;
      continue;
    }
    unwrapped.push(wrapped.slice(argsCursor, start), wrapped.slice(start + opener[0].length, close));
    argsCursor = close + "</command-args>".length;
    while (argsCloserIndex < argsClosers.length && argsClosers[argsCloserIndex] < argsCursor) argsCloserIndex++;
  }
  return stripLeadingChannelTag(unwrapped.join("") + wrapped.slice(argsCursor));
}

export function isOwnPromptEcho(message: {role: string; content: string; timestamp: number; turnId?: string},
  request: {query: string; turnId?: string; excludeRecentMessagesMs?: number}, now: number): boolean {
  const age = now - message.timestamp;
  if (message.role !== "user" || age < 0 || age > Math.max(120_000, request.excludeRecentMessagesMs ?? 0)) return false;
  if (request.turnId && message.turnId === request.turnId) return true;
  const query = normalizeEchoText(request.query);
  return normalizeEchoText(message.content) === query || normalizeEchoText(stripCaptureWrappers(message.content)) === query;
}

const unspacedScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const tokenize = (value: string) => value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

export function scoreRecallMessage(query: string, content: string, intent: RecallIntent) {
  const queryTokens = tokenize(query);
  const asciiTerms = new Set(analyzeQuery(query.normalize("NFKC").toLowerCase()).informativeTerms);
  const terms = [...new Set(queryTokens.filter(token => /^[a-z0-9]+$/.test(token)
    ? asciiTerms.has(token) : unspacedScript.test(token) || [...token].length > 1 || /^\p{N}+$/u.test(token)))];
  const normalizedContent = content.normalize("NFKC").toLowerCase();
  const tokens = tokenize(content);
  const tokenSet = new Set(tokens);
  const matched = terms.filter(term => unspacedScript.test(term) ? normalizedContent.includes(term) : tokenSet.has(term));
  const coverage = terms.length ? matched.length / terms.length : 0;
  if (!matched.length || (terms.length >= 2 && coverage < 0.5)) return null;
  const phrase = queryTokens.join(" ");
  const exactPhrase = phrase.length > 0 && (` ${tokens.join(" ")} `).includes(` ${phrase} `);
  // Convex's unbounded lexical score is not a probability. Normalize the
  // informative coverage and phrase signals directly rather than clipping it.
  const relevance = (coverage * 3 + Number(exactPhrase)) / 4;
  const subjects: string[] = [];
  if (intent === "personal_attribute") {
    for (const [subject, pattern] of [
      ["height", /\b(height|tall|feet|inches|cm)\b/i],
      ["weight", /\b(weight|lbs|pounds|kg|kilograms)\b/i],
      ["age", /\b(age|years old|born|birthday)\b/i],
      ["bmr", /\b(bmr|basal metabolic rate|metabolism)\b/i],
    ] as const) if (pattern.test(content)) subjects.push(subject);
  }
  return { relevance, subjects: [...new Set([...subjects, ...matched.slice(0, 3)])].slice(0, 5) };
}
