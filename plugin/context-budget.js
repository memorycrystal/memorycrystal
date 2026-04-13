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
// once the conversation itself grows past the remaining capacity. 16k chars (~4k
// tokens) is plenty for 8–10 recalled memories + recent messages + skills and
// leaves the vast majority of the window for the actual conversation.
const INJECTION_CEILING_CHARS = 8_000;

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

module.exports = { MODEL_EFFECTIVE_CAPACITY, getModelCapacity, getInjectionBudget, trimSections };
