// pressure-log.js — rate-limited pressure-event telemetry for Crystal's
// assemble() byte budget, plus host-compact attribution counters.
//
// Schema emitted (single JSON-encoded log line per event):
//   {
//     kind: "crystal_pressure",
//     session, est_tokens, ceiling, action,
//     hostCompactInvoked,          // bool — did the host invoke compact()
//                                  // at least once since the last pressure event?
//     hostCompactTokensReclaimed,  // total tokens reclaimed by host-invoked
//                                  // compaction in the same interval
//     suppressed_since_last,       // N rate-limited events we didn't log
//     ts                           // epoch ms
//   }
//
// Rate limit: at most one log line per session per PRESSURE_EVENT_MIN_INTERVAL_MS
// (60_000 ms). Suppressed events bump an aggregate counter that flushes on the
// next successful log. This exists to prevent hot sessions from flooding logs
// while still reporting that pressure happened.

const PRESSURE_EVENT_MIN_INTERVAL_MS = 60_000;

// Long-running gateway processes accumulate a map entry for every session that
// ever triggered pressure or host-compact attribution. Without eviction the maps
// grow until the process restarts. Each entry is tiny (~100 bytes) so the real
// risk is gradual: weeks-long gateway uptime with thousands of distinct sessions
// would slowly bloat heap without any individual leak being visible.
//
// Policy:
//   - Cap each map at MAX_SESSION_MAP_SIZE entries.
//   - When the cap is reached, evict in two passes:
//     (1) drop every entry whose lastAt is older than PRESSURE_STATE_MAX_AGE_MS.
//     (2) if still over cap, delete oldest entries (smallest lastAt) until under cap.
//   - Eviction runs lazily on write — no timers, no background work.
const MAX_SESSION_MAP_SIZE = 500;
const PRESSURE_STATE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

const pressureEventState = new Map(); // sessionKey -> { lastAt, suppressed }
const hostCompactState = new Map(); // sessionKey -> { invoked, tokensReclaimed, lastAt }

function evictIfOverCap(map, now) {
  if (map.size < MAX_SESSION_MAP_SIZE) return;
  // Pass 1: drop stale entries. `lastAt: 0` is treated as epoch (definitely
  // stale once we're past PRESSURE_STATE_MAX_AGE_MS), so we do NOT short-circuit
  // on falsy lastAt — that would leave seeded-at-0 entries stuck forever.
  for (const [key, value] of map) {
    const lastAt = Number(value?.lastAt) || 0;
    if (now - lastAt > PRESSURE_STATE_MAX_AGE_MS) {
      map.delete(key);
    }
  }
  if (map.size < MAX_SESSION_MAP_SIZE) return;
  // Pass 2: oldest-first until under cap. Map iteration order is insertion
  // order, so the earliest-inserted key is first — we favor that as a proxy
  // for oldest-active.
  const toDrop = map.size - MAX_SESSION_MAP_SIZE + 1;
  let dropped = 0;
  for (const key of map.keys()) {
    if (dropped >= toDrop) break;
    map.delete(key);
    dropped += 1;
  }
}

function recordHostCompact(sessionKey, tokensReclaimed, now = Date.now()) {
  const key = String(sessionKey || "default");
  const cur = hostCompactState.get(key) || { invoked: 0, tokensReclaimed: 0, lastAt: 0 };
  cur.invoked += 1;
  cur.lastAt = now;
  if (Number.isFinite(Number(tokensReclaimed))) {
    cur.tokensReclaimed += Math.max(0, Math.floor(Number(tokensReclaimed)));
  }
  hostCompactState.set(key, cur);
  evictIfOverCap(hostCompactState, now);
}

function consumeHostCompact(sessionKey) {
  const key = String(sessionKey || "default");
  const cur = hostCompactState.get(key) || { invoked: 0, tokensReclaimed: 0, lastAt: 0 };
  hostCompactState.set(key, { invoked: 0, tokensReclaimed: 0, lastAt: cur.lastAt });
  return cur;
}

function emitPressureEvent({ sessionKey, estTokens, ceiling, action, logger, now = Date.now() }) {
  const key = String(sessionKey || "default");
  const state = pressureEventState.get(key) || { lastAt: null, suppressed: 0 };
  if (state.lastAt !== null && now - state.lastAt < PRESSURE_EVENT_MIN_INTERVAL_MS) {
    state.suppressed += 1;
    pressureEventState.set(key, state);
    return { logged: false, suppressed: state.suppressed };
  }
  const hostAttribution = consumeHostCompact(key);
  const suppressed = state.suppressed;
  const event = {
    kind: "crystal_pressure",
    session: key,
    est_tokens: Math.max(0, Math.floor(Number(estTokens) || 0)),
    ceiling: Math.max(0, Math.floor(Number(ceiling) || 0)),
    action: String(action || "observe"),
    hostCompactInvoked: hostAttribution.invoked > 0,
    hostCompactTokensReclaimed: hostAttribution.tokensReclaimed,
    suppressed_since_last: suppressed,
    ts: now,
  };
  try {
    (logger?.info || logger?.log || console.log)(`[crystal] pressure ${JSON.stringify(event)}`);
  } catch {
    // Logging must never throw.
  }
  pressureEventState.set(key, { lastAt: now, suppressed: 0 });
  evictIfOverCap(pressureEventState, now);
  return { logged: true, event };
}

function __resetForTests() {
  pressureEventState.clear();
  hostCompactState.clear();
}

function __inspectForTests() {
  return {
    pressureEventSize: pressureEventState.size,
    hostCompactSize: hostCompactState.size,
    MAX_SESSION_MAP_SIZE,
    PRESSURE_STATE_MAX_AGE_MS,
  };
}

module.exports = {
  PRESSURE_EVENT_MIN_INTERVAL_MS,
  MAX_SESSION_MAP_SIZE,
  PRESSURE_STATE_MAX_AGE_MS,
  emitPressureEvent,
  recordHostCompact,
  consumeHostCompact,
  __resetForTests,
  __inspectForTests,
};
