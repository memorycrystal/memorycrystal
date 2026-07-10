#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_ROOT=${CRYSTAL_TEST_ARTIFACT_ROOT:-}
[[ -n "$ARTIFACT_ROOT" && -d "$ARTIFACT_ROOT" ]] || { echo "CRYSTAL_TEST_ARTIFACT_ROOT is required" >&2; exit 2; }

PROJECT="mc-postgres-$RANDOM-$$"
BASE=$((14200 + ($$ % 700)))
export COMPOSE_PROJECT_NAME=$PROJECT
export PORT=$BASE
export SITE_PROXY_PORT=$((BASE + 1))
export DASHBOARD_PORT=$((BASE + 2))
export POSTGRES_PORT=$((BASE + 3))
export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:$PORT"
export CRYSTAL_CONVEX_SITE_URL="http://127.0.0.1:$SITE_PROXY_PORT"
export CRYSTAL_CONVEX_DASHBOARD_URL="http://127.0.0.1:$DASHBOARD_PORT"
export MEMORY_CRYSTAL_WEB_URL="http://localhost:$((BASE + 4))"
export CRYSTAL_LOCAL_STORAGE_MODE=postgres
export POSTGRES_DB=convex_self_hosted
export POSTGRES_USER=convex
export POSTGRES_PASSWORD=convex-local-password
export POSTGRES_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432"
export DO_NOT_REQUIRE_SSL=1
export MEMORY_CRYSTAL_HOME
MEMORY_CRYSTAL_HOME=$(mktemp -d "${TMPDIR:-/tmp}/mc-postgres-home.XXXXXX")
BACKUP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mc-postgres-backup.XXXXXX")
export GEMINI_API_KEY=local-dev-gemini-stub
export OPENROUTER_API_KEY=local-test-stub
TOKEN="mc_local_postgres_${RANDOM}_$$"
USER_ID="local_postgres_${RANDOM}_$$"
TOKEN_HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')
mkdir -p "$MEMORY_CRYSTAL_HOME"
cat > "$MEMORY_CRYSTAL_HOME/local-auth.json" <<EOF
{"backend":"local-convex","userId":"$USER_ID","localToken":"$TOKEN","localTokenSha256":"$TOKEN_HASH"}
EOF

compose() { docker compose -p "$PROJECT" -f "$ARTIFACT_ROOT/infra/convex/docker-compose.yml" --profile postgres "$@"; }
cleanup() {
  local status=$?
  if (( status != 0 )); then compose logs --tail=160 backend postgres >&2 || true; fi
  compose down -v >/dev/null 2>&1 || true
  rm -rf "$MEMORY_CRYSTAL_HOME" "$BACKUP_ROOT"
  return "$status"
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

assert_source_count() {
  local expected=$1
  curl -fsS "$CRYSTAL_CONVEX_SITE_URL/api/research/collections/$COLLECTION_ID/stats" \
    -H "Authorization: Bearer $TOKEN" | \
    node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const v=JSON.parse(s);if(v.totals?.sources!==Number(process.argv[1])){console.error(s);process.exit(2);}});' "$expected"
}

cd "$ARTIFACT_ROOT"
bash scripts/convex-local-up.sh --storage=postgres
wait_backend

COLLECTION=$(api_post /api/research/collections '{"name":"Postgres Recovery","domain":"integration","retentionPolicy":"test"}')
COLLECTION_ID=$(printf '%s' "$COLLECTION" | json_field collectionId)
api_post /api/research/sources "{\"collectionId\":\"$COLLECTION_ID\",\"source\":{\"stableKey\":\"source:before-backup\",\"idempotencyKey\":\"source:before-backup\",\"sourceType\":\"document\",\"host\":\"example.test\",\"canonicalUrl\":\"https://example.test/before\",\"immutableVersion\":\"v1\",\"retrievedAt\":1,\"contentHash\":\"sha256-before\",\"licenseId\":\"MIT\",\"licenseDisposition\":\"acceptable\",\"securityDisposition\":\"clean\",\"quarantineState\":\"released\",\"parserVersion\":\"postgres-test-v1\"}}" >/dev/null
assert_source_count 1

bash scripts/convex-local-backup.sh "$BACKUP_ROOT"
[[ -s "$BACKUP_ROOT/postgres.dump" && -s "$BACKUP_ROOT/convex-data.tar.gz" ]] || { echo "Postgres backup artifacts are missing" >&2; exit 1; }

api_post /api/research/sources "{\"collectionId\":\"$COLLECTION_ID\",\"source\":{\"stableKey\":\"source:after-backup\",\"idempotencyKey\":\"source:after-backup\",\"sourceType\":\"document\",\"host\":\"example.test\",\"canonicalUrl\":\"https://example.test/after\",\"immutableVersion\":\"v1\",\"retrievedAt\":2,\"contentHash\":\"sha256-after\",\"licenseId\":\"MIT\",\"licenseDisposition\":\"acceptable\",\"securityDisposition\":\"clean\",\"quarantineState\":\"released\",\"parserVersion\":\"postgres-test-v1\"}}" >/dev/null
assert_source_count 2

CRYSTAL_CONFIRM_DESTRUCTIVE_RESTORE='restore local convex' bash scripts/convex-local-restore.sh "$BACKUP_ROOT"
wait_backend
assert_source_count 1
compose restart backend >/dev/null
wait_backend
assert_source_count 1

echo "Packaged artifact Postgres deploy/auth/research/backup/restore/restart test passed."
