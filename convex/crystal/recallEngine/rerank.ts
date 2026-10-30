import { logError } from "../crypto";
import { dropRecentMemoryIds } from "./scope";
import type { RecallRuntime, RerankFallbackReason, RerankReply } from "./types";

/** The most ranked memories the model is shown. */
export const RECALL_RERANK_CANDIDATES = 12;
/** Content excerpt per candidate, in code points. */
const EXCERPT_CODE_POINTS = 400;

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

/**
 * The candidate indices the model kept, best first, or null when the reply is not the requested JSON. Unknown,
 * duplicate and out-of-range indices are dropped; a non-empty list with no valid index is not an abstention.
 */
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

export function parseRerankReply(content: string, count: number): number[] | null {
  const parsed = parseLenientJson(content);
  const keep = (parsed as { keep?: unknown } | null)?.keep;
  if (!Array.isArray(keep)) return null;
  const indices: number[] = [];
  for (const value of keep) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < count && !indices.includes(value)) {
      indices.push(value);
    }
  }
  return keep.length > 0 && indices.length === 0 ? null : indices;
}

/**
 * Ask the configured model which composed memories help answer the query and return those, in its order, up to the
 * request limit. Any failure returns the ranked memories the request would return without the stage and marks a
 * recoverable degradation.
 */
export async function rerankMemories(state: RecallRuntime, composed: any[]): Promise<any[]> {
  const rerank = state.ports.rerank!;
  const unchecked = dropRecentMemoryIds(composed.slice(0, state.request.limit), state.request.recentMemoryIds);
  const candidates = dropRecentMemoryIds(composed, state.request.recentMemoryIds).slice(0, RECALL_RERANK_CANDIDATES);
  if (candidates.length === 0) return unchecked;
  const fallback = (reason: RerankFallbackReason): any[] => {
    state.degradation.mark({
      code: "rerank_unavailable",
      message: "The answer check was unavailable; memories are in ranked order and were not checked against the query.",
      recoverable: true,
      affectedStage: "rerank",
      reason,
    });
    state.diagnostics.rerank = { model: rerank.model, candidates: candidates.length, kept: 0, abstained: false, fallbackReason: reason };
    return unchecked;
  };
  if (state.recallBudget?.emergency) return fallback("cost_budget_exceeded");
  const reply: RerankReply = await state.timer
    .measure("rerank", () => rerank.complete(buildRerankPrompt(state.request.query, candidates)))
    .catch(async (err: unknown) => {
      console.error("[recall] rerank_unavailable:", await logError(err, state.ports.userId));
      return { ok: false, reason: "provider_error" };
    });
  if (!reply.ok) return fallback(reply.reason);
  const keep = parseRerankReply(reply.content, candidates.length);
  if (!keep) return fallback("invalid_response");
  state.diagnostics.rerank = { model: rerank.model, candidates: candidates.length, kept: keep.length, abstained: keep.length === 0 };
  return keep.map((index) => candidates[index]).slice(0, state.request.limit);
}
