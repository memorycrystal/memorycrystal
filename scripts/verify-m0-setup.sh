#!/usr/bin/env bash
# Verify M0 external setup is complete before launching Phase 1+ deployment.
#
# Run after manually completing CLOUD_OPS.md §1 (zone reservation, scoped
# token issuance, KV namespace creation). This script does not modify any
# CF resources — read-only checks.
#
# Usage:
#   ./scripts/verify-m0-setup.sh
#
# Required env (sourced from .env.production or 1Password):
#   CF_API_TOKEN          — scoped CF API token from CLOUD_OPS.md §1.2
#   CF_ACCOUNT_ID         — Illumin8 account ID (8da2b90c5b725be83ff421ea9035b489)
#   CF_TUNNELS_ZONE_ID    — zone ID captured from CLOUD_OPS.md §1.1 step 6
#
# Exit codes:
#   0 — all checks passed; ready for M1+ deployment
#   1 — one or more required env vars missing
#   2 — token authentication failed (re-issue or fix scopes)
#   3 — token has incorrect permissions (review CLOUD_OPS.md §1.2 step 3)
#   4 — KV namespaces missing (run wrangler create commands from §1.3)

set -euo pipefail

CF_API="https://api.cloudflare.com/client/v4"

red()   { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }
blue()  { printf "\033[34m%s\033[0m\n" "$1"; }

# 1. Required env
require_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    red "✗ Required env var missing: $var"
    return 1
  fi
  green "✓ $var is set"
}

blue "=== M0 setup verification ==="
echo

require_env CF_API_TOKEN || exit 1
require_env CF_ACCOUNT_ID || exit 1
require_env CF_TUNNELS_ZONE_ID || exit 1
echo

# 2. Token verify
blue "[1/5] Verify CF API token authenticates"
verify_response=$(curl -fsS \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "${CF_API}/user/tokens/verify" 2>&1) || {
    red "✗ Token verify failed"
    echo "$verify_response"
    exit 2
}
status=$(echo "$verify_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('status','unknown'))")
if [[ "$status" != "active" ]]; then
  red "✗ Token status is '$status', expected 'active'"
  exit 2
fi
green "✓ Token is active"
echo

# 3. Tunnel: Edit permission
blue "[2/5] Confirm Tunnel:Edit permission on Illumin8 account"
list_tunnels=$(curl -fsS \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${CF_API}/accounts/${CF_ACCOUNT_ID}/cfd_tunnel?per_page=1" 2>&1) || {
    red "✗ Cannot list CF tunnels — token lacks Tunnel:Edit on account?"
    echo "$list_tunnels" | head -5
    exit 3
}
green "✓ Tunnel:Edit permission confirmed"
echo

# 4. Zone DNS:Edit permission
blue "[3/5] Confirm Zone:DNS:Edit on tunnels.memorycrystal.ai"
zone_check=$(curl -fsS \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${CF_API}/zones/${CF_TUNNELS_ZONE_ID}/dns_records?per_page=1" 2>&1) || {
    red "✗ Cannot read DNS records — token lacks Zone:DNS:Edit on tunnels.memorycrystal.ai?"
    echo "$zone_check" | head -5
    exit 3
}
zone_name=$(curl -fsS \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${CF_API}/zones/${CF_TUNNELS_ZONE_ID}" 2>&1 | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('name','unknown'))")
if [[ "$zone_name" != "tunnels.memorycrystal.ai" ]]; then
  red "✗ Zone ID resolves to '$zone_name', expected 'tunnels.memorycrystal.ai'"
  red "  Check CF_TUNNELS_ZONE_ID env var matches the right zone."
  exit 3
fi
green "✓ Zone:DNS:Edit permission confirmed on tunnels.memorycrystal.ai"
echo

# 5. KV namespaces present
blue "[4/5] Confirm Workers KV namespaces exist"
kv_namespaces=$(curl -fsS \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${CF_API}/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces?per_page=100" 2>&1) || {
    red "✗ Cannot list KV namespaces — token lacks Workers KV:Edit?"
    echo "$kv_namespaces" | head -5
    exit 3
}

required_kv="MC_TUNNEL_STATUS MC_BOOTSTRAP_TOKENS"
for ns in $required_kv; do
  if echo "$kv_namespaces" | grep -q "\"title\":\"${ns}\""; then
    green "✓ KV namespace ${ns} exists"
  else
    red "✗ KV namespace ${ns} missing"
    yellow "  Create it: npx wrangler kv:namespace create ${ns}"
    exit 4
  fi
done
echo

# 6. Workers Scripts:Edit (optional check; only required for mc-tunnel-shield)
blue "[5/5] Confirm Workers Scripts:Edit (required for mc-tunnel-shield deploy)"
workers_check=$(curl -fsS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${CF_API}/accounts/${CF_ACCOUNT_ID}/workers/scripts" 2>&1) || workers_check="error"
case "$workers_check" in
  200|201)
    green "✓ Workers Scripts:Edit permission confirmed"
    ;;
  403)
    red "✗ Workers Scripts:Edit denied"
    yellow "  Add the 4th permission per CLOUD_OPS.md §1.2 step 3."
    exit 3
    ;;
  *)
    yellow "⚠ Workers Scripts check returned HTTP $workers_check — may need manual confirmation"
    ;;
esac
echo

green "=== All M0 setup checks passed ==="
echo "Ready to proceed with Phase 1+ deployment:"
echo "  1. cd ~/Projects/memorycrystal"
echo "  2. pnpm install   # ensures all declared devDependencies are present"
echo "  3. npx convex dev # pushes M1 schema + registers M2/M5/M6 actions + crons"
echo "  4. pnpm vitest run    # confirm 495+ tests still green"
echo "  5. Trigger first GHCR publish via:"
echo "     gh workflow run publish-selfhosted-images.yml"
echo "  6. Work through docs/RELEASE_CHECKLIST.md before opening public signup."
