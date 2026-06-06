#!/usr/bin/env bash
# Test: bootstrap-args.test.sh
#
# Tests that bootstrap.sh exits non-zero with a clear error message when
# required env vars are missing. Uses MC_BOOTSTRAP_DRY_RUN=1 to skip all
# docker calls (safe in CI without Docker).
#
# Usage: bash infra/selfhosted/__tests__/bootstrap-args.test.sh

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/../../.." && pwd)/scripts/bootstrap.sh"
PASS=0
FAIL=0

pass() { printf '  \033[0;32mPASS\033[0m %s\n' "$*"; PASS=$(( PASS + 1 )); }
fail() { printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; FAIL=$(( FAIL + 1 )); }

echo "==> bootstrap-args.test.sh"

# Guard: script must exist
if [[ ! -f "$SCRIPT" ]]; then
  printf '  \033[0;31mERROR\033[0m scripts/bootstrap.sh not found at %s\n' "$SCRIPT"
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: run bootstrap.sh with given env, write output + rc to temp files.
# Call get_output / get_rc (no args) after each run_bootstrap call.
# ---------------------------------------------------------------------------
_TMPOUT="$(mktemp)"
_TMPRC="$(mktemp)"
trap 'rm -f "$_TMPOUT" "$_TMPRC"' EXIT

run_bootstrap() {
  local env_exports="$1"
  set +e
  env -i HOME="${HOME}" PATH="${PATH}" \
    bash -c "${env_exports} MC_BOOTSTRAP_DRY_RUN=1 bash '${SCRIPT}'" \
    >"$_TMPOUT" 2>&1
  printf '%d' $? >"$_TMPRC"
  set -e
}

get_output() { cat "$_TMPOUT"; }
get_rc()     { cat "$_TMPRC"; }

# ---------------------------------------------------------------------------
# Test 1: all required vars set — should succeed (exit 0) in dry-run
# ---------------------------------------------------------------------------
run_bootstrap 'MC_VERSION=v1.0.0 MC_TENANT_SLUG=test MC_TUNNEL_TOKEN=t MC_BOOTSTRAP_TOKEN=b'
rc="$(get_rc)"

if [[ "$rc" -eq 0 ]]; then
  pass "All required vars set: exit 0 (dry-run)"
else
  fail "All required vars set but exited $rc: $(get_output)"
fi

# ---------------------------------------------------------------------------
# Test 2: MC_VERSION missing
# ---------------------------------------------------------------------------
run_bootstrap 'MC_TENANT_SLUG=test MC_TUNNEL_TOKEN=t MC_BOOTSTRAP_TOKEN=b'
rc="$(get_rc)"
output="$(get_output)"

if [[ "$rc" -ne 0 ]] && echo "$output" | grep -q "MC_VERSION"; then
  pass "MC_VERSION missing: exit != 0, error mentions MC_VERSION"
else
  fail "MC_VERSION missing: expected exit != 0 and mention of MC_VERSION (got rc=$rc)"
fi

# ---------------------------------------------------------------------------
# Test 3: MC_TENANT_SLUG missing
# ---------------------------------------------------------------------------
run_bootstrap 'MC_VERSION=v1.0.0 MC_TUNNEL_TOKEN=t MC_BOOTSTRAP_TOKEN=b'
rc="$(get_rc)"
output="$(get_output)"

if [[ "$rc" -ne 0 ]] && echo "$output" | grep -q "MC_TENANT_SLUG"; then
  pass "MC_TENANT_SLUG missing: exit != 0, error mentions MC_TENANT_SLUG"
else
  fail "MC_TENANT_SLUG missing: expected exit != 0 and mention of MC_TENANT_SLUG (got rc=$rc)"
fi

# ---------------------------------------------------------------------------
# Test 4: MC_TUNNEL_TOKEN missing
# ---------------------------------------------------------------------------
run_bootstrap 'MC_VERSION=v1.0.0 MC_TENANT_SLUG=test MC_BOOTSTRAP_TOKEN=b'
rc="$(get_rc)"
output="$(get_output)"

if [[ "$rc" -ne 0 ]] && echo "$output" | grep -q "MC_TUNNEL_TOKEN"; then
  pass "MC_TUNNEL_TOKEN missing: exit != 0, error mentions MC_TUNNEL_TOKEN"
else
  fail "MC_TUNNEL_TOKEN missing: expected exit != 0 and mention of MC_TUNNEL_TOKEN (got rc=$rc)"
fi

# ---------------------------------------------------------------------------
# Test 5: MC_BOOTSTRAP_TOKEN missing
# ---------------------------------------------------------------------------
run_bootstrap 'MC_VERSION=v1.0.0 MC_TENANT_SLUG=test MC_TUNNEL_TOKEN=t'
rc="$(get_rc)"
output="$(get_output)"

if [[ "$rc" -ne 0 ]] && echo "$output" | grep -q "MC_BOOTSTRAP_TOKEN"; then
  pass "MC_BOOTSTRAP_TOKEN missing: exit != 0, error mentions MC_BOOTSTRAP_TOKEN"
else
  fail "MC_BOOTSTRAP_TOKEN missing: expected exit != 0 and mention of MC_BOOTSTRAP_TOKEN (got rc=$rc)"
fi

# ---------------------------------------------------------------------------
# Test 6: all vars missing — error lists all four
# ---------------------------------------------------------------------------
run_bootstrap ''
rc="$(get_rc)"
output="$(get_output)"

if [[ "$rc" -ne 0 ]] \
  && echo "$output" | grep -q "MC_VERSION" \
  && echo "$output" | grep -q "MC_TENANT_SLUG" \
  && echo "$output" | grep -q "MC_TUNNEL_TOKEN" \
  && echo "$output" | grep -q "MC_BOOTSTRAP_TOKEN"; then
  pass "All vars missing: exit != 0, error lists all four"
else
  fail "All vars missing: expected all four var names in output (got rc=$rc)"
fi

# ---------------------------------------------------------------------------
# Test 7: error output includes docs URL
# ---------------------------------------------------------------------------
run_bootstrap ''
output="$(get_output)"

if echo "$output" | grep -q "memorycrystal.ai"; then
  pass "Error output includes docs URL"
else
  fail "Error output missing docs URL"
fi

# ---------------------------------------------------------------------------
# Test 8: bash -n syntax check on the script itself
# ---------------------------------------------------------------------------
set +e
bash -n "${SCRIPT}" 2>/dev/null
syntax_rc=$?
set -e

if [[ $syntax_rc -eq 0 ]]; then
  pass "bootstrap.sh passes bash -n syntax check"
else
  fail "bootstrap.sh has syntax errors (bash -n exit $syntax_rc)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
