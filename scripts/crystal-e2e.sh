#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG="$OPENCLAW_DIR/openclaw.json"
HOOK_MAP_PATH="$OPENCLAW_DIR/extensions/internal-hooks/openclaw-hook.json"
MCP_DIST="$REPO_ROOT/mcp-server/dist/index.js"
PASS_COUNT=0
FAIL_COUNT=0

run_step() {
  local label="$1"
  shift
  echo "==== ${label} ===="
  if "$@"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "PASS: ${label}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "FAIL: ${label}"
  fi
  echo
}

verify_files_contain_expected_keys() {
  python3 - "$OPENCLAW_CONFIG" "$HOOK_MAP_PATH" "$MCP_DIST" <<'PY'
import json
import os
import re
import sys

config_path, map_path, mcp_dist = sys.argv[1:4]

if not os.path.exists(config_path):
    raise SystemExit(1)


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    raw = re.sub(r",(\s*[}\]])", r"\1", raw)
    return json.loads(raw or "{}")


config = load(config_path)
plugins = config.get("plugins", {})
if not isinstance(plugins, dict):
    raise SystemExit(1)

entry = plugins.get("entries", {}).get("crystal-memory")
if not isinstance(entry, dict) or not entry.get("enabled"):
    raise SystemExit(1)

if plugins.get("slots", {}).get("memory") != "crystal-memory":
    raise SystemExit(1)

paths = plugins.get("load", {}).get("paths", [])
if not isinstance(paths, list) or not any(isinstance(item, str) and item.endswith("/crystal-memory") for item in paths):
    raise SystemExit(1)

plugin_dir = next(item for item in paths if isinstance(item, str) and item.endswith("/crystal-memory"))
manifest_path = os.path.join(plugin_dir, "openclaw.plugin.json")
if not os.path.exists(manifest_path):
    raise SystemExit(1)

manifest = load(manifest_path)
if manifest.get("id") != "crystal-memory":
    raise SystemExit(1)
if manifest.get("kind") != "memory":
    raise SystemExit(1)
PY
}

run_step "init" bash "$REPO_ROOT/scripts/crystal-init.sh"
run_step "doctor (pre-enable)" bash "$REPO_ROOT/scripts/crystal-doctor.sh" --dry-run
run_step "enable --dry-run" bash "$REPO_ROOT/scripts/crystal-enable.sh" --dry-run
run_step "enable (live)" bash "$REPO_ROOT/scripts/crystal-enable.sh"
run_step "verify config keys" verify_files_contain_expected_keys
run_step "disable --dry-run" bash "$REPO_ROOT/scripts/crystal-disable.sh" --dry-run

if [ $FAIL_COUNT -eq 0 ]; then
  echo "PASS: $PASS_COUNT / $((PASS_COUNT + FAIL_COUNT))"
  exit 0
else
  echo "FAIL: $FAIL_COUNT"
  echo "PASS: $PASS_COUNT"
  exit 1
fi
