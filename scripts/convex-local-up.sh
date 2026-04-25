#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/convex/docker-compose.yml"
ENV_FILE="$REPO_ROOT/.env.local"
TEMPLATE_FILE="$REPO_ROOT/infra/convex/.env.local.template"
MARKER_START="# >>> memory-crystal local-backend overlay (managed by scripts/convex-local-up.sh) >>>"
MARKER_END="# <<< memory-crystal local-backend overlay <<<"
API_URL=${CONVEX_SELF_HOSTED_URL:-http://127.0.0.1:3210}
SITE_URL=${CRYSTAL_CONVEX_SITE_URL:-http://127.0.0.1:3211}
DASHBOARD_URL=${CRYSTAL_CONVEX_DASHBOARD_URL:-http://127.0.0.1:6791}
ADMIN_KEY_RE='^[A-Za-z0-9._-]+\|[A-Za-z0-9]+$'

log() { printf '[convex-local-up] %s\n' "$*"; }
fail() { printf '[convex-local-up] ERROR: %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

read_env_value() {
  local key=$1 file=${2:-$ENV_FILE}
  [[ -f "$file" ]] || return 1
  awk -F= -v k="$key" '$1 == k { print substr($0, index($0, "=") + 1); found=1; exit } END { exit found ? 0 : 1 }' "$file"
}

mask_secret() {
  local value=$1 len=${#value}
  if (( len <= 10 )); then
    printf '****'
  else
    printf '%s…%s' "${value:0:4}" "${value: -4}"
  fi
}

wait_for_http() {
  log "Waiting for Convex backend HTTP readiness at $API_URL/version"
  for attempt in $(seq 1 60); do
    if curl -fsS "$API_URL/version" >/dev/null 2>&1; then
      log "Backend HTTP readiness passed"
      return 0
    fi
    sleep 1
  done
  fail "Backend did not answer $API_URL/version after 60s. If images are still pulling, wait and re-run."
}

generate_admin_key_with_retry() {
  local output delay=1
  log "Waiting for admin-key readiness"
  for attempt in $(seq 1 10); do
    output=$(compose exec -T backend ./generate_admin_key.sh 2>/dev/null | tr -d '\r' | awk 'NF { print; exit }' || true)
    if [[ $output =~ $ADMIN_KEY_RE ]]; then
      printf '%s\n' "$output"
      return 0
    fi
    if (( attempt == 10 )); then
      break
    fi
    log "Admin key not ready yet (attempt $attempt/10); retrying in ${delay}s"
    sleep "$delay"
    delay=$(( delay < 30 ? delay * 2 : 30 ))
  done
  fail "Could not generate a valid self-hosted admin key; last output was: ${output:-<empty>}"
}

write_root_overlay() {
  local admin_key=$1 tmp body
  tmp=$(mktemp "${ENV_FILE}.XXXXXX")
  body=$(cat <<EOF
$MARKER_START
CRYSTAL_BACKEND=local
CONVEX_SELF_HOSTED_URL=$API_URL
CONVEX_SELF_HOSTED_ADMIN_KEY=$admin_key
CONVEX_URL=$API_URL
CRYSTAL_CONVEX_URL=$SITE_URL
CRYSTAL_CONVEX_SITE_URL=$SITE_URL
MEMORY_CRYSTAL_API_URL=$SITE_URL
MEMORY_CRYSTAL_API_KEY=local-dev-bearer-token
CRYSTAL_LOCAL_LLM_STUB=1
CRYSTAL_EMAIL_DRY_RUN=1
$MARKER_END
EOF
)
  if [[ -f "$ENV_FILE" ]]; then
    awk -v start="$MARKER_START" -v end="$MARKER_END" '
      $0 == start { skipping=1; next }
      $0 == end { skipping=0; next }
      !skipping { print }
    ' "$ENV_FILE" > "$tmp"
    if [[ -s "$tmp" ]] && [[ $(tail -c 1 "$tmp" | wc -l | tr -d ' ') == 0 ]]; then
      printf '\n' >> "$tmp"
    fi
    printf '%s\n' "$body" >> "$tmp"
  else
    printf '%s\n' "$body" > "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  log "Updated root .env.local managed overlay (ignored by git)"
}

run_convex_env_set() {
  local key=$1 value=$2
  CONVEX_SELF_HOSTED_URL="$API_URL" CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
    npx convex env set "$key" "$value" >/dev/null
}

run_optional_ts_hook() {
  local script=$1 label=$2
  if [[ -f "$REPO_ROOT/$script" ]]; then
    log "Running $label ($script)"
    CONVEX_SELF_HOSTED_URL="$API_URL" CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" node --experimental-strip-types "$REPO_ROOT/$script"
  else
    log "Skipping $label; $script is added by a later local-Convex PR"
  fi
}

main() {
  need_cmd docker
  need_cmd curl
  need_cmd npx
  [[ -f "$COMPOSE_FILE" ]] || fail "Missing compose file: $COMPOSE_FILE"
  [[ -f "$TEMPLATE_FILE" ]] || fail "Missing env template: $TEMPLATE_FILE"

  log "Starting backend and dashboard"
  compose up -d backend dashboard
  wait_for_http

  ADMIN_KEY=${CONVEX_SELF_HOSTED_ADMIN_KEY:-$(read_env_value CONVEX_SELF_HOSTED_ADMIN_KEY || true)}
  if [[ -z "${ADMIN_KEY:-}" ]]; then
    ADMIN_KEY=$(generate_admin_key_with_retry)
  elif [[ ! $ADMIN_KEY =~ $ADMIN_KEY_RE ]]; then
    fail "Existing CONVEX_SELF_HOSTED_ADMIN_KEY does not match expected self-hosted shape"
  fi
  export ADMIN_KEY
  write_root_overlay "$ADMIN_KEY"

  # PR1 owns the local backend marker and a site URL needed by auth config. PR2 extends
  # this with JWT/JWKS and other deployment-env provisioning.
  log "Setting local deployment environment markers"
  run_convex_env_set CRYSTAL_BACKEND local
  run_convex_env_set CONVEX_SITE_URL "$SITE_URL"

  run_optional_ts_hook scripts/convex-local-auth-keys.ts "Convex Auth key provisioning"
  run_optional_ts_hook scripts/convex-local-provision-env.ts "deployment env provisioning"

  log "Pushing Convex schema/functions once"
  CONVEX_SELF_HOSTED_URL="$API_URL" CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" npx convex dev --once

  if [[ -f "$REPO_ROOT/scripts/convex-local-write-env.ts" ]]; then
    run_optional_ts_hook scripts/convex-local-write-env.ts "per-consumer env overlay writer"
  fi

  log "Local Convex is ready"
  printf '\nDashboard: %s\nAPI URL:   %s\nSite URL:  %s\nAdmin key: %s\n' \
    "$DASHBOARD_URL" "$API_URL" "$SITE_URL" "$(mask_secret "$ADMIN_KEY")"
}

main "$@"
