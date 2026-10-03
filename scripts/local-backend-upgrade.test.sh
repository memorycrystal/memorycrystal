#!/usr/bin/env bash
# Local-backend upgrade test (ILL-336, ILL-350, ILL-374, ILL-384): defaults to 0.9.1 -> 0.9.3.
# Runs real historical/current installers against committed archives and a
# local mock origin. Existing and fresh identities must survive re-runs.
#
# Default mode stubs Docker and asserts identity + artifact staging only.
# --docker deploys both versions and recalls a canary with the original token.
# Requires a Docker daemon and free ports 3210/3211/6791; uses no real keys.
#
# Usage: bash scripts/local-backend-upgrade.test.sh [--docker] [--keep]
#   --assert-provider-key-scope checks the per-leg key contract without Docker.
#   CRYSTAL_TEST_OLD_VERSION / CRYSTAL_TEST_NEW_VERSION override the pair.
#   CRYSTAL_TEST_OLD_ARCHIVE / CRYSTAL_TEST_NEW_ARCHIVE override archive paths.
#   CRYSTAL_TEST_OLD_INSTALLER_REF overrides the pinned 0.9.0 installer commit.
# For legacy version-bound coverage use OLD_VERSION=0.8.22 with an installer
# ref before ILL-336; the legacy seed assertion and rotation check still run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCKER_MODE=0
KEEP=0
ASSERT_PROVIDER_KEY_SCOPE=0
for arg in "$@"; do
  case "$arg" in
    --docker) DOCKER_MODE=1 ;;
    --keep) KEEP=1 ;;
    --assert-provider-key-scope) ASSERT_PROVIDER_KEY_SCOPE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

OLD_VERSION="${CRYSTAL_TEST_OLD_VERSION:-0.9.1}"
NEW_VERSION="${CRYSTAL_TEST_NEW_VERSION:-0.9.3}"
ASSETS_DIR="apps/web/public/install-assets/local-backend"
OLD_ARCHIVE="${CRYSTAL_TEST_OLD_ARCHIVE:-$ASSETS_DIR/memorycrystal-local-backend-$OLD_VERSION.tar.gz}"
NEW_ARCHIVE="${CRYSTAL_TEST_NEW_ARCHIVE:-$ASSETS_DIR/memorycrystal-local-backend-$NEW_VERSION.tar.gz}"
OLD_INSTALLER_REF="${CRYSTAL_TEST_OLD_INSTALLER_REF:-08fbe0d0ff8e9dadf45d71673eacd8ac02d589ea}"
API_KEY="mc_upgrade_test_hosted_key_$$"

for cmd in bash curl tar node git shasum; do
  command -v "$cmd" >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || { echo "missing required tool: $cmd" >&2; exit 2; }
done
[[ -f "$OLD_ARCHIVE" ]] || { echo "old archive not found: $OLD_ARCHIVE" >&2; exit 2; }
[[ -f "$NEW_ARCHIVE" ]] || { echo "new archive not found: $NEW_ARCHIVE" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mc-upgrade-test.XXXXXX")"
SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" >/dev/null 2>&1 || true
  if [[ "$DOCKER_MODE" = "1" && "$KEEP" != "1" ]]; then
    for v in "$NEW_VERSION" "$OLD_VERSION"; do
      [[ -x "$HOME_A/.memorycrystal/local-backend/$v/bin/down" ]] && (cd "$HOME_A/.memorycrystal/local-backend/$v" && bash bin/down >/dev/null 2>&1 || true) && break
    done
  fi
  [[ "$KEEP" = "1" ]] && { echo "kept: $WORK"; return; }
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf '  [ok] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*" >&2; exit 1; }
json_field() { node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]];process.stdout.write(v===undefined||v===null?"":String(v));' "$1" "$2"; }
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

# ── Fixtures ─────────────────────────────────────────────────────────────────
SITE="$WORK/site"
mkdir -p "$SITE/install-assets/local-backend"
cp "$OLD_ARCHIVE" "$SITE/install-assets/local-backend/memorycrystal-local-backend-$OLD_VERSION.tar.gz"
cp "$NEW_ARCHIVE" "$SITE/install-assets/local-backend/memorycrystal-local-backend-$NEW_VERSION.tar.gz"
cp apps/web/public/install-assets/platforms.json "$SITE/install-assets/platforms.json"
echo "  old archive sha256: $(sha256_file "$SITE/install-assets/local-backend/memorycrystal-local-backend-$OLD_VERSION.tar.gz")"
echo "  new archive sha256: $(sha256_file "$SITE/install-assets/local-backend/memorycrystal-local-backend-$NEW_VERSION.tar.gz")"

OLD_INSTALLER="$WORK/install-$OLD_VERSION.sh"
git show "$OLD_INSTALLER_REF:apps/web/public/install.sh" > "$OLD_INSTALLER"
chmod +x "$OLD_INSTALLER"
case "$OLD_VERSION" in
  0.8.*)
    grep -Fq 'seed="${API_KEY:-dry-run}:$LOCAL_BACKEND_VERSION:memory-crystal-local"' "$OLD_INSTALLER" \
      || fail "historical legacy installer must carry the version-bound seed"
    ;;
  *)
    grep -Fq 'seed="${API_KEY:-dry-run}:memory-crystal-local"' "$OLD_INSTALLER" \
      || fail "historical installer must carry the version-free seed"
    ;;
esac
NEW_INSTALLER="$REPO_ROOT/apps/web/public/install.sh"

# ── Mock hosted origin ───────────────────────────────────────────────────────
PORT_FILE="$WORK/port"
node - "$SITE" "$API_KEY" "$PORT_FILE" <<'NODE' &
const http = require("http");
const fs = require("fs");
const path = require("path");
const [site, apiKey, portFile] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/mcp/auth") {
    const ok = req.headers.authorization === `Bearer ${apiKey}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, userId: "hosted_user_test" } : { error: "unauthorized" }));
    return;
  }
  const file = path.join(site, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (file.startsWith(site) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404); res.end("not found");
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
NODE
SERVER_PID=$!
for _ in $(seq 1 50); do [[ -s "$PORT_FILE" ]] && break; sleep 0.1; done
[[ -s "$PORT_FILE" ]] || fail "mock server did not start"
MOCK="http://127.0.0.1:$(cat "$PORT_FILE")"
curl -fsS -o /dev/null -w '' -H "Authorization: Bearer $API_KEY" "$MOCK/api/mcp/auth" || fail "mock auth endpoint not reachable"

# ── PATH shims: curl origin rewrite, and a failing docker in no-Docker mode ──
SHIMS="$WORK/shims"
mkdir -p "$SHIMS"
REAL_CURL="$(command -v curl)"
cat > "$SHIMS/curl" <<EOF
#!/usr/bin/env bash
args=()
for a in "\$@"; do args+=("\${a//https:\/\/convex.memorycrystal.ai/$MOCK}"); done
exec "$REAL_CURL" "\${args[@]}"
EOF
chmod +x "$SHIMS/curl"
if [[ "$DOCKER_MODE" != "1" ]]; then
  printf '#!/usr/bin/env bash\necho "docker unavailable (upgrade test stub)" >&2\nexit 1\n' > "$SHIMS/docker"
  chmod +x "$SHIMS/docker"
fi

run_installer() {
  local installer="$1" test_home="$2" version="$3" log="$4"
  shift 4
  local provider_key_mode="inherit"
  local assert_no_provider_key_files=0
  local -a installer_args=()
  for arg in "$@"; do
    case "$arg" in
      --without-provider-keys) provider_key_mode="unset" ;;
      --require-provider-keys) provider_key_mode="required" ;;
      --assert-no-provider-key-files) assert_no_provider_key_files=1 ;;
      *) installer_args+=("$arg") ;;
    esac
  done
  if [[ "$assert_no_provider_key_files" = "1" ]]; then
    local package_root="$test_home/.memorycrystal/local-backend/$version"
    [[ ! -e "$package_root/.env.local" && ! -e "$package_root/.env" ]] \
      || fail "$version package root has a provider-key fallback file before installer run"
  fi
  local args=(--backend local --yes --api-key "$API_KEY" --targets generic-mcp --local-backend-version "$version" "${installer_args[@]}")
  [[ "$DOCKER_MODE" = "1" ]] || args+=(--allow-incomplete-local)
  local -a env_args=()
  if [[ "$provider_key_mode" == "unset" ]]; then
    env_args+=(-u GEMINI_API_KEY -u OPENROUTER_API_KEY)
  fi
  local env_guard='if [[ "$PROVIDER_KEY_MODE" == unset ]]; then
  [[ ! -v GEMINI_API_KEY && ! -v OPENROUTER_API_KEY ]] || { echo "provider keys leaked into a keyless installer leg" >&2; exit 97; }
elif [[ "$PROVIDER_KEY_MODE" == required ]]; then
  [[ -n "${GEMINI_API_KEY:-}" && -n "${OPENROUTER_API_KEY:-}" ]] || { echo "required provider keys missing from the old-version installer leg" >&2; exit 98; }
fi
exec bash "$@"'
  env "${env_args[@]}" \
    HOME="$test_home" MEMORY_CRYSTAL_HOME="$test_home/.memorycrystal" CRYSTAL_INSTALL_BASE="$MOCK" CRYSTAL_PLATFORMS_TABLE="$SITE/install-assets/platforms.json" \
    PATH="$SHIMS:$PATH" PROVIDER_KEY_MODE="$provider_key_mode" \
    bash -c "$env_guard" local-backend-provider-key-guard "$installer" "${args[@]}" \
    > "$log" 2>&1 || { cat "$log"; fail "installer exited non-zero ($installer @ $version)"; }
  case "$provider_key_mode" in
    unset) pass "$version installer environment has both provider keys unset" ;;
    required) pass "$version historical installer environment has both provider keys" ;;
  esac
  [[ "$assert_no_provider_key_files" = "0" ]] || pass "$version package root has no provider-key fallback files"
}

assert_log() { grep -q -- "$2" "$1" || { cat "$1"; fail "log missing: $2"; }; }

# ── Scenario A: historical stack upgrades to the new version ──────────────
HOME_A="$WORK/home-a"
mkdir -p "$HOME_A"
echo "== A1: historical installer ($OLD_INSTALLER_REF) at $OLD_VERSION"
if [[ "$DOCKER_MODE" = "1" || "$ASSERT_PROVIDER_KEY_SCOPE" = "1" ]]; then
  [[ -n "${GEMINI_API_KEY:-}" && -n "${OPENROUTER_API_KEY:-}" ]] || fail "A1 requires both provider keys in Docker/scope-check mode"
  run_installer "$OLD_INSTALLER" "$HOME_A" "$OLD_VERSION" "$WORK/a1.log" --require-provider-keys
else
  run_installer "$OLD_INSTALLER" "$HOME_A" "$OLD_VERSION" "$WORK/a1.log"
fi
assert_log "$WORK/a1.log" "memorycrystal-local-backend-$OLD_VERSION.tar.gz"
assert_log "$WORK/a1.log" "unpacked to $HOME_A/.memorycrystal/local-backend/$OLD_VERSION"
AUTH="$HOME_A/.memorycrystal/local-auth.json"
[[ -f "$AUTH" ]] || fail "run A1 did not write local-auth.json"
A1_USER="$(json_field "$AUTH" userId)"; A1_TOKEN="$(json_field "$AUTH" localToken)"; A1_BYTES="$(sha256_file "$AUTH")"
[[ -n "$A1_USER" && -n "$A1_TOKEN" ]] || fail "run A1 identity is empty"
pass "A1 provisioned local user $A1_USER at $OLD_VERSION (old installer)"

# The historical seed contract is checked across two fresh installs too.
# Staging only: a second live stack must not interfere with the canary stack.
HOME_OBS="$WORK/home-obs"; mkdir -p "$HOME_OBS"
OBS_DOCKER_MODE="$DOCKER_MODE"
DOCKER_MODE=0
# Force the observation down the staging path even on a Docker-capable host.
mkdir -p "$WORK/observation-shims"
printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/observation-shims/docker"
chmod +x "$WORK/observation-shims/docker"
PATH="$WORK/observation-shims:$PATH" run_installer "$OLD_INSTALLER" "$HOME_OBS" "$NEW_VERSION" "$WORK/obs.log"
DOCKER_MODE="$OBS_DOCKER_MODE"
OBS_USER="$(json_field "$HOME_OBS/.memorycrystal/local-auth.json" userId)"
case "$OLD_VERSION" in
  0.8.*)
    [[ -n "$OBS_USER" && "$OBS_USER" != "$A1_USER" ]] || fail "legacy installer did not demonstrate version-bound identity"
    pass "historical legacy installer rotates identity across versions"
    ;;
  *)
    [[ "$OBS_USER" == "$A1_USER" ]] || fail "historical version-free identity changed across versions"
    pass "historical version-free identity agrees across versions"
    ;;
esac

if [[ "$DOCKER_MODE" = "1" ]]; then
  echo "== A1 (docker): capture a memory on the $OLD_VERSION stack with the kept token"
  CAPTURE="$(curl -fsS -X POST http://127.0.0.1:3211/api/mcp/capture -H "Authorization: Bearer $A1_TOKEN" -H 'Content-Type: application/json' \
    --data '{"title":"Upgrade canary","content":"The local backend keeps the upgrade canary across backend releases.","store":"semantic","category":"fact","tags":["upgrade-test"]}')"
  printf '%s' "$CAPTURE" | grep -q '"id"' || fail "capture on $OLD_VERSION failed: $CAPTURE"
  pass "seeded a memory under $A1_USER on $OLD_VERSION"
fi

echo "== A2: working-tree installer at $NEW_VERSION (upgrade)"
run_installer "$NEW_INSTALLER" "$HOME_A" "$NEW_VERSION" "$WORK/a2.log" --without-provider-keys --assert-no-provider-key-files
assert_log "$WORK/a2.log" "memorycrystal-local-backend-$NEW_VERSION.tar.gz"
assert_log "$WORK/a2.log" "unpacked to $HOME_A/.memorycrystal/local-backend/$NEW_VERSION"
assert_log "$WORK/a2.log" "Kept existing local credential bridge"
[[ "$(json_field "$AUTH" userId)" == "$A1_USER" ]] || fail "userId changed on upgrade"
[[ "$(json_field "$AUTH" localToken)" == "$A1_TOKEN" ]] || fail "localToken changed on upgrade"
[[ "$(sha256_file "$AUTH")" == "$A1_BYTES" ]] || fail "local-auth.json bytes changed on upgrade"
[[ -x "$HOME_A/.memorycrystal/local-backend/$NEW_VERSION/bin/doctor" ]] || fail "$NEW_VERSION bin/doctor missing or not executable"
[[ -x "$HOME_A/.memorycrystal/local-backend/$NEW_VERSION/bin/install" ]] || fail "$NEW_VERSION bin/install missing or not executable"
[[ -d "$HOME_A/.memorycrystal/local-backend/$OLD_VERSION" ]] || fail "$OLD_VERSION directory was removed"
[[ "$(json_field "$HOME_A/.memorycrystal/local-backend/$NEW_VERSION/manifest.json" version)" == "$NEW_VERSION" ]] || fail "unpacked manifest is not $NEW_VERSION"
tar -xOf "$NEW_ARCHIVE" "memorycrystal-local-backend-$NEW_VERSION/manifest.json" > "$WORK/expected-manifest.json"
cmp "$WORK/expected-manifest.json" "$HOME_A/.memorycrystal/local-backend/$NEW_VERSION/manifest.json" \
  || fail "staged manifest differs from the archive"
pass "A2 upgrade kept userId $A1_USER and its token; $NEW_VERSION artifact unpacked next to $OLD_VERSION"
if [[ "$DOCKER_MODE" = "1" ]]; then
  assert_log "$WORK/a2.log" "No Gemini API key provided; using local stub"
fi

if [[ "$DOCKER_MODE" = "1" ]]; then
  echo "== A2 (docker): recall with the kept token on the $NEW_VERSION stack"
  RECALL="$(curl -fsS -X POST http://127.0.0.1:3211/api/mcp/recall -H "Authorization: Bearer $A1_TOKEN" -H 'Content-Type: application/json' \
    --data '{"query":"upgrade canary across backend releases","limit":5}')"
  printf '%s' "$RECALL" | grep -q "Upgrade canary" || fail "seeded memory not recallable after upgrade: $RECALL"
  pass "seeded memory recalled after the upgrade with the kept token"
fi

echo "== A3: re-run at $NEW_VERSION"
NEW_BACKEND_ROOT="$HOME_A/.memorycrystal/local-backend/$NEW_VERSION"
rm -f "$NEW_BACKEND_ROOT/.env.local" "$NEW_BACKEND_ROOT/.env"
run_installer "$NEW_INSTALLER" "$HOME_A" "$NEW_VERSION" "$WORK/a3.log" --without-provider-keys --assert-no-provider-key-files
assert_log "$WORK/a3.log" "Local backend artifact already present"
assert_log "$WORK/a3.log" "Kept existing local credential bridge"
[[ "$(sha256_file "$AUTH")" == "$A1_BYTES" ]] || fail "local-auth.json bytes changed on re-run"
pass "A3 re-run kept the identity byte-for-byte"

# ── Scenario B: fresh new-version install, re-run ─────────────────────────────────
HOME_B="$WORK/home-b"; mkdir -p "$HOME_B"
echo "== B1/B2: fresh $NEW_VERSION install, then re-run"
run_installer "$NEW_INSTALLER" "$HOME_B" "$NEW_VERSION" "$WORK/b1.log" --without-provider-keys
B_AUTH="$HOME_B/.memorycrystal/local-auth.json"
B1_BYTES="$(sha256_file "$B_AUTH")"; B1_USER="$(json_field "$B_AUTH" userId)"
run_installer "$NEW_INSTALLER" "$HOME_B" "$NEW_VERSION" "$WORK/b2.log" --without-provider-keys
[[ "$(sha256_file "$B_AUTH")" == "$B1_BYTES" ]] || fail "fresh install identity changed on re-run"
# New identities derive from the API key only: the same key yields the same user at any version.
EXPECTED_USER="local_$(printf '%s' "user:$API_KEY:memory-crystal-local" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | awk '{print $1}' | cut -c1-24)"
[[ "$B1_USER" == "$EXPECTED_USER" ]] || fail "fresh identity is not the API-key-only derivation ($B1_USER vs $EXPECTED_USER)"
pass "B fresh install is stable across re-runs and derives from the API key only ($B1_USER)"

echo ""
if [[ "$DOCKER_MODE" = "1" ]]; then
  echo "Local-backend upgrade test PASSED (mode: docker; seeded memory recalled after upgrade)."
else
  echo "Local-backend upgrade test PASSED (mode: no-docker; identity + artifact staging only, no backend deploy)."
fi
