#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR"

PORT=${PORT:-3001}
SITE_URL=${SITE_URL:-}
RUN_DEV=1
CLEAR_CACHE=1

usage() {
  cat <<'EOF'
Usage: ./test-local.sh [--port <port>] [--site-url <url>] [--no-dev] [--keep-cache]

Starts/prepares the local Convex database, points the local web app at it,
runs the local doctor, then starts Next.js dev on the chosen port.

Defaults:
  --port 3001
  --site-url http://localhost:<port>

Examples:
  ./test-local.sh
  ./test-local.sh --port 3000
  ./test-local.sh --site-url http://localhost:3001
EOF
}

while (($#)); do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      PORT=$2
      shift 2
      ;;
    --site-url)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      SITE_URL=$2
      shift 2
      ;;
    --no-dev)
      RUN_DEV=0
      shift
      ;;
    --keep-cache)
      CLEAR_CACHE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SITE_URL" ]]; then
  SITE_URL="http://localhost:$PORT"
fi

case "$SITE_URL" in
  http://*|https://*) ;;
  *)
    printf 'SITE_URL must be an http(s) URL, got: %s\n' "$SITE_URL" >&2
    exit 2
    ;;
esac

printf '[test-local] Web URL: %s\n' "$SITE_URL"
printf '[test-local] Starting local Convex and provisioning auth env\n'
MEMORY_CRYSTAL_WEB_URL="$SITE_URL" npm run convex:local:up

printf '[test-local] Pointing apps/web at local Convex\n'
npm run web:backend:local -- --site-url "$SITE_URL"

printf '[test-local] Running local Convex doctor\n'
if ! npm run convex:local:doctor; then
  printf '[test-local] Local doctor failed; repairing local auth/env bridge and retrying once\n'
  node --experimental-strip-types scripts/convex-local-write-env.ts
  node --experimental-strip-types scripts/convex-local-import-auth.ts
  npm run convex:local:doctor
fi

if [[ "$RUN_DEV" == "0" ]]; then
  printf '[test-local] Ready. Start the app with: PORT=%s npm run dev\n' "$PORT"
  exit 0
fi

if [[ "$CLEAR_CACHE" == "1" ]]; then
  printf '[test-local] Clearing Next.js dev webpack cache\n'
  rm -rf apps/web/.next/cache/webpack
fi

printf '[test-local] Starting Next.js dev server on %s\n' "$SITE_URL"
cd apps/web
PORT="$PORT" npm run dev
