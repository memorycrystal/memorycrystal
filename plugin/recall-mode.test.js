const { __test__ } = require("./index");
const { shouldFetchConvexContext } = __test__;

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

console.log("recall-mode tests:");

// Regression guard for the 2026-04-15 incident where assemble() gated
// Convex recall on mode === "full". Under the shipped default
// (localSummaryInjection off, localStoreEnabled off), getContextEngineMode
// returns "reduced", so Crystal was silently skipping per-turn recall and
// coach agents answered from training-data inference instead of KB content.
// These tests lock in the contract that only "hook-only" skips recall.

test('mode="full" fetches Convex context', () => {
  assert(shouldFetchConvexContext("full") === true, "full must fetch");
});

test('mode="reduced" fetches Convex context (this is THE regression guard)', () => {
  assert(shouldFetchConvexContext("reduced") === true,
    "reduced MUST fetch. If this fails, coach agents on default installs stop getting per-turn recall.");
});

test('mode="hook-only" skips Convex context', () => {
  assert(shouldFetchConvexContext("hook-only") === false, "hook-only skips");
});

test("unknown / empty mode still fetches (fail open)", () => {
  assert(shouldFetchConvexContext("") === true, "empty string fetches");
  assert(shouldFetchConvexContext(undefined) === true, "undefined fetches");
  assert(shouldFetchConvexContext("some-new-mode") === true, "unknown fetches");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
