#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR"

PORT=${PORT:-3001}
SITE_URL=${SITE_URL:-}
REMOTE_CONVEX_URL=${MEMORY_CRYSTAL_REMOTE_CONVEX_URL:-${NEXT_PUBLIC_REMOTE_CONVEX_URL:-${REMOTE_CONVEX_URL:-https://convex-backend-prod-production.up.railway.app}}}
REMOTE_CONVEX_SITE_URL=${MEMORY_CRYSTAL_REMOTE_CONVEX_SITE_URL:-${REMOTE_CONVEX_SITE_URL:-https://convex.memorycrystal.ai}}
REMOTE_DEPLOYMENT=${REMOTE_CONVEX_DEPLOYMENT:-}
RUN_DEV=1
SET_SITE_URL=0
CLEAR_CACHE=1

usage() {
  cat <<'EOF'
Usage: ./test-remote.sh [options]

Points the local web app at the production remote Convex deployment, then starts
Next.js dev.

Options:
  --convex-url <url>        Override remote Convex RPC URL.
  --convex-site-url <url>   Override remote HTTP-actions URL.
  --deployment <name>       Override Convex deployment name for SITE_URL updates.
  --port <port>             Local web port. Default: 3001
  --site-url <url>          Local web origin. Default: http://localhost:<port>
  --set-site-url-env        Set remote Convex deployment env SITE_URL to the local origin.
  --no-dev                  Configure only; do not start Next.js dev.
  --keep-cache              Keep the existing Next.js webpack dev cache.

Production defaults:
  Remote RPC:          https://convex-backend-prod-production.up.railway.app
  Remote HTTP actions: https://convex.memorycrystal.ai
  Deployment:          self-hosted Railway (no Convex Cloud selector)

Environment overrides:
  MEMORY_CRYSTAL_REMOTE_CONVEX_URL
  NEXT_PUBLIC_REMOTE_CONVEX_URL
  REMOTE_CONVEX_URL
  MEMORY_CRYSTAL_REMOTE_CONVEX_SITE_URL
  REMOTE_CONVEX_SITE_URL
  REMOTE_CONVEX_DEPLOYMENT

Examples:
  ./test-remote.sh
  ./test-remote.sh --no-dev
  ./test-remote.sh --set-site-url-env
EOF
}

while (($#)); do
  case "$1" in
    --convex-url)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      REMOTE_CONVEX_URL=$2
      shift 2
      ;;
    --convex-site-url)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      REMOTE_CONVEX_SITE_URL=$2
      shift 2
      ;;
    --deployment)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      REMOTE_DEPLOYMENT=$2
      shift 2
      ;;
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
    --set-site-url-env)
      SET_SITE_URL=1
      shift
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

case "$REMOTE_CONVEX_URL" in
  http://*|https://*) ;;
  *)
    printf 'Remote Convex URL must be an http(s) URL, got: %s\n' "$REMOTE_CONVEX_URL" >&2
    exit 2
    ;;
esac

printf '[test-remote] Web URL: %s\n' "$SITE_URL"
printf '[test-remote] Remote Convex RPC: %s\n' "$REMOTE_CONVEX_URL"

web_backend_args=(--convex-url "$REMOTE_CONVEX_URL" --site-url "$SITE_URL")
if [[ -n "$REMOTE_CONVEX_SITE_URL" ]]; then
  web_backend_args+=(--convex-site-url "$REMOTE_CONVEX_SITE_URL")
  printf '[test-remote] Remote Convex HTTP actions: %s\n' "$REMOTE_CONVEX_SITE_URL"
fi

printf '[test-remote] Pointing apps/web at remote Convex\n'
npm run web:backend:remote -- "${web_backend_args[@]}"

if [[ "$SET_SITE_URL" == "1" ]]; then
  if [[ -n "$REMOTE_DEPLOYMENT" ]]; then
    printf '[test-remote] Setting remote Convex Auth SITE_URL=%s on %s\n' "$SITE_URL" "$REMOTE_DEPLOYMENT"
    CONVEX_DEPLOYMENT="$REMOTE_DEPLOYMENT" npx convex env set SITE_URL "$SITE_URL"
  else
    printf '[test-remote] Setting self-hosted Railway Convex Auth SITE_URL=%s\n' "$SITE_URL"
    node scripts/convex-self-hosted-cli.mjs env set SITE_URL "$SITE_URL"
  fi
else
  printf '[test-remote] Leaving production SITE_URL unchanged. Use --set-site-url-env only when you intentionally want remote auth redirects pointed at %s.\n' "$SITE_URL"
fi

if [[ "$RUN_DEV" == "0" ]]; then
  printf '[test-remote] Ready. Start the app with: PORT=%s npm run dev\n' "$PORT"
  exit 0
fi

if [[ "$CLEAR_CACHE" == "1" ]]; then
  printf '[test-remote] Clearing Next.js dev webpack cache\n'
  rm -rf apps/web/.next/cache/webpack
fi

printf '[test-remote] Starting Next.js dev server on %s\n' "$SITE_URL"
cd apps/web
PORT="$PORT" npm run dev
