#!/usr/bin/env bash
# Memory Crystal — Self-Hosted Bootstrap Installer
#
# Usage:
#   MC_VERSION=v1.0.0 \
#   MC_TENANT_SLUG=your-slug \
#   MC_TUNNEL_TOKEN=<from signup> \
#   MC_BOOTSTRAP_TOKEN=<from signup> \
#   bash bootstrap.sh
#
# Set MC_BOOTSTRAP_DRY_RUN=1 to validate env/pre-flights without running docker.
#
# Docs: https://memorycrystal.ai/docs/self-hosted
# Troubleshooting: https://memorycrystal.ai/docs/troubleshooting

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DOCS_URL="https://memorycrystal.ai/docs/self-hosted"
TROUBLESHOOT_URL="https://memorycrystal.ai/docs/troubleshooting"
COMPOSE_FILE="infra/selfhosted/docker-compose.yml"

COSIGN_VERSION="2.2.4"
COSIGN_URL="https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-darwin-arm64"
# sha256 of cosign-darwin-arm64 v2.2.4 — verify at https://github.com/sigstore/cosign/releases
COSIGN_SHA256="c41494040fd3f2f50bb90f31b567ab7b77a1e0f33fad1e2b67d94462e2df00ba"

COSIGN_OIDC_ISSUER="https://token.actions.githubusercontent.com"
COSIGN_IDENTITY_REGEXP="^https://github\\.com/memorycrystal/.+$"

HEALTHCHECK_TIMEOUT=180  # seconds; matches AC1 cold-cache budget

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() {
  red "ERROR: $*"
  echo "  See: ${TROUBLESHOOT_URL}"
  exit 1
}

info() { printf '  %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Step 1 — Validate required env vars
# ---------------------------------------------------------------------------
bold "==> Validating environment..."

missing=()
for var in MC_VERSION MC_TENANT_SLUG MC_TUNNEL_TOKEN MC_BOOTSTRAP_TOKEN; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  red "ERROR: The following required environment variables are not set:"
  for v in "${missing[@]}"; do
    info "  - $v"
  done
  echo ""
  echo "  All four variables are issued during signup at memorycrystal.ai."
  echo "  See the onboarding screen or: ${DOCS_URL}"
  exit 1
fi

info "MC_VERSION      = ${MC_VERSION}"
info "MC_TENANT_SLUG  = ${MC_TENANT_SLUG}"
info "MC_TUNNEL_TOKEN = [set]"
info "MC_BOOTSTRAP_TOKEN = [set]"
green "Environment OK."

# ---------------------------------------------------------------------------
# Early exit for dry-run mode (used by test suite — skips all docker/platform
# checks so tests can run safely in CI without Docker or arm64 hardware)
# ---------------------------------------------------------------------------
if [[ "${MC_BOOTSTRAP_DRY_RUN:-0}" == "1" ]]; then
  green "DRY RUN: env validation passed. Skipping pre-flight, cosign, and docker compose up."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2 — Pre-flight checks
# ---------------------------------------------------------------------------
bold "==> Running pre-flight checks..."

# Docker
if ! command -v docker &>/dev/null; then
  die "docker not found. Install Docker Desktop from https://docs.docker.com/desktop/mac/install/"
fi
info "$(docker --version)"

# Docker Compose (v2 plugin)
if ! docker compose version &>/dev/null; then
  die "docker compose (v2 plugin) not found. Update Docker Desktop to 4.x or later."
fi
info "$(docker compose version)"

# Platform — cosign download is Mac arm64 only in v1
arch="$(uname -m)"
os="$(uname -s)"
if [[ "$os" != "Darwin" || "$arch" != "arm64" ]]; then
  die "bootstrap.sh v1 supports macOS arm64 (Apple Silicon) only.
  For x86_64 or Linux, see: ${DOCS_URL}#platforms"
fi
info "Platform: ${os} ${arch} — OK"

# Disk space (≥4 GB free)
free_bytes="$(df -k . | awk 'NR==2 {print $4}')"
free_gb=$(( free_bytes / 1024 / 1024 ))
if [[ $free_gb -lt 4 ]]; then
  die "Insufficient disk space: ${free_gb} GB free, need at least 4 GB."
fi
info "Disk: ${free_gb} GB free — OK"

# RAM (≥4 GB total — best effort; sysctl may not be available on all macOS)
if command -v sysctl &>/dev/null; then
  total_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  total_gb=$(( total_bytes / 1024 / 1024 / 1024 ))
  if [[ $total_gb -lt 4 ]]; then
    die "Insufficient RAM: ${total_gb} GB total, need at least 4 GB."
  fi
  info "RAM: ${total_gb} GB total — OK"
fi

green "Pre-flight checks passed."

# ---------------------------------------------------------------------------
# Step 3 — Install cosign (if not already present)
# ---------------------------------------------------------------------------
bold "==> Checking cosign..."

if command -v cosign &>/dev/null; then
  info "cosign already installed: $(cosign version 2>/dev/null | head -1 || echo 'version unknown')"
else
  info "Installing cosign ${COSIGN_VERSION} for macOS arm64..."
  info "Source: ${COSIGN_URL}"

  curl -sSL "${COSIGN_URL}" -o /tmp/cosign-mc-install
  actual_sha="$(shasum -a 256 /tmp/cosign-mc-install | awk '{print $1}')"

  if [[ "$actual_sha" != "$COSIGN_SHA256" ]]; then
    rm -f /tmp/cosign-mc-install
    die "cosign sha256 mismatch!
  Expected: ${COSIGN_SHA256}
  Got:      ${actual_sha}
  Do not proceed — download may be tampered. See: ${DOCS_URL}#security"
  fi

  install /tmp/cosign-mc-install /usr/local/bin/cosign
  rm -f /tmp/cosign-mc-install
  green "cosign installed to /usr/local/bin/cosign"
fi

# ---------------------------------------------------------------------------
# Step 4 — Verify image signatures with cosign
# ---------------------------------------------------------------------------
bold "==> Verifying image signatures..."

WEB_IMAGE="ghcr.io/memorycrystal/web-selfhosted:${MC_VERSION}"
MCP_IMAGE="ghcr.io/memorycrystal/mcp:${MC_VERSION}"

for img in "${WEB_IMAGE}" "${MCP_IMAGE}"; do
  info "Verifying: ${img}"
  if ! cosign verify \
      --certificate-identity-regexp "${COSIGN_IDENTITY_REGEXP}" \
      --certificate-oidc-issuer "${COSIGN_OIDC_ISSUER}" \
      "${img}"; then
    die "cosign verification failed for ${img}
  This image may not be published by memorycrystal/. Do not proceed.
  Supply-chain security docs: https://memorycrystal.ai/docs/security/supply-chain"
  fi
  green "Verified: ${img}"
done

# ---------------------------------------------------------------------------
# Step 5 — Write .env (never persists the cleartext bootstrap token)
# ---------------------------------------------------------------------------
bold "==> Writing infra/selfhosted/.env..."

cat > infra/selfhosted/.env <<ENV
# Memory Crystal self-hosted — generated by bootstrap.sh
# Do not commit this file.
MC_VERSION=${MC_VERSION}
MC_TENANT_SLUG=${MC_TENANT_SLUG}
MC_TUNNEL_TOKEN=${MC_TUNNEL_TOKEN}
# MC_BOOTSTRAP_TOKEN is intentionally not persisted here.
# It was consumed on first boot and is now invalid.
ENV

green ".env written (bootstrap token not persisted)."

# ---------------------------------------------------------------------------
# Step 6 — Pull images and start the stack
# ---------------------------------------------------------------------------
bold "==> Pulling images..."
docker compose -f "${COMPOSE_FILE}" pull

bold "==> Starting stack..."
# MC_BOOTSTRAP_TOKEN is passed via env only (not in .env) so it's available
# to the web container on first boot but not stored on disk.
MC_BOOTSTRAP_TOKEN="${MC_BOOTSTRAP_TOKEN}" \
  docker compose -f "${COMPOSE_FILE}" up -d

# ---------------------------------------------------------------------------
# Step 7 — Poll healthchecks (≤180s)
# ---------------------------------------------------------------------------
bold "==> Waiting for all services to become healthy (up to ${HEALTHCHECK_TIMEOUT}s)..."

services=(backend fallback cloudflared web mcp)
deadline=$(( $(date +%s) + HEALTHCHECK_TIMEOUT ))

while true; do
  all_healthy=true

  for svc in "${services[@]}"; do
    status="$(docker compose -f "${COMPOSE_FILE}" ps --format json "${svc}" 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health','unknown') if isinstance(d,dict) else [x.get('Health','unknown') for x in d][0])" 2>/dev/null \
      || echo "unknown")"

    if [[ "$status" != "healthy" ]]; then
      all_healthy=false
      info "${svc}: ${status}"
    fi
  done

  if $all_healthy; then
    break
  fi

  if [[ $(date +%s) -ge $deadline ]]; then
    yellow "Healthcheck timeout after ${HEALTHCHECK_TIMEOUT}s. Tearing down..."
    docker compose -f "${COMPOSE_FILE}" down
    die "Stack failed to become healthy within ${HEALTHCHECK_TIMEOUT}s.
  Check logs with: docker compose -f ${COMPOSE_FILE} logs
  Troubleshooting: ${TROUBLESHOOT_URL}"
  fi

  sleep 5
done

# ---------------------------------------------------------------------------
# Step 8 — Success
# ---------------------------------------------------------------------------
green ""
green "============================================================"
green " Memory Crystal is running!"
green "============================================================"
echo ""
info "Tunnel URL:    https://${MC_TENANT_SLUG}.tunnels.memorycrystal.ai"
info "Dashboard:     http://localhost:6791"
info "Issue API key: https://memorycrystal.ai/dashboard/${MC_TENANT_SLUG}/keys"
echo ""
info "To check status:  docker compose -f ${COMPOSE_FILE} ps"
info "To view logs:     docker compose -f ${COMPOSE_FILE} logs -f"
info "To stop:          docker compose -f ${COMPOSE_FILE} down"
echo ""
green "Setup complete."
