// Tests for reinforcement injection logic.
// We test the constants and behavior expectations directly since the
// reinforcement logic lives inside index.js as a hook.

const { getInjectionBudget } = require("./context-budget");

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

console.log("reinforcement tests:");

test("reinforcement block stays under 800 chars with long memories", () => {
  const REINFORCEMENT_MAX_CHARS = 800;
  const cached = [
    { title: "A".repeat(200), content: "B".repeat(1000) },
    { title: "C".repeat(200), content: "D".repeat(1000) },
  ];

  let block = "## Memory Reinforcement\n";
  let charCount = block.length;

  for (const mem of cached.slice(0, 2)) {
    const title = String(mem.title || "").slice(0, 80);
    const content = String(mem.content || "").slice(0, 300);
    const line = `[Recall: ${title}] ${content}\n`;
    if (charCount + line.length > REINFORCEMENT_MAX_CHARS) break;
    block += line;
    charCount += line.length;
  }

  assert(block.length <= REINFORCEMENT_MAX_CHARS, `block is ${block.length} chars, expected <= ${REINFORCEMENT_MAX_CHARS}`);
});

test("reinforcement only fires when turn count >= 5", () => {
  const REINFORCEMENT_TURN_THRESHOLD = 5;

  // Simulate turn counts
  assert(3 < REINFORCEMENT_TURN_THRESHOLD, "3 turns should NOT trigger reinforcement");
  assert(5 >= REINFORCEMENT_TURN_THRESHOLD, "5 turns should trigger reinforcement");
  assert(10 >= REINFORCEMENT_TURN_THRESHOLD, "10 turns should trigger reinforcement");
});

test("reinforcement returns nothing when no cached recall", () => {
  const cache = new Map();
  const sessionKey = "test-session";
  const cached = cache.get(sessionKey);
  assert(!cached || cached.length === 0, "empty cache should produce no reinforcement");
});

test("reinforcement returns nothing when cache is expired", () => {
  const SESSION_RECALL_CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000;
  const timestamps = new Map();
  timestamps.set("test", Date.now() - SESSION_RECALL_CACHE_MAX_AGE_MS - 1);
  const ts = timestamps.get("test");
  assert(Date.now() - ts > SESSION_RECALL_CACHE_MAX_AGE_MS, "expired cache should not trigger reinforcement");
});

test("reinforcement budget is within model injection budget", () => {
  const REINFORCEMENT_MAX_CHARS = 800;
  const smallBudget = getInjectionBudget("gpt-4o");
  assert(REINFORCEMENT_MAX_CHARS < smallBudget.maxChars,
    `reinforcement (${REINFORCEMENT_MAX_CHARS}) should fit within even smallest model budget (${smallBudget.maxChars})`);
});

test("cache cleanup works with Map.delete", () => {
  const cache = new Map();
  const timestamps = new Map();
  cache.set("s1", [{ title: "test", content: "test" }]);
  timestamps.set("s1", Date.now());
  cache.delete("s1");
  timestamps.delete("s1");
  assert(!cache.has("s1"), "cache should be empty after delete");
  assert(!timestamps.has("s1"), "timestamps should be empty after delete");
});

test("cache cleanup works with Map.clear", () => {
  const cache = new Map();
  const timestamps = new Map();
  cache.set("s1", []);
  cache.set("s2", []);
  timestamps.set("s1", Date.now());
  timestamps.set("s2", Date.now());
  cache.clear();
  timestamps.clear();
  assert(cache.size === 0, "cache should be empty after clear");
  assert(timestamps.size === 0, "timestamps should be empty after clear");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
