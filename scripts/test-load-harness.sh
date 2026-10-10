#!/usr/bin/env bash
# Run several full Convex vitest suites concurrently, for several rounds, to
# surface timing-sensitive tests (ILL-362). Copy 1 runs in this checkout; the
# other copies run in temporary detached worktrees that carry this checkout's
# uncommitted and untracked changes and share its node_modules by symlink. A
# temporary local clone owns their worktree metadata; the source Git directory
# remains read-only.
#
# Usage: scripts/test-load-harness.sh [copies] [rounds]
#   copies  concurrent suites per round (default 3)
#   rounds  number of rounds (default 3; the spec's 5 was reduced for shared-host load)
# Env: LOAD_HARNESS_OUT     output directory (default: a new mktemp dir)
#      LOAD_HARNESS_PREFIX  path prefix for the temporary worktrees
#                           (default /tmp/ill362-load)
#      LOAD_HARNESS_RUNNER  command prefix for Node-based test runs
#                           (default: mise exec node@22.23.2 --)
#
# Prints per-round, per-copy failures by file and case, the first failure
# message line, case duration, and suite wall duration. Per-copy JSON reports
# (with every failure message and test duration) stay in the output directory.
# Exits 1 when any copy had a failure.
set -euo pipefail

COPIES="${1:-3}"
ROUNDS="${2:-3}"
ROOT="$(git rev-parse --show-toplevel)"
BASE="$(git rev-parse HEAD)"
PREFIX="${LOAD_HARNESS_PREFIX:-/tmp/ill362-load}"
OUT="${LOAD_HARNESS_OUT:-$(mktemp -d /tmp/ill362-load-harness.XXXXXX)}"
CONTROL="$OUT/repository"
LOAD_HARNESS_RUNNER="${LOAD_HARNESS_RUNNER:-mise exec node@22.23.2 --}"
read -r -a RUNNER <<< "$LOAD_HARNESS_RUNNER"
mkdir -p "$OUT"
cd "$ROOT"
export SHARP_IGNORE_GLOBAL_LIBVIPS=1

EXTRA=()
CLEANUP_DONE=0
ACTIVE_PIDS=()
remove_exact_dir() {
  python3 - "$1" "$2" "$3" <<'PY'
import shutil
import sys
from pathlib import Path

target = Path(sys.argv[1])
expected_parent = Path(sys.argv[2])
expected_name = sys.argv[3]
if target.is_symlink() or target.parent.resolve() != expected_parent.resolve() or not target.name.startswith(expected_name):
    raise SystemExit(f"refusing to remove unexpected temporary directory: {target}")
if target.exists():
    shutil.rmtree(target)
PY
}
cleanup() {
  if (( CLEANUP_DONE )); then return; fi
  CLEANUP_DONE=1
  trap - INT TERM
  for pid in "${ACTIVE_PIDS[@]}"; do kill -TERM -- "-$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true; done
  for pid in "${ACTIVE_PIDS[@]}"; do wait "$pid" >/dev/null 2>&1 || true; done
  ACTIVE_PIDS=()
  for dir in "${EXTRA[@]}"; do
    git -C "$CONTROL" worktree remove --force "$dir" >/dev/null 2>&1 || true
    remove_exact_dir "$dir" /tmp "$(basename "$PREFIX")-" || true
  done
  remove_exact_dir "$CONTROL" "$OUT" repository
}
handle_signal() {
  local signal="$1" exit_code=130
  if [[ "$signal" == TERM ]]; then exit_code=143; fi
  printf 'received %s; stopping %s suite process group(s) before cleanup\n' "$signal" "${#ACTIVE_PIDS[@]}" >&2
  cleanup
  exit "$exit_code"
}
trap cleanup EXIT
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

PATCH="$OUT/working-tree.patch"
git diff HEAD --binary >"$PATCH"
git clone --shared --no-checkout "$ROOT" "$CONTROL" >/dev/null
for copy in $(seq 2 "$COPIES"); do
  dir="$(mktemp -d "$PREFIX-$copy.XXXXXX")"
  rmdir "$dir"
  EXTRA+=("$dir")
  git -C "$CONTROL" worktree add --detach "$dir" "$BASE" >/dev/null
  if [ -s "$PATCH" ]; then git -C "$dir" apply --binary "$PATCH"; fi
  git ls-files --others --exclude-standard -z | (cd "$ROOT" && xargs -0 -r cp --parents -t "$dir")
  ln -s "$ROOT/node_modules" "$dir/node_modules"
done

DIRS=("$ROOT" "${EXTRA[@]}")
for round in $(seq 1 "$ROUNDS"); do
  ACTIVE_PIDS=()
  for index in "${!DIRS[@]}"; do
    copy=$((index + 1))
    setsid bash -c '
      dir="$1"; out="$2"; round="$3"; copy="$4"; runner=()
      read -r -a runner <<< "$5"
      started_ms="$(date +%s%3N)"
      set +e
      (cd "$dir" && "${runner[@]}" npx vitest run --reporter=json --reporter=verbose --silent=false \
        --outputFile.json="$out/round$round-copy$copy.json") >"$out/round$round-copy$copy.log" 2>&1
      status=$?
      set -e
      ended_ms="$(date +%s%3N)"
      printf "%s\n" "$status" >"$out/round$round-copy$copy.exit"
      printf "%s\n" "$((ended_ms - started_ms))" >"$out/round$round-copy$copy.duration"
      sed -n "/recall v2 compose calibration:/p" "$out/round$round-copy$copy.log"
      exit 0
    ' _ "${DIRS[$index]}" "$OUT" "$round" "$copy" "$LOAD_HARNESS_RUNNER" &
    ACTIVE_PIDS+=("$!")
  done
  for pid in "${ACTIVE_PIDS[@]}"; do wait "$pid" || true; done
  ACTIVE_PIDS=()
done

"${RUNNER[@]}" node - "$OUT" "$ROUNDS" "$COPIES" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [out, rounds, copies] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
let total = 0;
const byFile = new Map();
const firstLine = (message) => String(message ?? "").split(/\r?\n/, 1)[0] || "(no failure message)";
function timeoutDiagnostic(round, copy, message, duration) {
  if (!/^(?:Error: )?STACK_TRACE_ERROR$/.test(message) && message !== "(no failure message)") return null;
  const logPath = path.join(out, `round${round}-copy${copy}.log`);
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  return log.split(/\r?\n/).find((line) => line.includes("Test timed out in"))?.trim() ?? "probable timeout";
}
for (let round = 1; round <= rounds; round += 1) {
  for (let copy = 1; copy <= copies; copy += 1) {
    const file = path.join(out, `round${round}-copy${copy}.json`);
    if (!fs.existsSync(file)) {
      console.log(`round ${round} | copy ${copy} | NO REPORT | duration unavailable`);
      total += 1;
      continue;
    }
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const durationPath = path.join(out, `round${round}-copy${copy}.duration`);
    const suiteDuration = fs.existsSync(durationPath) ? `${fs.readFileSync(durationPath, "utf8").trim()} ms` : "unavailable";
    const failures = [];
    for (const result of report.testResults) {
      const convexIndex = result.name.lastIndexOf("/convex/");
      const rel = convexIndex >= 0 ? result.name.slice(convexIndex + 1) : result.name;
      const failedTests = result.assertionResults.filter((test) => test.status === "failed");
      for (const test of failedTests) {
        const message = firstLine((test.failureMessages ?? [])[0]);
        failures.push({ rel, name: test.fullName || [...(test.ancestorTitles ?? []), test.title].filter(Boolean).join(" > "), duration: test.duration, message, timeoutDiagnostic: timeoutDiagnostic(round, copy, message, test.duration) });
      }
      if (failedTests.length === 0 && result.status === "failed") {
        const duration = result.endTime - result.startTime;
        const message = firstLine((result.failureMessage ?? "").split("\n")[0]);
        failures.push({ rel, name: "(file-level failure)", duration, message, timeoutDiagnostic: timeoutDiagnostic(round, copy, message, duration) });
      }
    }
    const exitPath = path.join(out, `round${round}-copy${copy}.exit`);
    const exitCode = fs.existsSync(exitPath) ? fs.readFileSync(exitPath, "utf8").trim() : "unknown";
    const nonzeroExit = /^\d+$/.test(exitCode) && Number(exitCode) !== 0;
    const countedFailures = failures.length + (nonzeroExit && failures.length === 0 ? 1 : 0);
    total += countedFailures;
    console.log(`round ${round} | copy ${copy} | ${report.numPassedTests} passed, ${countedFailures} failed | suite ${suiteDuration} | exit ${exitCode}`);
    if (nonzeroExit) console.log(`  FAIL copy ${copy} exited with code ${exitCode}`);
    if (failures.length === 0 && !nonzeroExit) console.log("  failures: none");
    if (failures.length === 0 && nonzeroExit) console.log("  test cases: none; suite exit failed");
    for (const failure of failures) {
      const timeoutText = failure.timeoutDiagnostic ? ` | ${failure.timeoutDiagnostic}` : "";
      console.log(`  FAIL ${failure.rel} :: ${failure.name} | duration ${Number.isFinite(failure.duration) ? `${failure.duration} ms` : "unavailable"} | ${failure.message}${timeoutText}`);
      byFile.set(failure.rel, (byFile.get(failure.rel) ?? 0) + 1);
    }
  }
}
console.log(`summary: ${total} failures across ${rounds} rounds x ${copies} copies`);
for (const [rel, count] of byFile) console.log(`  ${count} failure(s) in ${rel}`);
console.log(`reports: ${out}`);
process.exitCode = total === 0 ? 0 : 1;
NODE
