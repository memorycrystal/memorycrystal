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

echo "prepared Convex backend $REVISION in $DESTINATION with patches:"
echo "  - archive-cache.patch (configurable CONVEX_SEARCH_ARCHIVE_CACHE_MIB)"
echo "  - searchlight-coordination.patch (issue #525 refcount coordination)"
echo "  - Dockerfile.backend fail-fast gate (ILL-238)"
