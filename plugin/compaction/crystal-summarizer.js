// crystal-summarizer.js — LLM summarization layer for Memory Crystal compaction
// Plain JavaScript ES module. No TypeScript.

const SYS = "You are a context-compaction summarization engine. Follow user instructions exactly and return plain text summary content only.";
const FALLBACK_MAX_CHARS = 512 * 4;

/**
 * Estimate token count from a string (chars / 4, rounded up).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Format a Date into 'YYYY-MM-DD HH:MM TZ' using Intl, with UTC fallback.
 * @param {Date} value
 * @param {string} [timezone]
 * @returns {string}
 */
export function formatTimestamp(value, timezone) {
  timezone = timezone || "UTC";
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(value).map((p) => [p.type, p.value]));
    let tzAbbr = "UTC";
    if (timezone !== "UTC") {
      try {
        tzAbbr = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
          .formatToParts(value).find((p) => p.type === "timeZoneName")?.value ?? timezone;
      } catch { tzAbbr = timezone; }
    }
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${tzAbbr}`;
  } catch {
    const y = value.getUTCFullYear(), mo = String(value.getUTCMonth()+1).padStart(2,"0"),
          d = String(value.getUTCDate()).padStart(2,"0"), h = String(value.getUTCHours()).padStart(2,"0"),
          mi = String(value.getUTCMinutes()).padStart(2,"0");
    return `${y}-${mo}-${d} ${h}:${mi} UTC`;
  }
}

// ── Prompt builders ────────────────────────────────────────────────────────

const LEAF_REQS = `Output: plain text, no preamble/headings/markdown.\nTrack file ops with paths. If none: "Files: none".\nEnd with: "Expand for details about: <list>".\n`;
const LEAF_POLICY_NORMAL = "Policy: preserve decisions, rationale, constraints, active tasks. Remove filler.";
const LEAF_POLICY_AGGRESSIVE = "Policy: keep only durable facts, decisions, TODOs, blockers. Remove everything else.";

/**
 * Build a leaf-segment summarization prompt with timestamp narrative and Expand footer.
 * @param {string} text - Conversation segment
 * @param {string|undefined} prevSummary
 * @param {number} targetTokens
 * @returns {string}
 */
export function LEAF_PROMPT(text, prevSummary, targetTokens) {
  const prev = (prevSummary && prevSummary.trim()) || "(none)";
  return `Summarize this OpenClaw conversation SEGMENT for incremental memory compaction.\n${LEAF_POLICY_NORMAL}\n${LEAF_REQS}Target: ~${targetTokens} tokens.\n\n<previous_context>\n${prev}\n</previous_context>\n\n<conversation_segment>\n${text}\n</conversation_segment>`;
}

/**
 * Build a leaf prompt for aggressive mode (shorter target, facts-only).
 * @param {string} text
 * @param {string|undefined} prevSummary
 * @param {number} targetTokens
 * @returns {string}
 */
function LEAF_PROMPT_AGGRESSIVE(text, prevSummary, targetTokens) {
  const prev = (prevSummary && prevSummary.trim()) || "(none)";
  return `Summarize this OpenClaw conversation SEGMENT for incremental memory compaction.\n${LEAF_POLICY_AGGRESSIVE}\n${LEAF_REQS}Target: ~${targetTokens} tokens.\n\n<previous_context>\n${prev}\n</previous_context>\n\n<conversation_segment>\n${text}\n</conversation_segment>`;
}

/**
 * Build a condensed (multi-level) summarization prompt.
 * @param {string} text - Concatenated summaries to condense
 * @param {number} depth - Current depth (1=d1, 2=d2, 3+=d3+)
 * @param {number} targetTokens
 * @param {string|undefined} prevSummary - Prior context (depth 1 only)
 * @returns {string}
 */
export function CONDENSED_PROMPT(text, depth, targetTokens, prevSummary) {
  const expand = `End with: "Expand for details about: <list>". Target: ~${targetTokens} tokens.\n`;
  const wrap = `\n<conversation_to_condense>\n${text}\n</conversation_to_condense>`;
  if (depth <= 1) {
    const prev = prevSummary && prevSummary.trim();
    const prevBlock = prev
      ? `Do not repeat unchanged info from:\n<previous_context>\n${prev}\n</previous_context>`
      : "Focus on what matters for continuation:";
    return `Compact leaf summaries into a condensed memory node for a fresh model instance.\n${prevBlock}\nPreserve: decisions+rationale, superseded decisions, completed/in-progress tasks, blockers, identifiers.\nDrop: unchanged context, resolved dead ends, tool mechanics.\nTimeline with hour-level timestamps. Plain text.\n${expand}${wrap}`;
  }
  if (depth === 2) {
    return `Condense session-level summaries into a higher-level memory node.\nPreserve: active decisions+rationale, completed work, constraints, in-progress state.\nDrop: session-local ops, stale identifiers, superseded states.\nPlain text, brief headers ok. Timeline with dates.\n${expand}${wrap}`;
  }
  return `Create a high-level memory node from phase-level summaries. Keep only durable context.\nPreserve: key decisions, accomplishments, constraints, relationships, lessons.\nDrop: operational detail, method internals, non-essential references.\nPlain text. Brief date-range timeline.\n${expand}${wrap}`;
}

// ── Token target resolver ──────────────────────────────────────────────────

function resolveTargetTokens(inputTokens, aggressive, isCondensed, condensedTarget) {
  if (isCondensed) return Math.max(512, condensedTarget);
  if (aggressive) return Math.max(96, Math.min(640, Math.floor(inputTokens * 0.2)));
  return Math.max(192, Math.min(1200, Math.floor(inputTokens * 0.35)));
}

// ── OpenAI fetch helper ────────────────────────────────────────────────────

async function callOpenAI(baseUrl, apiKey, model, prompt, maxTokens, temperature) {
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYS }, { role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature,
      }),
    });
    if (!res.ok) { console.error(`[crystal-summarizer] OpenAI error: ${res.status}`); return null; }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch (err) {
    console.error(`[crystal-summarizer] callOpenAI failed: ${err?.message || err}`);
    return null;
  }
}

// ── createSummarizer ───────────────────────────────────────────────────────

/**
 * Factory returning async summarizeFn(text, aggressive, options) => Promise<string>.
 * 3-level escalation: normal LLM → aggressive LLM → deterministic truncation.
 *
 * @param {object} [config]
 * @param {string} [config.apiKey]
 * @param {string} [config.model]
 * @param {string} [config.baseUrl]
 * @param {number} [config.condensedTargetTokens]
 * @returns {Function}
 */
export function createSummarizer(config) {
  config = config || {};
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  const model = config.model || "gpt-4o-mini";
  const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const condensedTarget = config.condensedTargetTokens || 900;

  /**
   * Summarize text with 3-level escalation.
   * Level 1: normal; Level 2: aggressive (if L1 output >= input); Level 3: deterministic truncation.
   * @param {string} text
   * @param {boolean} [aggressive]
   * @param {object} [options]
   * @returns {Promise<string>}
   */
  return async function summarize(text, aggressive, options) {
    aggressive = aggressive === true;
    options = options || {};
    if (!text || !text.trim()) return "";

    const isCondensed = options.isCondensed === true;
    const depth = typeof options.depth === "number" && Number.isFinite(options.depth)
      ? Math.max(1, Math.floor(options.depth)) : 1;
    const prev = options.previousSummary;
    const inputTokens = estimateTokens(text);
    const target = resolveTargetTokens(inputTokens, aggressive, isCondensed, condensedTarget);
    const aggressiveTarget = resolveTargetTokens(inputTokens, true, isCondensed, condensedTarget);

    const buildPrompt = (agg) => isCondensed
      ? CONDENSED_PROMPT(text, depth, agg ? aggressiveTarget : target, prev)
      : (agg ? LEAF_PROMPT_AGGRESSIVE(text, prev, aggressiveTarget) : LEAF_PROMPT(text, prev, target));

    // Level 1: normal LLM call
    let result = await callOpenAI(baseUrl, apiKey, model, buildPrompt(false), target, 0.2);
    if (result) {
      if (estimateTokens(result) < inputTokens) return result;
      // Level 2: aggressive retry
      const retried = await callOpenAI(baseUrl, apiKey, model, buildPrompt(true), aggressiveTarget, 0.1);
      if (retried && estimateTokens(retried) < inputTokens) return retried;
    }

    // Level 3: deterministic fallback (~512 tokens)
    const truncated = text.length > FALLBACK_MAX_CHARS ? text.slice(0, FALLBACK_MAX_CHARS) : text;
    return `${truncated}\n[Truncated from ${inputTokens} tokens]`;
  };
}
