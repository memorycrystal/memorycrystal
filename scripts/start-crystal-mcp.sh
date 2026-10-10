#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR%/scripts}/mcp-server"
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
exec node dist/index.js
