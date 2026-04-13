#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"
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
REQUIRED_ENV_KEYS=(CONVEX_URL OPENAI_API_KEY MEMORY_CRYSTAL_API_KEY CRYSTAL_API_KEY GEMINI_API_KEY GEMINI_EMBEDDING_MODEL EMBEDDING_PROVIDER OBSIDIAN_VAULT_PATH CRYSTAL_MCP_MODE CRYSTAL_MCP_HOST CRYSTAL_MCP_PORT)
REQUIRED_RUNTIME_ENV_KEYS=(CONVEX_URL)
MCP_DIST="$REPO_ROOT/mcp-server/dist/index.js"
NODE_PATH="${NODE_PATH:-$(command -v node || true)}"
MCP_ENV_FILE="$REPO_ROOT/mcp-server/.env"
if [ ! -f "$MCP_ENV_FILE" ]; then
  MCP_ENV_FILE="$REPO_ROOT/.env"
fi

DRY_RUN=false
if [[ "${1-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "⚙️  Memory Crystal enable (dry-run)."
  echo "Would copy plugin bundle:"
  echo "  $REPO_ROOT/plugin -> $PLUGIN_PATH"
  echo "Would merge hook entry into:"
  echo "  $OPENCLAW_CONFIG"
  echo "Would merge internal hook command into:"
  echo "  $HOOK_MAP_PATH"
  echo "Would restart gateway: openclaw gateway restart (if available)."
  exit 0
fi

if [ ! -d "$REPO_ROOT/plugin" ]; then
  echo "ERROR: plugin source missing at $REPO_ROOT/plugin"
  exit 1
fi

ENABLE_CHANGED=0
if [ -d "$PLUGIN_PATH" ] && diff -qr "$REPO_ROOT/plugin" "$PLUGIN_PATH" >/dev/null 2>&1; then
  echo "Plugin bundle already up to date at $PLUGIN_PATH"
else
  mkdir -p "$PLUGIN_PATH"
  rm -rf "$PLUGIN_PATH"
  mkdir -p "$PLUGIN_PATH"
  cp -R "$REPO_ROOT/plugin/"* "$PLUGIN_PATH/"
  ENABLE_CHANGED=1
  echo "Copied plugin bundle to $PLUGIN_PATH"
fi

if [ ! -f "$MCP_DIST" ]; then
  echo "ERROR: MCP server artifact missing at $MCP_DIST. Run: (cd mcp-server && npm run build)"
  exit 1
fi

if [ -z "$NODE_PATH" ]; then
  echo "ERROR: node was not found in PATH."
  exit 1
fi

mkdir -p "$OPENCLAW_DIR"
mkdir -p "$OPENCLAW_DIR/extensions/internal-hooks"

PYTHON_OUTPUT="$(python3 - "$OPENCLAW_CONFIG" "$REPO_ROOT/.env" "${OPENCLAW_DIR}" "${REPO_ROOT}" "$MCP_DIST" "$NODE_PATH" "$PLUGIN_PATH" "$MCP_ENV_FILE" "${REQUIRED_ENV_KEYS[*]}" "${REQUIRED_RUNTIME_ENV_KEYS[*]}" <<'PY'
import json
import os
import re
import sys


def load_tolerant_json(path):
    if not os.path.exists(path):
        return {}
    raw = open(path, "r", encoding="utf-8").read()
    raw = re.sub(r",(\s*[}\]])", r"\1", raw)
    return json.loads(raw or "{}")


def load_env(path):
    values = {}
    if not os.path.exists(path):
        return values
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        values[key] = value
    return values


def normalize_convex_http_url(value):
    raw = (value or "").strip()
    if not raw:
        return raw
    raw = raw.rstrip("/")
    if raw.endswith(".convex.cloud"):
        raw = raw[: -len(".convex.cloud")] + ".convex.site"
    return raw


config_path, env_path, openclaw_dir, repo_root, mcp_dist, node_path, plugin_path, mcp_env_path, keys_csv, runtime_keys_csv = sys.argv[1:11]
required_keys = keys_csv.split()
required_runtime_keys = runtime_keys_csv.split()
env_values = load_env(env_path)
for key in set(required_keys + required_runtime_keys):
    env_override = os.environ.get(key)
    if env_override:
        env_values[key] = env_override
missing_runtime_keys = [key for key in required_runtime_keys if not env_values.get(key)]
if missing_runtime_keys:
    print("ERROR: missing required keys in .env: " + ", ".join(missing_runtime_keys))
    raise SystemExit(1)

def dump_pretty(value):
    return json.dumps(value, indent=2) + "\n"

before_config_raw = open(config_path, "r", encoding="utf-8").read() if os.path.exists(config_path) else ""
data = load_tolerant_json(config_path)
hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    data["hooks"] = hooks
internal = hooks.setdefault("internal", {})
if not isinstance(internal, dict):
    internal = {}
    hooks["internal"] = internal
entries = internal.setdefault("entries", {})
if not isinstance(entries, dict):
    entries = {}
    internal["entries"] = entries

entry = entries.get("crystal-memory", {})
if not isinstance(entry, dict):
    entry = {}

entry_env = entry.get("env", {})
if not isinstance(entry_env, dict):
    entry_env = {}

for key in required_keys:
    value = env_values.get(key)
    if value:
        entry_env[key] = value

entry["enabled"] = True
entry["env"] = entry_env
entries["crystal-memory"] = entry

plugins = data.setdefault("plugins", {})
if not isinstance(plugins, dict):
    plugins = {}
    data["plugins"] = plugins

plugin_load = plugins.setdefault("load", {})
if not isinstance(plugin_load, dict):
    plugin_load = {}
    plugins["load"] = plugin_load

existing_paths = plugin_load.get("paths", [])
if not isinstance(existing_paths, list):
    existing_paths = []
normalized_paths = [p for p in existing_paths if isinstance(p, str)]
if plugin_path not in normalized_paths:
    normalized_paths.append(plugin_path)
plugin_load["paths"] = normalized_paths

plugin_entries = plugins.setdefault("entries", {})
if not isinstance(plugin_entries, dict):
    plugin_entries = {}
    plugins["entries"] = plugin_entries

plugin_entry = plugin_entries.get("crystal-memory", {})
if not isinstance(plugin_entry, dict):
    plugin_entry = {}

plugin_config = plugin_entry.get("config", {})
if not isinstance(plugin_config, dict):
    plugin_config = {}

plugin_api_key = (
    plugin_config.get("apiKey")
    or env_values.get("MEMORY_CRYSTAL_API_KEY")
    or env_values.get("CRYSTAL_API_KEY")
)
if plugin_api_key:
    plugin_config["apiKey"] = plugin_api_key
if env_values.get("CONVEX_URL"):
    plugin_config["convexUrl"] = normalize_convex_http_url(env_values["CONVEX_URL"])

plugin_entry["enabled"] = True
plugin_entry["config"] = plugin_config
plugin_entries["crystal-memory"] = plugin_entry

plugin_slots = plugins.setdefault("slots", {})
if not isinstance(plugin_slots, dict):
    plugin_slots = {}
    plugins["slots"] = plugin_slots
plugin_slots["memory"] = "crystal-memory"
if "contextEngine" in plugin_slots:
    del plugin_slots["contextEngine"]

plugin_installs = plugins.setdefault("installs", {})
if not isinstance(plugin_installs, dict):
    plugin_installs = {}
    plugins["installs"] = plugin_installs
plugin_installs["crystal-memory"] = {
    "source": "path",
    "sourcePath": plugin_path,
    "installPath": plugin_path,
    "version": "0.2.4",
}

after_config_raw = dump_pretty(data)
config_changed = before_config_raw != after_config_raw
if config_changed:
    with open(config_path, "w", encoding="utf-8") as f:
        f.write(after_config_raw)

hook_path = os.path.join(openclaw_dir, "extensions", "internal-hooks", "openclaw-hook.json")
plugin_hook_path = os.path.join(plugin_path, "openclaw-hook.json")
before_hook_raw = open(hook_path, "r", encoding="utf-8").read() if os.path.exists(hook_path) else ""
hook_data = load_tolerant_json(hook_path)
commands = hook_data.setdefault("commands", {})
if not isinstance(commands, dict):
    commands = {}
    hook_data["commands"] = commands

capture_script = os.path.join(plugin_path, "capture-hook.js")
recall_script = os.path.join(plugin_path, "recall-hook.js")
command_env = {
    "CRYSTAL_MCP_MODE": "stdio",
    "CRYSTAL_MCP_HOST": env_values.get("CRYSTAL_MCP_HOST", "127.0.0.1"),
    "CRYSTAL_MCP_PORT": env_values.get("CRYSTAL_MCP_PORT", "8788"),
    "CRYSTAL_NODE": node_path,
    "CRYSTAL_PLUGIN_DIR": plugin_path,
    "CRYSTAL_ROOT": repo_root,
    "CRYSTAL_ENV_FILE": mcp_env_path,
}
for key in required_keys:
    value = env_values.get(key)
    if value:
        if key == "CRYSTAL_MCP_MODE":
            continue
        command_env[key] = value

commands["crystal-memory"] = {
    "command": node_path,
    "args": [mcp_dist],
    "env": {
        **command_env,
    },
}

commands["crystal-capture"] = {
    "command": node_path,
    "args": [capture_script],
    "env": {
        **command_env,
    },
}

commands["crystal-recall"] = {
    "command": node_path,
    "args": [recall_script],
    "env": {
        **command_env,
    },
}

after_hook_raw = dump_pretty(hook_data)
hook_changed = before_hook_raw != after_hook_raw
if hook_changed:
    with open(hook_path, "w", encoding="utf-8") as f:
        f.write(after_hook_raw)

before_plugin_hook_raw = open(plugin_hook_path, "r", encoding="utf-8").read() if os.path.exists(plugin_hook_path) else ""
plugin_hook = load_tolerant_json(plugin_hook_path)
plugin_capabilities = plugin_hook.setdefault("capabilities", {})
plugin_commands = plugin_hook.setdefault("commands", {})
plugin_env = plugin_hook.setdefault("env", {})
if not isinstance(plugin_capabilities, dict):
    plugin_capabilities = {}
    plugin_hook["capabilities"] = plugin_capabilities
if not isinstance(plugin_commands, dict):
    plugin_commands = {}
    plugin_hook["commands"] = plugin_commands
if not isinstance(plugin_env, dict):
    plugin_env = {}
    plugin_hook["env"] = plugin_env

plugin_capabilities["mcpCommand"] = node_path
plugin_capabilities["mcpArgs"] = [mcp_dist]

plugin_commands["crystal-capture"] = {
    "command": node_path,
    "args": [capture_script],
    "env": {
        **command_env,
    },
}

plugin_commands["crystal-recall"] = {
    "command": node_path,
    "args": [recall_script],
    "env": {
        **command_env,
    },
}

plugin_env["CRYSTAL_MCP_MODE"] = "stdio"
plugin_env["CRYSTAL_MCP_HOST"] = command_env["CRYSTAL_MCP_HOST"]
plugin_env["CRYSTAL_MCP_PORT"] = command_env["CRYSTAL_MCP_PORT"]
plugin_env["CRYSTAL_ENV_FILE"] = mcp_env_path

after_plugin_hook_raw = dump_pretty(plugin_hook)
plugin_hook_changed = before_plugin_hook_raw != after_plugin_hook_raw
if plugin_hook_changed:
    with open(plugin_hook_path, "w", encoding="utf-8") as f:
        f.write(after_plugin_hook_raw)

print(f"CONFIG_CHANGED={1 if config_changed else 0}")
print(f"HOOK_MAP_CHANGED={1 if hook_changed else 0}")
print(f"PLUGIN_HOOK_CHANGED={1 if plugin_hook_changed else 0}")
PY
)"
printf '%s\n' "$PYTHON_OUTPUT" | sed '/_CHANGED=/d'
if printf '%s\n' "$PYTHON_OUTPUT" | grep -q '^CONFIG_CHANGED=1$'; then
  ENABLE_CHANGED=1
  echo "Updated $OPENCLAW_CONFIG"
else
  echo "$OPENCLAW_CONFIG already up to date"
fi
if printf '%s\n' "$PYTHON_OUTPUT" | grep -q '^HOOK_MAP_CHANGED=1$'; then
  ENABLE_CHANGED=1
  echo "Updated $HOOK_MAP_PATH"
else
  echo "$HOOK_MAP_PATH already up to date"
fi
if printf '%s\n' "$PYTHON_OUTPUT" | grep -q '^PLUGIN_HOOK_CHANGED=1$'; then
  ENABLE_CHANGED=1
  echo "$PLUGIN_PATH/openclaw-hook.json updated"
else
  echo "$PLUGIN_PATH/openclaw-hook.json already up to date"
fi

if [ "$ENABLE_CHANGED" != "1" ]; then
  echo "No plugin or config changes detected."
  echo "Skipping auto-restart — gateway restart is not required."
  echo "Enabled Memory Crystal wiring for $OPENCLAW_DIR"
  exit 0
fi

echo "Skipping auto-restart — caller is responsible for restarting the gateway."

echo "Enabled Memory Crystal wiring for $OPENCLAW_DIR"
