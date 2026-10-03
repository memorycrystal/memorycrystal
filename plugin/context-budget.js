// context-budget.js — Model-aware injection budget calculator
//
// Memory Crystal injects context (recall results, recent messages, etc.) into
// the agent's system prompt. This module ensures we don't blow past the model's
// effective context capacity. Research shows effective capacity is ~60-70% of
// advertised max, and past that hallucination climbs.

const MODEL_EFFECTIVE_CAPACITY = {
  "claude-opus": { maxTokens: 1000000, effectiveTokens: 600000, safeInjectionPct: 0.15 },
  "claude-sonnet": { maxTokens: 1000000, effectiveTokens: 500000, safeInjectionPct: 0.15 },
  "claude-haiku": { maxTokens: 200000, effectiveTokens: 120000, safeInjectionPct: 0.12 },
  "gpt-5": { maxTokens: 1000000, effectiveTokens: 500000, safeInjectionPct: 0.15 },
  "gpt-4.1": { maxTokens: 1000000, effectiveTokens: 500000, safeInjectionPct: 0.15 },
  "gpt-4o": { maxTokens: 128000, effectiveTokens: 80000, safeInjectionPct: 0.12 },
  "gemini-2.5-pro": { maxTokens: 1000000, effectiveTokens: 500000, safeInjectionPct: 0.15 },
  "gemini-2.5-flash": { maxTokens: 1000000, effectiveTokens: 400000, safeInjectionPct: 0.12 },
  "gemini-3-pro": { maxTokens: 2000000, effectiveTokens: 800000, safeInjectionPct: 0.15 },
  "gemini-3-flash": { maxTokens: 1000000, effectiveTokens: 400000, safeInjectionPct: 0.12 },
  codex: { maxTokens: 1000000, effectiveTokens: 500000, safeInjectionPct: 0.15 },
  default: { maxTokens: 128000, effectiveTokens: 75000, safeInjectionPct: 0.10 },
};

function getModelCapacity(modelName) {
  const normalized = String(modelName || "").toLowerCase();
  for (const [key, capacity] of Object.entries(MODEL_EFFECTIVE_CAPACITY)) {
    if (key === "default") continue;
    if (normalized.includes(key)) return capacity;
  }
  return MODEL_EFFECTIVE_CAPACITY.default;
}

// Hard ceiling on injected context so the host agent's compaction engine keeps
// enough headroom. Without this, a 500k-token model at 15% injection = 75k tokens
// = 300k chars — more than enough to trigger "Context limit exceeded" in OpenClaw
// once the conversation itself grows past the remaining capacity. 12.5k chars
// (~3.1k tokens) fits the default recall window of 12 memories x 800 preview
// chars (9,600 chars) plus wake-briefing headroom + recent messages + skills,
// while still leaving the vast majority of the window for the actual conversation.
const INJECTION_CEILING_CHARS = 12_500;

// One-line per-turn reminder appended to recall payloads (ILL-173). Kept short
// so it competes for the same injection budget without displacing memories.
const DISCIPLINE_FOOTER =
  "Memory Crystal: recall first (crystal_recall); remember durable facts (crystal_remember); preflight before risky changes.";
const DISCIPLINE_FOOTER_SEPARATOR = "\n\n";
const DISCIPLINE_TRIM_MARKER = "\n\n_[Memory context trimmed to fit model budget]_";

// Hard ceiling for the ContextEngine `assemble()` callback specifically. Applies
// to convexContext (injected system message) + localMessages combined, not the
// tail of raw conversation messages. ~15000 chars ≈ 3750 tokens, which leaves
// ample room for the host's own transcript + compaction headroom on hot sessions
// while accommodating the larger recall window (up to 12 memories by default).
// See docs/release-prompt.md + .omc/plans/find-and-fix-bugs-2026-04-15.md.
const ASSEMBLE_MAX_INJECTION_CHARS = 15_000;
const ASSEMBLE_PRESSURE_FRACTION = 0.6;

function getInjectionBudget(modelName) {
  const cap = getModelCapacity(modelName);
  const modelBudget = Math.floor(cap.effectiveTokens * cap.safeInjectionPct) * 4;
  const maxChars = Math.min(modelBudget, INJECTION_CEILING_CHARS);
  return {
    maxChars,
    maxTokens: Math.floor(maxChars / 4),
    model: modelName,
    effectiveCapacity: cap.effectiveTokens,
  };
}

/**
 * Trims an array of labeled sections to fit within a character budget.
 * Drops lowest-priority sections first.
 *
 * @param {Array<{label: string, text: string}>} sections - Sections to trim
 * @param {number} maxChars - Maximum total characters
 * @param {string[]} dropOrder - Labels ordered from lowest to highest priority
 * @returns {Array<{label: string, text: string}>} Trimmed sections
 */
function trimSections(sections, maxChars, dropOrder) {
  let totalChars = sections.reduce((sum, s) => sum + s.text.length, 0);
  if (totalChars <= maxChars) return sections;

  const result = [...sections];
  for (const label of dropOrder) {
    // Drop ALL sections matching this label (handles duplicate labels)
    for (let i = result.length - 1; i >= 0; i--) {
      if (totalChars <= maxChars) break;
      if (result[i].label === label) {
        totalChars -= result[i].text.length;
        result.splice(i, 1);
      }
    }
    if (totalChars <= maxChars) break;
  }
  return result;
}

/**
 * Append the one-line discipline footer, reserving its characters from maxChars
 * so the combined payload stays within the injection budget.
 *
 * @param {string} payload - Recall / injection text (may be empty)
 * @param {number} maxChars - Maximum total characters including the footer
 * @returns {string} Payload with footer, trimmed to maxChars
 */
function applyDisciplineFooter(payload, maxChars) {
  const footer = DISCIPLINE_FOOTER;
  const body = typeof payload === "string" ? payload.trim() : "";
  const ceiling = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : footer.length;
  if (ceiling < footer.length) return footer.slice(0, Math.max(0, ceiling));
  const separator = body ? DISCIPLINE_FOOTER_SEPARATOR : "";
  const bodyBudget = Math.max(0, ceiling - footer.length - separator.length);
  let trimmedBody = body;
  if (body.length > bodyBudget) {
    if (bodyBudget <= 0) {
      trimmedBody = "";
    } else if (bodyBudget > DISCIPLINE_TRIM_MARKER.length) {
      trimmedBody = body.slice(0, bodyBudget - DISCIPLINE_TRIM_MARKER.length) + DISCIPLINE_TRIM_MARKER;
    } else {
      trimmedBody = body.slice(0, bodyBudget);
    }
  }
  const combined = trimmedBody ? `${trimmedBody}${separator}${footer}` : footer;
  return combined.length > ceiling ? combined.slice(0, ceiling) : combined;
}

/**
 * Trim the assemble-path injection (system message + local messages) to the
 * hard ceiling. Drops oldest local messages first, then truncates convexContext.
 * Pure function — no logging, no side effects.
 *
 * @param {string} convexContext - Rendered Convex context string (may be empty)
 * @param {Array<{role: string, content: any}>} localMessages - Local store messages
 * @param {number} [ceiling=ASSEMBLE_MAX_INJECTION_CHARS] - Max combined chars
 * @returns {{ convexContext: string, localMessages: Array, trimmedChars: number, trimmedMessages: number, injectedChars: number }}
 */
function trimAssembledInjection(convexContext, localMessages, ceiling = ASSEMBLE_MAX_INJECTION_CHARS) {
  const charsOf = (msg) => {
    const c = msg?.content;
    if (typeof c === "string") return c.length;
    if (c == null) return 0;
    try { return JSON.stringify(c).length; } catch { return 0; }
  };
  let convex = typeof convexContext === "string" ? convexContext : "";
  let locals = Array.isArray(localMessages) ? [...localMessages] : [];
  let trimmedChars = 0;
  let trimmedMessages = 0;
  const total = () => convex.length + locals.reduce((n, m) => n + charsOf(m), 0);
  while (total() > ceiling && locals.length > 0) {
    const dropped = locals.shift();
    trimmedChars += charsOf(dropped);
    trimmedMessages += 1;
  }
  if (total() > ceiling) {
    const overflow = total() - ceiling;
    const keep = Math.max(0, convex.length - overflow);
    trimmedChars += convex.length - keep;
    convex = convex.slice(0, keep);
  }
  return {
    convexContext: convex,
    localMessages: locals,
    trimmedChars,
    trimmedMessages,
    injectedChars: total(),
  };
}

module.exports = {
  MODEL_EFFECTIVE_CAPACITY,
  getModelCapacity,
  getInjectionBudget,
  trimSections,
  trimAssembledInjection,
  applyDisciplineFooter,
  DISCIPLINE_FOOTER,
  ASSEMBLE_MAX_INJECTION_CHARS,
  ASSEMBLE_PRESSURE_FRACTION,
  INJECTION_CEILING_CHARS,
};
