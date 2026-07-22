#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/convex/docker-compose.yml"
WIPE=0

usage() {
  cat <<'EOF'
Usage: bash scripts/convex-local-down.sh [--wipe]

Stops the local Convex stack. Volumes are preserved unless --wipe is passed.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --wipe) WIPE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "Missing required command: docker" >&2; exit 1; }

if (( WIPE )); then
  if [[ -t 0 ]]; then
    read -r -p "Remove local Convex containers and volumes? This deletes local data. Type 'wipe local convex' to continue: " answer
    [[ "$answer" == "wipe local convex" ]] || { echo "Aborted."; exit 1; }
  fi
  docker compose -f "$COMPOSE_FILE" down --volumes
else
  docker compose -f "$COMPOSE_FILE" down
fi
