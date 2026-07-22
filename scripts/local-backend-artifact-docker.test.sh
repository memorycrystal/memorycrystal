#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_ROOT=${CRYSTAL_TEST_ARTIFACT_ROOT:-}
[[ -n "$ARTIFACT_ROOT" && -d "$ARTIFACT_ROOT" ]] || { echo "CRYSTAL_TEST_ARTIFACT_ROOT is required" >&2; exit 2; }

PROJECT="mc-artifact-$RANDOM-$$"
BASE=$((13200 + ($$ % 1000)))
export COMPOSE_PROJECT_NAME=$PROJECT
export PORT=$BASE
export SITE_PROXY_PORT=$((BASE + 1))
export DASHBOARD_PORT=$((BASE + 2))
export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:$PORT"
export CRYSTAL_CONVEX_SITE_URL="http://127.0.0.1:$SITE_PROXY_PORT"
export CRYSTAL_CONVEX_DASHBOARD_URL="http://127.0.0.1:$DASHBOARD_PORT"
export MEMORY_CRYSTAL_WEB_URL="http://localhost:$((BASE + 3))"
export MEMORY_CRYSTAL_HOME
MEMORY_CRYSTAL_HOME=$(mktemp -d "${TMPDIR:-/tmp}/mc-artifact-home.XXXXXX")
export GEMINI_API_KEY=local-dev-gemini-stub
TOKEN="mc_local_artifact_${RANDOM}_$$"
USER_ID="local_artifact_${RANDOM}_$$"
TOKEN_HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')
mkdir -p "$MEMORY_CRYSTAL_HOME"
cat > "$MEMORY_CRYSTAL_HOME/local-auth.json" <<EOF
{"backend":"local-convex","userId":"$USER_ID","localToken":"$TOKEN","localTokenSha256":"$TOKEN_HASH"}
EOF

compose() { docker compose -p "$PROJECT" -f "$ARTIFACT_ROOT/infra/convex/docker-compose.yml" "$@"; }
cleanup() {
  compose down -v >/dev/null 2>&1 || true
  rm -rf "$MEMORY_CRYSTAL_HOME"
}
trap cleanup EXIT

wait_backend() {
  for _ in $(seq 1 90); do
    curl -fsS "$CONVEX_SELF_HOSTED_URL/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "Backend did not become ready" >&2
  return 1
}

api_post() {
  local path=$1 payload=$2
  curl -fsS -X POST "$CRYSTAL_CONVEX_SITE_URL$path" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data "$payload"
}

json_field() {
  local field=$1
  node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const v=JSON.parse(s);const out=v[process.argv[1]];if(out===undefined||out===null)process.exit(2);process.stdout.write(String(out));});' "$field"
}

cd "$ARTIFACT_ROOT"
bash scripts/convex-local-up.sh --storage=embedded
wait_backend

CAPTURE=$(api_post /api/mcp/capture '{"title":"Artifact persistence canary","content":"The packaged local backend persists authenticated memories across restarts.","store":"semantic","category":"fact","tags":["artifact-test"]}')
printf '%s' "$CAPTURE" | json_field id >/dev/null
RECALL=$(api_post /api/mcp/recall '{"query":"packaged local backend persistence","limit":5}')
printf '%s' "$RECALL" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const v=JSON.parse(s);if(!Array.isArray(v.memories))process.exit(2);});'

KB=$(api_post /api/knowledge-bases '{"name":"Artifact Test KB","description":"Packaged artifact integration canary"}')
KB_ID=$(printf '%s' "$KB" | json_field knowledgeBaseId)
api_post "/api/knowledge-bases/$KB_ID/bulk-insert" '{"chunks":[{"title":"Canary","content":"Artifact knowledge base query canary","chunkIndex":0,"totalChunks":1,"dedupeKey":"canary"}]}' >/dev/null
api_post "/api/knowledge-bases/$KB_ID/query" '{"query":"artifact canary","limit":3,"includeGraphContext":false}' >/dev/null

COLLECTION=$(api_post /api/research/collections '{"name":"Artifact Research","domain":"integration","retentionPolicy":"test"}')
COLLECTION_ID=$(printf '%s' "$COLLECTION" | json_field collectionId)
SOURCE=$(api_post /api/research/sources "{\"collectionId\":\"$COLLECTION_ID\",\"source\":{\"stableKey\":\"source:v1\",\"idempotencyKey\":\"source:v1\",\"sourceType\":\"document\",\"host\":\"example.test\",\"canonicalUrl\":\"https://example.test/source\",\"immutableVersion\":\"v1\",\"retrievedAt\":1,\"contentHash\":\"sha256-canary\",\"licenseId\":\"MIT\",\"licenseDisposition\":\"acceptable\",\"securityDisposition\":\"clean\",\"quarantineState\":\"released\",\"parserVersion\":\"artifact-test-v1\"}}")
printf '%s' "$SOURCE" | json_field sourceId >/dev/null

VOLUME_BEFORE=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/convex/data"}}{{.Name}}{{end}}{{end}}' "$(compose ps -q backend)")
compose restart backend >/dev/null
wait_backend
STATS=$(curl -fsS "$CRYSTAL_CONVEX_SITE_URL/api/research/collections/$COLLECTION_ID/stats" -H "Authorization: Bearer $TOKEN")
printf '%s' "$STATS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const v=JSON.parse(s);if(v.totals?.sources!==1)process.exit(2);});'

# Upgrade and rollback entry points reuse the exact compose project and volume.
# CI may provide distinct candidate/baseline artifacts; otherwise this still
# proves repeated install/redeploy and rollback restarts are non-destructive.
UPGRADE_ROOT=${CRYSTAL_TEST_UPGRADE_ARTIFACT_ROOT:-$ARTIFACT_ROOT}
ROLLBACK_ROOT=${CRYSTAL_TEST_ROLLBACK_ARTIFACT_ROOT:-$ARTIFACT_ROOT}
(cd "$UPGRADE_ROOT" && bash scripts/convex-local-up.sh --storage=embedded)
(cd "$ROLLBACK_ROOT" && bash scripts/convex-local-up.sh --storage=embedded)
wait_backend
VOLUME_AFTER=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/convex/data"}}{{.Name}}{{end}}{{end}}' "$(compose ps -q backend)")
[[ "$VOLUME_BEFORE" == "$VOLUME_AFTER" ]] || { echo "Upgrade/rollback changed the data volume" >&2; exit 1; }
STATS=$(curl -fsS "$CRYSTAL_CONVEX_SITE_URL/api/research/collections/$COLLECTION_ID/stats" -H "Authorization: Bearer $TOKEN")
printf '%s' "$STATS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const v=JSON.parse(s);if(v.totals?.sources!==1)process.exit(2);});'

echo "Packaged artifact Docker deploy/auth/memory/recall/KB/research/restart/upgrade/rollback test passed."
