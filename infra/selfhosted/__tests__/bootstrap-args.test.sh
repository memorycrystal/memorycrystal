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
run_bootstrap 'MC_VERSION=v0.9.0 MC_TENANT_SLUG=test MC_TUNNEL_TOKEN=t MC_BOOTSTRAP_TOKEN=b'
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
run_bootstrap 'MC_VERSION=v0.9.0 MC_TUNNEL_TOKEN=t MC_BOOTSTRAP_TOKEN=b'
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
run_bootstrap 'MC_VERSION=v0.9.0 MC_TENANT_SLUG=test MC_BOOTSTRAP_TOKEN=b'
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
run_bootstrap 'MC_VERSION=v0.9.0 MC_TENANT_SLUG=test MC_TUNNEL_TOKEN=t'
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
# Test 9: a real run stops after env validation, before any docker work, while
# self-hosting is MCP-only (no MC_BOOTSTRAP_DRY_RUN, no MC_SELFHOSTED_EXPERIMENTAL).
# The stub docker on PATH records any call, so the test proves none was made.
# It exits 1, so a regressed run dies at the compose check with no side effects.
# ---------------------------------------------------------------------------
_STUBDIR="$(mktemp -d)"
printf '#!/bin/sh\necho called >> "%s/docker-calls"\nexit 1\n' "${_STUBDIR}" > "${_STUBDIR}/docker"
chmod +x "${_STUBDIR}/docker"
set +e
env -i HOME="${HOME}" PATH="${_STUBDIR}:${PATH}" \
  bash -c "MC_VERSION=v0.10.0 MC_TENANT_SLUG=test MC_TUNNEL_TOKEN=t MC_BOOTSTRAP_TOKEN=b bash '${SCRIPT}'" \
  >"$_TMPOUT" 2>&1
real_rc=$?
set -e
output="$(get_output)"

if [[ "$real_rc" -ne 0 ]] \
  && echo "$output" | grep -q "not available yet" \
  && echo "$output" | grep -q "MCP-only" \
  && [[ ! -e "${_STUBDIR}/docker-calls" ]]; then
  pass "Real run stops before docker: MCP-only notice, exit != 0"
else
  fail "Real run: expected exit != 0, the MCP-only notice and no docker call (rc=$real_rc)"
fi
rm -rf "${_STUBDIR}"

# ---------------------------------------------------------------------------
# Test 10: the bundle files do not name the unpublished web image as something
# bootstrap verifies by default (only the experimental path keeps it)
# ---------------------------------------------------------------------------
if sed -n '/MC_SELFHOSTED_EXPERIMENTAL:-0/,$p' "${SCRIPT}" | grep -q 'web-selfhosted' \
  && ! sed -n '1,/MC_SELFHOSTED_EXPERIMENTAL:-0/p' "${SCRIPT}" | grep -q 'web-selfhosted'; then
  pass "web-selfhosted appears only after the MCP-only stop (experimental path)"
else
  fail "web-selfhosted must not be reachable before the MCP-only stop"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
