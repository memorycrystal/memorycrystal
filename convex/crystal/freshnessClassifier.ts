// Write-time fast-fact vs slow-fact classifier (ILL-106).
//
// A "fast fact" is a volatile present-tense value — a quantity or changeable
// state that will be false in a week ("the pipeline has 13 open deals", "MRR is
// $12,400 right now"). Stored as an undated `semantic/fact`, recall treats it as
// permanently true. A "slow fact" is durable — an identity, definition, or
// decision ("Illumin8 is a CCPC incorporated in Alberta", "we chose Convex").
//
// This is Obsidian's freshness "meter vs wiring" test: a meter reading is a dated
// snapshot; the wiring behind it is timeless. We flag likely meter readings so the
// write path can warn the author (advisory) or, under a config flag, anchor them
// as a dated `episodic/event` instead.
//
// Hard constraints (ILL-106):
//   * Pure + deterministic + cheap — safe for the synchronous write path. No
//     network, no LLM, no clock read here (the caller owns time).
//   * Precision over recall — a false flag is a low-value nag, so the heuristic is
//     conservative: it fires only on a volatile SUBJECT carrying a NUMBER/STATE in
//     PRESENT tense with NO date anchor and NO durable/identity marker.
//   * Scope: `semantic` and `procedural` writes only. Never `sensory`, never KB.

export type FreshnessAssessment = {
  volatile: boolean;
  reason?: string;
  suggestion?: string;
  /** Suggested dated re-home for the value when coercion is enabled. */
  coercion?: { store: "episodic"; category: "event" };
};

const NOT_VOLATILE: FreshnessAssessment = { volatile: false };

// Stores the classifier is allowed to inspect. Everything else (sensory, KB,
// prospective) is skipped outright.
const IN_SCOPE_STORES = new Set(["semantic", "procedural"]);

// A changeable, countable/measurable subject. These are the nouns whose value
// moves over time — the heart of a "meter reading".
const VOLATILE_SUBJECT =
  /\b(pipelines?|deals?|leads?|prospects?|customers?|clients?|users?|subscribers?|members?|followers?|signups?|tickets?|issues?|bugs?|tasks?|balances?|revenues?|mrr|arr|incomes?|profits?|sales?|prices?|pricing|costs?|rates?|salar(?:y|ies)|budgets?|inventor(?:y|ies)|stock|units?|counts?|totals?|headcounts?|employees?|engineers?|developers?|staff|versions?|statuses?|status|scores?|ranks?|ranking|standings?|temperatures?|weights?|quotas?|capacit(?:y|ies)|utilization|occupancy|attendances?|enrollments?|streaks?)\b/i;

// Present-tense / stative framing — the value is being asserted as true *now*.
const PRESENT_STATE =
  /\b(is|are|has|have|currently|current|now|right\s+now|at\s+the\s+moment|as\s+of\s+(?:now|today)|these\s+days|nowadays|stands?\s+at|sits?\s+at|holds?|contains?|totals?|remains?|reached|hovering|running\s+at)\b/i;

// A concrete magnitude: a number, money amount, percentage, or a number-word.
// This alone is a strong volatility signal ("13 open deals", "$12,400", "5%").
const NUMERIC_MAGNITUDE =
  /(\$\s?\d|\b\d[\d,.]*\b|\b\d+%|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand|million|billion)\b)/i;

// A changeable status word. On its own this is a weak signal (a terminal state
// like "the deal is closed" is durable), so we only treat it as volatile when it
// is paired with an explicit "currently / right now" cue below.
const CHANGEABLE_STATE =
  /\b(?:open|closed|pending|active|inactive|online|offline|blocked|paused|live|sold\s?out|in\s?stock|out\s?of\s?stock|overdue|on\s?track|at\s?risk|off\s?track|understaffed|overbooked)\b/i;

// An explicit "as of now" cue. Required to promote a bare changeable-state word to
// a volatile flag; not required when a numeric magnitude is present.
const VOLATILITY_CUE =
  /\b(currently|current|now|right\s+now|at\s+the\s+moment|as\s+of\s+(?:now|today)|these\s+days|nowadays|at\s+present|at\s+this\s+time)\b/i;

// An explicit date/time anchor already present in the content. If the author
// dated it, it is no longer a floating "true forever" claim — do not flag.
const DATE_ANCHOR =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:19|20)\d{2}|q[1-4]\s*(?:19|20)?\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|yesterday|today|tomorrow|last\s+(?:week|month|quarter|year)|this\s+(?:week|month|quarter|year)|as\s+of\s+\w+\s+\d)\b/i;

// Durable / identity / decision markers. Their presence means the statement is
// about how the world is *wired*, not a momentary reading — never flag.
const DURABLE_MARKER =
  /\b(incorporated|founded|established|born|headquartered|located\s+in|based\s+in|chose|chosen|decided|prefers?|preferred|licen[sc]ed|means|defined\s+as|stands\s+for|refers\s+to|named|called|is\s+a\s+type|is\s+an?\s+(?:llc|inc|corp|ccpc|company|framework|library|language|protocol|standard|tool|platform|database|person|team|project))\b/i;

function snippet(match: RegExpMatchArray | null): string | undefined {
  if (!match) return undefined;
  return match[0].trim();
}

/**
 * Classify a candidate write as a durable "slow fact" or a volatile "fast fact".
 * Pure and side-effect-free. Returns `{ volatile: false }` for anything out of
 * scope or not confidently volatile.
 */
export function classifyFreshness(input: {
  content: string;
  store: string;
  category: string;
}): FreshnessAssessment {
  const { content, store } = input;
  if (!IN_SCOPE_STORES.has(store)) return NOT_VOLATILE;
  if (typeof content !== "string" || content.trim().length === 0) {
    return NOT_VOLATILE;
  }

  // Already dated, or a durable/identity statement → durable, never flag.
  if (DATE_ANCHOR.test(content)) return NOT_VOLATILE;
  if (DURABLE_MARKER.test(content)) return NOT_VOLATILE;

  const subjectMatch = content.match(VOLATILE_SUBJECT);
  if (!subjectMatch) return NOT_VOLATILE;
  if (!PRESENT_STATE.test(content)) return NOT_VOLATILE;

  // A numeric magnitude is volatile on its own; a bare changeable-state word is
  // only volatile when explicitly framed as "current".
  const numericMatch = content.match(NUMERIC_MAGNITUDE);
  const stateMatch = content.match(CHANGEABLE_STATE);
  const stateIsVolatile = Boolean(stateMatch) && VOLATILITY_CUE.test(content);
  const valueMatch = numericMatch ?? (stateIsVolatile ? stateMatch : null);
  if (!valueMatch) return NOT_VOLATILE;

  const subject = snippet(subjectMatch);
  const value = snippet(valueMatch);
  return {
    volatile: true,
    reason:
      `This reads as a volatile present-tense value` +
      (subject && value ? ` (${subject} = ${value})` : "") +
      ` with no date anchor — it will read as true forever once stored as a timeless fact.`,
    suggestion:
      `Anchor it with an explicit date, or store it as episodic/event so recall treats it as a dated snapshot rather than a timeless fact.`,
    coercion: { store: "episodic", category: "event" },
  };
}
