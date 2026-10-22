#!/usr/bin/env bash
# Test: lint Dockerfiles with hadolint
# Skips gracefully if hadolint is not installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

WEB_DOCKERFILE="${REPO_ROOT}/apps/web/Dockerfile.selfhosted"
MCP_DOCKERFILE="${REPO_ROOT}/mcp-server/Dockerfile"

echo "==> dockerfile.lint.test.sh"

if ! command -v hadolint &>/dev/null; then
  echo "    SKIP: hadolint not installed (brew install hadolint to enable)"
  exit 0
fi

FAILED=0

for df in "${WEB_DOCKERFILE}" "${MCP_DOCKERFILE}"; do
  echo "    Linting: ${df}"
  if hadolint "${df}"; then
    echo "    PASS: ${df}"
  else
    echo "    FAIL: ${df} has hadolint errors"
    FAILED=1
  fi
done

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi

echo "    All Dockerfile lints passed."
