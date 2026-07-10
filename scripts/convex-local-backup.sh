#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/convex/docker-compose.yml"
MODE=${CRYSTAL_LOCAL_STORAGE_MODE:-embedded}
DEST=${1:-"$HOME/.memorycrystal/backups/$(date -u +%Y%m%dT%H%M%SZ)"}
API_URL=${CONVEX_SELF_HOSTED_URL:-http://127.0.0.1:3210}

log() { printf '[convex-local-backup] %s\n' "$*" >&2; }
fail() { printf '[convex-local-backup] ERROR: %s\n' "$*" >&2; exit 1; }
compose() {
  if [[ "$MODE" == "postgres" ]]; then docker compose -f "$COMPOSE_FILE" --profile postgres "$@";
  else docker compose -f "$COMPOSE_FILE" "$@"; fi
}
wait_for_backend() {
  for _ in $(seq 1 60); do
    if curl -fsS "$API_URL/version" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "Backend did not become healthy after the snapshot"
}

command -v docker >/dev/null 2>&1 || fail "Docker is required"
mkdir -p "$DEST"
BACKEND_ID=$(compose ps -q backend)
[[ -n "$BACKEND_ID" ]] || fail "Local Convex backend is not running"
VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/convex/data"}}{{.Name}}{{end}}{{end}}' "$BACKEND_ID")
[[ -n "$VOLUME" ]] || fail "Could not resolve the Convex data volume"

if [[ "$MODE" == "embedded" ]]; then
  log "Stopping backend for a crash-consistent embedded-volume snapshot"
  compose stop backend >/dev/null
fi
trap 'if [[ "$MODE" == "embedded" ]]; then compose start backend >/dev/null 2>&1 || true; fi' EXIT

docker run --rm -v "$VOLUME:/source:ro" -v "$DEST:/backup" alpine:3.21 \
  tar -C /source -czf /backup/convex-data.tar.gz .

if [[ "$MODE" == "postgres" ]]; then
  compose exec -T postgres pg_dump -U "${POSTGRES_USER:-convex}" -d "${POSTGRES_DB:-convex_self_hosted}" -Fc > "$DEST/postgres.dump"
fi

cat > "$DEST/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "storageMode": "$MODE",
  "includesConvexData": true,
  "includesPostgres": $( [[ "$MODE" == "postgres" ]] && printf true || printf false )
}
EOF

if [[ "$MODE" == "embedded" ]]; then
  compose start backend >/dev/null
  wait_for_backend
  trap - EXIT
fi
log "Backup complete: $DEST"
