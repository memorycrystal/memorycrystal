#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVISION="$(tr -d '[:space:]' < "$SCRIPT_DIR/UPSTREAM_REVISION")"
DESTINATION="${1:?usage: prepare-context.sh DESTINATION}"

if [[ -e "$DESTINATION" ]]; then
  echo "destination already exists: $DESTINATION" >&2
  exit 1
fi

git clone --filter=blob:none --no-checkout \
  https://github.com/get-convex/convex-backend.git "$DESTINATION"
git -C "$DESTINATION" checkout --detach "$REVISION"
git -C "$DESTINATION" apply "$SCRIPT_DIR/archive-cache.patch"
git -C "$DESTINATION" apply "$SCRIPT_DIR/searchlight-coordination.patch"
git -C "$DESTINATION" apply "$SCRIPT_DIR/export-cleanup-notfound.patch"
git -C "$DESTINATION" diff --check

# Overlay fail-fast cargo build onto Dockerfile.backend (ILL-238 gate)
# The upstream heredoc uses pipefail but no -e, so failed cargo compiles
# still copied chef-cook dummies (338KB stub vs tens-of-MB real backend).
DOCKERFILE="$DESTINATION/self-hosted/docker-build/Dockerfile.backend"
if ! grep -q '"-e".*pipefail' "$DOCKERFILE"; then
  # Change SHELL ["/bin/bash", "-o", "pipefail", "-c"] to add "-e"
  # Avoid "-u" (nounset) to preserve upstream ARG debug + [[ -z "$debug" ]] idiom
  sed -i '/SHELL \[.*pipefail/s|"-o", "pipefail"|"-e", "-o", "pipefail"|' "$DOCKERFILE"
  # Verify the overlay actually changed the file
  if ! grep -q '"-e".*pipefail' "$DOCKERFILE"; then
    echo "❌ FATAL: sed overlay did not modify Dockerfile.backend SHELL directive" >&2
    exit 1
  fi
  echo "  → overlaid '-e' onto Dockerfile.backend SHELL (fail-fast cargo)"
fi

# Overlay the startup temp cleanup onto the image entrypoint (ILL-347).
# Upstream Dockerfile.backend: ENTRYPOINT ["./run_backend.sh"]; run_backend.sh
# sets TMPDIR="$DATA_DIR/tmp", runs `mkdir -p "$TMPDIR" "$STORAGE_DIR"` and
# then exec's ./convex-local-backend. The cleanup is inserted directly after
# that mkdir, before anything can use $TMPDIR.
RUN_BACKEND="$DESTINATION/self-hosted/docker-build/run_backend.sh"
OVERLAY="$SCRIPT_DIR/run_backend-tmp-cleanup.overlay.sh"
# shellcheck disable=SC2016  # literal upstream line, matched exactly
ANCHOR='mkdir -p "$TMPDIR" "$STORAGE_DIR"'
if [[ ! -f "$RUN_BACKEND" ]]; then
  echo "❌ FATAL: upstream run_backend.sh not found at $RUN_BACKEND" >&2
  exit 1
fi
if grep -qF 'ILL-347' "$RUN_BACKEND"; then
  echo "❌ FATAL: run_backend.sh already carries the ILL-347 overlay" >&2
  exit 1
fi
if [[ "$(grep -cF "$ANCHOR" "$RUN_BACKEND")" != "1" ]]; then
  echo "❌ FATAL: run_backend.sh anchor '$ANCHOR' not found exactly once; upstream changed, refresh the overlay" >&2
  exit 1
fi
if ! grep -qF 'exec ./convex-local-backend' "$RUN_BACKEND"; then
  echo "❌ FATAL: run_backend.sh no longer exec's ./convex-local-backend; refresh the overlay" >&2
  exit 1
fi
PATCHED="$RUN_BACKEND.ill347"
: > "$PATCHED"
while IFS= read -r line || [[ -n "$line" ]]; do
  printf '%s\n' "$line" >> "$PATCHED"
  if [[ "$line" == "$ANCHOR" ]]; then
    cat "$OVERLAY" >> "$PATCHED"
  fi
done < "$RUN_BACKEND"
chmod --reference="$RUN_BACKEND" "$PATCHED"
mv "$PATCHED" "$RUN_BACKEND"
if [[ "$(grep -cF 'startup temp cleanup: removed' "$RUN_BACKEND")" != "1" ]]; then
  echo "❌ FATAL: temp cleanup overlay did not apply to run_backend.sh" >&2
  exit 1
fi
# The cleanup must sit after the mkdir and before the exec.
if [[ "$(grep -nF "$ANCHOR" "$RUN_BACKEND" | cut -d: -f1)" -ge "$(grep -nF 'startup temp cleanup: removed' "$RUN_BACKEND" | cut -d: -f1)" ]] \
  || [[ "$(grep -nF 'startup temp cleanup: removed' "$RUN_BACKEND" | cut -d: -f1)" -ge "$(grep -nF 'exec ./convex-local-backend' "$RUN_BACKEND" | cut -d: -f1)" ]]; then
  echo "❌ FATAL: temp cleanup overlay landed in the wrong place in run_backend.sh" >&2
  exit 1
fi
bash -n "$RUN_BACKEND"
echo "  → overlaid startup temp cleanup onto run_backend.sh (ILL-347)"

echo "prepared Convex backend $REVISION in $DESTINATION with patches:"
echo "  - archive-cache.patch (configurable CONVEX_SEARCH_ARCHIVE_CACHE_MIB)"
echo "  - searchlight-coordination.patch (issue #525 refcount coordination)"
echo "  - export-cleanup-notfound.patch (ILL-349 expired export NotFound handling)"
echo "  - Dockerfile.backend fail-fast gate (ILL-238)"
echo "  - run_backend.sh startup temp cleanup overlay (ILL-347)"
