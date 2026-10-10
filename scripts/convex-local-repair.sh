#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/infra/convex/docker-compose.yml"
MODE=${CRYSTAL_LOCAL_STORAGE_MODE:-embedded}
CONFIRMATION=${CRYSTAL_CONFIRM_OFFLINE_REPAIR:-}
EXPECTED_CONFIRMATION="repair local convex index"
EXPECTED_INDEX="documents_by_table_and_id"
API_URL=${CONVEX_SELF_HOSTED_URL:-http://127.0.0.1:3210}
SITE_URL=${CRYSTAL_CONVEX_SITE_URL:-http://127.0.0.1:3211}
REPORT_ROOT=${CRYSTAL_RECOVERY_REPORT_DIR:-$HOME/.memorycrystal/recovery-reports}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/memorycrystal-repair.XXXXXX")
SAFETY_DIR="$REPORT_ROOT/repair-safety-$STAMP"
REPORT_PATH="$REPORT_ROOT/repair-$STAMP.json"
VERIFY_NAME="mc-repair-verify-$(printf '%s' "$STAMP" | tr '[:upper:]' '[:lower:]')-$$"
VERIFY_VOLUME="${VERIFY_NAME}-data"
BACKEND_IMAGE=""
BACKEND_STOPPED=false
LIVE_APPLIED=false
VERIFY_STARTED=false

log() { printf '[convex-local-repair] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; return 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
compose() {
  if [[ "$MODE" == "postgres" ]]; then
    docker compose -f "$COMPOSE_FILE" --profile postgres "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
file_bytes() { stat -f %z "$1"; }
wait_for_http() {
  local url=$1
  for _ in $(seq 1 90); do
    curl -fsS "$url/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
integrity_output() { sqlite3 "$1" 'PRAGMA integrity_check;' 2>&1; }
quick_output() { sqlite3 "$1" 'PRAGMA quick_check;' 2>&1; }
logical_digest() {
  local db=$1
  {
    sqlite3 -readonly "$db" 'SELECT hex(id),ts,hex(table_id),coalesce(json_value,""),deleted,coalesce(prev_ts,"") FROM documents NOT INDEXED ORDER BY ts,hex(table_id),hex(id);'
    sqlite3 -readonly "$db" 'SELECT * FROM indexes NOT INDEXED ORDER BY rowid;'
    sqlite3 -readonly "$db" 'SELECT * FROM persistence_globals NOT INDEXED ORDER BY rowid;'
  } | shasum -a 256 | awk '{print $1}'
}
artifact_digest() {
  local root=$1
  if [[ ! -d "$root/storage/files" ]]; then
    printf '%s' empty | shasum -a 256 | awk '{print $1}'
    return
  fi
  find "$root/storage/files" -type f | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(sha256_file "$file")" "${file#"$root/"}"
  done | shasum -a 256 | awk '{print $1}'
}
artifact_count() { find "$1/storage/files" -type f 2>/dev/null | wc -l | tr -d ' '; }
artifact_bytes() {
  find "$1/storage/files" -type f -exec stat -f %z {} + 2>/dev/null | awk '{total += $1} END {print total + 0}'
}
document_count() { sqlite3 -readonly "$1" 'SELECT count(*) FROM documents NOT INDEXED;'; }
assert_expected_index_damage() {
  local output=$1 line seen=false
  [[ "$output" != "ok" ]] || fail "Disposable copy is already healthy; refusing an unnecessary repair"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == "wrong # of entries in index $EXPECTED_INDEX" ]] ||
       [[ "$line" =~ ^row\ [0-9]+\ missing\ from\ index\ $EXPECTED_INDEX$ ]]; then
      seen=true
      continue
    fi
    fail "Damage is not limited to $EXPECTED_INDEX: $line"
  done <<< "$output"
  [[ "$seen" == true ]] || fail "Expected index damage was not observed"
}
safe_archive() {
  local archive=$1 entry
  gzip -t "$archive"
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$entry" != /* ]] || fail "Unsafe absolute archive path: $entry"
    [[ ! "/$entry/" =~ /\.\./ ]] || fail "Unsafe parent traversal in archive: $entry"
  done < <(tar -tzf "$archive")
}
read_local_token() {
  local auth_file=${MEMORY_CRYSTAL_HOME:-$HOME/.memorycrystal}/local-auth.json
  [[ -f "$auth_file" ]] || return 1
  jq -er '.localToken | select(type == "string" and length > 0)' "$auth_file"
}
api_canary() {
  local site=$1 token collections collection_id runs run_id
  token=$(read_local_token) || fail "Local auth bridge is required for isolated API canaries"
  collections=$(curl -fsS -H "Authorization: Bearer $token" "$site/api/research/collections?limit=1")
  collection_id=$(jq -r '.page[0]._id // .collections[0]._id // empty' <<< "$collections")
  [[ -n "$collection_id" ]] || fail "No research collection is available for the recovery canary"
  curl -fsS -H "Authorization: Bearer $token" "$site/api/research/collections/$collection_id/stats" >/dev/null
  runs=$(curl -fsS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    "$site/api/research/query" --data "$(jq -nc --arg collectionId "$collection_id" '{kind:"runs",collectionId:$collectionId,limit:1}')")
  run_id=$(jq -r '.page[0]._id // .runs[0]._id // empty' <<< "$runs")
  if [[ -n "$run_id" ]]; then
    curl -fsS -H "Authorization: Bearer $token" "$site/api/research/trace?runId=$run_id" >/dev/null
  fi
  jq -nc --arg collectionId "$collection_id" --arg runId "$run_id" \
    '{collectionId:$collectionId,traceRunId:(if ($runId | length) > 0 then $runId else null end)}'
}
write_report() {
  local status=$1 phase=$2 message=${3:-} quick=${4:-} integrity=${5:-} canary=${6:-null}
  mkdir -p "$REPORT_ROOT"
  local tmp="$REPORT_PATH.tmp"
  jq -n \
    --arg status "$status" --arg phase "$phase" --arg message "$message" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg repoCommit "$(git -C "$REPO_ROOT" rev-parse HEAD)" \
    --arg backendImage "$BACKEND_IMAGE" --arg storageMode "$MODE" \
    --arg expectedIndex "$EXPECTED_INDEX" --arg safetySnapshot "$SAFETY_DIR" \
    --arg quickCheck "$quick" --arg integrityCheck "$integrity" \
    --argjson canary "$canary" \
    '{schemaVersion:2,operation:"offline-index-repair",status:$status,phase:$phase,message:$message,createdAt:$createdAt,repoCommit:$repoCommit,backendImage:$backendImage,storageMode:$storageMode,expectedIndex:$expectedIndex,safetySnapshot:$safetySnapshot,database:{quickCheck:$quickCheck,integrityCheck:$integrityCheck},canary:$canary}' > "$tmp"
  mv "$tmp" "$REPORT_PATH"
}
cleanup_verify() {
  if [[ "$VERIFY_STARTED" == true ]]; then docker rm -f "$VERIFY_NAME" >/dev/null 2>&1 || true; fi
  docker volume rm "$VERIFY_VOLUME" >/dev/null 2>&1 || true
}
restore_live_db() {
  log "Rolling back the live database from the safety snapshot"
  compose stop backend >/dev/null 2>&1 || true
  BACKEND_STOPPED=true
  docker run --rm -v "$LIVE_VOLUME:/target" -v "$WORK_DIR/original:/source:ro" alpine:3.21 \
    sh -c 'cp /source/db.sqlite3 /target/db.sqlite3.rollback && mv /target/db.sqlite3.rollback /target/db.sqlite3'
  compose start backend >/dev/null 2>&1 || true
  BACKEND_STOPPED=false
  wait_for_http "$API_URL" || true
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  cleanup_verify
  if (( rc != 0 )) && [[ "$LIVE_APPLIED" == true ]]; then restore_live_db; fi
  if [[ "$BACKEND_STOPPED" == true ]]; then compose start backend >/dev/null 2>&1 || true; fi
  if (( rc != 0 )); then
    write_report failed "${CURRENT_PHASE:-unknown}" "repair command failed with exit code $rc" "${FINAL_QUICK:-}" "${FINAL_INTEGRITY:-}" null || true
    log "Failure report: $REPORT_PATH"
  fi
  docker run --rm -v "$WORK_DIR:/work" alpine:3.21 sh -c 'rm -rf /work/* /work/.[!.]* /work/..?* 2>/dev/null || true' >/dev/null 2>&1 || true
  rmdir "$WORK_DIR" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

main() {
  CURRENT_PHASE=preflight
  for cmd in docker curl jq sqlite3 shasum tar gzip git; do need_cmd "$cmd"; done
  [[ "$MODE" == embedded ]] || fail "Offline SQLite repair only supports CRYSTAL_LOCAL_STORAGE_MODE=embedded"
  [[ "$CONFIRMATION" == "$EXPECTED_CONFIRMATION" ]] || fail "Set CRYSTAL_CONFIRM_OFFLINE_REPAIR='$EXPECTED_CONFIRMATION'"
  mkdir -p "$REPORT_ROOT" "$SAFETY_DIR" "$WORK_DIR/original" "$WORK_DIR/candidate"

  local backend_id
  backend_id=$(compose ps -q backend)
  [[ -n "$backend_id" ]] || fail "Local Convex backend is not running"
  LIVE_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/convex/data"}}{{.Name}}{{end}}{{end}}' "$backend_id")
  BACKEND_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$backend_id")
  [[ -n "$LIVE_VOLUME" && -n "$BACKEND_IMAGE" ]] || fail "Could not resolve local backend volume/image"

  CURRENT_PHASE=safety-snapshot
  log "Quiescing the embedded backend and creating a safety snapshot"
  compose stop backend >/dev/null
  BACKEND_STOPPED=true
  docker run --rm -v "$LIVE_VOLUME:/source:ro" -v "$SAFETY_DIR:/backup" alpine:3.21 \
    tar -C /source -czf /backup/convex-data.tar.gz .
  safe_archive "$SAFETY_DIR/convex-data.tar.gz"
  tar -xzf "$SAFETY_DIR/convex-data.tar.gz" -C "$WORK_DIR/original"
  cp -a "$WORK_DIR/original/." "$WORK_DIR/candidate/"

  local before_integrity before_quick before_digest before_artifacts before_count before_artifact_count before_artifact_bytes
  before_quick=$(quick_output "$WORK_DIR/original/db.sqlite3")
  before_integrity=$(integrity_output "$WORK_DIR/original/db.sqlite3")
  assert_expected_index_damage "$before_quick"
  assert_expected_index_damage "$before_integrity"
  before_digest=$(logical_digest "$WORK_DIR/original/db.sqlite3")
  before_artifacts=$(artifact_digest "$WORK_DIR/original")
  before_count=$(document_count "$WORK_DIR/original/db.sqlite3")
  before_artifact_count=$(artifact_count "$WORK_DIR/original")
  before_artifact_bytes=$(artifact_bytes "$WORK_DIR/original")
  jq -n \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg repoCommit "$(git -C "$REPO_ROOT" rev-parse HEAD)" \
    --arg backendImage "$BACKEND_IMAGE" --arg storageMode "$MODE" \
    --arg archiveSha256 "$(sha256_file "$SAFETY_DIR/convex-data.tar.gz")" \
    --argjson archiveBytes "$(file_bytes "$SAFETY_DIR/convex-data.tar.gz")" \
    --arg quickCheck "$before_quick" --arg integrityCheck "$before_integrity" \
    --arg logicalDigest "$before_digest" --arg artifactDigest "$before_artifacts" \
    --argjson documents "$before_count" --argjson artifactCount "$before_artifact_count" --argjson artifactBytes "$before_artifact_bytes" \
    '{schemaVersion:2,completionState:"complete",validationState:"known-repairable-index-damage",createdAt:$createdAt,repoCommit:$repoCommit,backendImage:$backendImage,storageMode:$storageMode,files:[{path:"convex-data.tar.gz",sha256:$archiveSha256,bytes:$archiveBytes}],database:{quickCheck:$quickCheck,integrityCheck:$integrityCheck,logicalDigest:$logicalDigest,documents:$documents},artifacts:{count:$artifactCount,bytes:$artifactBytes,digest:$artifactDigest},atomicCompletion:true}' \
    > "$SAFETY_DIR/manifest.json.tmp"
  mv "$SAFETY_DIR/manifest.json.tmp" "$SAFETY_DIR/manifest.json"

  CURRENT_PHASE=disposable-repair
  log "Repairing the disposable copy"
  sqlite3 "$WORK_DIR/candidate/db.sqlite3" "REINDEX $EXPECTED_INDEX;"
  FINAL_QUICK=$(quick_output "$WORK_DIR/candidate/db.sqlite3")
  FINAL_INTEGRITY=$(integrity_output "$WORK_DIR/candidate/db.sqlite3")
  [[ "$FINAL_QUICK" == ok && "$FINAL_INTEGRITY" == ok ]] || fail "Disposable repair did not pass integrity checks"
  [[ "$(logical_digest "$WORK_DIR/candidate/db.sqlite3")" == "$before_digest" ]] || fail "Logical database digest changed during disposable repair"
  [[ "$(document_count "$WORK_DIR/candidate/db.sqlite3")" == "$before_count" ]] || fail "Document count changed during disposable repair"
  [[ "$(artifact_digest "$WORK_DIR/candidate")" == "$before_artifacts" ]] || fail "Artifact digest changed during disposable repair"

  CURRENT_PHASE=isolated-boot
  log "Booting the repaired copy in an isolated Docker volume"
  docker volume create "$VERIFY_VOLUME" >/dev/null
  docker run --rm -v "$VERIFY_VOLUME:/target" -v "$WORK_DIR/candidate:/source:ro" alpine:3.21 sh -c 'cp -a /source/. /target/'
  docker run -d --name "$VERIFY_NAME" -p 127.0.0.1::3210 -p 127.0.0.1::3211 -v "$VERIFY_VOLUME:/convex/data" "$BACKEND_IMAGE" >/dev/null
  VERIFY_STARTED=true
  local verify_api_port verify_site_port verify_api verify_site canary
  verify_api_port=$(docker port "$VERIFY_NAME" 3210/tcp | head -1 | awk -F: '{print $NF}')
  verify_site_port=$(docker port "$VERIFY_NAME" 3211/tcp | head -1 | awk -F: '{print $NF}')
  verify_api="http://127.0.0.1:$verify_api_port"
  verify_site="http://127.0.0.1:$verify_site_port"
  wait_for_http "$verify_api" || fail "Isolated repaired backend did not become healthy"
  canary=$(api_canary "$verify_site")
  cleanup_verify
  VERIFY_STARTED=false

  CURRENT_PHASE=live-activation
  log "Activating the validated repaired database"
  docker run --rm -v "$LIVE_VOLUME:/target" -v "$WORK_DIR/candidate:/source:ro" alpine:3.21 \
    sh -c 'cp /source/db.sqlite3 /target/db.sqlite3.repaired && mv /target/db.sqlite3.repaired /target/db.sqlite3'
  LIVE_APPLIED=true
  compose start backend >/dev/null
  BACKEND_STOPPED=false
  wait_for_http "$API_URL" || fail "Live backend did not become healthy after repair"
  bash "$SCRIPT_DIR/convex-local-doctor.sh" >/dev/null || fail "Local doctor failed after repair"
  api_canary "$SITE_URL" >/dev/null

  CURRENT_PHASE=post-activation-integrity
  log "Re-quiescing for post-activation integrity verification"
  compose stop backend >/dev/null
  BACKEND_STOPPED=true
  rm -rf "$WORK_DIR/post"
  mkdir -p "$WORK_DIR/post"
  docker run --rm -v "$LIVE_VOLUME:/source:ro" -v "$WORK_DIR/post:/backup" alpine:3.21 cp /source/db.sqlite3 /backup/db.sqlite3
  FINAL_QUICK=$(quick_output "$WORK_DIR/post/db.sqlite3")
  FINAL_INTEGRITY=$(integrity_output "$WORK_DIR/post/db.sqlite3")
  [[ "$FINAL_QUICK" == ok && "$FINAL_INTEGRITY" == ok ]] || fail "Post-activation database integrity failed"
  compose start backend >/dev/null
  BACKEND_STOPPED=false
  wait_for_http "$API_URL" || fail "Live backend did not recover after final integrity check"
  LIVE_APPLIED=false

  CURRENT_PHASE=complete
  write_report passed complete "offline repair and live activation verified" "$FINAL_QUICK" "$FINAL_INTEGRITY" "$canary"
  log "Repair complete: $REPORT_PATH"
  printf '%s\n' "$REPORT_PATH"
}

main "$@"
