#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/convex/docker-compose.yml"
SOURCE=${1:-}
[[ -n "$SOURCE" && -d "$SOURCE" ]] || { echo "Usage: $0 /absolute/path/to/backup-directory" >&2; exit 2; }
[[ -f "$SOURCE/manifest.json" && -f "$SOURCE/convex-data.tar.gz" ]] || { echo "Backup manifest or Convex data archive missing" >&2; exit 2; }

MODE=$(sed -n 's/.*"storageMode": "\([^"]*\)".*/\1/p' "$SOURCE/manifest.json" | head -1)
[[ "$MODE" == "embedded" || "$MODE" == "postgres" ]] || { echo "Invalid backup storage mode" >&2; exit 2; }

compose() {
  if [[ "$MODE" == "postgres" ]]; then docker compose -f "$COMPOSE_FILE" --profile postgres "$@";
  else docker compose -f "$COMPOSE_FILE" "$@"; fi
}

if [[ "${CRYSTAL_CONFIRM_DESTRUCTIVE_RESTORE:-}" == "restore local convex" ]]; then
  :
elif [[ -r /dev/tty ]]; then
  printf 'Restore will replace the selected local Convex data. Type "restore local convex" to continue: ' > /dev/tty
  IFS= read -r answer < /dev/tty
  [[ "$answer" == "restore local convex" ]] || { echo "Aborted." >&2; exit 1; }
else
  [[ "${CRYSTAL_CONFIRM_DESTRUCTIVE_RESTORE:-}" == "restore local convex" ]] || {
    echo "Set CRYSTAL_CONFIRM_DESTRUCTIVE_RESTORE='restore local convex' for non-interactive restore" >&2
    exit 1
  }
fi

if [[ "$MODE" == "postgres" ]]; then
  export POSTGRES_DB=${POSTGRES_DB:-convex_self_hosted}
  [[ "$POSTGRES_DB" == "convex_self_hosted" ]] || { echo "POSTGRES_DB must be convex_self_hosted for the default self-hosted instance" >&2; exit 2; }
  export POSTGRES_URL=${POSTGRES_URL:-postgresql://${POSTGRES_USER:-convex}:${POSTGRES_PASSWORD:-convex-local-password}@postgres:5432}
  export DO_NOT_REQUIRE_SSL=${DO_NOT_REQUIRE_SSL:-1}
fi

if [[ "$MODE" == "postgres" ]]; then compose up -d postgres backend >/dev/null;
else compose up -d backend >/dev/null; fi
BACKEND_ID=$(compose ps -q backend)
VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/convex/data"}}{{.Name}}{{end}}{{end}}' "$BACKEND_ID")
[[ -n "$VOLUME" ]] || { echo "Could not resolve Convex data volume" >&2; exit 1; }
compose stop backend >/dev/null

docker run --rm -v "$VOLUME:/target" -v "$SOURCE:/backup:ro" alpine:3.21 \
  sh -c 'rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; tar -C /target -xzf /backup/convex-data.tar.gz'

if [[ "$MODE" == "postgres" ]]; then
  [[ -f "$SOURCE/postgres.dump" ]] || { echo "Postgres backup missing" >&2; exit 1; }
  compose up -d postgres >/dev/null
  cat "$SOURCE/postgres.dump" | compose exec -T postgres pg_restore \
    --clean --if-exists --no-owner -U "${POSTGRES_USER:-convex}" -d "$POSTGRES_DB"
fi

compose up -d backend dashboard >/dev/null
echo "Restore complete. Run npm run convex:local:doctor and verify research counters before resuming workers."
