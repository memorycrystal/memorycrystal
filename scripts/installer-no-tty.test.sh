#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mc-installer-no-tty.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() { printf '[FAIL] %s\n' "$1" >&2; exit 1; }
pass() { printf '[ok] %s\n' "$1"; }

if ! command -v setsid >/dev/null 2>&1; then
  fail "setsid is required for no-controlling-terminal coverage"
fi
if setsid -w bash -c 'if { : </dev/tty; } 2>/dev/null; then exit 1; else exit 0; fi' < /dev/null; then
  :
else
  fail "setsid session retained a controlling terminal"
fi

# Source the shipped functions without invoking main, then run the exact
# post-admin-key provisioning chain against isolated files and a compose stub.
FUNCTIONS_FILE="$WORK/convex-local-up-functions.sh"
tail -n 1 "$ROOT/scripts/convex-local-up.sh" | grep -Fxq 'main "$@"' \
  || fail "local backend entrypoint changed; update this source fixture"
sed '$d' "$ROOT/scripts/convex-local-up.sh" > "$FUNCTIONS_FILE"
CHAIN_SCRIPT="$WORK/post-admin-key-chain.sh"
cat > "$CHAIN_SCRIPT" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$CONVEX_FUNCTIONS_FILE"
REPO_ROOT="$CONVEX_TEST_ROOT"
ENV_FILE="$CONVEX_TEST_ROOT/.env.local"
TEMPLATE_FILE="$CONVEX_TEST_ROOT/template"
compose() { printf '%s\n' 'convex-self-hosted|0123456789abcdef'; }
ADMIN_KEY="$(generate_admin_key_with_retry 2>/dev/null)"
export ADMIN_KEY
write_local_convex_env_file
resolve_backend_provider_keys
write_root_overlay "$ADMIN_KEY"
grep -Fxq 'CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|0123456789abcdef' "$ENV_FILE"
grep -Fxq "GEMINI_API_KEY=$CONVEX_EXPECTED_GEMINI_KEY" "$ENV_FILE"
if [[ -n "$CONVEX_EXPECTED_OPENROUTER_KEY" ]]; then
  grep -Fxq "OPENROUTER_API_KEY=$CONVEX_EXPECTED_OPENROUTER_KEY" "$ENV_FILE"
else
  ! grep -q '^OPENROUTER_API_KEY=' "$ENV_FILE"
fi
EOF
chmod +x "$CHAIN_SCRIPT"

run_backend_case() {
  local case_name="$1" gemini_key="$2" expected_gemini="$3" output status test_root
  test_root="$WORK/$case_name"
  mkdir -p "$test_root"
  if [[ -n "$gemini_key" ]]; then
    if output="$(env -u OPENROUTER_API_KEY -u GEMINI_API_KEY \
      CONVEX_FUNCTIONS_FILE="$FUNCTIONS_FILE" CONVEX_TEST_ROOT="$test_root" \
      CONVEX_EXPECTED_GEMINI_KEY="$expected_gemini" CONVEX_EXPECTED_OPENROUTER_KEY="" \
      GEMINI_API_KEY="$gemini_key" setsid -w bash "$CHAIN_SCRIPT" < /dev/null 2>&1)"; then
      status=0
    else
      status=$?
    fi
  else
    if output="$(env -u OPENROUTER_API_KEY -u GEMINI_API_KEY \
      CONVEX_FUNCTIONS_FILE="$FUNCTIONS_FILE" CONVEX_TEST_ROOT="$test_root" \
      CONVEX_EXPECTED_GEMINI_KEY="$expected_gemini" CONVEX_EXPECTED_OPENROUTER_KEY="" \
      setsid -w bash "$CHAIN_SCRIPT" < /dev/null 2>&1)"; then
      status=0
    else
      status=$?
    fi
  fi
  [[ "$status" -eq 0 ]] || fail "headless local backend chain failed for $case_name (exit $status)"
  [[ "$output" != *"No such device"* && "$output" != *"Input/output error"* \
    && "$output" != *"/dev/tty:"* ]] \
    || fail "headless local backend chain printed a raw terminal error"
  [[ -s "$test_root/.env.local" ]] || fail "headless local backend chain did not write its overlay for $case_name"
}

run_backend_case "gemini-present" "synthetic-gemini-test-key" "synthetic-gemini-test-key"
run_backend_case "both-keys-unset" "" "local-dev-gemini-stub"

# Requirement 2: an unhandled failure inside a function must name its step and
# keep its status instead of exiting silently. Without `set -E` the ERR trap is
# not inherited by functions, so this also pins errtrace. The EXIT cleanup must
# not add a second error line.
FAILING_STEP_SCRIPT="$WORK/failing-step.sh"
cat > "$FAILING_STEP_SCRIPT" <<'EOF'
#!/usr/bin/env bash
source "$CONVEX_FUNCTIONS_FILE"
failing_step() { false; echo "unreachable-after-failure"; }
failing_step
echo "unreachable-after-call"
EOF
if output="$(CONVEX_FUNCTIONS_FILE="$FUNCTIONS_FILE" setsid -w bash "$FAILING_STEP_SCRIPT" < /dev/null 2>&1)"; then
  status=0
else
  status=$?
fi
[[ "$status" -eq 1 ]] || fail "an unhandled failing step exited with $status, expected 1"
[[ "$output" == *"step failed with status 1: false"* ]] || fail "an unhandled failing step did not name itself"
[[ "$output" != *"unreachable"* ]] || fail "execution continued after an unhandled failure"
[[ "$(grep -c 'step failed with status' <<< "$output")" -eq 1 ]] || fail "an unhandled failure printed more than one error line"
pass "unhandled failures name the failing step exactly once and keep their status"

# The script's own fail helper (an explicit exit 1) prints its message once; the
# EXIT cleanup must not make the ERR trap add a second "step failed" line.
FAIL_HELPER_SCRIPT="$WORK/fail-helper.sh"
cat > "$FAIL_HELPER_SCRIPT" <<'EOF'
#!/usr/bin/env bash
source "$CONVEX_FUNCTIONS_FILE"
fail "synthetic failure"
EOF
if output="$(CONVEX_FUNCTIONS_FILE="$FUNCTIONS_FILE" setsid -w bash "$FAIL_HELPER_SCRIPT" < /dev/null 2>&1)"; then
  status=0
else
  status=$?
fi
[[ "$status" -eq 1 ]] || fail "the fail helper exited with $status, expected 1"
[[ "$output" == *"ERROR: synthetic failure"* ]] || fail "the fail helper did not print its message"
[[ "$output" != *"step failed with status"* ]] || fail "an explicit fail added a spurious step-failed line"
pass "an explicit fail prints one error and no spurious step-failed line"

# The real prompt remains connected to a controlling pseudo-terminal.
if command -v script >/dev/null 2>&1; then
  pty_root="$WORK/interactive"
  mkdir -p "$pty_root"
  if printf '%s\n' 'synthetic-openrouter-pty-test-key' | \
    env -u OPENROUTER_API_KEY -u GEMINI_API_KEY \
      CONVEX_FUNCTIONS_FILE="$FUNCTIONS_FILE" CONVEX_TEST_ROOT="$pty_root" \
      CONVEX_EXPECTED_GEMINI_KEY="synthetic-gemini-test-key" \
      CONVEX_EXPECTED_OPENROUTER_KEY="synthetic-openrouter-pty-test-key" \
      GEMINI_API_KEY="synthetic-gemini-test-key" \
      CONVEX_CHAIN_SCRIPT="$CHAIN_SCRIPT" \
      script -qec "bash \"\$CONVEX_CHAIN_SCRIPT\"" /dev/null >/dev/null 2>&1; then
    :
  else
    fail "interactive local backend prompt failed under a pseudo-terminal"
  fi
  [[ -s "$pty_root/.env.local" ]] || fail "interactive local backend prompt did not write its overlay"
  pass "headless and pseudo-terminal local backend prompts"
else
  pass "headless local backend prompts (pseudo-terminal coverage unavailable)"
fi

# Exercise each required manual-key path detached from a terminal. The curl
# and CLI shims prevent network access and keep the test independent of clients.
MOCK_BIN="$WORK/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$MOCK_BIN/curl"
for cli in claude codex droid openclaw; do
  cat > "$MOCK_BIN/$cli" <<EOF
#!/usr/bin/env bash
  printf '%s\\n' '${cli/openclaw/9999.1.1}'
EOF
  chmod +x "$MOCK_BIN/$cli"
done

check_manual_key_path() {
  local installer="$1" home_dir output status
  home_dir="$WORK/home-$RANDOM"
  mkdir -p "$home_dir"
  if output="$(env -u MEMORY_CRYSTAL_API_KEY -u CRYSTAL_CONVEX_URL \
    HOME="$home_dir" OPENCLAW_DIR="$home_dir/.openclaw" PATH="$MOCK_BIN:$PATH" \
    setsid -w bash "$ROOT/$installer" < /dev/null 2>&1)"; then
    status=0
  else
    status=$?
  fi
  [[ "$status" -ne 0 ]] || fail "a manual-key installer path unexpectedly succeeded without a terminal"
  [[ "$output" == *"MEMORY_CRYSTAL_API_KEY"* || "$output" == *"--api-key"* ]] \
    || fail "a manual-key installer path did not print actionable key guidance"
  [[ "$output" != *"No such device"* && "$output" != *"Input/output error"* \
    && "$output" != *"/dev/tty:"* ]] \
    || fail "a manual-key installer path printed a raw terminal error"
}

check_manual_key_path "apps/web/public/install-claude-mcp.sh"
check_manual_key_path "apps/web/public/install-codex-mcp.sh"
check_manual_key_path "apps/web/public/install-droid-mcp.sh"
check_manual_key_path "apps/web/public/install-openclaw-plugin.sh"
check_manual_key_path "scripts/install-openclaw.sh"

for installer in \
  apps/web/public/install-claude-mcp.sh \
  apps/web/public/install-codex-mcp.sh \
  apps/web/public/install-droid-mcp.sh \
  apps/web/public/install-openclaw-plugin.sh \
  scripts/install-openclaw.sh; do
  if grep -Fq -- '-r /dev/tty' "$ROOT/$installer"; then
    fail "a readability-only terminal guard remains"
  fi
done

pass "required installer key paths print actionable no-terminal guidance"

# The universal installer must also suppress failing /dev/tty opens and avoid
# offering browser recovery for a rejected key when no terminal is attached.
for key in '' synthetic-rejected-key; do
  home_dir="$WORK/universal-${key:-missing}"
  mkdir -p "$home_dir"
  if output="$(env -u CRYSTAL_CONVEX_URL \
    HOME="$home_dir" TMPDIR="$home_dir" XDG_CONFIG_HOME="$home_dir/.config" \
    MEMORY_CRYSTAL_HOME="$home_dir/.memorycrystal" OPENCLAW_DIR="$home_dir/.openclaw" \
    MEMORY_CRYSTAL_API_KEY="$key" PATH="$MOCK_BIN:$PATH" \
    setsid -w bash "$ROOT/apps/web/public/install.sh" --targets generic-mcp < /dev/null 2>&1)"; then
    status=0
  else
    status=$?
  fi
  [[ "$status" -ne 0 ]] || fail "universal installer accepted a missing or rejected key"
  if [[ -z "$key" ]]; then
    [[ "$output" == *"Pass the value as a flag/env var"* ]] || fail "missing key guidance absent: $output"
  else
    [[ "$output" == *"Check that your Memory Crystal API key is current"* ]] || fail "rejected key guidance absent: $output"
  fi
  [[ "$output" != *"/dev/tty:"* && "$output" != *"No such device"* && "$output" != *"Input/output error"* ]] \
    || fail "universal installer printed a raw terminal error"
  [[ "$output" != *"Starting browser sign-in"* && "$output" != *"Choose backend:"* ]] \
    || fail "universal installer offered an interactive flow without a terminal"
done
pass "universal installer missing and rejected keys have clean headless guidance"

# Default target discovery must keep terminal-open diagnostics out of headless output.
home_dir="$WORK/universal-discovery"
mkdir -p "$home_dir"
if output="$(env -u CRYSTAL_CONVEX_URL \
  HOME="$home_dir" TMPDIR="$home_dir" XDG_CONFIG_HOME="$home_dir/.config" \
  MEMORY_CRYSTAL_HOME="$home_dir/.memorycrystal" OPENCLAW_DIR="$home_dir/.openclaw" \
  MEMORY_CRYSTAL_API_KEY="" PATH="$MOCK_BIN:$PATH" \
  setsid -w bash "$ROOT/apps/web/public/install.sh" --dry-run < /dev/null 2>&1)"; then
  status=0
else
  status=$?
fi
[[ "$status" -eq 0 ]] || fail "headless target discovery dry-run failed (exit $status)"
[[ "$output" == *"Detected targets:"* ]] || fail "headless target discovery did not run"
[[ "$output" != *"/dev/tty:"* && "$output" != *"No such device"* && "$output" != *"Input/output error"* ]] \
  || fail "headless target discovery printed a raw terminal error"
pass "universal installer target discovery has clean headless dry-run output"
