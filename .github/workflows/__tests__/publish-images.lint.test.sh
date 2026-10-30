#!/usr/bin/env bash
# Test: lint publish-selfhosted-images.yml with actionlint
# Skips gracefully if actionlint is not installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/publish-selfhosted-images.yml"

echo "==> publish-images.lint.test.sh"
echo "    Workflow: ${WORKFLOW}"

if ! command -v actionlint &>/dev/null; then
  echo "    SKIP: actionlint not installed (brew install actionlint to enable)"
  exit 0
fi

echo "    Running actionlint..."
if actionlint "${WORKFLOW}"; then
  echo "    PASS: publish-selfhosted-images.yml passes actionlint"
else
  echo "    FAIL: publish-selfhosted-images.yml has actionlint errors"
  exit 1
fi
