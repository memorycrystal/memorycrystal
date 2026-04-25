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
REQUIRED_ENV_KEYS=(CONVEX_URL CRYSTAL_CONVEX_URL CRYSTAL_CONVEX_SITE_URL MEMORY_CRYSTAL_API_URL OPENAI_API_KEY MEMORY_CRYSTAL_API_KEY CRYSTAL_API_KEY GEMINI_API_KEY GEMINI_EMBEDDING_MODEL EMBEDDING_PROVIDER OBSIDIAN_VAULT_PATH CRYSTAL_BACKEND CRYSTAL_LOCAL_LLM_STUB CRYSTAL_EMAIL_DRY_RUN CRYSTAL_MCP_MODE CRYSTAL_MCP_HOST CRYSTAL_MCP_PORT)
MCP_DIST="$REPO_ROOT/mcp-server/dist/index.js"
NODE_PATH="${NODE_PATH:-$(command -v node || true)}"
MCP_ENV_FILE="$REPO_ROOT/mcp-server/.env"
if [ ! -f "$MCP_ENV_FILE" ]; then
  MCP_ENV_FILE="$REPO_ROOT/.env.local"
fi
if [ ! -f "$MCP_ENV_FILE" ]; then
  MCP_ENV_FILE="$REPO_ROOT/.env"
fi

detect_local_sqlite_ready() {
  case "${CRYSTAL_LOCAL_SQLITE_READY:-}" in
    1|true|TRUE|yes|YES) echo "1"; return ;;
    0|false|FALSE|no|NO) echo "0"; return ;;
  esac
  "$NODE_PATH" - "$PLUGIN_PATH" <<'NODE'
const nodePath = require('node:path');
const pluginPath = process.argv[2];
try {
  require(nodePath.join(pluginPath, 'node_modules', 'better-sqlite3'));
  process.stdout.write('1');
} catch (_) {
  process.stdout.write('0');
}
NODE
}

DRY_RUN=false
ALLOW_UNVALIDATED_BACKEND=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --allow-unvalidated-backend) ALLOW_UNVALIDATED_BACKEND=true ;;
    *)
      echo "ERROR: unknown argument: $arg"
      echo "Usage: $0 [--dry-run] [--allow-unvalidated-backend]"
      exit 1
      ;;
  esac
done

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

LOCAL_SQLITE_READY=0
if command -v npm >/dev/null 2>&1; then
  (cd "$PLUGIN_PATH" && npm install better-sqlite3 --save-optional --silent 2>/dev/null && echo "Installed optional better-sqlite3 dependency") || echo "Optional better-sqlite3 dependency unavailable; continuing in cloud-only mode"
fi
LOCAL_SQLITE_READY="$(detect_local_sqlite_ready)"
if [ "$LOCAL_SQLITE_READY" = "1" ]; then
  echo "Local SQLite runtime available for crystal-memory"
else
  echo "Local SQLite runtime unavailable; preserving reduced mode unless config explicitly opts into local compaction"
fi

mkdir -p "$OPENCLAW_DIR"
mkdir -p "$OPENCLAW_DIR/extensions/internal-hooks"

if ! PYTHON_OUTPUT="$(python3 - "$OPENCLAW_CONFIG" "$REPO_ROOT/.env" "${OPENCLAW_DIR}" "${REPO_ROOT}" "$MCP_DIST" "$NODE_PATH" "$PLUGIN_PATH" "$MCP_ENV_FILE" "${REQUIRED_ENV_KEYS[*]}" "$ALLOW_UNVALIDATED_BACKEND" "$LOCAL_SQLITE_READY" <<'PY'
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request


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


DEFAULT_MEMORY_BACKEND = "https://convex.memorycrystal.ai"


def classify_backend(url):
    target = normalize_convex_http_url(url)
    if not target:
        return ("missing", "no backend configured")
    request = urllib.request.Request(f"{target}/api/mcp/stats", method="GET")
    insecure_context = ssl.create_default_context()
    insecure_context.check_hostname = False
    insecure_context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(request, timeout=5, context=insecure_context) as response:
            status = getattr(response, "status", None) or response.getcode()
    except urllib.error.HTTPError as err:
        status = err.code
    except Exception as err:
        return ("unreachable", f"{type(err).__name__}: {err}")

    if status in (200, 401, 403):
        return ("ok", f"MCP routes reachable (HTTP {status})")
    if status == 404:
        return ("missing-routes", "MCP routes missing (HTTP 404)")
    return ("unexpected-status", f"unexpected HTTP {status}")


def pick_backend(plugin_config, env_values):
    if env_values.get("CRYSTAL_BACKEND") == "local":
        local_backend = normalize_convex_http_url(
            env_values.get("CRYSTAL_CONVEX_SITE_URL")
            or env_values.get("CRYSTAL_CONVEX_URL")
            or env_values.get("MEMORY_CRYSTAL_API_URL")
            or "http://127.0.0.1:3211"
        )
        return local_backend, "local backend overlay"

    persisted = normalize_convex_http_url(plugin_config.get("convexUrl"))
    explicit = normalize_convex_http_url(
        env_values.get("CRYSTAL_CONVEX_URL") or env_values.get("MEMORY_CRYSTAL_API_URL")
    )
    bootstrap = normalize_convex_http_url(env_values.get("CONVEX_URL"))
    local_backend = normalize_convex_http_url(
        env_values.get("CRYSTAL_CONVEX_SITE_URL") or "http://127.0.0.1:3211"
    )

    if env_values.get("CRYSTAL_BACKEND") == "local":
        return local_backend, "CRYSTAL_BACKEND=local"
    if explicit:
        return explicit, "explicit memory backend env override"
    if persisted:
        return persisted, "persisted plugin config"
    if bootstrap:
        return bootstrap, "CONVEX_URL bootstrap fallback"
    return DEFAULT_MEMORY_BACKEND, "managed default"


config_path, env_path, openclaw_dir, repo_root, mcp_dist, node_path, plugin_path, mcp_env_path, keys_csv, allow_unvalidated_raw, local_sqlite_ready_raw = sys.argv[1:12]
required_keys = keys_csv.split()
allow_unvalidated_backend = allow_unvalidated_raw.lower() == "true"
local_sqlite_ready = local_sqlite_ready_raw.lower() in {"1", "true", "yes"}
env_values = load_env(env_path)
env_values.update(load_env(os.path.join(repo_root, ".env.local")))
if mcp_env_path != env_path:
    env_values.update(load_env(mcp_env_path))
for key in set(required_keys):
    env_override = os.environ.get(key)
    if env_override:
        env_values[key] = env_override

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
selected_backend, backend_source = pick_backend(plugin_config, env_values)
backend_status, backend_detail = classify_backend(selected_backend)
if backend_status != "ok" and not allow_unvalidated_backend:
    print(f"ERROR: refusing to persist Memory Crystal backend {selected_backend}")
    print(f"Backend source: {backend_source}")
    print(f"Backend validation: {backend_detail}")
    print("Hint: set CRYSTAL_CONVEX_URL to a valid Memory Crystal backend or rerun with --allow-unvalidated-backend for trusted private-network/self-hosted installs.")
    raise SystemExit(1)
plugin_config["convexUrl"] = selected_backend
explicit_mode = plugin_config.get("contextEngineMode")
has_explicit_mode = explicit_mode in {"full", "reduced", "hook-only"}
has_explicit_local_store = isinstance(plugin_config.get("localStoreEnabled"), bool)
has_explicit_db_path = isinstance(plugin_config.get("dbPath"), str) and plugin_config.get("dbPath").strip() != ""
if local_sqlite_ready:
    if not has_explicit_local_store:
        plugin_config["localStoreEnabled"] = True
    if not has_explicit_mode:
        plugin_config["contextEngineMode"] = "full"
else:
    if (not has_explicit_mode) and (not has_explicit_local_store) and (not has_explicit_db_path):
        plugin_config.pop("contextEngineMode", None)

entry_env["CONVEX_URL"] = selected_backend
entry_env["CRYSTAL_CONVEX_URL"] = selected_backend

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
command_env["CONVEX_URL"] = selected_backend
command_env["CRYSTAL_CONVEX_URL"] = selected_backend
if "CRYSTAL_API_KEY" not in command_env and env_values.get("MEMORY_CRYSTAL_API_KEY"):
    command_env["CRYSTAL_API_KEY"] = env_values["MEMORY_CRYSTAL_API_KEY"]

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
plugin_env["CRYSTAL_CONVEX_URL"] = selected_backend
plugin_env["CONVEX_URL"] = selected_backend

after_plugin_hook_raw = dump_pretty(plugin_hook)
plugin_hook_changed = before_plugin_hook_raw != after_plugin_hook_raw
if plugin_hook_changed:
    with open(plugin_hook_path, "w", encoding="utf-8") as f:
        f.write(after_plugin_hook_raw)

print(f"CONFIG_CHANGED={1 if config_changed else 0}")
print(f"HOOK_MAP_CHANGED={1 if hook_changed else 0}")
print(f"PLUGIN_HOOK_CHANGED={1 if plugin_hook_changed else 0}")
print(f"BACKEND={selected_backend}")
print(f"BACKEND_SOURCE={backend_source}")
print(f"BACKEND_VALIDATION={backend_detail}")
print(f"BACKEND_STATUS={backend_status}")
print(f"LOCAL_SQLITE_READY={1 if local_sqlite_ready else 0}")
PY
)"; then
  printf '%s\n' "$PYTHON_OUTPUT"
  exit 1
fi
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
