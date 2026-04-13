#!/usr/bin/env bash
set -u

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
OPENCLAW_CONFIG="$OPENCLAW_DIR/openclaw.json"
HOOK_MAP_PATH="$OPENCLAW_DIR/extensions/internal-hooks/openclaw-hook.json"
PLUGIN_PATH="${OPENCLAW_PLUGIN_DIR:-$OPENCLAW_DIR/extensions/crystal-memory}"

DRY_RUN=false
SMOKE=false
LIVE=false
VERBOSE=false
ERRORS=0
WARNINGS=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    --smoke)
      SMOKE=true
      ;;
    --live)
      LIVE=true
      ;;
    --verbose)
      VERBOSE=true
      ;;
    *)
      echo "WARN: unknown flag '$arg'"
      ;;
  esac
done

fail() {
  local message="$1"
  echo "  [FAIL] $message"
  ERRORS=$((ERRORS + 1))
}

warn() {
  local message="$1"
  echo "  [warn] $message"
  WARNINGS=$((WARNINGS + 1))
}

ok() {
  local message="$1"
  echo "  [ok]   $message"
}

info() {
  local message="$1"
  echo "  [info] $message"
}

check_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "Missing required command: $command_name"
    return 1
  fi
  ok "$command_name found ($(command -v "$command_name"))"
  return 0
}

check_file() {
  local path="$1"
  local label="${2:-$path}"
  if [ ! -f "$path" ]; then
    fail "Missing: $label"
    return 1
  fi
  if [ "$VERBOSE" == "true" ]; then
    ok "$label"
  fi
  return 0
}

check_executable() {
  local path="$1"
  local label="${2:-$path}"
  if [ ! -x "$path" ]; then
    fail "Not executable: $label"
    return 1
  fi
  return 0
}

# ── Header ────────────────────────────────────────────────────────────────────

PLUGIN_VERSION="unknown"
if [ -f "$REPO_ROOT/plugin/openclaw.plugin.json" ]; then
  PLUGIN_VERSION=$(grep '"version"' "$REPO_ROOT/plugin/openclaw.plugin.json" 2>/dev/null | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/' || echo "unknown")
fi

echo ""
echo "  Memory Crystal Doctor v${PLUGIN_VERSION}"
if [ "$DRY_RUN" == "true" ]; then
  echo "  (dry-run mode)"
fi
echo ""

# ── 1. Required tooling ──────────────────────────────────────────────────────

echo "  == Required tooling =="
check_command node
check_command npm
check_command npx
echo ""

# ── 2. Repo file structure ───────────────────────────────────────────────────

echo "  == Repo file structure =="

# Core repo files
REPO_FILES=(
  "package.json"
  "mcp-server/package.json"
  ".env.example"
)

for f in "${REPO_FILES[@]}"; do
  check_file "$REPO_ROOT/$f" "$f"
done

# Plugin source files (source of truth)
PLUGIN_FILES=(
  "plugin/index.js"
  "plugin/handler.js"
  "plugin/capture-hook.js"
  "plugin/recall-hook.js"
  "plugin/openclaw.plugin.json"
  "plugin/openclaw-hook.json"
  "plugin/package.json"
  "plugin/store/crystal-local-store.js"
  "plugin/compaction/crystal-assembler.js"
  "plugin/compaction/crystal-compaction.js"
  "plugin/compaction/crystal-summarizer.js"
  "plugin/compaction/package.json"
  "plugin/tools/crystal-local-tools.js"
  "plugin/utils/crystal-utils.js"
  "plugin/context-budget.js"
  "plugin/update.sh"
)

for f in "${PLUGIN_FILES[@]}"; do
  check_file "$REPO_ROOT/$f" "$f"
done

# Scripts (must be executable)
REQUIRED_SCRIPTS=(
  "scripts/crystal-init.sh"
  "scripts/crystal-doctor.sh"
  "scripts/crystal-enable.sh"
  "scripts/crystal-disable.sh"
  "scripts/crystal-bootstrap.sh"
  "scripts/crystal-e2e.sh"
  "scripts/start-crystal-mcp.sh"
  "scripts/update.sh"
  "scripts/install-openclaw.sh"
)

for s in "${REQUIRED_SCRIPTS[@]}"; do
  if check_file "$REPO_ROOT/$s" "$s"; then
    check_executable "$REPO_ROOT/$s" "$s"
  fi
done

ok "Repo file structure checked (${#REPO_FILES[@]} core + ${#PLUGIN_FILES[@]} plugin + ${#REQUIRED_SCRIPTS[@]} scripts)"
echo ""

# ── 3. Environment variables ─────────────────────────────────────────────────

echo "  == Environment variables =="

# Find the env file (same fallback as crystal-enable.sh)
ENV_FILE="$REPO_ROOT/mcp-server/.env"
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE="$REPO_ROOT/.env"
fi

if [ -f "$ENV_FILE" ]; then
  info "Loading env from $ENV_FILE"
  # shellcheck disable=SC1091
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  # Required for all setups
  if [ -z "${CONVEX_URL:-}" ] || [ "$CONVEX_URL" = "https://your-deployment.convex.cloud" ]; then
    fail "CONVEX_URL is missing or still set to the template value."
  else
    ok "CONVEX_URL set"
  fi

  if [ -z "${OBSIDIAN_VAULT_PATH:-}" ] || [ "$OBSIDIAN_VAULT_PATH" = "/path/to/your/obsidian/vault" ]; then
    warn "OBSIDIAN_VAULT_PATH is missing or still set to placeholder."
  elif [ ! -d "$OBSIDIAN_VAULT_PATH" ]; then
    warn "OBSIDIAN_VAULT_PATH ($OBSIDIAN_VAULT_PATH) does not exist."
  else
    ok "OBSIDIAN_VAULT_PATH set and exists"
  fi

  # Embedding provider checks
  EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-gemini}"
  info "EMBEDDING_PROVIDER=${EMBEDDING_PROVIDER}"

  case "$EMBEDDING_PROVIDER" in
    gemini)
      EFFECTIVE_GEMINI_KEY="${GEMINI_API_KEY:-${CRYSTAL_API_KEY:-}}"
      if [ -z "$EFFECTIVE_GEMINI_KEY" ]; then
        if [ "$SMOKE" == "true" ] || [ "$DRY_RUN" == "true" ]; then
          warn "GEMINI_API_KEY (or legacy CRYSTAL_API_KEY) is not set for local Gemini embeddings; doctor will continue because smoke/dry-run verification does not require a local embedding key."
        else
          fail "GEMINI_API_KEY (or legacy CRYSTAL_API_KEY) is required when EMBEDDING_PROVIDER=gemini"
        fi
      elif [ -n "${GEMINI_API_KEY:-}" ]; then
        ok "GEMINI_API_KEY set"
      else
        ok "CRYSTAL_API_KEY set (legacy alias used for Gemini embeddings)"
      fi
      ;;
    openai)
      if [ -z "${OPENAI_API_KEY:-}" ] || [ "$OPENAI_API_KEY" = "sk-..." ]; then
        fail "OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai"
      else
        ok "OPENAI_API_KEY set"
      fi
      ;;
    ollama)
      OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
      info "OLLAMA_BASE_URL=${OLLAMA_BASE_URL}"
      ok "EMBEDDING_PROVIDER=ollama (local)"
      ;;
    *)
      fail "EMBEDDING_PROVIDER='${EMBEDDING_PROVIDER}' is not supported. Use: gemini, openai, or ollama."
      ;;
  esac

  # MCP connection vars
  MCP_MODE="${CRYSTAL_MCP_MODE:-stdio}"
  if [ "$MCP_MODE" = "stdio" ]; then
    ok "CRYSTAL_MCP_MODE=stdio"
  elif [ "$MCP_MODE" = "http" ]; then
    if [ -z "${CRYSTAL_MCP_HOST:-}" ] || [ -z "${CRYSTAL_MCP_PORT:-}" ]; then
      warn "CRYSTAL_MCP_MODE=http requires CRYSTAL_MCP_HOST and CRYSTAL_MCP_PORT."
    else
      ok "CRYSTAL_MCP_MODE=http, HOST=${CRYSTAL_MCP_HOST}, PORT=${CRYSTAL_MCP_PORT}"
    fi
  else
    warn "CRYSTAL_MCP_MODE='${MCP_MODE}' is unsupported. Expected 'stdio' or 'http'."
  fi

  # CRYSTAL_ROOT / CRYSTAL_ENV_FILE (used by enable script and hooks)
  if [ -n "${CRYSTAL_ROOT:-}" ]; then
    if [ ! -d "$CRYSTAL_ROOT" ]; then
      warn "CRYSTAL_ROOT ($CRYSTAL_ROOT) does not exist."
    else
      ok "CRYSTAL_ROOT set and exists"
    fi
  else
    info "CRYSTAL_ROOT not set (optional for remote-only installs)"
  fi

  if [ -n "${CRYSTAL_ENV_FILE:-}" ]; then
    if [ ! -f "$CRYSTAL_ENV_FILE" ]; then
      warn "CRYSTAL_ENV_FILE ($CRYSTAL_ENV_FILE) does not exist."
    else
      ok "CRYSTAL_ENV_FILE set and exists"
    fi
  fi
else
  warn "No .env file found at $REPO_ROOT/mcp-server/.env or $REPO_ROOT/.env"
  warn "Run scripts/crystal-init.sh to generate from .env.example."
fi

if [ ! -f "$REPO_ROOT/.env.example" ]; then
  fail "Missing .env.example template."
fi
echo ""

# ── 4. Node modules & MCP build ──────────────────────────────────────────────

echo "  == Build artifacts =="

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  warn "Root node_modules missing. Run npm install or scripts/crystal-init.sh."
else
  ok "Root node_modules present"
fi

if [ ! -d "$REPO_ROOT/mcp-server/node_modules" ]; then
  warn "mcp-server/node_modules missing. Run: (cd mcp-server && npm install)"
else
  ok "mcp-server/node_modules present"
fi

if [ ! -f "$REPO_ROOT/mcp-server/dist/index.js" ]; then
  warn "MCP server build artifact missing. Run: (cd mcp-server && npm run build)"
else
  ok "mcp-server/dist/index.js present"
fi

NODE_PATH="$(command -v node || true)"
if [ -z "${NODE_PATH:-}" ] || [ ! -x "$NODE_PATH" ]; then
  fail "Could not resolve executable node path."
else
  ok "Node: $NODE_PATH ($(node --version 2>/dev/null || echo 'unknown'))"
fi
echo ""

# ── 5. Installed plugin validation ───────────────────────────────────────────

echo "  == Installed plugin =="

if [ -d "$PLUGIN_PATH" ]; then
  info "Plugin install dir: $PLUGIN_PATH"

  # Check installed plugin version vs repo version
  INSTALLED_VERSION="none"
  if [ -f "$PLUGIN_PATH/openclaw.plugin.json" ]; then
    INSTALLED_VERSION=$(grep '"version"' "$PLUGIN_PATH/openclaw.plugin.json" 2>/dev/null | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/' || echo "none")
  fi

  if [ "$INSTALLED_VERSION" = "none" ]; then
    warn "Installed plugin is missing openclaw.plugin.json"
  elif [ "$INSTALLED_VERSION" != "$PLUGIN_VERSION" ]; then
    warn "Version mismatch: installed=${INSTALLED_VERSION}, repo=${PLUGIN_VERSION}. Run crystal-enable.sh or update.sh."
  else
    ok "Installed version matches repo (${INSTALLED_VERSION})"
  fi

  # Check key installed files
  INSTALLED_FILES=(index.js handler.js capture-hook.js recall-hook.js openclaw.plugin.json openclaw-hook.json package.json)
  MISSING_INSTALLED=0
  for f in "${INSTALLED_FILES[@]}"; do
    if [ ! -f "$PLUGIN_PATH/$f" ]; then
      warn "Missing installed file: $PLUGIN_PATH/$f"
      MISSING_INSTALLED=$((MISSING_INSTALLED + 1))
    fi
  done
  if [ "$MISSING_INSTALLED" -eq 0 ]; then
    ok "All core plugin files present in install dir"
  fi
else
  warn "Plugin not installed at $PLUGIN_PATH. Run crystal-enable.sh or install-openclaw.sh."
fi
echo ""

# ── 6. OpenClaw config validation ────────────────────────────────────────────

echo "  == OpenClaw config =="

if [ -f "$OPENCLAW_CONFIG" ]; then
  info "Config: $OPENCLAW_CONFIG"

  if ! python3 - "$OPENCLAW_CONFIG" "$HOOK_MAP_PATH" "$PLUGIN_PATH" <<'PY'
import json
import os
import re
import sys


def load_tolerant_json(path):
    if not os.path.exists(path):
        return None
    raw = open(path, "r", encoding="utf-8").read()
    raw = re.sub(r",(\s*[}\]])", r"\1", raw)
    return json.loads(raw or "{}")


config_path = sys.argv[1]
hook_map_path = sys.argv[2]
plugin_path = sys.argv[3]

errors = 0
warnings = 0

def ok(msg):
    print(f"  [ok]   {msg}")

def warn(msg):
    global warnings
    print(f"  [warn] {msg}")
    warnings += 1

def fail(msg):
    global errors
    print(f"  [FAIL] {msg}")
    errors += 1

def effective_context_engine_mode(config):
    explicit = config.get("contextEngineMode")
    if explicit in {"full", "reduced", "hook-only"}:
        return explicit
    db_path = config.get("dbPath")
    local_store_enabled = config.get("localStoreEnabled") is True
    has_db_path = isinstance(db_path, str) and db_path.strip() != ""
    return "full" if (local_store_enabled or has_db_path) else "reduced"

# ── openclaw.json ──

openclaw = load_tolerant_json(config_path)
if openclaw is None:
    fail(f"Cannot read {config_path}")
    raise SystemExit(1)

plugins = openclaw.get("plugins", {})
if not isinstance(plugins, dict):
    fail("plugins block missing from OpenClaw config.")
    raise SystemExit(1)

# plugins.entries.crystal-memory
entries = plugins.get("entries", {})
entry = entries.get("crystal-memory") if isinstance(entries, dict) else None
if not isinstance(entry, dict):
    fail("plugins.entries.crystal-memory is missing.")
elif not entry.get("enabled"):
    fail("plugins.entries.crystal-memory is not enabled.")
else:
    ok("plugins.entries.crystal-memory enabled")
    config = entry.get("config", {})
    if isinstance(config, dict):
        if config.get("apiKey"):
            ok("crystal-memory config has backend apiKey")
        else:
            warn("crystal-memory config missing backend apiKey (remote API calls will fail)")
        if config.get("convexUrl"):
            ok("crystal-memory config has convexUrl")
        mode = effective_context_engine_mode(config)
        ok(f"crystal-memory context engine mode = {mode}")
        if mode == "hook-only":
            warn("crystal-memory is configured in hook-only mode; OpenClaw context-engine features are disabled")
        elif mode == "reduced":
            ok("crystal-memory reduced mode will keep hooks/tools while minimizing compaction-time work")
        if config.get("localStoreEnabled") is True:
            ok("crystal-memory local store is explicitly enabled")
        else:
            ok("crystal-memory local store is disabled or not explicitly enabled")
    else:
        warn("crystal-memory config block missing")

# crystal-capture should NOT exist (legacy)
if isinstance(entries, dict) and "crystal-capture" in entries:
    warn("Legacy plugins.entries.crystal-capture found. Remove it.")

# plugins.slots
slots = plugins.get("slots", {})
if not isinstance(slots, dict) or slots.get("memory") != "crystal-memory":
    fail("plugins.slots.memory is not set to crystal-memory.")
else:
    ok("plugins.slots.memory = crystal-memory")

if isinstance(slots, dict) and slots.get("contextEngine"):
    warn(f"plugins.slots.contextEngine is still set to {slots.get('contextEngine')!r}. Remove it.")

# plugins.load.paths
load = plugins.get("load", {})
paths = load.get("paths", []) if isinstance(load, dict) else []
if not isinstance(paths, list) or not any(isinstance(item, str) and "crystal-memory" in item for item in paths):
    fail("plugins.load.paths does not include the crystal-memory plugin directory.")
else:
    ok("plugins.load.paths includes crystal-memory")

# plugins.allow
allow = plugins.get("allow", [])
if isinstance(allow, list) and "crystal-memory" in allow:
    ok("plugins.allow includes crystal-memory")
elif isinstance(allow, list) and len(allow) > 0:
    warn("plugins.allow does not include crystal-memory")

# ── openclaw-hook.json (internal hooks) ──

hook_map = load_tolerant_json(hook_map_path)
if hook_map is None:
    warn(f"Hook map not found at {hook_map_path} (optional for plugin-only installs)")
else:
    commands = hook_map.get("commands", {})
    if not isinstance(commands, dict):
        warn("openclaw-hook.json commands block missing.")
    else:
        # crystal-memory command
        cm_entry = commands.get("crystal-memory")
        if isinstance(cm_entry, dict):
            if cm_entry.get("command") and cm_entry.get("args"):
                ok("Hook map: crystal-memory command configured")
            else:
                warn("Hook map: crystal-memory missing command or args")
        else:
            warn("Hook map: crystal-memory command entry missing")

        # crystal-capture command
        cc_entry = commands.get("crystal-capture")
        if isinstance(cc_entry, dict):
            if cc_entry.get("command") and cc_entry.get("args"):
                ok("Hook map: crystal-capture command configured")
            else:
                warn("Hook map: crystal-capture missing command or args")

        # crystal-recall command
        cr_entry = commands.get("crystal-recall")
        if isinstance(cr_entry, dict):
            if cr_entry.get("command") and cr_entry.get("args"):
                ok("Hook map: crystal-recall command configured")
            else:
                warn("Hook map: crystal-recall missing command or args")

# ── Installed openclaw-hook.json (in plugin dir) ──

installed_hook = load_tolerant_json(os.path.join(plugin_path, "openclaw-hook.json"))
if installed_hook is not None:
    caps = installed_hook.get("capabilities", {})
    if isinstance(caps, dict) and caps.get("mcpCommand"):
        mcp_cmd = caps["mcpCommand"]
        mcp_args = caps.get("mcpArgs", [])
        if os.path.isfile(mcp_cmd):
            ok(f"Plugin hook mcpCommand exists: {mcp_cmd}")
        else:
            warn(f"Plugin hook mcpCommand path does not exist: {mcp_cmd}")
        if isinstance(mcp_args, list) and len(mcp_args) > 0:
            mcp_dist = mcp_args[0]
            if os.path.isfile(mcp_dist):
                ok(f"Plugin hook MCP dist exists: {mcp_dist}")
            else:
                warn(f"Plugin hook MCP dist does not exist: {mcp_dist}")

if errors > 0:
    raise SystemExit(1)
PY
  then
    warn "OpenClaw config has issues. Run scripts/crystal-enable.sh to fix."
  fi
else
  warn "OpenClaw config not found at $OPENCLAW_CONFIG."
  warn "Run install-openclaw.sh (remote) or crystal-enable.sh (dev) to configure."
fi
echo ""

# ── 6b. Plugin backend auth probe ─────────────────────────────────────────────

echo "  == Plugin backend auth probe =="
PLUGIN_AUTH_PROBE="$(node - "$OPENCLAW_CONFIG" <<'NODE'
const fs = require('node:fs');

function loadTolerantJson(path) {
  try {
    const raw = fs.readFileSync(path, 'utf8').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

(async () => {
  const configPath = process.argv[2];
  const openclaw = loadTolerantJson(configPath);
  if (!openclaw) {
    console.log(JSON.stringify({ status: 'missing-config' }));
    return;
  }
  const config = (((openclaw.plugins || {}).entries || {})['crystal-memory'] || {}).config || {};
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const convexUrl = typeof config.convexUrl === 'string' ? config.convexUrl.trim().replace(/\/$/, '') : '';
  if (!apiKey || !convexUrl) {
    console.log(JSON.stringify({ status: 'missing-credentials' }));
    return;
  }
  try {
    const response = await fetch(`${convexUrl}/api/mcp/stats`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) {
      console.log(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (response.status === 401) {
      try {
        const hosted = await fetch('https://api.memorycrystal.ai/mcp', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} }),
        });
        if (hosted.ok) {
          console.log(JSON.stringify({ status: 'hosted-mcp-only', code: response.status }));
          return;
        }
      } catch {}
    }
    console.log(JSON.stringify({ status: 'http-error', code: response.status }));
  } catch (error) {
    console.log(JSON.stringify({ status: 'network-error', detail: String((error && error.message) || error) }));
  }
})();
NODE
)"
case "$(printf '%s' "$PLUGIN_AUTH_PROBE" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.status || '');")" in
  ok)
    ok "Installed plugin auth reaches backend successfully"
    ;;
  http-error)
    PROBE_CODE="$(printf '%s' "$PLUGIN_AUTH_PROBE" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(String(data.code || 'unknown'));")"
    fail "Installed plugin backend probe failed with HTTP ${PROBE_CODE}"
    ;;
  hosted-mcp-only)
    fail "Installed plugin backend probe failed with HTTP 401, but the configured key still works for hosted MCP. Re-run the OpenClaw installer/device-auth flow or configure a plugin/backend API key."
    ;;
  network-error)
    PROBE_DETAIL="$(printf '%s' "$PLUGIN_AUTH_PROBE" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(String(data.detail || 'unknown error'));")"
    warn "Installed plugin backend probe hit a network error: ${PROBE_DETAIL}"
    ;;
  missing-credentials)
    warn "Installed plugin backend probe skipped (missing plugin apiKey or convexUrl)"
    ;;
  *)
    warn "Installed plugin backend probe skipped (missing OpenClaw config)"
    ;;
esac
echo ""

# ── 7. Update script consistency ─────────────────────────────────────────────

echo "  == Update script consistency =="

# Check that scripts/update.sh and plugin/update.sh have the same PLUGIN_FILES
if [ -f "$REPO_ROOT/scripts/update.sh" ] && [ -f "$REPO_ROOT/plugin/update.sh" ]; then
  SCRIPTS_FILES=$(grep -A 100 '^PLUGIN_FILES=(' "$REPO_ROOT/scripts/update.sh" | sed -n '/^PLUGIN_FILES=(/,/^)/p' | grep '"plugin/' | sort)
  PLUGIN_FILES_LIST=$(grep -A 100 '^PLUGIN_FILES=(' "$REPO_ROOT/plugin/update.sh" | sed -n '/^PLUGIN_FILES=(/,/^)/p' | grep '"plugin/' | sort)
  if [ "$SCRIPTS_FILES" != "$PLUGIN_FILES_LIST" ]; then
    warn "PLUGIN_FILES mismatch between scripts/update.sh and plugin/update.sh"
    if [ "$VERBOSE" == "true" ]; then
      echo "    scripts/update.sh only:"
      diff <(echo "$SCRIPTS_FILES") <(echo "$PLUGIN_FILES_LIST") | grep '^<' | sed 's/^/      /'
      echo "    plugin/update.sh only:"
      diff <(echo "$SCRIPTS_FILES") <(echo "$PLUGIN_FILES_LIST") | grep '^>' | sed 's/^/      /'
    fi
  else
    ok "scripts/update.sh and plugin/update.sh PLUGIN_FILES match"
  fi

  # Check for references to files that don't exist in plugin/
  for f in $(grep -A 100 '^PLUGIN_FILES=(' "$REPO_ROOT/scripts/update.sh" | sed -n '/^PLUGIN_FILES=(/,/^)/p' | grep '"plugin/' | sed 's/.*"\(plugin\/[^"]*\)".*/\1/'); do
    if [ ! -f "$REPO_ROOT/$f" ]; then
      fail "scripts/update.sh references $f but it does not exist in repo"
    fi
  done

  # Same check for plugin/update.sh
  for f in $(grep -A 100 '^PLUGIN_FILES=(' "$REPO_ROOT/plugin/update.sh" | sed -n '/^PLUGIN_FILES=(/,/^)/p' | grep '"plugin/' | sed 's/.*"\(plugin\/[^"]*\)".*/\1/'); do
    if [ ! -f "$REPO_ROOT/$f" ]; then
      fail "plugin/update.sh references $f but it does not exist in repo"
    fi
  done
else
  warn "Cannot compare update scripts (one or both missing)"
fi

# Check public/update.sh matches scripts/update.sh
if [ -f "$REPO_ROOT/apps/web/public/update.sh" ] && [ -f "$REPO_ROOT/scripts/update.sh" ]; then
  if ! diff -q "$REPO_ROOT/scripts/update.sh" "$REPO_ROOT/apps/web/public/update.sh" >/dev/null 2>&1; then
    warn "apps/web/public/update.sh differs from scripts/update.sh (should be identical)"
  else
    ok "apps/web/public/update.sh matches scripts/update.sh"
  fi
fi
echo ""

# ── 8. Live health check ─────────────────────────────────────────────────────

if [ "${LIVE:-false}" == "true" ]; then
  echo "  == Live health check =="

  MCP_MODE="${CRYSTAL_MCP_MODE:-stdio}"
  MCP_HOST="${CRYSTAL_MCP_HOST:-127.0.0.1}"
  MCP_PORT="${CRYSTAL_MCP_PORT:-8788}"
  MCP_PROBE_TOKEN="${MC_MCP_TOKEN:-${MEMORY_CRYSTAL_API_KEY:-${CRYSTAL_API_KEY:-}}}"

  if [ "$MCP_MODE" == "http" ]; then
    info "Probing http://${MCP_HOST}:${MCP_PORT}/health"
    if ! python3 - "$MCP_HOST" "$MCP_PORT" "$MCP_PROBE_TOKEN" <<'PY'
import sys
import urllib.request

host = sys.argv[1]
port = sys.argv[2]
token = sys.argv[3]
url = f"http://{host}:{port}/health"
try:
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=3) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
    print(f"  [ok]   Health endpoint responded 200")
except Exception as exc:
    print(f"  [FAIL] Health check failed: {exc}")
    raise SystemExit(1)
PY
    then
      fail "MCP health endpoint unavailable at ${MCP_HOST}:${MCP_PORT}"
    fi
  elif [ "$MCP_MODE" == "stdio" ]; then
    info "MCP mode is 'stdio'; skipping HTTP health probe."
  else
    warn "Unknown MCP mode '${MCP_MODE}'. Expected 'stdio' or 'http'."
  fi

  # Check if openclaw CLI can see the plugin
  if command -v openclaw >/dev/null 2>&1; then
    PLUGIN_INFO="$(openclaw plugins info crystal-memory 2>&1 || true)"
    if echo "$PLUGIN_INFO" | grep -q "Status: loaded"; then
      ok "openclaw reports crystal-memory is loaded"
    elif echo "$PLUGIN_INFO" | grep -q "crystal-memory"; then
      warn "crystal-memory found but not in 'loaded' state"
    else
      warn "openclaw plugins info crystal-memory returned no results"
    fi
  fi
  echo ""
fi

# ── 9. Smoke test ────────────────────────────────────────────────────────────

if [ "${SMOKE:-false}" == "true" ]; then
  echo "  == Smoke test =="
  info "Smoke test: verifying plugin can be loaded by node..."
  if [ -f "$PLUGIN_PATH/index.js" ]; then
    if node -e "const m = require('$PLUGIN_PATH/index.js'); console.log('  [ok]   Plugin exports:', typeof m === 'function' ? 'function' : typeof m);" 2>/dev/null; then
      true  # output already printed
    else
      warn "Plugin index.js failed to load in node"
    fi
  else
    warn "Cannot smoke test: $PLUGIN_PATH/index.js not found"
  fi
  echo ""
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo "  ════════════════════════════════════════"
if [ "$ERRORS" -gt 0 ]; then
  echo "  RESULT: FAILED ($ERRORS errors, $WARNINGS warnings)"
  echo ""
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo "  RESULT: PASSED with $WARNINGS warnings"
  echo ""
  exit 0
else
  echo "  RESULT: ALL CHECKS PASSED"
  echo ""
  exit 0
fi
