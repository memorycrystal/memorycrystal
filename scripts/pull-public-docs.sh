#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"
PUBLIC_REMOTE_NAME="${PUBLIC_REMOTE_NAME:-public}"
PUBLIC_REMOTE_URL="${PUBLIC_REMOTE_URL:-https://github.com/memorycrystal/memorycrystal.git}"
PUBLIC_BRANCH="${PUBLIC_BRANCH:-stable}"
DOCS_PATH="${DOCS_PATH:-apps/docs}"

cd "$REPO_ROOT"

current_branch="$(git branch --show-current)"

if [ -z "$current_branch" ]; then
  echo "[err] Could not determine the current branch."
  exit 1
fi

if git remote get-url "$PUBLIC_REMOTE_NAME" >/dev/null 2>&1; then
  existing_url="$(git remote get-url "$PUBLIC_REMOTE_NAME")"
  if [ "$existing_url" != "$PUBLIC_REMOTE_URL" ]; then
    echo "[warn] Remote '$PUBLIC_REMOTE_NAME' points to $existing_url"
    echo "[info] Updating it to $PUBLIC_REMOTE_URL"
    git remote set-url "$PUBLIC_REMOTE_NAME" "$PUBLIC_REMOTE_URL"
  fi
else
  echo "[info] Adding remote '$PUBLIC_REMOTE_NAME' -> $PUBLIC_REMOTE_URL"
  git remote add "$PUBLIC_REMOTE_NAME" "$PUBLIC_REMOTE_URL"
fi

echo "[info] Fetching $PUBLIC_REMOTE_NAME/$PUBLIC_BRANCH"
git fetch "$PUBLIC_REMOTE_NAME" "$PUBLIC_BRANCH"

if ! git diff --quiet -- "$DOCS_PATH" || ! git diff --cached --quiet -- "$DOCS_PATH"; then
  echo "[err] Local changes detected under $DOCS_PATH. Commit, stash, or discard them before pulling public docs."
  exit 1
fi

echo "[info] Checking out $DOCS_PATH from $PUBLIC_REMOTE_NAME/$PUBLIC_BRANCH into $current_branch"
git checkout "$PUBLIC_REMOTE_NAME/$PUBLIC_BRANCH" -- "$DOCS_PATH"

echo "[ok] Pulled $DOCS_PATH from $PUBLIC_REMOTE_NAME/$PUBLIC_BRANCH"
echo "[next] Review changes with: git diff -- $DOCS_PATH"
echo "[next] Commit when ready."
