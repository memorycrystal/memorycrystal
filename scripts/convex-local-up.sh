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
WEB_SITE_URL=${MEMORY_CRYSTAL_WEB_URL:-${NEXT_PUBLIC_SITE_URL:-http://localhost:3000}}
DASHBOARD_URL=${CRYSTAL_CONVEX_DASHBOARD_URL:-http://127.0.0.1:6791}
ADMIN_KEY_RE='^[A-Za-z0-9._-]+\|[A-Za-z0-9]+$'
LOCAL_CONVEX_ENV_FILE=""
STORAGE_MODE=${CRYSTAL_LOCAL_STORAGE_MODE:-embedded}

log() { printf '[convex-local-up] %s\n' "$*" >&2; }
fail() { printf '[convex-local-up] ERROR: %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }

for arg in "$@"; do
  case "$arg" in
    --storage=embedded) STORAGE_MODE=embedded ;;
    --storage=postgres) STORAGE_MODE=postgres ;;
    -h|--help)
      printf 'Usage: %s [--storage=embedded|--storage=postgres]\n' "$0"
      exit 0
      ;;
    *) fail "Unknown argument: $arg" ;;
  esac
done
[[ "$STORAGE_MODE" == "embedded" || "$STORAGE_MODE" == "postgres" ]] || fail "CRYSTAL_LOCAL_STORAGE_MODE must be embedded or postgres"

compose() {
  if [[ "$STORAGE_MODE" == "postgres" ]]; then
    docker compose -f "$COMPOSE_FILE" --profile postgres "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}
cleanup() { [[ -n "$LOCAL_CONVEX_ENV_FILE" ]] && rm -f "$LOCAL_CONVEX_ENV_FILE"; }
trap cleanup EXIT

read_env_value() {
  local key=$1 file=${2:-$ENV_FILE}
  [[ -f "$file" ]] || return 1
  awk -F= -v k="$key" '$1 == k { print substr($0, index($0, "=") + 1); found=1; exit } END { exit found ? 0 : 1 }' "$file"
}

read_host_env_value() {
  local key=$1 value
  value=${!key:-}
  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  if value=$(read_env_value "$key" "$ENV_FILE" 2>/dev/null); then
    printf '%s\n' "$value"
    return 0
  fi
  if value=$(read_env_value "$key" "$REPO_ROOT/.env" 2>/dev/null); then
    printf '%s\n' "$value"
    return 0
  fi
  return 1
}

prompt_secret() {
  local prompt=$1 value
  [[ -r /dev/tty ]] || return 1
  printf '%s' "$prompt" > /dev/tty
  IFS= read -r value < /dev/tty || true
  printf '\n' > /dev/tty
  [[ -n "$value" ]] || return 1
  printf '%s\n' "$value"
}

resolve_backend_provider_keys() {
  GEMINI_API_KEY_VALUE="$(read_host_env_value GEMINI_API_KEY 2>/dev/null || true)"
  OPENROUTER_API_KEY_VALUE="$(read_host_env_value OPENROUTER_API_KEY 2>/dev/null || true)"

  if [[ -z "$GEMINI_API_KEY_VALUE" ]]; then
    log "Gemini API key is required for semantic embeddings in the local/self-hosted backend"
    GEMINI_API_KEY_VALUE="$(prompt_secret "Enter Gemini API key for backend embeddings: " 2>/dev/null || true)"
  fi
  if [[ -z "$GEMINI_API_KEY_VALUE" ]]; then
    GEMINI_API_KEY_VALUE="local-dev-gemini-stub"
    log "No Gemini API key provided; using local stub. Semantic embedding calls will fail until GEMINI_API_KEY is set."
  fi

  if [[ -z "$OPENROUTER_API_KEY_VALUE" ]]; then
    OPENROUTER_API_KEY_VALUE="$(prompt_secret "Enter OpenRouter API key for organic model features (optional, press Enter to skip): " 2>/dev/null || true)"
  fi

  export GEMINI_API_KEY="$GEMINI_API_KEY_VALUE"
  if [[ -n "$OPENROUTER_API_KEY_VALUE" ]]; then
    export OPENROUTER_API_KEY="$OPENROUTER_API_KEY_VALUE"
  fi
}

mask_secret() {
  local value=$1
  local len=${#value}
  if (( len <= 10 )); then
    printf '****'
  else
    printf '%s...%s' "${value:0:4}" "${value:len-4:4}"
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

ensure_node_dependencies() {
  if [[ -d "$REPO_ROOT/node_modules/convex" && -d "$REPO_ROOT/node_modules/@convex-dev/auth" ]]; then
    return
  fi
  [[ -f "$REPO_ROOT/package.json" ]] || fail "Missing package.json for local backend dependency install"
  need_cmd npm
  log "Installing local backend Node dependencies"
  npm install --omit=dev --ignore-scripts --no-audit --no-fund
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
CRYSTAL_LOCAL_STORAGE_MODE=$STORAGE_MODE
CONVEX_SELF_HOSTED_URL=$API_URL
CONVEX_SELF_HOSTED_ADMIN_KEY=$admin_key
CONVEX_URL=$API_URL
CRYSTAL_CONVEX_URL=$SITE_URL
CRYSTAL_CONVEX_SITE_URL=$SITE_URL
MEMORY_CRYSTAL_API_URL=$SITE_URL
MEMORY_CRYSTAL_API_KEY=local-dev-bearer-token
GEMINI_API_KEY=$GEMINI_API_KEY_VALUE
$(if [[ -n "${OPENROUTER_API_KEY_VALUE:-}" ]]; then printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY_VALUE"; fi)
CRYSTAL_LOCAL_LLM_STUB=1
CRYSTAL_EMAIL_DRY_RUN=1
CRYSTAL_MCP_HTTP_RATE_LIMIT_PER_MINUTE=0
$MARKER_END
EOF
)
  if [[ -f "$ENV_FILE" ]]; then
    awk -v end="$MARKER_END" '
      $0 ~ /^# >>> memory-crystal local-backend overlay / { skipping=1; next }
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

write_local_convex_env_file() {
  LOCAL_CONVEX_ENV_FILE=$(mktemp "${TMPDIR:-/tmp}/memorycrystal-convex.XXXXXX.env")
  chmod 600 "$LOCAL_CONVEX_ENV_FILE" 2>/dev/null || true
  cat > "$LOCAL_CONVEX_ENV_FILE" <<EOF
CONVEX_SELF_HOSTED_URL=$API_URL
CONVEX_SELF_HOSTED_ADMIN_KEY=$ADMIN_KEY
EOF
}

run_convex_env_set() {
  local key=$1 value=$2
  env -u CONVEX_DEPLOYMENT CONVEX_SELF_HOSTED_URL="$API_URL" CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
    npx convex env set "$key" "$value" --env-file "$LOCAL_CONVEX_ENV_FILE" >/dev/null
}

run_optional_ts_hook() {
  local script=$1 label=$2
  if [[ -f "$REPO_ROOT/$script" ]]; then
    log "Running $label ($script)"
    env -u CONVEX_DEPLOYMENT \
      NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--disable-warning=MODULE_TYPELESS_PACKAGE_JSON" \
      CONVEX_SELF_HOSTED_URL="$API_URL" \
      CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
      CRYSTAL_CONVEX_ENV_FILE="$LOCAL_CONVEX_ENV_FILE" \
      node --experimental-strip-types "$REPO_ROOT/$script"
  else
    log "Skipping $label; $script is added by a later local-Convex PR"
  fi
}

main() {
  need_cmd docker
  need_cmd curl
  need_cmd npx
  ensure_node_dependencies
  [[ -f "$COMPOSE_FILE" ]] || fail "Missing compose file: $COMPOSE_FILE"
  [[ -f "$TEMPLATE_FILE" ]] || fail "Missing env template: $TEMPLATE_FILE"

  log "Starting backend and dashboard"
  if [[ "$STORAGE_MODE" == "postgres" ]]; then
    export POSTGRES_DB=${POSTGRES_DB:-convex_self_hosted}
    [[ "$POSTGRES_DB" == "convex_self_hosted" ]] || fail "POSTGRES_DB must be convex_self_hosted for the default self-hosted instance"
    # Convex treats this as a cluster URL and creates its own logical database;
    # including a path (for example `/convex`) makes the backend fail closed.
    export POSTGRES_URL=${POSTGRES_URL:-postgresql://${POSTGRES_USER:-convex}:${POSTGRES_PASSWORD:-convex-local-password}@postgres:5432}
    export DO_NOT_REQUIRE_SSL=${DO_NOT_REQUIRE_SSL:-1}
    log "Starting opt-in Postgres metadata store"
    compose up -d postgres
    for attempt in $(seq 1 30); do
      if compose exec -T postgres pg_isready -U "${POSTGRES_USER:-convex}" -d "$POSTGRES_DB" >/dev/null 2>&1; then break; fi
      (( attempt == 30 )) && fail "Postgres did not become ready"
      sleep 1
    done
  fi
  compose up -d backend dashboard
  wait_for_http

  ADMIN_KEY=${CONVEX_SELF_HOSTED_ADMIN_KEY:-$(read_env_value CONVEX_SELF_HOSTED_ADMIN_KEY || true)}
  if [[ -z "${ADMIN_KEY:-}" ]]; then
    ADMIN_KEY=$(generate_admin_key_with_retry)
  elif [[ ! $ADMIN_KEY =~ $ADMIN_KEY_RE ]]; then
    fail "Existing CONVEX_SELF_HOSTED_ADMIN_KEY does not match expected self-hosted shape"
  fi
  export ADMIN_KEY
  write_local_convex_env_file
  resolve_backend_provider_keys
  write_root_overlay "$ADMIN_KEY"

  # Convex provides CONVEX_SITE_URL as a built-in self-hosted value, so only set
  # Memory Crystal-owned deployment markers here.
  log "Setting local deployment environment markers"
  run_convex_env_set CRYSTAL_BACKEND local
  run_convex_env_set SITE_URL "$WEB_SITE_URL"

  run_optional_ts_hook scripts/convex-local-auth-keys.ts "Convex Auth key provisioning"
  run_optional_ts_hook scripts/convex-local-provision-env.ts "deployment env provisioning"

  log "Pushing Convex schema/functions once"
  env -u CONVEX_DEPLOYMENT CONVEX_SELF_HOSTED_URL="$API_URL" CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" npx convex dev --once --env-file "$LOCAL_CONVEX_ENV_FILE"

  run_optional_ts_hook scripts/convex-local-import-auth.ts "local installer API key import"

  if [[ -f "$REPO_ROOT/scripts/convex-local-write-env.ts" ]]; then
    run_optional_ts_hook scripts/convex-local-write-env.ts "per-consumer env overlay writer"
  fi

  log "Local Convex is ready"
  printf '\nDashboard: %s\nAPI URL:   %s\nSite URL:  %s\nWeb URL:   %s\nAdmin key: %s\n' \
    "$DASHBOARD_URL" "$API_URL" "$SITE_URL" "$WEB_SITE_URL" "$(mask_secret "$ADMIN_KEY")"
}

main "$@"
