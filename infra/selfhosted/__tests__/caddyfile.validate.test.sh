#!/usr/bin/env bash
# Test: caddyfile.validate.test.sh
#
# Validates infra/selfhosted/Caddyfile by running caddy validate inside a
# caddy:2-alpine container. Skips gracefully if docker is not available.
#
# Usage: bash infra/selfhosted/__tests__/caddyfile.validate.test.sh

set -euo pipefail

SELFHOSTED_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CADDYFILE="${SELFHOSTED_DIR}/Caddyfile"
PASS=0
FAIL=0

pass() { printf '  \033[0;32mPASS\033[0m %s\n' "$*"; PASS=$(( PASS + 1 )); }
fail() { printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; FAIL=$(( FAIL + 1 )); }
skip() { printf '  \033[0;33mSKIP\033[0m %s\n' "$*"; }

echo "==> caddyfile.validate.test.sh"

# ---------------------------------------------------------------------------
# Guard: skip if docker not available
# ---------------------------------------------------------------------------
if ! command -v docker &>/dev/null; then
  skip "docker not available — skipping Caddyfile validation"
  echo "0 passed, 0 failed, 1 skipped"
  exit 0
fi

# ---------------------------------------------------------------------------
# Test 1: caddy validate passes
# ---------------------------------------------------------------------------
set +e
output="$(docker run --rm \
  -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile 2>&1)"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  pass "caddy validate passes"
else
  fail "caddy validate failed: $output"
fi

# ---------------------------------------------------------------------------
# Test 2: /_health route is present
# ---------------------------------------------------------------------------
if grep -q '/_health' "${CADDYFILE}"; then
  pass "/_health route present"
else
  fail "/_health route missing — docker healthcheck will fail"
fi

# ---------------------------------------------------------------------------
# Test 3: §10 status field is tunnel-fallback-ingress
# ---------------------------------------------------------------------------
if grep -q '"status":"tunnel-fallback-ingress"' "${CADDYFILE}"; then
  pass '503 body contains status:tunnel-fallback-ingress (§10 contract)'
else
  fail '503 body missing status:tunnel-fallback-ingress — §10 contract violated'
fi

# ---------------------------------------------------------------------------
# Test 4: retry_after:30 present in 503 body
# ---------------------------------------------------------------------------
if grep -q '"retry_after":30' "${CADDYFILE}"; then
  pass '503 body contains retry_after:30'
else
  fail '503 body missing retry_after:30'
fi

# ---------------------------------------------------------------------------
# Test 5: tenant_slug is env-interpolated (not hardcoded)
# ---------------------------------------------------------------------------
if grep -q '{$MC_TENANT_SLUG}' "${CADDYFILE}"; then
  pass 'tenant_slug uses Caddy env interpolation {$MC_TENANT_SLUG}'
else
  fail 'tenant_slug is not env-interpolated — will be hardcoded or empty'
fi

# ---------------------------------------------------------------------------
# Test 6: admin off is set (no management endpoint exposed)
# ---------------------------------------------------------------------------
if grep -q 'admin off' "${CADDYFILE}"; then
  pass 'admin off is set'
else
  fail 'admin endpoint not disabled — may expose management port in container'
fi

# ---------------------------------------------------------------------------
# Test 7: Retry-After header present in catch-all
# ---------------------------------------------------------------------------
if grep -q 'Retry-After 30' "${CADDYFILE}"; then
  pass 'Retry-After 30 header present'
else
  fail 'Retry-After header missing'
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
