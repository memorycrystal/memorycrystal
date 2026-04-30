#!/usr/bin/env bash
# Memory Crystal Plugin Auto-Updater
# Pulls latest plugin files from the public mirror and installs them.
# Usage:
#   ./scripts/update.sh              # update to latest release
#   ./scripts/update.sh --dry-run    # preview only, no changes
#   ./scripts/update.sh --force      # skip version check
#
# Called automatically by OpenClaw on startup when crystal-memory plugin
# has auto-update enabled (set in plugin config: autoUpdate: true).

set -euo pipefail

# Always pull from the public mirror.
#
# The plugin files are identical in the public mirror and the private repo, and
# most installs (client deployments, third-party users) do not have access to
# the private repo. Routing token-authenticated requests to the private repo
# was a historic complication — it 404'd for installs whose token didn't carry
# access to `illumin8ca/memorycrystal`, and the previous target branch
# (`release`) was retired anyway. When a token is available we still attach it
# as an Authorization header below, which lifts the GitHub unauthenticated
# rate limit without changing what repo we read from.
REPO="memorycrystal/memorycrystal"
BRANCH="main"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

# Resolve a GitHub token for private-repo access.
# Tries (in order): GITHUB_TOKEN env var, GH_TOKEN env var, `gh auth token` CLI.
# Falls back to unauthenticated if none are available (works for public repos / public CDN).
_GH_TOKEN=""
resolve_gh_token() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    _GH_TOKEN="$GITHUB_TOKEN"
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    _GH_TOKEN="$GH_TOKEN"
  elif command -v gh &>/dev/null; then
    _GH_TOKEN=$(gh auth token 2>/dev/null || true)
  fi
}
resolve_gh_token

# curl wrapper: adds Authorization header when a token is available.
gh_curl() {
  if [[ -n "$_GH_TOKEN" ]]; then
    curl -fsSL -H "Authorization: token ${_GH_TOKEN}" "$@"
  else
    curl -fsSL "$@"
  fi
}
PLUGIN_FILES=(
  "plugin/index.js"
  "plugin/update.sh"
  "plugin/openclaw.plugin.json"
  "plugin/package.json"
  "plugin/handler.js"
  "plugin/capture-hook.js"
  "plugin/recall-hook.js"
  "plugin/store/crystal-local-store.js"
  "plugin/compaction/crystal-assembler.js"
  "plugin/compaction/crystal-compaction.js"
  "plugin/compaction/crystal-summarizer.js"
  "plugin/compaction/package.json"
  "plugin/tools/crystal-local-tools.js"
  "plugin/utils/crystal-utils.js"
  "plugin/context-budget.js"
  "plugin/pressure-log.js"
  "plugin/memory-formatter.js"
)

DRY_RUN=false
FORCE=false
NO_RESTART=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
  [[ "$arg" == "--force" ]] && FORCE=true
  [[ "$arg" == "--no-restart" ]] && NO_RESTART=true
done

# Resolve install dir (matches OpenClaw's lookup order)
resolve_install_dir() {
  if [[ -n "${OPENCLAW_PLUGIN_DIR:-}" ]]; then
    echo "${OPENCLAW_PLUGIN_DIR}/crystal-memory"
  elif [[ -n "${OPENCLAW_DIR:-}" ]]; then
    echo "${OPENCLAW_DIR}/extensions/crystal-memory"
  elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    echo "${XDG_CONFIG_HOME}/openclaw/extensions/crystal-memory"
  elif [[ -d "$HOME/.openclaw/extensions" ]]; then
    echo "$HOME/.openclaw/extensions/crystal-memory"
  elif [[ -d "$HOME/Library/Application Support/openclaw/extensions" ]]; then
    echo "$HOME/Library/Application Support/openclaw/extensions/crystal-memory"
  else
    echo "$HOME/.config/openclaw/extensions/crystal-memory"
  fi
}

INSTALL_DIR=$(resolve_install_dir)

echo " Memory Crystal Plugin Updater"
echo "   Release branch : ${BRANCH}"
echo "   Install dir    : ${INSTALL_DIR}"
echo ""

# Fetch remote version
REMOTE_MANIFEST=$(gh_curl "${RAW_BASE}/plugin/openclaw.plugin.json" 2>/dev/null) || {
  echo "[err] Could not fetch remote manifest. Check network or repo visibility."
  if [[ -z "$_GH_TOKEN" ]]; then
    echo "      Tip: set GITHUB_TOKEN or install 'gh' CLI to access private repos."
  fi
  exit 1
}
REMOTE_VERSION=$(echo "$REMOTE_MANIFEST" | grep '"version"' | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')

# Read local version
LOCAL_VERSION="none"
if [[ -f "${INSTALL_DIR}/openclaw.plugin.json" ]]; then
  LOCAL_VERSION=$(grep '"version"' "${INSTALL_DIR}/openclaw.plugin.json" 2>/dev/null | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/' || echo "none")
fi

echo "   Local version  : ${LOCAL_VERSION}"
echo "   Remote version : ${REMOTE_VERSION}"
echo ""

if [[ "$FORCE" == "false" && "$LOCAL_VERSION" == "$REMOTE_VERSION" ]]; then
  echo "[ok] Already up to date (${LOCAL_VERSION}). Use --force to reinstall."
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "    Dry run: ${LOCAL_VERSION} -> ${REMOTE_VERSION}"
  echo "   Files:"
  for f in "${PLUGIN_FILES[@]}"; do
    rel="${f#plugin/}"
    echo "     ${RAW_BASE}/${f} -> ${INSTALL_DIR}/${rel}"
  done
  exit 0
fi

echo "-> Updating ${LOCAL_VERSION} -> ${REMOTE_VERSION}..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/store" "$INSTALL_DIR/compaction" "$INSTALL_DIR/tools" "$INSTALL_DIR/utils"

for f in "${PLUGIN_FILES[@]}"; do
  rel="${f#plugin/}"
  dest="${INSTALL_DIR}/${rel}"
  tmp="${dest}.tmp"
  gh_curl "${RAW_BASE}/${f}" -o "$tmp" || {
    echo "[err] Failed to download ${f}"
    rm -f "$tmp"
    exit 1
  }
  mv "$tmp" "$dest"
  echo "   [ok] ${rel}"
done

# --- SHA-256 checksum verification ---
# Fetch checksums.txt from the public mirror (optional — backward compatible)
CHECKSUMS_URL="${RAW_BASE}/plugin/checksums.txt"
CHECKSUMS_TMP="${INSTALL_DIR}/checksums.txt.tmp"
if gh_curl "$CHECKSUMS_URL" -o "$CHECKSUMS_TMP" 2>/dev/null; then
  echo ""
  echo "-> Verifying file checksums..."
  VERIFY_FAIL=false
  while IFS='  ' read -r expected_hash fname; do
    # checksums.txt uses paths relative to plugin/ (e.g. "index.js")
    local_file="${INSTALL_DIR}/${fname}"
    if [[ ! -f "$local_file" ]]; then
      echo "   [warn] ${fname} not found locally, skipping checksum"
      continue
    fi
    actual_hash=$(shasum -a 256 "$local_file" | awk '{print $1}')
    if [[ "$actual_hash" != "$expected_hash" ]]; then
      echo "   [FAIL] ${fname}: checksum mismatch"
      echo "          expected: ${expected_hash}"
      echo "          got:      ${actual_hash}"
      VERIFY_FAIL=true
    else
      echo "   [ok] ${fname}"
    fi
  done < "$CHECKSUMS_TMP"
  rm -f "$CHECKSUMS_TMP"
  if [[ "$VERIFY_FAIL" == "true" ]]; then
    echo ""
    echo "[err] Checksum verification failed. Files may be corrupted or tampered with."
    echo "      Re-run with --force or inspect the files manually."
    exit 1
  fi
  echo "   All checksums verified."
else
  rm -f "$CHECKSUMS_TMP"
  echo ""
  echo "(i) No checksums.txt on remote — skipping integrity verification."
  echo "    To generate: cd plugin && shasum -a 256 *.js *.json *.sh store/*.js compaction/*.js compaction/*.json tools/*.js utils/*.js > checksums.txt"
fi
# --- end checksum verification ---

echo ""
echo "[ok] Memory Crystal plugin updated to ${REMOTE_VERSION}"
echo ""

# Restart OpenClaw if available (skip when called from plugin auto-update to avoid mid-session disruption)
if [[ "$NO_RESTART" == "true" ]]; then
  echo "(i) Skipping gateway restart (--no-restart). Restart OpenClaw to apply the update."
elif command -v openclaw &>/dev/null; then
  echo "-> Restarting OpenClaw gateway..."
  openclaw gateway restart || echo "   (restart failed - please restart manually)"
else
  echo "(i) Run 'openclaw gateway restart' to apply the update."
fi

echo ""
echo "-> Installing optional native dependencies..."
if command -v npm >/dev/null 2>&1; then
  (cd "$INSTALL_DIR" && npm install better-sqlite3 --save-optional --silent 2>/dev/null && echo "  [ok] better-sqlite3 installed") || echo "  (i) better-sqlite3 skipped (cloud memory still works)"
else
  echo "  (i) npm not found - skipping better-sqlite3"
fi
