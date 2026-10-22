#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${CONVEX_SELF_HOSTED_URL:?CONVEX_SELF_HOSTED_URL is required}"
: "${CONVEX_SELF_HOSTED_ADMIN_KEY:?CONVEX_SELF_HOSTED_ADMIN_KEY is required}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="/convex/data/storage/exports/shutdown-${stamp}"
mkdir -p "$backup_dir"
cd "$backup_dir"

npm init -y >/dev/null 2>&1
npm install --save-exact convex@1.41.0 >/dev/null 2>&1
printf 'stage=exporting\nstarted_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > status.txt

nohup bash -c '
  set +e
  CONVEX_DEPLOYMENT="" npx convex export \
    --include-file-storage \
    --path railway-production.zip > export.log 2>&1
  rc=$?
  if [[ $rc -eq 0 ]]; then
    sha256sum railway-production.zip > railway-production.zip.sha256
    printf "stage=exported\nfinished_at=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > status.txt
  else
    printf "stage=failed\nexit_code=%s\nfinished_at=%s\n" \
      "$rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > status.txt
  fi
  exit "$rc"
' >/dev/null 2>&1 &

printf '%s\n' "$backup_dir"
