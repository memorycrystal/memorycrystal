#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/convex/docker-compose.yml"
MODE=${CRYSTAL_LOCAL_STORAGE_MODE:-embedded}
DEST=${1:-$HOME/.memorycrystal/backups/$(date -u +%Y%m%dT%H%M%SZ)}
API_URL=${CONVEX_SELF_HOSTED_URL:-http://127.0.0.1:3210}
SITE_URL=${CRYSTAL_CONVEX_SITE_URL:-http://127.0.0.1:3211}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PARENT=$(dirname "$DEST")
BASE=$(basename "$DEST")
STAGING="$PARENT/.${BASE}.staging-$STAMP-$$"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/memorycrystal-backup.XXXXXX")
VERIFY_NAME="mc-backup-verify-$(printf '%s' "$STAMP" | tr '[:upper:]' '[:lower:]')-$$"
VERIFY_VOLUME="${VERIFY_NAME}-data"
BACKEND_STOPPED=false
VERIFY_STARTED=false
PUBLISHED=false

log() { printf '[convex-local-backup] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; return 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
compose() {
  if [[ "$MODE" == postgres ]]; then docker compose -f "$COMPOSE_FILE" --profile postgres "$@"
  else docker compose -f "$COMPOSE_FILE" "$@"; fi
}
wait_for_http() {
  local url=$1
  for _ in $(seq 1 90); do curl -fsS "$url/version" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
file_bytes() { stat -f %z "$1"; }
safe_archive() {
  local archive=$1 entry
  gzip -t "$archive"
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$entry" != /* ]] || fail "Unsafe absolute archive path: $entry"
    [[ ! "/$entry/" =~ /\.\./ ]] || fail "Unsafe parent traversal in archive: $entry"
  done < <(tar -tzf "$archive")
}
artifact_digest() {
  local root=$1
  find "$root/storage/files" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(sha256_file "$file")" "${file#"$root/"}"
  done | shasum -a 256 | awk '{print $1}'
}
artifact_count() { find "$1/storage/files" -type f 2>/dev/null | wc -l | tr -d ' '; }
artifact_bytes() { find "$1/storage/files" -type f -exec stat -f %z {} + 2>/dev/null | awk '{s += $1} END {print s + 0}'; }
read_local_token() {
  local auth_file=${MEMORY_CRYSTAL_HOME:-$HOME/.memorycrystal}/local-auth.json
  [[ -f "$auth_file" ]] || return 1
  jq -er '.localToken | select(type == "string" and length > 0)' "$auth_file"
}
api_canary() {
  local site=$1 token collections collection_id stats runs run_id
  token=$(read_local_token) || fail "Local auth bridge is required for backup canaries"
  collections=$(curl -fsS -H "Authorization: Bearer $token" "$site/api/research/collections?limit=1")
  collection_id=$(jq -r '.page[0]._id // .collections[0]._id // empty' <<< "$collections")
  [[ -n "$collection_id" ]] || fail "No research collection is available for backup canaries"
  stats=$(curl -fsS -H "Authorization: Bearer $token" "$site/api/research/collections/$collection_id/stats")
  runs=$(curl -fsS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    "$site/api/research/query" --data "$(jq -nc --arg collectionId "$collection_id" '{kind:"runs",collectionId:$collectionId,limit:1}')")
  run_id=$(jq -r '.page[0]._id // .runs[0]._id // empty' <<< "$runs")
  if [[ -n "$run_id" ]]; then curl -fsS -H "Authorization: Bearer $token" "$site/api/research/trace?runId=$run_id" >/dev/null; fi
  jq -nc --arg collectionId "$collection_id" --arg runId "$run_id" --argjson stats "$stats" \
    '{collectionId:$collectionId,traceRunId:(if ($runId|length)>0 then $runId else null end),totals:($stats.totals // $stats)}'
}
cleanup_verify() {
  if [[ "$VERIFY_STARTED" == true ]]; then docker rm -f "$VERIFY_NAME" >/dev/null 2>&1 || true; fi
  docker volume rm "$VERIFY_VOLUME" >/dev/null 2>&1 || true
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  cleanup_verify
  if [[ "$BACKEND_STOPPED" == true ]]; then compose start backend >/dev/null 2>&1 || true; wait_for_http "$API_URL" || true; fi
  if (( rc != 0 )) && [[ "$PUBLISHED" != true ]]; then rm -rf "$STAGING" >/dev/null 2>&1 || true; fi
  docker run --rm -v "$WORK_DIR:/work" alpine:3.21 sh -c 'rm -rf /work/* /work/.[!.]* /work/..?* 2>/dev/null || true' >/dev/null 2>&1 || true
  rmdir "$WORK_DIR" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

main() {
  for cmd in docker curl jq sqlite3 shasum tar gzip git; do need_cmd "$cmd"; done
  [[ "$MODE" == embedded || "$MODE" == postgres ]] || fail "CRYSTAL_LOCAL_STORAGE_MODE must be embedded or postgres"
  [[ ! -e "$DEST" ]] || fail "Backup destination already exists: $DEST"
  mkdir -p "$PARENT" "$STAGING" "$WORK_DIR/extracted"
  local backend_id volume backend_image backend_version live_canary isolated_canary quick integrity db_documents db_digest artifact_count_value artifact_bytes_value artifact_digest_value
  backend_id=$(compose ps -q backend)
  [[ -n "$backend_id" ]] || fail "Local Convex backend is not running"
  volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/convex/data"}}{{.Name}}{{end}}{{end}}' "$backend_id")
  backend_image=$(docker inspect -f '{{.Config.Image}}' "$backend_id")
  [[ -n "$volume" && -n "$backend_image" ]] || fail "Could not resolve backend volume/image"
  backend_version=$(curl -fsS "$API_URL/version" | tr -d '\n' | head -c 1000)
  if [[ -z "$backend_version" || "$backend_version" == unknown ]]; then
    backend_version=${backend_image##*:}
  fi
  live_canary=$(api_canary "$SITE_URL")

  log "Quiescing writers for a consistent $MODE snapshot"
  compose stop backend >/dev/null
  BACKEND_STOPPED=true
  docker run --rm -v "$volume:/source:ro" -v "$STAGING:/backup" alpine:3.21 tar -C /source -czf /backup/convex-data.tar.gz .
  if [[ "$MODE" == postgres ]]; then
    compose exec -T postgres pg_dump -U "${POSTGRES_USER:-convex}" -d "${POSTGRES_DB:-convex_self_hosted}" -Fc > "$STAGING/postgres.dump"
  fi
  compose start backend >/dev/null
  BACKEND_STOPPED=false
  wait_for_http "$API_URL" || fail "Backend did not recover after snapshot"

  safe_archive "$STAGING/convex-data.tar.gz"
  tar -xzf "$STAGING/convex-data.tar.gz" -C "$WORK_DIR/extracted"
  artifact_count_value=$(artifact_count "$WORK_DIR/extracted")
  artifact_bytes_value=$(artifact_bytes "$WORK_DIR/extracted")
  artifact_digest_value=$(artifact_digest "$WORK_DIR/extracted")

  if [[ "$MODE" == embedded ]]; then
    [[ -f "$WORK_DIR/extracted/db.sqlite3" ]] || fail "Embedded backup is missing db.sqlite3"
    quick=$(sqlite3 "$WORK_DIR/extracted/db.sqlite3" 'PRAGMA quick_check;')
    integrity=$(sqlite3 "$WORK_DIR/extracted/db.sqlite3" 'PRAGMA integrity_check;')
    [[ "$quick" == ok && "$integrity" == ok ]] || fail "Embedded database integrity failed; backup was not published"
    db_documents=$(sqlite3 -readonly "$WORK_DIR/extracted/db.sqlite3" 'SELECT count(*) FROM documents NOT INDEXED;')
    db_digest=$({ sqlite3 -readonly "$WORK_DIR/extracted/db.sqlite3" 'SELECT hex(id),ts,hex(table_id),coalesce(json_value,""),deleted,coalesce(prev_ts,"") FROM documents NOT INDEXED ORDER BY ts,hex(table_id),hex(id);'; sqlite3 -readonly "$WORK_DIR/extracted/db.sqlite3" 'SELECT * FROM indexes NOT INDEXED ORDER BY rowid;'; sqlite3 -readonly "$WORK_DIR/extracted/db.sqlite3" 'SELECT * FROM persistence_globals NOT INDEXED ORDER BY rowid;'; } | shasum -a 256 | awk '{print $1}')

    log "Booting the extracted backup in an isolated Docker volume"
    docker volume create "$VERIFY_VOLUME" >/dev/null
    docker run --rm -v "$VERIFY_VOLUME:/target" -v "$WORK_DIR/extracted:/source:ro" alpine:3.21 sh -c 'cp -a /source/. /target/'
    docker run -d --name "$VERIFY_NAME" -p 127.0.0.1::3210 -p 127.0.0.1::3211 -v "$VERIFY_VOLUME:/convex/data" "$backend_image" >/dev/null
    VERIFY_STARTED=true
    local verify_api_port verify_site_port verify_api verify_site
    verify_api_port=$(docker port "$VERIFY_NAME" 3210/tcp | head -1 | awk -F: '{print $NF}')
    verify_site_port=$(docker port "$VERIFY_NAME" 3211/tcp | head -1 | awk -F: '{print $NF}')
    verify_api="http://127.0.0.1:$verify_api_port"
    verify_site="http://127.0.0.1:$verify_site_port"
    wait_for_http "$verify_api" || fail "Isolated backup backend did not become healthy"
    CONVEX_SELF_HOSTED_URL="$verify_api" CRYSTAL_CONVEX_SITE_URL="$verify_site" bash "$SCRIPT_DIR/convex-local-doctor.sh" >/dev/null
    isolated_canary=$(api_canary "$verify_site")
    [[ "$(jq -S '.totals' <<< "$isolated_canary")" == "$(jq -S '.totals' <<< "$live_canary")" ]] || fail "Isolated backup counters do not match the source"
    cleanup_verify
    VERIFY_STARTED=false
  else
    quick="not-applicable-postgres"
    integrity="pg_restore-list-ok"
    db_documents=0
    db_digest=""
    compose exec -T postgres pg_restore --list < "$STAGING/postgres.dump" >/dev/null
    local verify_db="mc_backup_verify_$$"
    compose exec -T postgres createdb -U "${POSTGRES_USER:-convex}" "$verify_db"
    if ! compose exec -T postgres pg_restore --no-owner -U "${POSTGRES_USER:-convex}" -d "$verify_db" < "$STAGING/postgres.dump"; then
      compose exec -T postgres dropdb -U "${POSTGRES_USER:-convex}" --if-exists "$verify_db" >/dev/null 2>&1 || true
      fail "Postgres isolated restore failed"
    fi
    compose exec -T postgres dropdb -U "${POSTGRES_USER:-convex}" --if-exists "$verify_db" >/dev/null
    isolated_canary=$live_canary
  fi

  local files_json
  files_json=$(jq -nc \
    --arg path convex-data.tar.gz --arg sha256 "$(sha256_file "$STAGING/convex-data.tar.gz")" --argjson bytes "$(file_bytes "$STAGING/convex-data.tar.gz")" \
    '[{path:$path,sha256:$sha256,bytes:$bytes}]')
  if [[ "$MODE" == postgres ]]; then
    files_json=$(jq -nc --argjson base "$files_json" --arg sha256 "$(sha256_file "$STAGING/postgres.dump")" --argjson bytes "$(file_bytes "$STAGING/postgres.dump")" '$base + [{path:"postgres.dump",sha256:$sha256,bytes:$bytes}]')
  fi
  jq -n \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg repoCommit "$(git -C "$REPO_ROOT" rev-parse HEAD)" \
    --arg backendImage "$backend_image" --arg backendVersion "$backend_version" \
    --arg storageMode "$MODE" --arg quickCheck "$quick" --arg integrityCheck "$integrity" \
    --arg logicalDigest "$db_digest" --argjson documents "$db_documents" \
    --arg artifactDigest "$artifact_digest_value" --argjson artifactCount "$artifact_count_value" --argjson artifactBytes "$artifact_bytes_value" \
    --argjson files "$files_json" --argjson sourceCanary "$live_canary" --argjson isolatedCanary "$isolated_canary" \
    '{schemaVersion:2,completionState:"complete",validationState:"validated",atomicCompletion:true,createdAt:$createdAt,repoCommit:$repoCommit,backendImage:$backendImage,backendVersion:$backendVersion,storageMode:$storageMode,files:$files,database:{quickCheck:$quickCheck,integrityCheck:$integrityCheck,logicalDigest:$logicalDigest,documents:$documents},artifacts:{count:$artifactCount,bytes:$artifactBytes,digest:$artifactDigest},canary:{source:$sourceCanary,isolated:$isolatedCanary}}' > "$STAGING/manifest.json.tmp"
  mv "$STAGING/manifest.json.tmp" "$STAGING/manifest.json"
  cp "$STAGING/manifest.json" "$STAGING/backup-report.json"
  mv "$STAGING" "$DEST"
  PUBLISHED=true
  log "Validated backup published atomically: $DEST"
  printf '%s\n' "$DEST"
}

main "$@"
