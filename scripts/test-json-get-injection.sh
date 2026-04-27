#!/usr/bin/env bash
# Adversarial test for json_get $key shell injection (15h review US-2).
#
# Strategy: feed a key crafted to escape the inline -c heredoc quoting
# (e.g. one containing single quotes, semicolons, backslashes, and an
# attempt to touch a sentinel file). If the sanitized json_get is correct
# the sentinel file MUST NOT exist after the call.
#
# We extract the json_get + _detect_json_tool block from each installer
# rather than sourcing the whole installer (which would execute the rest
# of the installer flow).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=(
  "$REPO_ROOT/apps/web/public/install-claude-mcp.sh"
  "$REPO_ROOT/apps/web/public/install-openclaw-plugin.sh"
)

TMP_DIR="$(mktemp -d -t json-get-injection.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

CANARY="$TMP_DIR/PWNED"

# Several malicious keys: classic single-quote escape, semicolon command
# injection, backslash escape, and command-substitution.
MALICIOUS_KEYS=(
  "k'\$(touch '$CANARY');'"
  "k\"; require('child_process').execSync('touch $CANARY'); //"
  "k'); import os; os.system('touch $CANARY'); ('"
  "k\\\";process.mainModule.require('child_process').execSync('touch $CANARY');//"
  "'); __import__('os').system('touch $CANARY'); ('"
)

# Extract just the JSON helper block: _CRYSTAL_JSON_TOOL var + the
# _detect_json_tool() function + the json_get() function + the call to
# _detect_json_tool. Stop before any non-helper code by tracking braces.
extract_helpers() {
  local src="$1" dest="$2"
  python3 - "$src" "$dest" <<'PY'
import re, sys
src, dest = sys.argv[1], sys.argv[2]
text = open(src).read()
# Grab from `_CRYSTAL_JSON_TOOL=""` to the line after `json_get() { ... }`
m = re.search(
    r'(_CRYSTAL_JSON_TOOL=""\s*\n.*?\njson_get\(\) \{.*?\n\}\s*\n)',
    text, re.DOTALL)
if not m:
    sys.exit("could not extract helpers from " + src)
out = m.group(1) + "\n_detect_json_tool\njson_get \"$1\"\n"
open(dest, "w").write(out)
PY
}

failures=0
for target in "${TARGETS[@]}"; do
  helper="$TMP_DIR/$(basename "$target").helper.sh"
  extract_helpers "$target" "$helper"
  echo "  [test] $target"
  for key in "${MALICIOUS_KEYS[@]}"; do
    rm -f "$CANARY"
    out=$(printf '%s' '{"k": "value"}' | bash "$helper" "$key" 2>/dev/null || true)
    if [ -e "$CANARY" ]; then
      echo "    [FAIL] sentinel file was created with key: $key"
      failures=$((failures + 1))
      rm -f "$CANARY"
    else
      printf '    [ok] safe for key=%q (out=%q)\n' "$key" "$out"
    fi
  done
done

if [ "$failures" -gt 0 ]; then
  echo "  [err] $failures injection(s) succeeded"
  exit 1
fi
echo "  [ok] all json_get adversarial probes failed safely"
