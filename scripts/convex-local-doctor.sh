#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"
STATUS=0
API_URL="${CONVEX_SELF_HOSTED_URL:-http://127.0.0.1:3210}"
SITE_URL="${CRYSTAL_CONVEX_SITE_URL:-http://127.0.0.1:3211}"
MEMORY_HOME="${MEMORY_CRYSTAL_HOME:-$HOME/.memorycrystal}"

pass() { printf 'PASS %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; STATUS=1; }

check_no_auth_secrets() {
  local file="$1"
  if [ ! -f "$file" ]; then
    warn "missing optional env overlay ${file#$REPO_ROOT/}"
    return
  fi
  if grep -Eq '^(JWT_PRIVATE_KEY|JWKS)=' "$file"; then
    fail "${file#$REPO_ROOT/} contains deployment-only auth secret names"
  else
    pass "${file#$REPO_ROOT/} has no JWT_PRIVATE_KEY/JWKS host leak"
  fi
}

check_overlay_key() {
  local file="$1"
  local key="$2"
  local expected="$3"
  if [ ! -f "$file" ]; then
    fail "missing ${file#$REPO_ROOT/}"
    return
  fi
  if grep -Eq "^${key}=${expected//\//\/}$" "$file"; then
    pass "${file#$REPO_ROOT/} sets ${key}=${expected}"
  else
    fail "${file#$REPO_ROOT/} does not set ${key}=${expected}"
  fi
}

json_field_file() {
  local file="$1" field="$2"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$file" "$field"
  elif command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]] || ""));' "$file" "$field"
  else
    return 1
  fi
}

check_backend_http() {
  if curl -fsS "$API_URL/version" >/dev/null 2>&1; then
    pass "Convex backend responds at $API_URL/version"
  else
    fail "Convex backend does not respond at $API_URL/version"
  fi
}

check_local_auth_smoke() {
  local auth_file="$MEMORY_HOME/local-auth.json" token status
  if [ ! -f "$auth_file" ]; then
    warn "missing local auth bridge $auth_file; run the universal installer in local mode first"
    return
  fi
  token="$(json_field_file "$auth_file" localToken 2>/dev/null || true)"
  if [ -z "$token" ]; then
    fail "could not read localToken from $auth_file"
    return
  fi
  status="$(curl -s -o /dev/null -w "%{http_code}" "$SITE_URL/api/mcp/auth" -H "Authorization: Bearer $token" 2>/dev/null || true)"
  if [ "$status" = "200" ]; then
    pass "local MCP auth accepts installer credential at $SITE_URL/api/mcp/auth"
  else
    fail "local MCP auth rejected installer credential at $SITE_URL/api/mcp/auth (HTTP ${status:-000})"
  fi
}

for env_file in "$REPO_ROOT/.env.local" "$REPO_ROOT/apps/web/.env.local" "$REPO_ROOT/mcp-server/.env"; do
  check_no_auth_secrets "$env_file"
done

check_overlay_key "$REPO_ROOT/apps/web/.env.local" "NEXT_PUBLIC_CONVEX_URL" "http://127.0.0.1:3210"
check_overlay_key "$REPO_ROOT/.env.local" "CONVEX_URL" "http://127.0.0.1:3210"
check_overlay_key "$REPO_ROOT/mcp-server/.env" "MEMORY_CRYSTAL_API_URL" "http://127.0.0.1:3211"

if [ -f "$REPO_ROOT/apps/web/.env" ] && grep -Eq '^NEXT_PUBLIC_CONVEX_URL=' "$REPO_ROOT/apps/web/.env"; then
  warn "apps/web/.env also defines NEXT_PUBLIC_CONVEX_URL; .env.local wins, but deleting only the managed block may reveal this value"
fi

if [ -n "$(git -C "$REPO_ROOT" ls-files .env.local apps/web/.env.local mcp-server/.env 2>/dev/null || true)" ]; then
  fail "one or more local env overlay files are tracked by git"
else
  pass "local env overlay destinations are untracked/ignored"
fi

check_backend_http
check_local_auth_smoke

exit "$STATUS"
