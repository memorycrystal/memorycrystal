#!/usr/bin/env bash
# Prune orphaned Convex Node-action executor sandboxes from the self-hosted
# backend's persistent volume.
#
# WHY THIS EXISTS
# ---------------
# The Convex self-hosted backend creates a Node action executor sandbox under
# `/convex/data/tmp/.tmpXXXXXX` — a ~2-3 GB tree containing the bundled action
# source and its dependencies. That path is on the PERSISTENT volume, so when
# Railway replaces the container the old sandbox survives forever. One orphan
# accumulates per deploy.
#
# On 2026-08-06 this had reached 17 orphans / ~52 GB, and it is the same growth
# that caused the 2026-08-01 disk-full (41 GB of scratch at the time). There is
# no TMPDIR-style setting on the service, and the container's own /tmp (on
# ephemeral overlay, ~1.8 TB free) is where these belong but is not selectable.
#
# WHY IT RUNS FROM OUTSIDE
# ------------------------
# - A separate Railway cron service cannot see the volume (volumes attach to one
#   service).
# - `preDeployCommand` runs while the OLD container is still serving, so an
#   age-based prune there would delete a sandbox that is still in use.
# - Overriding `startCommand` means reproducing the upstream image entrypoint,
#   which is a production-breaking class of change for a housekeeping job.
#
# So this runs over `railway ssh` and decides liveness from the running
# process's own open file descriptors, which is authoritative rather than
# guessed. Missing a scheduled run is harmless — the volume just grows a little.
#
# USAGE
#   scripts/prune-convex-tmp.sh                 # dry run (default — prints, deletes nothing)
#   scripts/prune-convex-tmp.sh --apply         # actually delete
#   scripts/prune-convex-tmp.sh --apply --min-age-min 60
#
# Exits non-zero if the remote command fails. Safe to re-run.

set -euo pipefail

SERVICE="${CONVEX_BACKEND_SERVICE:-convex-backend-prod}"
ENVIRONMENT="${RAILWAY_TARGET_ENVIRONMENT:-production}"
TMP_ROOT="/convex/data/tmp"
MIN_AGE_MIN=1440   # 24h. The live sandbox is excluded by fd check regardless;
                   # this is a second, independent guard against deleting a
                   # sandbox created by an in-flight deploy.
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --min-age-min) MIN_AGE_MIN="$2"; shift 2 ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

rw() {
  # Single-string remote command; railway ssh joins argv, and `sh -c` through it
  # mangles quoting, so keep each invocation to one flat command.
  npx --yes @railway/cli ssh -s "$SERVICE" -e "$ENVIRONMENT" -- "$1"
}

printf '== convex tmp prune (%s / %s) ==\n' "$SERVICE" "$ENVIRONMENT"
printf 'mode: %s | min age: %s min\n\n' "$([[ $APPLY == 1 ]] && echo APPLY || echo DRY-RUN)" "$MIN_AGE_MIN"

printf '%s\n' '-- volume before --'
rw "df -h $TMP_ROOT | tail -1"

# Liveness is decided by the backend's own open file descriptors. A sandbox the
# running executor has open must never be removed, whatever its age.
printf '\n%s\n' '-- live sandboxes (never pruned) --'
LIVE="$(rw "ls -l /proc/*/fd 2>/dev/null | grep -o '$TMP_ROOT/\.tmp[A-Za-z0-9]*' | sort -u" | grep -o '\.tmp[A-Za-z0-9]*' | sort -u || true)"
if [[ -z "$LIVE" ]]; then
  printf 'none found — refusing to prune.\n' >&2
  printf 'A running backend always holds one sandbox open, so an empty result\n' >&2
  printf 'means the check failed, not that everything is orphaned.\n' >&2
  exit 1
fi
printf '%s\n' "$LIVE"

# Build the exclusion predicate from the live set.
EXCLUDES=""
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  EXCLUDES+=" ! -name $name"
done <<< "$LIVE"

FIND="find $TMP_ROOT -mindepth 1 -maxdepth 1 -name '.tmp*'$EXCLUDES -mmin +$MIN_AGE_MIN"

printf '\n%s\n' '-- candidates --'
rw "$FIND -print" || true

if [[ $APPLY == 1 ]]; then
  printf '\n%s\n' '-- deleting --'
  rw "$FIND -print -exec rm -rf {} +"
  printf '\n%s\n' '-- volume after --'
  rw "df -h $TMP_ROOT | tail -1"
else
  printf '\n(dry run — nothing deleted; re-run with --apply)\n'
fi
