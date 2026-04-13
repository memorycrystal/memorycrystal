// crystal-assembler.js — Context assembly layer for Memory Crystal compaction
// Plain JavaScript ES module. No TypeScript.
import { estimateTokens } from "./crystal-summarizer.js";

/**
 * Number of most-recent raw messages always protected from summarization.
 * @type {number}
 */
export const FRESH_TAIL_COUNT = 8;

function resolveSummaryTokenCount(summary) {
  if (typeof summary.tokenCount === "number" && Number.isFinite(summary.tokenCount) && summary.tokenCount > 0) {
    return summary.tokenCount;
  }
  return estimateTokens(summary.content || "");
}

function resolveFreshTailOrdinal(contextItems, freshTailCount) {
  const count = typeof freshTailCount === "number" && Number.isFinite(freshTailCount) && freshTailCount > 0
    ? Math.floor(freshTailCount)
    : FRESH_TAIL_COUNT;
  const rawMessages = contextItems.filter(
    (item) => item.itemType === "message" && item.messageId != null,
  );
  if (rawMessages.length === 0) return Infinity;
  const tailStartIdx = Math.max(0, rawMessages.length - count);
  return rawMessages[tailStartIdx]?.ordinal ?? Infinity;
}

/**
 * Default max tokens for locally injected relevant summaries.
 * @type {number}
 */
export const LOCAL_SUMMARY_MAX_TOKENS = 2000;

/**
 * Extract a search query from the most recent user message in a payload.
 * Returns null if no user message is found.
 * @param {{role: string, content: string}[]} tailMessages
 * @returns {string|null}
 */
function extractUserQuery(tailMessages) {
  for (let i = tailMessages.length - 1; i >= 0; i--) {
    if (tailMessages[i].role === "user" && tailMessages[i].content) {
      return tailMessages[i].content;
    }
  }
  return null;
}

function shouldSkipRelevanceSearch(query) {
  if (!query || typeof query !== "string") {
    return "missing query";
  }

  if (query.trim().length < 10) {
    return "query too short";
  }

  const lines = query.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "missing query";

  const indentedLines = lines.filter((line) => /^[\t ]+/.test(line));
  if ((indentedLines.length / lines.length) > 0.5) {
    return "query looks like a code block";
  }

  return null;
}

/**
 * Assemble a budget-constrained context window for a session.
 * Always includes the last freshTailCount raw messages; fills remaining
 * budget with summaries (newest first) as XML-wrapped user messages.
 *
 * When the store supports searchSummariesByRelevance() and localSummaryInjection
 * is enabled, relevant local summaries are prepended to the context window.
 *
 * @param {object} store - Store with getContextItems, getMessageById, getSummary
 * @param {string} sessionKey
 * @param {number} tokenBudget
 * @param {number} [freshTailCount] - Override for fresh tail size (default: FRESH_TAIL_COUNT)
 * @param {object} [opts] - Optional config
 * @param {boolean} [opts.localSummaryInjection=true] - Enable relevance-based summary injection
 * @param {number}  [opts.localSummaryMaxTokens=2000] - Max tokens for injected summaries
 * @returns {Promise<{role: string, content: string}[]>}
 */
export async function assembleContext(store, sessionKey, tokenBudget, freshTailCount, opts) {
  if (!store) return [];
  const contextItems = await store.getContextItems(sessionKey);
  if (!contextItems || contextItems.length === 0) return [];

  const tailOrdinal = resolveFreshTailOrdinal(contextItems, freshTailCount);

  const tailItems = contextItems.filter(
    (item) => item.ordinal >= tailOrdinal && item.itemType === "message" && item.messageId != null,
  );

  const tailMessages = [];
  let tailTokens = 0;
  for (const item of tailItems) {
    const msg = await store.getMessageById(item.messageId);
    if (!msg) continue;
    const tc = typeof msg.tokenCount === "number" && Number.isFinite(msg.tokenCount) && msg.tokenCount > 0
      ? msg.tokenCount
      : estimateTokens(msg.content || "");
    tailMessages.push({ role: msg.role || "user", content: msg.content || "", tokens: tc });
    tailTokens += tc;
  }

  const summaryBudget = Math.max(0, tokenBudget - tailTokens);

  const summaryItems = contextItems.filter(
    (item) => item.ordinal < tailOrdinal && item.itemType === "summary" && item.summaryId != null,
  );

  const summaryMessages = [];
  let summaryTokensUsed = 0;
  const includedSummaryIds = new Set();
  for (let i = summaryItems.length - 1; i >= 0; i--) {
    const item = summaryItems[i];
    const summary = await store.getSummary(item.summaryId);
    if (!summary) continue;
    const tc = resolveSummaryTokenCount(summary);
    if (summaryTokensUsed + tc > summaryBudget) break;
    const xmlContent = `<crystal_summary id="${summary.summaryId}" kind="${summary.kind || "leaf"}" depth="${summary.depth ?? 0}">${summary.content}</crystal_summary>`;
    summaryMessages.unshift({ role: "user", content: xmlContent, tokens: tc });
    summaryTokensUsed += tc;
    includedSummaryIds.add(summary.summaryId);
  }

  // --- Relevance-based local summary injection ---
  const injectionEnabled = opts?.localSummaryInjection !== false;
  const maxInjectionTokens = typeof opts?.localSummaryMaxTokens === "number" && opts.localSummaryMaxTokens > 0
    ? opts.localSummaryMaxTokens
    : LOCAL_SUMMARY_MAX_TOKENS;

  const relevanceMessages = [];
  if (injectionEnabled && typeof store.searchSummariesByRelevance === "function") {
    const query = extractUserQuery(tailMessages);
    const skipReason = shouldSkipRelevanceSearch(query);
    if (skipReason) {
      console.debug(`[crystal-assembler] Skipping local summary injection: ${skipReason}`);
    } else if (query) {
      const relevant = await store.searchSummariesByRelevance(query, 10, sessionKey);
      let injectedTokens = 0;
      const snippets = [];
      for (const hit of relevant) {
        if (includedSummaryIds.has(hit.summaryId)) continue;
        const tc = typeof hit.tokenCount === "number" && hit.tokenCount > 0
          ? hit.tokenCount
          : estimateTokens(hit.content || "");
        if (injectedTokens + tc > maxInjectionTokens) continue;
        snippets.push(hit.content);
        injectedTokens += tc;
        includedSummaryIds.add(hit.summaryId);
      }
      if (snippets.length > 0) {
        relevanceMessages.push({
          role: "system",
          content: "Relevant context from earlier in this conversation:\n" + snippets.join("\n\n"),
        });
      }
    }
  }

  const result = [];
  for (const m of relevanceMessages) result.push({ role: m.role, content: m.content });
  for (const m of summaryMessages) result.push({ role: m.role, content: m.content });
  for (const m of tailMessages) result.push({ role: m.role, content: m.content });
  return result;
}

/**
 * Return a guidance string to inject into the system prompt when summaries are present.
 * Returns undefined if no summaries (nothing to inject).
 *
 * @param {number} summaryCount
 * @param {number} maxDepth
 * @returns {string|undefined}
 */
export function buildSystemPromptAddition(summaryCount, maxDepth) {
  if (!summaryCount || summaryCount <= 0) return undefined;
  const depthNote = maxDepth > 0
    ? ` (including ${maxDepth}-level condensed summaries)`
    : "";
  return [
    `This context includes ${summaryCount} crystal_summary block(s)${depthNote}.`,
    "These are compressed representations of earlier conversation history.",
    "Each crystal_summary may end with 'Expand for details about: ...' listing what was omitted.",
    "Treat them as factual prior context. Do not re-summarize or re-process them.",
  ].join(" ");
}
