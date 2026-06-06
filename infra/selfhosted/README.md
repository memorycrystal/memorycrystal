# Memory Crystal — Self-Hosted Docker Bundle

This directory contains the Docker Compose bundle, Caddy fallback configuration, and documentation for running the Memory Crystal self-hosted stack.

## What this bundle is

The self-hosted bundle runs the full Memory Crystal stack on your own Mac:

| Service | Purpose | Image |
|---------|---------|-------|
| `backend` | Convex self-hosted backend | `ghcr.io/get-convex/convex-backend` (pinned digest) |
| `dashboard` | Convex admin dashboard on `:6791` | `ghcr.io/get-convex/convex-dashboard` (pinned digest) |
| `web` | Memory Crystal Next.js app | `ghcr.io/memorycrystal/web-selfhosted:${MC_VERSION}` |
| `mcp` | MCP HTTP server on `:8788` | `ghcr.io/memorycrystal/mcp:${MC_VERSION}` |
| `fallback` | Tier-1 structured-503 responder | `caddy:2-alpine` (≤16 MB compressed) |
| `cloudflared` | Cloudflare tunnel sidecar | `cloudflare/cloudflared:latest` |

The `cloudflared` sidecar creates a permanent named tunnel so your stack is reachable at `https://{slug}.tunnels.memorycrystal.ai` from any machine, even behind NAT, without port-forwarding.

**Memory content never leaves your machine.** Only anonymous telemetry (memory counts, version, last-seen timestamp) is sent to the cloud.

## Required environment variables

Copy `.env.example` to `.env` and fill in all four values:

| Variable | Description |
|----------|-------------|
| `MC_VERSION` | Image tag to deploy (e.g. `v1.0.0`) |
| `MC_TENANT_SLUG` | Your unique slug, assigned at signup (e.g. `alice-studio`) |
| `MC_TUNNEL_TOKEN` | Cloudflare tunnel token, issued during signup |
| `MC_BOOTSTRAP_TOKEN` | Single-use token (1h TTL), issued during signup — consumed on first boot |

These are issued automatically on the Memory Crystal onboarding screen at `memorycrystal.ai`. No manual Cloudflare steps required.

## Bootstrap installer (`bootstrap.sh`)

The recommended installation path. Run from the repo root:

```bash
MC_VERSION=v1.0.0 \
MC_TENANT_SLUG=your-slug \
MC_TUNNEL_TOKEN=<from signup> \
MC_BOOTSTRAP_TOKEN=<from signup> \
bash scripts/bootstrap.sh
```

The script:
1. Validates all required env vars.
2. Checks Docker, disk space (≥4 GB), RAM (≥4 GB).
3. Installs `cosign` if not present (macOS arm64 only in v1).
4. Verifies image signatures with `cosign` (supply-chain security).
5. Writes `infra/selfhosted/.env` — **the bootstrap token is not persisted**.
6. Runs `docker compose pull && docker compose up -d`.
7. Polls healthchecks for up to 180 seconds.
8. Prints the tunnel URL and API key issuance link.

**Platform support**: macOS arm64 (Apple Silicon) only in v1. For x86_64 or Linux, see `https://memorycrystal.ai/docs/self-hosted#platforms`.

### File permissions

Shell scripts in this repo must be executable. After checkout, if running tests manually:

```bash
# git update-index marks scripts executable without requiring sudo chmod
git update-index --chmod=+x scripts/bootstrap.sh
git update-index --chmod=+x infra/selfhosted/__tests__/*.sh
```

## Manual startup (without `bootstrap.sh`)

```bash
cd /path/to/memorycrystal
cp infra/selfhosted/.env.example infra/selfhosted/.env
# Edit infra/selfhosted/.env with your values

MC_BOOTSTRAP_TOKEN=<from signup> \
  docker compose -f infra/selfhosted/docker-compose.yml up -d
```

## Service management

```bash
# View status
docker compose -f infra/selfhosted/docker-compose.yml ps

# Follow logs
docker compose -f infra/selfhosted/docker-compose.yml logs -f

# Stop
docker compose -f infra/selfhosted/docker-compose.yml down

# Restart a single service
docker compose -f infra/selfhosted/docker-compose.yml restart mcp
```

## Two-tier offline fallback

The bundle implements the §10 structured-503 contract with two tiers:

**Tier 1 — Mac on, cloudflared up, web/mcp down**: The `fallback` Caddy container serves a structured JSON 503 response via the cloudflared ingress final rule. The `fallback` container has no `depends_on` on web/mcp/backend — it stays healthy even when the rest of the stack is down.

**Tier 2 — Mac off / cloudflared unreachable**: The cloud-side Cloudflare Worker (`mc-tunnel-shield`) intercepts CF origin-unreachable errors and serves the structured 503 with `last_seen_at` from KV storage.

Both tiers produce the same JSON envelope shape (`§10`):

```json
{
  "status": "tunnel-fallback-ingress",
  "retry_after": 30,
  "last_seen_at": null,
  "tenant_slug": "your-slug",
  "support_link": "https://memorycrystal.ai/docs/troubleshooting",
  "error": "upstream_unavailable",
  "message": "Your Memory Crystal stack is unreachable. The Mac is online but web/mcp services are not responding."
}
```

## Troubleshooting

### Tunnel shows offline on memorycrystal.ai

Check that cloudflared is running and healthy:

```bash
docker compose -f infra/selfhosted/docker-compose.yml ps cloudflared
docker compose -f infra/selfhosted/docker-compose.yml logs cloudflared
```

If `TUNNEL_TOKEN` is wrong, you will see `403 Forbidden` in the cloudflared logs. Re-issue the token from `https://memorycrystal.ai/dashboard/{slug}/tunnel`.

### Bad bootstrap token

If the `web` container logs show `bootstrap token expired` or `bootstrap token already consumed`:

- Tokens are single-use and expire after 1 hour.
- Request a new token from the onboarding screen at `memorycrystal.ai`.
- Do not store the bootstrap token in `.env` — it is consumed on first boot.

### Image signature mismatch (cosign failure)

```
FATAL: cosign verification failed for ghcr.io/memorycrystal/web-selfhosted:v1.0.0
```

- Confirm `MC_VERSION` matches the version on your onboarding screen.
- Confirm your network can reach `https://fulcio.sigstore.dev` and `https://rekor.sigstore.dev`.
- See `https://memorycrystal.ai/docs/security/supply-chain` for details.

### Backend unhealthy at startup

The Convex backend takes 10–20 seconds to initialize on first boot. The healthcheck retries 6 times with 10s intervals (up to 70s). If it still fails:

```bash
docker compose -f infra/selfhosted/docker-compose.yml logs backend
```

Look for `INSTANCE_SECRET` or `DATABASE_URL` errors. Ensure `INSTANCE_SECRET` is set in `.env` if required by your version.

### Stack works locally but tunnel is unreachable

Verify `cloudflared` is healthy and the tunnel token matches:

```bash
docker compose -f infra/selfhosted/docker-compose.yml logs cloudflared --tail 50
```

A healthy cloudflared log shows: `Connection ... registered connIndex=0`.

## Running the tests

```bash
# Validate docker-compose.yml (requires docker)
bash infra/selfhosted/__tests__/docker-compose.validate.test.sh

# Validate Caddyfile (requires docker)
bash infra/selfhosted/__tests__/caddyfile.validate.test.sh

# Test bootstrap.sh env-var validation (no docker required)
bash infra/selfhosted/__tests__/bootstrap-args.test.sh
```

All tests skip gracefully when docker is not available.

---

## Image distribution (M9)

The `web-selfhosted` and `mcp` images are built and published to GHCR by the
CI workflow `.github/workflows/publish-selfhosted-images.yml`.

### How images are built and pushed

- Multi-stage Docker builds targeting ≤200 MB (`web-selfhosted`) and ≤80 MB (`mcp`) compressed.
- Cross-platform: `linux/amd64` and `linux/arm64` via Docker Buildx + QEMU.
- Published to:
  - `ghcr.io/memorycrystal/web-selfhosted:<version>`
  - `ghcr.io/memorycrystal/mcp:<version>`
- `:latest` floats to the most recent stable `vX.Y.Z` tag (no `-rc`/`-beta` suffix).
- A size gate job (`.github/workflows/image-size-gate.yml`) checks compressed size
  via `docker manifest inspect` after each publish and fails CI if limits are exceeded.

### Supply-chain security: cosign verification

Every production image is signed with **cosign keyless signing** using GitHub OIDC.
`bootstrap.sh` verifies signatures before pulling:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/memorycrystal/.+$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/memorycrystal/web-selfhosted:v1.0.0
```

There is no static signing key — trust is rooted in the Sigstore TUF repository.
No key rotation is needed; Fulcio certificate lifetimes are ~10 minutes.

### Finding Rekor transparency log entries

Each signed image has a permanent entry in the Sigstore Rekor log. The CI job
summary for each publish run includes a direct link. To find entries manually:

```bash
DIGEST=$(docker inspect ghcr.io/memorycrystal/web-selfhosted:v1.0.0 \
  --format '{{index .RepoDigests 0}}' | cut -d@ -f2)
open "https://search.sigstore.dev/?hash=${DIGEST}"
```

### Manual verify command (operator use)

```bash
# Verify web image
cosign verify \
  --certificate-identity-regexp '^https://github\.com/memorycrystal/.+$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/memorycrystal/web-selfhosted:v1.0.0

# Verify mcp image
cosign verify \
  --certificate-identity-regexp '^https://github\.com/memorycrystal/.+$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/memorycrystal/mcp:v1.0.0
```

See `docs/IMAGE_VERSIONING.md` for full versioning conventions and the SBOM
attestation retrieval commands.
