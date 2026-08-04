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
git -C "$DESTINATION" diff --check

echo "prepared Convex backend $REVISION in $DESTINATION"
