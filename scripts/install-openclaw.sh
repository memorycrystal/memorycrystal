#!/usr/bin/env bash
set -euo pipefail

CONVEX_URL="${CRYSTAL_CONVEX_URL:-https://convex.memorycrystal.ai}"
INSTALL_BASE="${CRYSTAL_INSTALL_BASE:-https://memorycrystal.ai}"
PLUGIN_REPO_BASE="$INSTALL_BASE/install-assets/plugin"
MIGRATE_URL="$INSTALL_BASE/migrate.sh"
DEVICE_START_URL="$CONVEX_URL/api/device/start"
DEVICE_STATUS_URL="$CONVEX_URL/api/device/status"
API_KEY="${MEMORY_CRYSTAL_API_KEY:-${CRYSTAL_API_KEY:-}}"

while [ $# -gt 0 ]; do
  case "$1" in
    --api-key)
      if [ $# -lt 2 ]; then
        echo "  ✗ --api-key requires a value."
        exit 1
      fi
      API_KEY="$2"
      shift 2
      ;;
    *)
      echo "  ✗ Unknown argument: $1"
      echo "    Supported: --api-key <key>"
      exit 1
      ;;
  esac
done

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
LEGACY_HOOK_DIR="$OPENCLAW_DIR/hooks/crystal-stm"
LEGACY_CAPTURE_EXT_DIR="$OPENCLAW_DIR/extensions/crystal-capture"
EXT_DIR="$OPENCLAW_DIR/extensions/crystal-memory"
INSTALL_CHANGED=0

fetch_plugin_file() {
  local file="$1"
  local target="$2"
  local url="$PLUGIN_REPO_BASE/$file"
  local tmp_file
  tmp_file="$(mktemp)"

  if ! curl -fsSL "$url" -o "$tmp_file"; then
    rm -f "$tmp_file"
    echo "  ✗ Failed to download plugin file: $url"
    exit 1
  fi

  if [ -f "$target" ] && cmp -s "$tmp_file" "$target"; then
    rm -f "$tmp_file"
    return
  fi

  mv "$tmp_file" "$target"
  INSTALL_CHANGED=1
}

open_authorization_url() {
  local url="$1"

  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 && return 0
  fi

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 && return 0
  fi

  return 1
}

prompt_for_api_key() {
  if [ ! -r /dev/tty ]; then
    echo "  ✗ Interactive terminal required to enter your API key."
    exit 1
  fi

  IFS= read -r -p "  Enter your Memory Crystal API key: " API_KEY < /dev/tty
  echo ""

  if [ -z "$API_KEY" ]; then
    echo "  ✗ No API key provided. Exiting."
    exit 1
  fi
}

start_device_auth_flow() {
  local start_json
  local device_code
  local user_code
  local verification_url
  local status_json
  local status
  local api_key
  local attempts=60
  local slept=0

  start_json="$(curl -fsSL -X POST "$DEVICE_START_URL")" || return 1
  device_code="$(printf '%s' "$start_json" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.device_code || '');")"
  user_code="$(printf '%s' "$start_json" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.user_code || '');")"
  verification_url="$(printf '%s' "$start_json" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.verification_url || '');")"

  if [ -z "$device_code" ] || [ -z "$verification_url" ]; then
    return 1
  fi

  echo "  → Open browser to authorize this install"
  echo "    Code: $user_code"
  echo "    URL:  $verification_url"
  echo ""

  if open_authorization_url "$verification_url"; then
    echo "  ✓ Browser opened. Approve the install, then come back here."
  else
    echo "  → Could not open a browser automatically."
    echo "    Visit the URL above, then authorize the device."
  fi

  echo "  → Waiting for authorization (up to 3 minutes)..."
  while [ "$attempts" -gt 0 ]; do
    status_json="$(curl -fsSL "$DEVICE_STATUS_URL?device_code=$device_code" 2>/dev/null || true)"
    status="$(printf '%s' "$status_json" | node -e "const fs=require('fs'); try { const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.status || ''); } catch { process.stdout.write(''); }")"

    case "$status" in
      complete)
        api_key="$(printf '%s' "$status_json" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.apiKey || '');")"
        if [ -n "$api_key" ]; then
          API_KEY="$api_key"
          echo "  ✓ Device authorized"
          return 0
        fi
        ;;
      expired)
        echo "  ✗ Device authorization expired."
        return 1
        ;;
    esac

    attempts=$((attempts - 1))
    slept=$((slept + 3))
    sleep 3
  done

  echo "  ✗ Timed out waiting for browser authorization."
  return 1
}

verify_openclaw_install() {
  local config_file="$1"
  local memory_slot
  local context_slot
  local plugin_info_file

  memory_slot="$(node -e "const fs=require('fs');let cfg={};try{cfg=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));}catch{};process.stdout.write(String(cfg?.plugins?.slots?.memory ?? ''));" "$config_file")"
  context_slot="$(node -e "const fs=require('fs');let cfg={};try{cfg=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));}catch{};process.stdout.write(String(cfg?.plugins?.slots?.contextEngine ?? ''));" "$config_file")"

  if [ "$memory_slot" != "crystal-memory" ]; then
    echo "  ✗ Verification failed: plugins.slots.memory is '$memory_slot' (expected crystal-memory)"
    return 1
  fi

  if [ -n "$context_slot" ]; then
    echo "  ✗ Verification failed: plugins.slots.contextEngine is still set to '$context_slot' (expected unset)"
    return 1
  fi

  plugin_info_file="$(mktemp)"
  if ! openclaw plugins info crystal-memory >"$plugin_info_file" 2>&1; then
    echo "  ✗ Verification failed: openclaw plugins info crystal-memory returned an error"
    sed -n '1,40p' "$plugin_info_file"
    rm -f "$plugin_info_file"
    return 1
  fi

  if ! grep -q "Status: loaded" "$plugin_info_file"; then
    echo "  ✗ Verification failed: crystal-memory is not loaded after restart"
    sed -n '1,40p' "$plugin_info_file"
    rm -f "$plugin_info_file"
    return 1
  fi

  if ! grep -q "memory_search" "$plugin_info_file"; then
    echo "  ✗ Verification failed: crystal-memory does not expose memory_search"
    sed -n '1,60p' "$plugin_info_file"
    rm -f "$plugin_info_file"
    return 1
  fi

  if ! grep -q "memory_get" "$plugin_info_file"; then
    echo "  ✗ Verification failed: crystal-memory does not expose memory_get"
    sed -n '1,60p' "$plugin_info_file"
    rm -f "$plugin_info_file"
    return 1
  fi

  if ! grep -q "crystal_search_messages" "$plugin_info_file"; then
    echo "  ✗ Verification failed: crystal-memory does not expose crystal_search_messages"
    sed -n '1,80p' "$plugin_info_file"
    rm -f "$plugin_info_file"
    return 1
  fi

  rm -f "$plugin_info_file"
  echo "  ✓ Verified plugins.slots.memory = crystal-memory"
  echo "  ✓ Verified crystal-memory plugin is loaded"
  echo "  ✓ Verified crystal-memory memory_search/memory_get/crystal_search_messages"
  return 0
}

prompt_memory_import() {
  local choice
  local tmp_file

  if [ ! -r /dev/tty ]; then
    return 0
  fi

  echo ""
  echo "  → Import existing OpenClaw memories? [Y/n]"
  IFS= read -r choice < /dev/tty || true

  case "$choice" in
    ""|[Yy]|[Yy][Ee][Ss])
      tmp_file="$(mktemp)"
      if ! curl -fsSL "$MIGRATE_URL" -o "$tmp_file"; then
        rm -f "$tmp_file"
        echo "  ✗ Failed to download memory migration script: $MIGRATE_URL"
        return 1
      fi
      chmod +x "$tmp_file"
      if ! CRYSTAL_API_KEY="$API_KEY" "$tmp_file" --api-key "$API_KEY" --openclaw-dir "$OPENCLAW_DIR" --workspace-dir "$HOME"; then
        rm -f "$tmp_file"
        echo "  ✗ Memory import encountered errors. You can retry later with:"
        echo "    curl -fsSL $MIGRATE_URL | bash -s -- --api-key <key>"
        return 1
      fi
      rm -f "$tmp_file"
      ;;
    *)
      echo "  → Skipped memory import. You can run it later with:"
      echo "    curl -fsSL $MIGRATE_URL | bash -s -- --api-key <key>"
      ;;
  esac

  return 0
}

echo ""
echo "  ◈ Memory Crystal Installer"
echo "  Persistent memory for your AI agents"
echo ""

# ── Check prerequisites ───────────────────────────────────────────────────────
if ! command -v openclaw >/dev/null 2>&1; then
  echo "  ✗ OpenClaw not found."
  echo "  Install it first: https://openclaw.ai"
  echo ""
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js is required but was not found."
  exit 1
fi

echo "  ✓ OpenClaw detected ($(openclaw --version 2>/dev/null || echo 'version unknown'))"

# ── Get API key ───────────────────────────────────────────────────────────────
echo ""
if [ -n "$API_KEY" ]; then
  echo "  → Using API key provided via flag/environment"
else
  echo "  → Starting browser authorization flow"
  if ! start_device_auth_flow; then
    echo ""
    echo "  → Falling back to manual API key entry"
    echo "    Create one at: https://memorycrystal.ai/dashboard/settings"
    echo ""
    prompt_for_api_key
  fi
fi

# Validate key against the API
echo "  → Validating API key..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X GET \
  "$CONVEX_URL/api/mcp/auth" \
  -H "Authorization: Bearer $API_KEY" \
  2>/dev/null)

if [ "$STATUS" != "200" ]; then
  echo "  ✗ Invalid API key (HTTP $STATUS). Check https://memorycrystal.ai/dashboard/settings"
  exit 1
fi
echo "  ✓ API key valid"

mkdir -p "$OPENCLAW_DIR"
if [ -d "$LEGACY_HOOK_DIR" ]; then
  echo "  → Removing legacy crystal-stm hook from $LEGACY_HOOK_DIR..."
  rm -rf "$LEGACY_HOOK_DIR"
  INSTALL_CHANGED=1
  echo "  ✓ Legacy hook removed"
fi

if [ -d "$LEGACY_CAPTURE_EXT_DIR" ]; then
  echo "  → Removing legacy crystal-capture extension from $LEGACY_CAPTURE_EXT_DIR..."
  rm -rf "$LEGACY_CAPTURE_EXT_DIR"
  INSTALL_CHANGED=1
  echo "  ✓ Legacy crystal-capture extension removed"
fi

# ── Install crystal-memory extension (tools) ─────────────────────────────────
echo "  → Installing crystal-memory plugin to $EXT_DIR..."
mkdir -p "$EXT_DIR"

fetch_plugin_file "index.js" "$EXT_DIR/index.js"
fetch_plugin_file "openclaw.plugin.json" "$EXT_DIR/openclaw.plugin.json"
fetch_plugin_file "package.json" "$EXT_DIR/package.json"
fetch_plugin_file "recall-hook.js" "$EXT_DIR/recall-hook.js"
fetch_plugin_file "capture-hook.js" "$EXT_DIR/capture-hook.js"
fetch_plugin_file "handler.js" "$EXT_DIR/handler.js"
fetch_plugin_file "openclaw-hook.json" "$EXT_DIR/openclaw-hook.json"

echo "  ✓ Plugin files written"

# ── Configure OpenClaw ────────────────────────────────────────────────────────
echo "  → Updating OpenClaw config at $OPENCLAW_CONFIG..."
CONFIG_OUTPUT="$(node - "$OPENCLAW_CONFIG" "$API_KEY" "$CONVEX_URL" "$EXT_DIR" <<'NODE'
const fs = require('node:fs');
const nodePath = require('node:path');
const path = process.argv[2];
const apiKey = process.argv[3];
const convexUrl = process.argv[4];
const extDir = process.argv[5];
const preserveDevPath = process.env.CRYSTAL_PRESERVE_DEV_PLUGIN_PATH === '1';

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch {
  cfg = {};
}
const beforeRaw = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
const notes = [];

cfg.hooks ??= {};
cfg.hooks.internal ??= {};
cfg.hooks.internal.enabled = true;
if (cfg.hooks.internal.entries && typeof cfg.hooks.internal.entries === 'object') {
  delete cfg.hooks.internal.entries['crystal-memory'];
  delete cfg.hooks.internal.entries['crystal-stm'];
  delete cfg.hooks.internal.entries['cortex-mcp'];
}

cfg.plugins ??= {};
cfg.plugins.slots = (cfg.plugins.slots && typeof cfg.plugins.slots === 'object') ? cfg.plugins.slots : {};
cfg.plugins.slots.memory = 'crystal-memory';
if (Object.prototype.hasOwnProperty.call(cfg.plugins.slots, 'contextEngine')) {
  delete cfg.plugins.slots.contextEngine;
}

cfg.plugins.allow = Array.isArray(cfg.plugins.allow) ? cfg.plugins.allow : [];
if (!cfg.plugins.allow.includes('crystal-memory')) cfg.plugins.allow.push('crystal-memory');

cfg.plugins.load ??= {};
const existingPaths = Array.isArray(cfg.plugins.load.paths) ? cfg.plugins.load.paths : [];

const normalize = (p) => String(p || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const extNorm = normalize(extDir);
const isLikelyRepoDevPath = (p) => {
  const n = normalize(p);
  return n.endsWith('/memorycrystal/plugin') || n.includes('/projects/memorycrystal/plugin');
};
const isLegacyCapturePath = (p) => normalize(p).endsWith('/extensions/crystal-capture');

const devPaths = existingPaths.filter(isLikelyRepoDevPath);
const hasDevPath = devPaths.length > 0;
const preferDevPath = preserveDevPath && hasDevPath;

let activePath = extDir;
let nextPaths = [...existingPaths];

if (preferDevPath) {
  activePath = devPaths[0];
  nextPaths = nextPaths.filter((p) => normalize(p) !== extNorm);
  notes.push('  ℹ Preserving existing repo dev plugin path for crystal-memory (CRYSTAL_PRESERVE_DEV_PLUGIN_PATH=1).');
} else {
  nextPaths = nextPaths.filter((p) => !isLikelyRepoDevPath(p) && !isLegacyCapturePath(p));
  if (hasDevPath) {
    notes.push('  ℹ Removed repo dev plugin path to avoid duplicate crystal-memory plugin loading.');
  }
  if (!nextPaths.some((p) => normalize(p) === extNorm)) nextPaths.push(extDir);
}

cfg.plugins.load.paths = Array.from(new Set(nextPaths));

cfg.plugins.entries ??= {};
delete cfg.plugins.entries['crystal-capture'];
const existingEntry = (cfg.plugins.entries['crystal-memory'] && typeof cfg.plugins.entries['crystal-memory'] === 'object')
  ? cfg.plugins.entries['crystal-memory']
  : {};
const existingConfig = (existingEntry.config && typeof existingEntry.config === 'object')
  ? existingEntry.config
  : {};

cfg.plugins.entries['crystal-memory'] = {
  ...existingEntry,
  enabled: true,
  config: {
    ...existingConfig,
    apiKey,
    convexUrl,
  },
};

cfg.plugins.installs ??= {};
delete cfg.plugins.installs['crystal-capture'];
const existingInstall = (cfg.plugins.installs['crystal-memory'] && typeof cfg.plugins.installs['crystal-memory'] === 'object')
  ? cfg.plugins.installs['crystal-memory']
  : {};
const installChanged =
  existingInstall.source !== 'path' ||
  existingInstall.sourcePath !== activePath ||
  existingInstall.installPath !== activePath ||
  existingInstall.version !== '0.2.4';

cfg.plugins.installs['crystal-memory'] = {
  source: 'path',
  sourcePath: activePath,
  installPath: activePath,
  version: '0.2.4',
  installedAt: installChanged
    ? new Date().toISOString()
    : (typeof existingInstall.installedAt === 'string' && existingInstall.installedAt
      ? existingInstall.installedAt
      : new Date().toISOString()),
};

const afterRaw = `${JSON.stringify(cfg, null, 2)}\n`;
const configChanged = beforeRaw !== afterRaw;
if (configChanged) {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, afterRaw);
}
for (const note of notes) {
  console.log(note);
}
console.log(`CONFIG_CHANGED=${configChanged ? 1 : 0}`);
NODE
)"
printf '%s\n' "$CONFIG_OUTPUT" | sed '/^CONFIG_CHANGED=/d'
CONFIG_CHANGED="$(printf '%s\n' "$CONFIG_OUTPUT" | awk -F= '/^CONFIG_CHANGED=/{print $2}' | tail -n1)"
if [ "$CONFIG_CHANGED" = "1" ]; then
  INSTALL_CHANGED=1
fi

if [ "$CONFIG_CHANGED" = "1" ]; then
  echo "  ✓ OpenClaw config updated"
else
  echo "  ✓ OpenClaw config already up to date"
fi

if [ "$INSTALL_CHANGED" != "1" ]; then
  echo ""
  echo "  ✓ No plugin or config changes detected"
  echo "  → Skipping gateway restart prompt"
  exit 0
fi

echo ""
echo "  → Restart OpenClaw gateway now? [Y/n]"
RESTART_CHOICE=""
if [ -r /dev/tty ]; then
  IFS= read -r RESTART_CHOICE < /dev/tty || true
fi

case "$RESTART_CHOICE" in
  ""|[Yy]|[Yy][Ee][Ss])
    echo "  → Restarting OpenClaw gateway..."
    if openclaw gateway restart; then
      echo "  ✓ OpenClaw gateway restarted"
      echo "  → Verifying Memory Crystal activation..."
      if ! verify_openclaw_install "$OPENCLAW_CONFIG"; then
        echo ""
        echo "  ✗ Memory Crystal installed, but verification failed."
        echo "    Check:"
        echo "    openclaw config get plugins.slots"
        echo "    openclaw plugins info crystal-memory"
        exit 1
      fi
    else
      echo "  ✗ Failed to restart gateway automatically."
      echo "    Run manually: openclaw gateway restart"
      exit 1
    fi
    ;;
  *)
    echo "  → Skipped restart. Run manually when ready:"
    echo "    openclaw gateway restart"
    echo "    openclaw config get plugins.slots"
    echo "    openclaw plugins info crystal-memory"
    ;;
esac

prompt_memory_import || true

echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  ◈  Memory Crystal is active!                       │"
echo "  │                                                     │"
echo "  │  Installed:                                         │"
echo "  │    $EXT_DIR"
echo "  │                                                     │"
echo "  │  View your memory:  https://memorycrystal.ai        │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""
