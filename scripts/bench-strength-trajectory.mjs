#!/usr/bin/env node
/**
 * bench-strength-trajectory.mjs — ILL-103 reinforcement/decay equilibrium demo.
 *
 * Simulates a memory's `strength` over a sequence of recalls at different
 * cadences using the REAL model (convex/crystal/decayModel.ts: reinforceOnRecall
 * = lazy idle-decay then bounded reinforcement). Prints the trajectory table and
 * asserts the three acceptance-criteria behaviours:
 *   - AC-1: a frequently-used memory rises monotonically-with-diminishing-returns
 *           and never exceeds the 1.0 ceiling.
 *   - AC-3: strength settles into a STABLE BAND whose level reflects cadence
 *           (daily high, few-day mid, weekly low) — equilibrium, not runaway.
 *   - AC-2: an idle (never-recalled) memory fades via the decay half.
 *
 * Deterministic and offline. Run: `npm run bench:strength`.
 */
import { computeDecay, reinforceOnRecall, MAX_ACCESS_DECAY, DEFAULT_REINFORCE_ALPHA }
  from "../convex/crystal/decayModel.ts";

const STEPS = 80;
const CONFIDENCE = 0.9;

// Reinforced trajectory at a fixed recall cadence (days between recalls).
const reinforceSeries = (initial, cadenceDays) => {
  let strength = initial;
  let accessCount = 0;
  const series = [strength];
  for (let i = 0; i < STEPS; i += 1) {
    strength = reinforceOnRecall({
      strength, ageDays: cadenceDays, accessCount,
      valence: 0, arousal: 0, confidence: CONFIDENCE,
    });
    accessCount += 1;
    series.push(strength);
  }
  return series;
};

// Idle trajectory: never recalled, so only the decay half acts, over growing age.
const idleSeries = (initial) => {
  const series = [];
  for (let day = 0; day <= STEPS; day += 1) {
    series.push(computeDecay(initial, day, 0, 0, 0));
  }
  return series;
};

const daily = reinforceSeries(0.4, 1);
const every3 = reinforceSeries(0.4, 3);
const weekly = reinforceSeries(0.4, 7);
const idle = idleSeries(0.7);

const band = (s) => {
  const tail = s.slice(-5);
  return { last: s[s.length - 1], lo: Math.min(...tail), hi: Math.max(...tail) };
};

console.log(`Strength trajectory — reinforceOnRecall (alpha=${DEFAULT_REINFORCE_ALPHA}, maxAccessDecay=${MAX_ACCESS_DECAY})\n`);
console.log(`${"recall#".padEnd(8)}${"daily".padStart(9)}${"every-3d".padStart(10)}${"weekly".padStart(9)}${"idle(day)".padStart(11)}`);
for (const i of [0, 1, 2, 5, 10, 20, 40, STEPS]) {
  console.log(
    `${String(i).padEnd(8)}${daily[i].toFixed(3).padStart(9)}${every3[i].toFixed(3).padStart(10)}` +
    `${weekly[i].toFixed(3).padStart(9)}${idle[i].toFixed(3).padStart(11)}`,
  );
}
const bd = band(daily), b3 = band(every3), bw = band(weekly);
console.log(`\nequilibrium bands  daily=${bd.last.toFixed(3)}  every-3d=${b3.last.toFixed(3)}  weekly=${bw.last.toFixed(3)}  idle@${STEPS}d=${idle[STEPS].toFixed(3)}`);

// --- assertions ---
const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

// AC-1: daily rises monotonically (diminishing) and stays below the ceiling.
for (let i = 1; i < daily.length; i += 1) {
  check(daily[i] >= daily[i - 1] - 1e-9, `daily not monotonic at step ${i}`);
  check(daily[i] <= 1, `daily exceeded ceiling at step ${i}`);
}
check(daily[STEPS] < 1, "daily did not stay below the ceiling");
check(daily[1] - daily[0] > daily[STEPS] - daily[STEPS - 1], "daily increments not diminishing");

// AC-3: converged stable bands, ordered by cadence (denser use => higher band).
check(bd.hi - bd.lo < 0.02, "daily band did not converge");
check(b3.hi - b3.lo < 0.02, "every-3d band did not converge");
check(bw.hi - bw.lo < 0.02, "weekly band did not converge");
check(bd.last > b3.last && b3.last > bw.last, "bands not ordered daily > every-3d > weekly");

// AC-2: idle memory fades (decay half is live).
check(idle[STEPS] < idle[0], "idle memory did not fade");
check(idle[STEPS] >= 0, "idle strength went negative");

if (problems.length) {
  console.error("\nFAIL:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("\nOK: reinforcement rises+bounded (AC-1), settles into cadence-ordered stable bands (AC-3), idle fades (AC-2).");
