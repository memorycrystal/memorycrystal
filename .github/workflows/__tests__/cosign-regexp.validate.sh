#!/usr/bin/env bash
# Test: statically validate that the cosign certificate-identity-regexp in
# publish-selfhosted-images.yml matches the one in scripts/bootstrap.sh.
#
# This prevents skew between what the CI workflow signs with and what
# bootstrap.sh verifies — a mismatch would cause supply-chain verification
# failures on all tenant installs.
#
# No external tools required — uses grep and Python 3.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

WORKFLOW="${REPO_ROOT}/.github/workflows/publish-selfhosted-images.yml"
BOOTSTRAP="${REPO_ROOT}/scripts/bootstrap.sh"

echo "==> cosign-regexp.validate.sh"
echo "    Workflow:  ${WORKFLOW}"
echo "    Bootstrap: ${BOOTSTRAP}"

# ── Extract COSIGN_IDENTITY_REGEXP from bootstrap.sh ───────────────────────
BOOTSTRAP_REGEXP=$(grep -E '^COSIGN_IDENTITY_REGEXP=' "${BOOTSTRAP}" \
  | head -1 \
  | sed 's/COSIGN_IDENTITY_REGEXP=//' \
  | tr -d '"'"'")

if [[ -z "$BOOTSTRAP_REGEXP" ]]; then
  echo "    FAIL: Could not extract COSIGN_IDENTITY_REGEXP from ${BOOTSTRAP}"
  exit 1
fi
echo "    bootstrap.sh regexp:  ${BOOTSTRAP_REGEXP}"

# ── Extract certificate-identity-regexp from workflow ──────────────────────
# The workflow uses the literal in the cosign verify command in the job summary
# and in the cosign sign step (implicitly via the OIDC cert identity).
# We validate the job summary verify command matches bootstrap.sh.
WORKFLOW_REGEXP=$(grep -oE "certificate-identity-regexp '[^']+'" "${WORKFLOW}" \
  | head -1 \
  | sed "s/certificate-identity-regexp '//;s/'$//")

if [[ -z "$WORKFLOW_REGEXP" ]]; then
  # Try double-quote variant
  WORKFLOW_REGEXP=$(grep -oE 'certificate-identity-regexp "[^"]+"' "${WORKFLOW}" \
    | head -1 \
    | sed 's/certificate-identity-regexp "//;s/"$//')
fi

if [[ -z "$WORKFLOW_REGEXP" ]]; then
  echo "    FAIL: Could not extract certificate-identity-regexp from ${WORKFLOW}"
  exit 1
fi
echo "    workflow regexp:      ${WORKFLOW_REGEXP}"

# ── Compare (normalise any shell escape differences) ───────────────────────
BOOTSTRAP_NORM=$(python3 -c "import sys; print(sys.argv[1])" "${BOOTSTRAP_REGEXP}")
WORKFLOW_NORM=$(python3 -c "import sys; print(sys.argv[1])" "${WORKFLOW_REGEXP}")

if [[ "$BOOTSTRAP_NORM" == "$WORKFLOW_NORM" ]]; then
  echo "    PASS: cosign certificate-identity-regexp matches between bootstrap.sh and workflow."
else
  echo "    FAIL: Mismatch detected!"
  echo "      bootstrap.sh: ${BOOTSTRAP_NORM}"
  echo "      workflow:     ${WORKFLOW_NORM}"
  echo ""
  echo "    Fix: update one of the two files so they match."
  echo "    Mismatch will cause 'cosign verify' to fail on tenant installs."
  exit 1
fi

# ── Also verify OIDC issuer matches ────────────────────────────────────────
BOOTSTRAP_ISSUER=$(grep -E '^COSIGN_OIDC_ISSUER=' "${BOOTSTRAP}" \
  | head -1 \
  | sed 's/COSIGN_OIDC_ISSUER=//' \
  | tr -d '"'"'")

WORKFLOW_ISSUER=$(grep -oE "certificate-oidc-issuer '[^']+'" "${WORKFLOW}" \
  | head -1 \
  | sed "s/certificate-oidc-issuer '//;s/'$//")

if [[ -z "$WORKFLOW_ISSUER" ]]; then
  WORKFLOW_ISSUER=$(grep -oE 'certificate-oidc-issuer "[^"]+"' "${WORKFLOW}" \
    | head -1 \
    | sed 's/certificate-oidc-issuer "//;s/"$//')
fi

echo "    bootstrap.sh issuer:  ${BOOTSTRAP_ISSUER}"
echo "    workflow issuer:      ${WORKFLOW_ISSUER}"

if [[ "$BOOTSTRAP_ISSUER" == "$WORKFLOW_ISSUER" ]]; then
  echo "    PASS: OIDC issuer matches."
else
  echo "    FAIL: OIDC issuer mismatch!"
  echo "      bootstrap.sh: ${BOOTSTRAP_ISSUER}"
  echo "      workflow:     ${WORKFLOW_ISSUER}"
  exit 1
fi

echo ""
echo "    All cosign supply-chain checks passed."
