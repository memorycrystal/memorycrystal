#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECT_OPENCLAW_DIR() {
  if [ -n "${OPENCLAW_DIR:-}" ]; then
    echo "$OPENCLAW_DIR"
    return
  fi

  if [ -d "$HOME/.openclaw" ]; then
    echo "$HOME/.openclaw"
    return
  fi

  if [ -d "$HOME/.config/openclaw" ]; then
    echo "$HOME/.config/openclaw"
    return
  fi

  if [ -n "${XDG_CONFIG_HOME:-}" ] && [ -d "$XDG_CONFIG_HOME/openclaw" ]; then
    echo "$XDG_CONFIG_HOME/openclaw"
    return
  fi

  if [ -d "$HOME/Library/Application Support/openclaw" ]; then
    echo "$HOME/Library/Application Support/openclaw"
    return
  fi

  echo "$HOME/.openclaw"
}

OPENCLAW_DIR="$(DETECT_OPENCLAW_DIR)"
PLUGIN_PATH="${OPENCLAW_PLUGIN_DIR:-$OPENCLAW_DIR/extensions/crystal-memory}"
OPENCLAW_CONFIG="$OPENCLAW_DIR/openclaw.json"
HOOK_MAP_PATH="$OPENCLAW_DIR/extensions/internal-hooks/openclaw-hook.json"

DRY_RUN=false
PURGE=false
for arg in "${@:-}"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    --purge)
      PURGE=true
      ;;
    *)
      echo "WARN: unknown flag '$arg'"
      ;;
  esac
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo "⚙️  Memory Crystal disable (dry-run)."
  echo "Would remove/disable the crystal-memory plugin entry and reset the memory slot in:"
  echo "  $OPENCLAW_CONFIG"
  echo "Would remove crystal-memory command from:"
  echo "  $HOOK_MAP_PATH"
  if [[ "$PURGE" == "true" ]]; then
    echo "Would remove plugin bundle at: $PLUGIN_PATH"
  else
    echo "Would keep plugin bundle in place: $PLUGIN_PATH"
  fi
  echo "Would restart gateway: openclaw gateway restart (if available)."
  exit 0
fi

if [ -f "$OPENCLAW_CONFIG" ]; then
  python3 - "$OPENCLAW_CONFIG" <<'PY'
import json
import os
import re
import sys


def load_tolerant_json(path):
    if not os.path.exists(path):
        return {}
    raw = open(path, "r", encoding="utf-8").read()
    raw = re.sub(r",(\s*[}\]])", r"\\1", raw)
    return json.loads(raw or "{}")


path = sys.argv[1]
data = load_tolerant_json(path)
hooks = data.get("hooks", {})
internal = hooks.get("internal", {}) if isinstance(hooks, dict) else {}
entries = internal.get("entries", {}) if isinstance(internal, dict) else {}
plugins = data.get("plugins", {})

if isinstance(entries, dict):
    if "crystal-memory" in entries:
        del entries["crystal-memory"]

if isinstance(plugins, dict):
    plugin_entries = plugins.get("entries", {})
    if isinstance(plugin_entries, dict) and "crystal-memory" in plugin_entries:
        del plugin_entries["crystal-memory"]

    plugin_slots = plugins.get("slots", {})
    if isinstance(plugin_slots, dict) and plugin_slots.get("memory") == "crystal-memory":
        plugin_slots["memory"] = "memory-core"
    if isinstance(plugin_slots, dict) and plugin_slots.get("contextEngine") == "crystal-memory":
        del plugin_slots["contextEngine"]

    plugin_installs = plugins.get("installs", {})
    if isinstance(plugin_installs, dict) and "crystal-memory" in plugin_installs:
        del plugin_installs["crystal-memory"]

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
PY
  echo "Updated $OPENCLAW_CONFIG to remove crystal-memory plugin wiring."
else
  echo "Missing OpenClaw config at $OPENCLAW_CONFIG."
fi

if [ -f "$HOOK_MAP_PATH" ]; then
  python3 - "$HOOK_MAP_PATH" <<'PY'
import json
import os
import re
import sys


def load_tolerant_json(path):
    if not os.path.exists(path):
        return {}
    raw = open(path, "r", encoding="utf-8").read()
    raw = re.sub(r",(\s*[}\]])", r"\\1", raw)
    return json.loads(raw or "{}")


path = sys.argv[1]
data = load_tolerant_json(path)
commands = data.get("commands", {})

if isinstance(commands, dict) and "crystal-memory" in commands:
    del commands["crystal-memory"]

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
PY
  echo "Updated $HOOK_MAP_PATH to remove crystal-memory command."
else
  echo "Missing internal hook command map at $HOOK_MAP_PATH."
fi

if [[ "$PURGE" == "true" ]]; then
  if [ -d "$PLUGIN_PATH" ]; then
    rm -rf "$PLUGIN_PATH"
    echo "Removed plugin bundle at $PLUGIN_PATH."
  else
    echo "No plugin bundle found at $PLUGIN_PATH."
  fi
fi

if command -v openclaw >/dev/null 2>&1; then
  echo "Restarting OpenClaw gateway..."
  openclaw gateway restart
else
  echo "OpenClaw CLI not found. Please run manually: openclaw gateway restart"
fi

if [ "$PURGE" == "true" ]; then
  echo "Disabled Memory Crystal wiring and removed plugin bundle."
else
  echo "Disabled Memory Crystal wiring and kept plugin bundle."
fi
