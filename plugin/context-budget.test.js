const { getModelCapacity, getInjectionBudget, trimSections } = require("./context-budget");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} — ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

console.log("context-budget tests:");

test("getInjectionBudget for claude-opus is capped by INJECTION_CEILING", () => {
  const budget = getInjectionBudget("claude-opus-4-6");
  // Model budget would be 600000 * 0.15 * 4 = 360000 chars, but the ceiling caps it.
  assert(budget.maxChars === 8000, `expected 16000, got ${budget.maxChars}`);
  assert(budget.maxTokens === 2000, `expected 4000, got ${budget.maxTokens}`);
  assert(budget.effectiveCapacity === 600000, `expected 600000, got ${budget.effectiveCapacity}`);
});

test("getInjectionBudget for gpt-4o is capped by INJECTION_CEILING", () => {
  const budget = getInjectionBudget("gpt-4o-mini");
  // Model budget would be 80000 * 0.12 * 4 = 38400 chars, ceiling caps it.
  assert(budget.maxChars === 8000, `expected 16000, got ${budget.maxChars}`);
  assert(budget.effectiveCapacity === 80000);
});

test("getInjectionBudget for unknown model returns default capped", () => {
  const budget = getInjectionBudget("unknown-model-xyz");
  assert(budget.effectiveCapacity === 75000, `expected 75000, got ${budget.effectiveCapacity}`);
  // Model budget would be 75000 * 0.10 * 4 = 30000, ceiling caps to 16000
  assert(budget.maxChars === 8000, `expected 16000, got ${budget.maxChars}`);
});

test("getInjectionBudget for empty string returns default", () => {
  const budget = getInjectionBudget("");
  assert(budget.effectiveCapacity === 75000);
});

test("all models are capped at the same ceiling", () => {
  const small = getInjectionBudget("gpt-4o");
  const large = getInjectionBudget("claude-opus-4");
  // Both hit the 16K ceiling — the injection budget is now display-safe.
  assert(small.maxChars === large.maxChars, `both should be capped at ceiling, got ${small.maxChars} vs ${large.maxChars}`);
  assert(small.maxChars === 8000);
});

test("getModelCapacity matches partial model names", () => {
  const opus = getModelCapacity("anthropic/claude-opus-4-6");
  assert(opus.effectiveTokens === 600000, `expected 600000, got ${opus.effectiveTokens}`);

  const codex = getModelCapacity("openai-codex/gpt-5.3-codex");
  // Should match gpt-5 or codex
  assert(codex.effectiveTokens >= 500000, `expected >= 500000, got ${codex.effectiveTokens}`);
});

test("trimSections returns all sections when under budget", () => {
  const sections = [
    { label: "A", text: "hello" },
    { label: "B", text: "world" },
  ];
  const result = trimSections(sections, 1000, ["A", "B"]);
  assert(result.length === 2);
});

test("trimSections drops lowest-priority first", () => {
  const sections = [
    { label: "Recent Context", text: "x".repeat(500) },
    { label: "Relevant Recall", text: "y".repeat(500) },
  ];
  const result = trimSections(sections, 600, ["Recent Context", "Relevant Recall"]);
  assert(result.length === 1, `expected 1, got ${result.length}`);
  assert(result[0].label === "Relevant Recall", `expected Relevant Recall, got ${result[0].label}`);
});

test("trimSections drops multiple sections if needed", () => {
  const sections = [
    { label: "A", text: "x".repeat(300) },
    { label: "B", text: "y".repeat(300) },
    { label: "C", text: "z".repeat(300) },
  ];
  const result = trimSections(sections, 350, ["A", "B", "C"]);
  assert(result.length === 1, `expected 1, got ${result.length}`);
  assert(result[0].label === "C");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
