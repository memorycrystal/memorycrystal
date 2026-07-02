#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"
STATE_DIR="$REPO_ROOT/.crystal"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

echo "🦾 Memory Crystal init starting in $REPO_ROOT"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "Created .env from .env.example."
else
  echo ".env already exists; leaving existing keys untouched."
fi

get_env_value() {
  local file="$1"
  local key="$2"
  awk -F'=' -v key="$key" '$1 == key { $1=""; sub(/^=/, "", $0); sub(/\r$/, "", $0); print; exit }' "$file"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"

  python3 - "$file" "$key" "$value" <<'PY'
import sys

path, key, value = sys.argv[1:4]
try:
    lines = open(path, "r", encoding="utf-8").read().splitlines()
except FileNotFoundError:
    lines = []

updated = False
out = []
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={value}")
        updated = True
    else:
        out.append(line)

if not updated:
    out.append(f"{key}={value}")

with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
PY
}

value_is_missing() {
  local value="$1"
  [ -z "$value" ] && return 0
  case "$value" in
    https://your-deployment.convex.cloud|sk-...) return 0;;
    *) return 1;;
  esac
}

readonly REQUIRED_KEYS=(
  CONVEX_URL
  OPENAI_API_KEY
  OBSIDIAN_VAULT_PATH
  CRYSTAL_MCP_MODE
  CRYSTAL_MCP_HOST
  CRYSTAL_MCP_PORT
)

for key in "${REQUIRED_KEYS[@]}"; do
  current="$(get_env_value "$ENV_FILE" "$key" || true)"
  if value_is_missing "$current"; then
    if [ -t 0 ]; then
      read -r -p "Enter value for $key: " value_input
      if [ -n "$value_input" ]; then
        set_env_value "$ENV_FILE" "$key" "$value_input"
        echo "Updated $key."
      else
        echo "Keeping placeholder for $key."
      fi
    else
      echo "WARN: $key is missing in $ENV_FILE and no input is available."
    fi
  fi
done

mkdir -p "$STATE_DIR"
{
  echo "initializedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$STATE_DIR/state.ini"

if [ -d "$REPO_ROOT/node_modules" ]; then
  echo "Root node_modules already present."
else
  echo "Installing root dependencies..."
  (cd "$REPO_ROOT" && npm install --no-audit --no-fund)
fi

if [ -d "$REPO_ROOT/mcp-server/node_modules" ]; then
  echo "MCP server node_modules already present."
else
  echo "Installing MCP server dependencies..."
  (cd "$REPO_ROOT/mcp-server" && npm install --no-audit --no-fund)
fi

echo "Building MCP server..."
(cd "$REPO_ROOT/mcp-server" && npm run build)

if [ ! -x "$REPO_ROOT/scripts/start-crystal-mcp.sh" ]; then
  echo "Warning: start-crystal-mcp.sh is not executable."
fi

echo "Memory Crystal init complete. Run:"
echo "  scripts/crystal-doctor.sh --dry-run"
echo "  scripts/crystal-enable.sh"
echo "  (cd mcp-server && npm run build)"
