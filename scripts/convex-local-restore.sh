#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/convex/docker-compose.yml"
SOURCE=${1:-}
EXPECTED_CONFIRMATION="restore local convex"
CONFIRMATION=${CRYSTAL_CONFIRM_DESTRUCTIVE_RESTORE:-}
API_URL=${CONVEX_SELF_HOSTED_URL:-http://127.0.0.1:3210}
SITE_URL=${CRYSTAL_CONVEX_SITE_URL:-http://127.0.0.1:3211}
REPORT_ROOT=${CRYSTAL_RECOVERY_REPORT_DIR:-$HOME/.memorycrystal/recovery-reports}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/memorycrystal-restore.XXXXXX")
REPORT_PATH="$REPORT_ROOT/restore-$STAMP.json"
PRE_RESTORE_DIR="$REPORT_ROOT/pre-restore-$STAMP"
VERIFY_NAME="mc-restore-verify-$(printf '%s' "$STAMP" | tr '[:upper:]' '[:lower:]')-$$"
VERIFY_VOLUME="${VERIFY_NAME}-data"
MODE=""
BACKEND_IMAGE=""
LIVE_VOLUME=""
BACKEND_STOPPED=false
VERIFY_STARTED=false
ACTIVATION_STARTED=false
ROLLBACK_PERFORMED=false
CURRENT_PHASE=preflight

log() { printf '[convex-local-restore] %s\n' "$*" >&2; }
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
wait_for_doctor() {
  local api=${1:-$API_URL} site=${2:-$SITE_URL}
  for _ in $(seq 1 60); do
    CONVEX_SELF_HOSTED_URL="$api" CRYSTAL_CONVEX_SITE_URL="$site" \
      bash "$SCRIPT_DIR/convex-local-doctor.sh" >/dev/null 2>&1 && return 0
    sleep 1
  done
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
  token=$(read_local_token) || fail "Local auth bridge is required for restore canaries"
  collections=$(curl -fsS -H "Authorization: Bearer $token" "$site/api/research/collections?limit=1")
  collection_id=$(jq -r '.page[0]._id // .collections[0]._id // empty' <<< "$collections")
  [[ -n "$collection_id" ]] || fail "No research collection is available for restore canaries"
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
write_report() {
  local status=$1 phase=$2 message=${3:-} canary=${4:-null}
  mkdir -p "$REPORT_ROOT"
  jq -n --arg status "$status" --arg phase "$phase" --arg message "$message" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg source "$SOURCE" \
    --arg storageMode "$MODE" --arg preRestoreSnapshot "$PRE_RESTORE_DIR" \
    --argjson rollbackPerformed "$ROLLBACK_PERFORMED" --argjson canary "$canary" \
    '{schemaVersion:2,operation:"staged-restore",status:$status,phase:$phase,message:$message,createdAt:$createdAt,source:$source,storageMode:$storageMode,preRestoreSnapshot:$preRestoreSnapshot,rollbackPerformed:$rollbackPerformed,canary:$canary}' > "$REPORT_PATH.tmp"
  mv "$REPORT_PATH.tmp" "$REPORT_PATH"
}
rollback() {
  log "Activation failed; automatically restoring the pre-restore snapshot"
  compose stop backend >/dev/null 2>&1 || true
  BACKEND_STOPPED=true
  docker run --rm -v "$LIVE_VOLUME:/target" -v "$PRE_RESTORE_DIR:/backup:ro" alpine:3.21 \
    sh -c 'rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; tar -C /target -xzf /backup/convex-data.tar.gz'
  if [[ "$MODE" == postgres && -f "$PRE_RESTORE_DIR/postgres.dump" ]]; then
    compose up -d postgres >/dev/null 2>&1 || true
    compose exec -T postgres pg_restore --clean --if-exists --no-owner -U "${POSTGRES_USER:-convex}" -d "${POSTGRES_DB:-convex_self_hosted}" < "$PRE_RESTORE_DIR/postgres.dump" >/dev/null 2>&1 || true
  fi
  compose start backend >/dev/null 2>&1 || true
  BACKEND_STOPPED=false
  wait_for_http "$API_URL" || true
  ROLLBACK_PERFORMED=true
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  cleanup_verify
  if (( rc != 0 )) && [[ "$ACTIVATION_STARTED" == true ]]; then rollback; fi
  if [[ "$BACKEND_STOPPED" == true ]]; then compose start backend >/dev/null 2>&1 || true; wait_for_http "$API_URL" || true; fi
  if (( rc != 0 )); then write_report failed "$CURRENT_PHASE" "restore command failed with exit code $rc" null || true; log "Failure report: $REPORT_PATH"; fi
  docker run --rm -v "$WORK_DIR:/work" alpine:3.21 sh -c 'rm -rf /work/* /work/.[!.]* /work/..?* 2>/dev/null || true' >/dev/null 2>&1 || true
  rmdir "$WORK_DIR" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

main() {
  for cmd in docker curl jq sqlite3 shasum tar gzip git; do need_cmd "$cmd"; done
  [[ -n "$SOURCE" && -d "$SOURCE" ]] || fail "Usage: $0 /absolute/path/to/backup-directory"
  [[ -f "$SOURCE/manifest.json" ]] || fail "Backup manifest is missing"
  jq -e '.schemaVersion == 2 and .completionState == "complete" and .validationState == "validated" and .atomicCompletion == true' "$SOURCE/manifest.json" >/dev/null || fail "Backup manifest is incomplete, unvalidated, or uses an unsupported schema"
  MODE=$(jq -r '.storageMode' "$SOURCE/manifest.json")
  [[ "$MODE" == embedded || "$MODE" == postgres ]] || fail "Invalid backup storage mode"

  CURRENT_PHASE=manifest-validation
  local file path expected_hash expected_bytes actual_hash actual_bytes
  while IFS= read -r file; do
    path=$(jq -r '.path' <<< "$file")
    [[ "$path" == convex-data.tar.gz || "$path" == postgres.dump ]] || fail "Unsupported manifest file: $path"
    [[ -f "$SOURCE/$path" ]] || fail "Manifest file is missing: $path"
    expected_hash=$(jq -r '.sha256' <<< "$file")
    expected_bytes=$(jq -r '.bytes' <<< "$file")
    actual_hash=$(sha256_file "$SOURCE/$path")
    actual_bytes=$(file_bytes "$SOURCE/$path")
    [[ "$actual_hash" == "$expected_hash" ]] || fail "Checksum mismatch for $path"
    [[ "$actual_bytes" == "$expected_bytes" ]] || fail "Byte-size mismatch for $path"
  done < <(jq -c '.files[]' "$SOURCE/manifest.json")
  [[ -f "$SOURCE/convex-data.tar.gz" ]] || fail "Convex data archive is missing"
  if [[ "$MODE" == postgres ]]; then [[ -f "$SOURCE/postgres.dump" ]] || fail "Postgres dump is missing"; fi
  safe_archive "$SOURCE/convex-data.tar.gz"
  mkdir -p "$WORK_DIR/candidate"
  tar -xzf "$SOURCE/convex-data.tar.gz" -C "$WORK_DIR/candidate"
  [[ "$(artifact_count "$WORK_DIR/candidate")" == "$(jq -r '.artifacts.count' "$SOURCE/manifest.json")" ]] || fail "Artifact count mismatch"
  [[ "$(artifact_bytes "$WORK_DIR/candidate")" == "$(jq -r '.artifacts.bytes' "$SOURCE/manifest.json")" ]] || fail "Artifact byte mismatch"
  [[ "$(artifact_digest "$WORK_DIR/candidate")" == "$(jq -r '.artifacts.digest' "$SOURCE/manifest.json")" ]] || fail "Artifact checksum mismatch"

  local isolated_canary
  if [[ "$MODE" == embedded ]]; then
    [[ -f "$WORK_DIR/candidate/db.sqlite3" ]] || fail "Embedded database is missing"
    [[ "$(sqlite3 "$WORK_DIR/candidate/db.sqlite3" 'PRAGMA quick_check;')" == ok ]] || fail "Embedded quick_check failed"
    [[ "$(sqlite3 "$WORK_DIR/candidate/db.sqlite3" 'PRAGMA integrity_check;')" == ok ]] || fail "Embedded integrity_check failed"
    log "Booting the restore candidate in an isolated Docker volume"
    docker volume create "$VERIFY_VOLUME" >/dev/null
    docker run --rm -v "$VERIFY_VOLUME:/target" -v "$WORK_DIR/candidate:/source:ro" alpine:3.21 sh -c 'cp -a /source/. /target/'
    BACKEND_IMAGE=$(jq -r '.backendImage' "$SOURCE/manifest.json")
    docker run -d --name "$VERIFY_NAME" -p 127.0.0.1::3210 -p 127.0.0.1::3211 -v "$VERIFY_VOLUME:/convex/data" "$BACKEND_IMAGE" >/dev/null
    VERIFY_STARTED=true
    local verify_api_port verify_site_port verify_api verify_site
    verify_api_port=$(docker port "$VERIFY_NAME" 3210/tcp | head -1 | awk -F: '{print $NF}')
    verify_site_port=$(docker port "$VERIFY_NAME" 3211/tcp | head -1 | awk -F: '{print $NF}')
    verify_api="http://127.0.0.1:$verify_api_port"
    verify_site="http://127.0.0.1:$verify_site_port"
    wait_for_http "$verify_api" || fail "Isolated restore candidate did not become healthy"
    wait_for_doctor "$verify_api" "$verify_site" || fail "Doctor failed for isolated restore candidate"
    isolated_canary=$(api_canary "$verify_site")
    [[ "$(jq -S '.totals' <<< "$isolated_canary")" == "$(jq -S '.canary.source.totals' "$SOURCE/manifest.json")" ]] || fail "Restore candidate counters differ from the manifest"
    cleanup_verify
    VERIFY_STARTED=false
  else
    compose exec -T postgres pg_restore --list < "$SOURCE/postgres.dump" >/dev/null
    local verify_db="mc_restore_verify_$$"
    compose exec -T postgres createdb -U "${POSTGRES_USER:-convex}" "$verify_db"
    if ! compose exec -T postgres pg_restore --no-owner -U "${POSTGRES_USER:-convex}" -d "$verify_db" < "$SOURCE/postgres.dump"; then
      compose exec -T postgres dropdb -U "${POSTGRES_USER:-convex}" --if-exists "$verify_db" >/dev/null 2>&1 || true
      fail "Postgres isolated restore failed"
    fi
    compose exec -T postgres dropdb -U "${POSTGRES_USER:-convex}" --if-exists "$verify_db" >/dev/null
    isolated_canary=$(jq -c '.canary.source' "$SOURCE/manifest.json")
  fi

  if [[ "${CRYSTAL_RECOVERY_TEST_ABORT_PHASE:-}" == after-validation ]]; then
    CURRENT_PHASE=test-abort-after-validation
    fail "Injected test abort after validation"
  fi
  [[ "$CONFIRMATION" == "$EXPECTED_CONFIRMATION" ]] || fail "Set CRYSTAL_CONFIRM_DESTRUCTIVE_RESTORE='$EXPECTED_CONFIRMATION'"

  CURRENT_PHASE=pre-restore-snapshot
  local backend_id
  backend_id=$(compose ps -q backend)
  [[ -n "$backend_id" ]] || fail "Local Convex backend is not running"
  LIVE_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/convex/data"}}{{.Name}}{{end}}{{end}}' "$backend_id")
  mkdir -p "$PRE_RESTORE_DIR"
  compose stop backend >/dev/null
  BACKEND_STOPPED=true
  docker run --rm -v "$LIVE_VOLUME:/source:ro" -v "$PRE_RESTORE_DIR:/backup" alpine:3.21 tar -C /source -czf /backup/convex-data.tar.gz .
  if [[ "$MODE" == postgres ]]; then compose exec -T postgres pg_dump -U "${POSTGRES_USER:-convex}" -d "${POSTGRES_DB:-convex_self_hosted}" -Fc > "$PRE_RESTORE_DIR/postgres.dump"; fi
  jq -n --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg archiveHash "$(sha256_file "$PRE_RESTORE_DIR/convex-data.tar.gz")" --argjson archiveBytes "$(file_bytes "$PRE_RESTORE_DIR/convex-data.tar.gz")" \
    '{schemaVersion:2,completionState:"complete",purpose:"automatic-pre-restore-rollback",createdAt:$createdAt,files:[{path:"convex-data.tar.gz",sha256:$archiveHash,bytes:$archiveBytes}]}' > "$PRE_RESTORE_DIR/manifest.json"

  CURRENT_PHASE=activation
  ACTIVATION_STARTED=true
  docker run --rm -v "$LIVE_VOLUME:/target" -v "$WORK_DIR/candidate:/source:ro" alpine:3.21 \
    sh -c 'rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; cp -a /source/. /target/'
  if [[ "${CRYSTAL_RECOVERY_TEST_FAIL_PHASE:-}" == after-activation-copy ]]; then
    CURRENT_PHASE=test-failure-after-activation-copy
    fail "Injected activation failure after candidate copy"
  fi
  if [[ "$MODE" == postgres ]]; then
    compose up -d postgres >/dev/null
    compose exec -T postgres pg_restore --clean --if-exists --no-owner -U "${POSTGRES_USER:-convex}" -d "${POSTGRES_DB:-convex_self_hosted}" < "$SOURCE/postgres.dump"
  fi
  compose start backend >/dev/null
  BACKEND_STOPPED=false
  wait_for_http "$API_URL" || fail "Activated backend did not become healthy"
  wait_for_doctor || fail "Doctor failed after restore activation"
  local live_canary
  live_canary=$(api_canary "$SITE_URL")
  [[ "$(jq -S '.totals' <<< "$live_canary")" == "$(jq -S '.canary.source.totals' "$SOURCE/manifest.json")" ]] || fail "Activated restore counters differ from the manifest"

  CURRENT_PHASE=post-activation-integrity
  if [[ "$MODE" == embedded ]]; then
    compose stop backend >/dev/null
    BACKEND_STOPPED=true
    docker run --rm -v "$LIVE_VOLUME:/source:ro" -v "$WORK_DIR:/backup" alpine:3.21 cp /source/db.sqlite3 /backup/post-restore.sqlite3
    [[ "$(sqlite3 "$WORK_DIR/post-restore.sqlite3" 'PRAGMA quick_check;')" == ok ]] || fail "Post-restore quick_check failed"
    [[ "$(sqlite3 "$WORK_DIR/post-restore.sqlite3" 'PRAGMA integrity_check;')" == ok ]] || fail "Post-restore integrity_check failed"
    compose start backend >/dev/null
    BACKEND_STOPPED=false
    wait_for_http "$API_URL" || fail "Backend did not restart after post-restore integrity check"
  fi

  ACTIVATION_STARTED=false
  CURRENT_PHASE=complete
  write_report passed complete "staged restore and activation verified" "$live_canary"
  log "Restore complete: $REPORT_PATH"
  printf '%s\n' "$REPORT_PATH"
}

main "$@"
