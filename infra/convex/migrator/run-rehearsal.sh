#!/usr/bin/env bash
set -euo pipefail

work_dir=${MIGRATION_WORK_DIR:-/work}
cd "$work_dir"

# The Convex CLI requires a project marker even for key-selected exports.
if [[ ! -f package.json ]]; then
  printf '{"private":true}\n' >package.json
fi

required=(
  SOURCE_CONVEX_DEPLOY_KEY
  TARGET_CONVEX_URL
  TARGET_CONVEX_ADMIN_KEY
)
for name in "${required[@]}"; do
  if [[ -z ${!name:-} ]]; then
    echo "missing required variable: $name" >&2
    exit 2
  fi
done

status_file="$work_dir/rehearsal.status"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'stage=starting\nstarted_at=%s\n' "$started_at" >"$status_file"

fail() {
  rc=$?
  printf 'stage=failed\nexit_code=%s\nfinished_at=%s\n' \
    "$rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$status_file"
  exit "$rc"
}
trap fail ERR

if [[ ${MIGRATION_RESUME_AFTER_EXPORT:-0} == 1 ]]; then
  [[ -s source-cloud.zip ]] || {
    echo "cannot resume: source-cloud.zip is missing or empty" >&2
    exit 2
  }
  rm -f target-railway.zip target-manifest.json
  if [[ ${MIGRATION_REUSE_SOURCE_MANIFEST:-0} != 1 ]]; then
    rm -f source-manifest.json
  fi
else
  rm -f \
    source-cloud.zip source-manifest.json \
    target-railway.zip target-manifest.json

  printf 'stage=source_export\nstarted_at=%s\n' "$started_at" >"$status_file"
  CONVEX_DEPLOY_KEY="$SOURCE_CONVEX_DEPLOY_KEY" \
    CONVEX_DEPLOYMENT='' \
    CONVEX_SELF_HOSTED_URL='' \
    CONVEX_SELF_HOSTED_ADMIN_KEY='' \
    convex export --prod --include-file-storage --path source-cloud.zip
fi

printf 'stage=source_audit\nstarted_at=%s\n' "$started_at" >"$status_file"
if [[ ${MIGRATION_REUSE_SOURCE_MANIFEST:-0} == 1 ]]; then
  [[ -s source-manifest.json ]] || {
    echo "cannot reuse source manifest: source-manifest.json is missing or empty" >&2
    exit 2
  }
else
  bash ./convex-snapshot-audit.sh audit source-cloud.zip source-manifest.json
fi

printf 'stage=target_import\nstarted_at=%s\n' "$started_at" >"$status_file"
CONVEX_DEPLOY_KEY='' \
  CONVEX_DEPLOYMENT='' \
  CONVEX_SELF_HOSTED_URL="$TARGET_CONVEX_URL" \
  CONVEX_SELF_HOSTED_ADMIN_KEY="$TARGET_CONVEX_ADMIN_KEY" \
  convex import --replace-all --yes source-cloud.zip

printf 'stage=target_export\nstarted_at=%s\n' "$started_at" >"$status_file"
CONVEX_DEPLOY_KEY='' \
  CONVEX_DEPLOYMENT='' \
  CONVEX_SELF_HOSTED_URL="$TARGET_CONVEX_URL" \
  CONVEX_SELF_HOSTED_ADMIN_KEY="$TARGET_CONVEX_ADMIN_KEY" \
  convex export --include-file-storage --path target-railway.zip

printf 'stage=target_audit\nstarted_at=%s\n' "$started_at" >"$status_file"
bash ./convex-snapshot-audit.sh audit target-railway.zip target-manifest.json

printf 'stage=compare\nstarted_at=%s\n' "$started_at" >"$status_file"
bash ./convex-snapshot-audit.sh compare source-manifest.json target-manifest.json

printf 'stage=complete\nstarted_at=%s\nfinished_at=%s\n' \
  "$started_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$status_file"
trap - ERR
