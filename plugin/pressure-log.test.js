const {
  emitPressureEvent,
  recordHostCompact,
  consumeHostCompact,
  __resetForTests,
  __inspectForTests,
  PRESSURE_EVENT_MIN_INTERVAL_MS,
  MAX_SESSION_MAP_SIZE,
  PRESSURE_STATE_MAX_AGE_MS,
} = require("./pressure-log");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    __resetForTests();
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

function silentLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(line),
  };
}

console.log("pressure-log tests:");

test("single call logs once with expected schema", () => {
  const logger = silentLogger();
  const result = emitPressureEvent({
    sessionKey: "sess-1",
    estTokens: 1500,
    ceiling: 12000,
    action: "observe",
    logger,
    now: 1000,
  });
  assert(result.logged === true, "should have logged");
  assert(result.event.session === "sess-1", "session");
  assert(result.event.est_tokens === 1500, "est_tokens");
  assert(result.event.ceiling === 12000, "ceiling");
  assert(result.event.action === "observe", "action");
  assert(result.event.hostCompactInvoked === false, "no host compact yet");
  assert(result.event.hostCompactTokensReclaimed === 0, "no tokens reclaimed");
  assert(result.event.suppressed_since_last === 0, "no suppressed");
  assert(result.event.kind === "crystal_pressure", "kind");
  assert(logger.lines.length === 1, `expected 1 log line, got ${logger.lines.length}`);
});

test("10 rapid calls on same session produce exactly 1 log line plus suppressed counter of 9", () => {
  const logger = silentLogger();
  let loggedCount = 0;
  let lastSuppressed = 0;
  for (let i = 0; i < 10; i++) {
    const r = emitPressureEvent({
      sessionKey: "sess-2",
      estTokens: 1500,
      ceiling: 12000,
      action: "observe",
      logger,
      now: 1000 + i * 100, // 100ms apart, well under 60s interval
    });
    if (r.logged) loggedCount += 1;
    else lastSuppressed = r.suppressed;
  }
  assert(loggedCount === 1, `expected exactly 1 logged, got ${loggedCount}`);
  assert(lastSuppressed === 9, `expected 9 suppressed, got ${lastSuppressed}`);
  assert(logger.lines.length === 1, `expected 1 log line, got ${logger.lines.length}`);
});

test("next call after rate-limit window logs again with suppressed_since_last populated", () => {
  const logger = silentLogger();
  // Burst of 5 within window
  for (let i = 0; i < 5; i++) {
    emitPressureEvent({ sessionKey: "sess-3", estTokens: 1500, ceiling: 12000, action: "observe", logger, now: 1000 + i });
  }
  // Now advance past rate limit
  const r = emitPressureEvent({
    sessionKey: "sess-3",
    estTokens: 2000,
    ceiling: 12000,
    action: "trim",
    logger,
    now: 1000 + PRESSURE_EVENT_MIN_INTERVAL_MS + 1,
  });
  assert(r.logged === true, "should log after interval");
  assert(r.event.suppressed_since_last === 4, `expected 4 suppressed flushed, got ${r.event.suppressed_since_last}`);
  assert(r.event.action === "trim", "action carried through");
  assert(logger.lines.length === 2, `expected 2 log lines total, got ${logger.lines.length}`);
});

test("host compact counters attributed to the next pressure event and reset after", () => {
  const logger = silentLogger();
  recordHostCompact("sess-4", 2048);
  recordHostCompact("sess-4", 512);
  const r = emitPressureEvent({
    sessionKey: "sess-4",
    estTokens: 3000,
    ceiling: 12000,
    action: "observe",
    logger,
    now: 5000,
  });
  assert(r.event.hostCompactInvoked === true, "should report host invoked");
  assert(r.event.hostCompactTokensReclaimed === 2560, `expected 2560, got ${r.event.hostCompactTokensReclaimed}`);
  // Counters consumed — next observable should see zero
  const after = consumeHostCompact("sess-4");
  assert(after.invoked === 0, `expected invoked=0 after emit, got ${after.invoked}`);
  assert(after.tokensReclaimed === 0, `expected tokensReclaimed=0 after emit, got ${after.tokensReclaimed}`);
});

test("different sessions are rate-limited independently", () => {
  const logger = silentLogger();
  const a = emitPressureEvent({ sessionKey: "a", estTokens: 1000, ceiling: 12000, action: "observe", logger, now: 1000 });
  const b = emitPressureEvent({ sessionKey: "b", estTokens: 1000, ceiling: 12000, action: "observe", logger, now: 1000 });
  assert(a.logged === true, "a logged");
  assert(b.logged === true, "b logged (independent session)");
  assert(logger.lines.length === 2, "2 log lines");
});

test("schema contains exactly the required keys", () => {
  const logger = silentLogger();
  const r = emitPressureEvent({ sessionKey: "sess-schema", estTokens: 100, ceiling: 200, action: "trim", logger, now: 1000 });
  const expected = ["kind", "session", "est_tokens", "ceiling", "action", "hostCompactInvoked", "hostCompactTokensReclaimed", "suppressed_since_last", "ts"];
  const actual = Object.keys(r.event).sort();
  for (const k of expected) {
    assert(actual.includes(k), `missing key ${k}`);
  }
  assert(actual.length === expected.length, `unexpected keys: ${actual.join(",")}`);
});

// Regression: unbounded Map growth. Long-running gateway processes previously
// accumulated one map entry per session forever; now the maps are LRU-capped.
test("pressureEventState stays ≤ MAX_SESSION_MAP_SIZE across many unique sessions", () => {
  const logger = silentLogger();
  const total = MAX_SESSION_MAP_SIZE + 100;
  for (let i = 0; i < total; i++) {
    // Each call a minute apart so new sessions always log (no suppression).
    emitPressureEvent({
      sessionKey: `bulk-${i}`,
      estTokens: 1500,
      ceiling: 12000,
      action: "observe",
      logger,
      now: i * (PRESSURE_EVENT_MIN_INTERVAL_MS + 1),
    });
  }
  const { pressureEventSize } = __inspectForTests();
  assert(
    pressureEventSize <= MAX_SESSION_MAP_SIZE,
    `expected ≤ ${MAX_SESSION_MAP_SIZE}, got ${pressureEventSize}`
  );
});

test("hostCompactState stays ≤ MAX_SESSION_MAP_SIZE across many unique sessions", () => {
  const total = MAX_SESSION_MAP_SIZE + 100;
  for (let i = 0; i < total; i++) {
    recordHostCompact(`host-${i}`, 1024, i * 1000);
  }
  const { hostCompactSize } = __inspectForTests();
  assert(
    hostCompactSize <= MAX_SESSION_MAP_SIZE,
    `expected ≤ ${MAX_SESSION_MAP_SIZE}, got ${hostCompactSize}`
  );
});

test("stale pressure entries (older than PRESSURE_STATE_MAX_AGE_MS) are evicted when over cap", () => {
  const logger = silentLogger();
  // Seed cap worth of "old" entries at t=0
  for (let i = 0; i < MAX_SESSION_MAP_SIZE; i++) {
    emitPressureEvent({
      sessionKey: `old-${i}`,
      estTokens: 100,
      ceiling: 12000,
      action: "observe",
      logger,
      now: 0,
    });
  }
  // Advance past max-age and write one more — should evict the stale cohort.
  const tFuture = PRESSURE_STATE_MAX_AGE_MS + 5_000;
  emitPressureEvent({
    sessionKey: "fresh-entry",
    estTokens: 100,
    ceiling: 12000,
    action: "observe",
    logger,
    now: tFuture,
  });
  const { pressureEventSize } = __inspectForTests();
  assert(
    pressureEventSize <= MAX_SESSION_MAP_SIZE,
    `expected ≤ ${MAX_SESSION_MAP_SIZE} after stale-eviction, got ${pressureEventSize}`
  );
  // A bulk majority of the old entries should have been purged in pass 1.
  assert(
    pressureEventSize < MAX_SESSION_MAP_SIZE / 2,
    `expected stale eviction to reclaim most entries, still have ${pressureEventSize}`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
