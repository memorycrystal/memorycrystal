import { logError } from "../crypto";
import { dropRecentMemoryIds } from "./scope";
import type { RecallRuntime, RerankFallbackReason, RerankReply, RerankTrace } from "./types";

/** The most ranked memories the model is shown. */
export const RECALL_RERANK_CANDIDATES = 12;
/** Content excerpt per candidate, in code points. */
const EXCERPT_CODE_POINTS = 400;

/** At most this many ranked memories come back when the answer check falls back, unless RECALL_RERANK_FALLBACK_LIMIT says otherwise. */
export const RECALL_RERANK_DEFAULT_FALLBACK_LIMIT = 5;

/**
 * ILL-1241: the fallback cap, RECALL_RERANK_FALLBACK_LIMIT when it is an integer from 1 to 50, otherwise the default.
 * An unchecked fallback is the case most likely to carry off-topic memories, so it must never be the largest response.
 * It applies only to lean requests (maxContentChars set); any other request falls back exactly as before.
 */
export function recallRerankFallbackLimit(): number {
  const value = Number(process.env.RECALL_RERANK_FALLBACK_LIMIT?.trim());
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : RECALL_RERANK_DEFAULT_FALLBACK_LIMIT;
}

/** The stage runs when a model is configured, except for identifier early returns and knowledge-base scoped requests. */
export function rerankApplies(state: RecallRuntime): boolean {
  return state.ports.rerank !== undefined && !state.earlyReturn && !state.request.hasKnowledgeBaseScope;
}

/** How many memories final composition returns when the stage runs: enough for the limit and every candidate. */
export function rerankDepth(state: RecallRuntime): number {
  return Math.max(state.request.limit, RECALL_RERANK_CANDIDATES);
}

function excerpt(text: string): string {
  let end = 0;
  let codePoints = 0;
  while (end < text.length && codePoints < EXCERPT_CODE_POINTS) {
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
    codePoints++;
  }
  return text.slice(0, end);
}

export function buildRerankPrompt(query: string, candidates: any[]): string {
  const numbered = candidates.map((memory, index) =>
    `[${index}] ${String(memory.title ?? "")}\n${excerpt(String(memory.content ?? ""))}`,
  );
  return [
    `Query: ${query}`,
    "",
    "Memories:",
    numbered.join("\n\n"),
    "",
    "Which memories directly help answer the query? A memory that is only on the same topic does not.",
    'Reply with JSON only: {"keep":[...]} listing their numbers, best first, for example {"keep":[2,0]}. Reply {"keep":[]} if none do.',
  ].join("\n");
}

/** The reply as JSON, tolerating the trailing commas small models sometimes emit (`{"keep":[0,]}`). */
function parseLenientJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    try {
      return JSON.parse(content.replace(/,\s*([\]}])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

/** A reply wrapped in one Markdown code fence (```json ... ```), unwrapped; any other reply unchanged. */
function stripCodeFence(content: string): string {
  return content.trim().match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i)?.[1] ?? content;
}

/** Why a reply was not usable: unparseable, no `keep` array, or a non-empty `keep` with no valid index. */
export type RerankReplyFault = "not_json" | "no_keep" | "no_valid_index";

/** The reply's structure for the operator log, never its text. */
export type RerankReplyShape = {
  shape: "empty" | "whitespace" | "json_object" | "json_other" | "fenced" | "text";
  hasKeepKey: boolean;
  /** Integer indices from 0 to candidates - 1, other integers, and entries that are not integers. */
  validCount: number;
  outOfRangeCount: number;
  nonIntegerCount: number;
};

/**
 * The model's reply read: the valid candidate indices it kept, best first, or the fault when the reply is not the
 * requested JSON, with its structure for the operator's fallback log.
 */
export function readRerankReply(
  content: string,
  count: number,
): ({ keep: number[] } | { keep: null; fault: RerankReplyFault }) & { structure: RerankReplyShape } {
  const unfenced = stripCodeFence(content);
  const parsed = parseLenientJson(unfenced);
  const object = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const keep = object?.keep;
  const entries = Array.isArray(keep) ? keep : [];
  const integers = entries.filter((value): value is number => Number.isInteger(value));
  const indices: number[] = [];
  for (const value of integers) if (value >= 0 && value < count && !indices.includes(value)) indices.push(value);
  const validCount = integers.filter((value) => value >= 0 && value < count).length;
  const structure: RerankReplyShape = {
    shape: content.length === 0 ? "empty"
      : content.trim().length === 0 ? "whitespace"
      : unfenced !== content ? "fenced"
      : object ? "json_object"
      : parsed !== undefined ? "json_other"
      : "text",
    hasKeepKey: object !== null && Object.prototype.hasOwnProperty.call(object, "keep"),
    validCount,
    outOfRangeCount: integers.length - validCount,
    nonIntegerCount: entries.length - integers.length,
  };
  if (parsed === undefined) return { keep: null, fault: "not_json", structure };
  if (!Array.isArray(keep)) return { keep: null, fault: "no_keep", structure };
  return keep.length > 0 && indices.length === 0 ? { keep: null, fault: "no_valid_index", structure } : { keep: indices, structure };
}

/**
 * The candidate indices the model kept, best first, or null when the reply is not the requested JSON. Unknown,
 * duplicate and out-of-range indices are dropped; a non-empty list with no valid index is not an abstention.
 */
export function parseRerankReply(content: string, count: number): number[] | null {
  return readRerankReply(content, count).keep;
}

type RerankFallbackDetails = { trace?: RerankTrace; fault?: RerankReplyFault } & Partial<RerankReplyShape>;

/**
 * One operator log line per fallback, counted by grepping `rerank_fallbacks=1`: counts, flags and allow-listed names
 * only, never a character of the reply or upstream free text; never returned in a recall response.
 */
function logRerankFallback(details: { reason: RerankFallbackReason; candidates: number } & RerankFallbackDetails) {
  console.warn(`[recall] rerank_fallbacks=1 ${JSON.stringify(details)}`);
}

/**
 * Ask the configured model which composed memories help answer the query and return those, in its order, up to the
 * request limit. Any failure returns the ranked memories the request would return without the stage, at most
 * recallRerankFallbackLimit() of them for a lean request, and marks a recoverable degradation.
 */
export async function rerankMemories(state: RecallRuntime, composed: any[]): Promise<any[]> {
  const rerank = state.ports.rerank!;
  const unchecked = dropRecentMemoryIds(composed.slice(0, state.request.limit), state.request.recentMemoryIds);
  const candidates = dropRecentMemoryIds(composed, state.request.recentMemoryIds).slice(0, RECALL_RERANK_CANDIDATES);
  if (candidates.length === 0) return unchecked;
  const fallback = (reason: RerankFallbackReason, details: RerankFallbackDetails = {}): any[] => {
    // Only a fallback after a request was sent is logged; a missing key, the cost breaker or a deadline that passed
    // before dispatch (leg "none") never reached the model.
    if (details.trace && details.trace.leg !== "none") logRerankFallback({ reason, candidates: candidates.length, ...details });
    state.degradation.mark({
      code: "rerank_unavailable",
      message: "The answer check was unavailable; memories are in ranked order and were not checked against the query.",
      recoverable: true,
      affectedStage: "rerank",
      reason,
    });
    state.diagnostics.rerank = { model: rerank.model, candidates: candidates.length, kept: 0, abstained: false, fallbackReason: reason };
    return state.request.maxContentChars === undefined ? unchecked : unchecked.slice(0, recallRerankFallbackLimit());
  };
  if (state.recallBudget?.emergency) return fallback("cost_budget_exceeded");
  const reply: RerankReply = await state.timer
    .measure("rerank", () => rerank.complete(buildRerankPrompt(state.request.query, candidates)))
    .catch(async (err: unknown) => {
      console.error("[recall] rerank_unavailable:", await logError(err, state.ports.userId));
      return { ok: false, reason: "provider_error" };
    });
  if (!reply.ok) return fallback(reply.reason, { trace: reply.trace });
  const read = readRerankReply(reply.content, candidates.length);
  if (!read.keep) return fallback("invalid_response", { trace: reply.trace, fault: read.fault, ...read.structure });
  const keep = read.keep;
  state.diagnostics.rerank = { model: rerank.model, candidates: candidates.length, kept: keep.length, abstained: keep.length === 0 };
  return keep.map((index) => candidates[index]).slice(0, state.request.limit);
}
