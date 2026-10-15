#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"

run_step() {
  local description="$1"
  shift
  echo "==== ${description} ===="
  "$@"
}

run_step "Initialize and install dependencies" bash "$SCRIPT_DIR/crystal-init.sh"
run_step "Validate environment and integration prerequisites" bash "$SCRIPT_DIR/crystal-doctor.sh" --dry-run
run_step "Enable Memory Crystal plugin wiring" bash "$SCRIPT_DIR/crystal-enable.sh"
run_step "Verify final wiring" bash "$SCRIPT_DIR/crystal-doctor.sh"

cat <<'EOF'
Bootstrap complete.

From here:
- run `openclaw gateway restart` if you do not have the CLI configured for restart
  or if restart did not run automatically.
- test connectivity in OpenClaw and verify tools are available.
- optional: `npm run test:smoke`
EOF
