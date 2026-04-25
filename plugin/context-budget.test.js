const {
  getModelCapacity,
  getInjectionBudget,
  trimSections,
  trimAssembledInjection,
  ASSEMBLE_MAX_INJECTION_CHARS,
} = require("./context-budget");

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
  assert(budget.maxChars === 8000, `expected 8000, got ${budget.maxChars}`);
  assert(budget.maxTokens === 2000, `expected 2000, got ${budget.maxTokens}`);
  assert(budget.effectiveCapacity === 600000, `expected 600000, got ${budget.effectiveCapacity}`);
});

test("getInjectionBudget for gpt-4o is capped by INJECTION_CEILING", () => {
  const budget = getInjectionBudget("gpt-4o-mini");
  // Model budget would be 80000 * 0.12 * 4 = 38400 chars, ceiling caps it.
  assert(budget.maxChars === 8000, `expected 8000, got ${budget.maxChars}`);
  assert(budget.effectiveCapacity === 80000);
});

test("getInjectionBudget for unknown model returns default capped", () => {
  const budget = getInjectionBudget("unknown-model-xyz");
  assert(budget.effectiveCapacity === 75000, `expected 75000, got ${budget.effectiveCapacity}`);
  // Model budget would be 75000 * 0.10 * 4 = 30000, ceiling caps to 8000
  assert(budget.maxChars === 8000, `expected 8000, got ${budget.maxChars}`);
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

test("trimAssembledInjection returns input unchanged when under ceiling", () => {
  const result = trimAssembledInjection("short context", [{ role: "user", content: "hi" }], 1000);
  assert(result.convexContext === "short context", `expected unchanged convex, got ${result.convexContext}`);
  assert(result.localMessages.length === 1, `expected 1 local msg, got ${result.localMessages.length}`);
  assert(result.trimmedChars === 0, `expected 0 trimmed, got ${result.trimmedChars}`);
  assert(result.trimmedMessages === 0, `expected 0 trimmed msgs, got ${result.trimmedMessages}`);
});

test("trimAssembledInjection drops oldest local messages first when over ceiling", () => {
  const convex = "x".repeat(500);
  const locals = [
    { role: "user", content: "a".repeat(400) }, // oldest, should drop
    { role: "assistant", content: "b".repeat(400) }, // keeps
  ];
  const result = trimAssembledInjection(convex, locals, 1000);
  assert(result.injectedChars <= 1000, `expected <= 1000, got ${result.injectedChars}`);
  assert(result.localMessages.length === 1, `expected 1 kept, got ${result.localMessages.length}`);
  assert(result.localMessages[0].content === "b".repeat(400), "should keep the newer message");
  assert(result.trimmedMessages === 1, `expected 1 trimmed msg, got ${result.trimmedMessages}`);
  assert(result.trimmedChars === 400, `expected 400 trimmed chars, got ${result.trimmedChars}`);
});

test("trimAssembledInjection truncates convexContext after exhausting local messages", () => {
  const convex = "c".repeat(2000);
  const locals = [{ role: "user", content: "d".repeat(100) }];
  const result = trimAssembledInjection(convex, locals, 1000);
  assert(result.injectedChars <= 1000, `expected <= 1000, got ${result.injectedChars}`);
  assert(result.localMessages.length === 0, `expected all locals dropped, got ${result.localMessages.length}`);
  assert(result.convexContext.length === 1000, `expected convex truncated to 1000, got ${result.convexContext.length}`);
  assert(result.trimmedChars === 1100, `expected 1100 trimmed total, got ${result.trimmedChars}`);
});

test("trimAssembledInjection with 20000 injected chars and default ceiling returns <= 12000", () => {
  const convex = "a".repeat(12000);
  const locals = [
    { role: "user", content: "b".repeat(4000) },
    { role: "assistant", content: "c".repeat(4000) },
  ];
  const result = trimAssembledInjection(convex, locals, ASSEMBLE_MAX_INJECTION_CHARS);
  assert(result.injectedChars <= ASSEMBLE_MAX_INJECTION_CHARS, `expected <= ${ASSEMBLE_MAX_INJECTION_CHARS}, got ${result.injectedChars}`);
});

test("ASSEMBLE_MAX_INJECTION_CHARS is 12000", () => {
  assert(ASSEMBLE_MAX_INJECTION_CHARS === 12_000, `expected 12000, got ${ASSEMBLE_MAX_INJECTION_CHARS}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
