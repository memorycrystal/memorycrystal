# Memory Crystal — Self-Hosted Docker Bundle

This directory contains the Docker Compose bundle, Caddy fallback configuration, and documentation for running the Memory Crystal self-hosted stack.

> **Status (2026-10-07): not available yet.** Self-hosting is MCP-only for now: run the MCP image (`ghcr.io/memorycrystal/mcp`) with the local backend. This tunnel bundle still needs at least these pieces:
> * the web image, which was never published;
> * a deploy of the Memory Crystal Convex functions into the bundle's backend (nothing in the bundle does that today);
> * first-boot token wiring. `convex/local/bootstrap.ts` reads `MC_BOOTSTRAP_TOKEN` from the Convex deployment environment, but the compose file passes the token only to the `web` service;
> * registration of the first-boot fetch cron. `bootstrapInitialFetch` is defined in `convex/localCrons.ts`, and Convex registers crons only from `convex/crons.ts`;
> * local backend mode and API-key seeding (`CRYSTAL_BACKEND=local`; see ILL-367).
>
> The bundle is not offered: `/onboard` redirects to the normal onboarding (decision 2026-10-08). `scripts/bootstrap.sh` stops after env validation unless `MC_SELFHOSTED_EXPERIMENTAL=1`. To self-host today, follow the local-first guide: https://docs.memorycrystal.ai/configuration/local-first

## What this bundle is

The self-hosted bundle runs the full Memory Crystal stack on your own Mac:

| Service | Purpose | Image |
|---------|---------|-------|
| `backend` | Convex self-hosted backend | `ghcr.io/get-convex/convex-backend` (pinned digest) |
| `dashboard` | Convex admin dashboard on `:6791` | `ghcr.io/get-convex/convex-dashboard` (pinned digest) |
| `web` | Memory Crystal Next.js app. No tagged release published this image through the publish workflow, so this service cannot pull a current tag. | `ghcr.io/memorycrystal/web-selfhosted:${MC_VERSION}` |
| `mcp` | MCP HTTP server on `:8788` | `ghcr.io/memorycrystal/mcp:${MC_VERSION}` |
| `fallback` | Tier-1 structured-503 responder | `caddy:2-alpine` (≤16 MB compressed) |
| `cloudflared` | Cloudflare tunnel sidecar | `cloudflare/cloudflared:latest` |

No tagged release published `ghcr.io/memorycrystal/web-selfhosted` through `.github/workflows/publish-selfhosted-images.yml`. Commit 67b4170f added that workflow and commit 7e098a27 removed web-selfhosted from it on the same day, both before the v0.8.4 tag, because the public mirror excludes `apps/web`. The compose `web` service still names that image, so `docker compose` cannot pull it for a current `MC_VERSION`. Self-hosting is MCP-only for now (decision 2026-10-07), so no web image will be published.

The `cloudflared` sidecar creates a permanent named tunnel so your stack is reachable at `https://{slug}.tunnels.memorycrystal.ai` from any machine, even behind NAT, without port-forwarding.

**Memory content never leaves your machine.** Only anonymous telemetry (memory counts, version, last-seen timestamp) is sent to the cloud.

## Required environment variables

Copy `.env.example` to `.env` and fill in all four values:

| Variable | Description |
|----------|-------------|
| `MC_VERSION` | Image tag to deploy (e.g. `0.10.0`) |
| `MC_TENANT_SLUG` | Your unique slug, assigned at signup (e.g. `alice-studio`) |
| `MC_TUNNEL_TOKEN` | Cloudflare tunnel token, issued during signup |
| `MC_BOOTSTRAP_TOKEN` | Single-use token (1h TTL), issued during signup — consumed on first boot |

These are issued automatically on the Memory Crystal onboarding screen at `memorycrystal.ai`. No manual Cloudflare steps required.

## Bootstrap installer (`bootstrap.sh`): experimental

Not available yet (see the status note above). A default run stops after step 1 with the MCP-only notice. Steps 2 to 8 run only with `MC_SELFHOSTED_EXPERIMENTAL=1`, which is for bundle development. Run from the repo root:

```bash
MC_VERSION=0.10.0 \
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

**Platform support**: macOS arm64 (Apple Silicon) only in v1. For x86_64 or Linux, see `https://docs.memorycrystal.ai/configuration/self-hosting`.

### File permissions

Shell scripts in this repo must be executable. After checkout, if running tests manually:

```bash
# git update-index marks scripts executable without requiring sudo chmod
git update-index --chmod=+x scripts/bootstrap.sh
git update-index --chmod=+x infra/selfhosted/__tests__/*.sh
```

## Manual startup (without `bootstrap.sh`): experimental

For bundle development only. This starts the `web` service, whose image was never published, so the pull fails for a current `MC_VERSION`.

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

On the experimental path, if the `web` container logs show `bootstrap token expired` or `bootstrap token already consumed`:

- Tokens are single-use and expire after 1 hour.
- Request a new token from the onboarding screen at `memorycrystal.ai`.
- Do not store the bootstrap token in `.env` — it is consumed on first boot.

### Image signature mismatch (cosign failure)

On the experimental path, `bootstrap.sh` verifies `ghcr.io/memorycrystal/web-selfhosted:${MC_VERSION}` before it pulls. No tagged release published that image through the publish workflow: commit 67b4170f added the workflow and commit 7e098a27 removed web-selfhosted from it on the same day, both before the v0.8.4 tag. A current `MC_VERSION` stops there. The installer prints:

```
ERROR: cosign verification failed for ghcr.io/memorycrystal/web-selfhosted:0.10.0
  This image may not be published by memorycrystal/. Do not proceed.
```

On the experimental path (`MC_SELFHOSTED_EXPERIMENTAL=1`) that failure is expected for the compose `web` service. The service still names `ghcr.io/memorycrystal/web-selfhosted:${MC_VERSION}`, and there is no current tag to verify or pull. Self-hosting is MCP-only for now (decision 2026-10-07), so no web image will be published.

For the `mcp` image, which is published, a cosign failure means the signature check itself failed:

- Confirm `MC_VERSION` matches a published mcp tag.
- Confirm your network can reach `https://fulcio.sigstore.dev` and `https://rekor.sigstore.dev`.
- See `docs/IMAGE_VERSIONING.md` for details.

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

Every service healthcheck uses `127.0.0.1`. This avoids BusyBox `wget`
resolving `localhost` to IPv6 when the service listens on IPv4.
`mcp-server/tests/selfhosted-contract.test.mjs` pins all five probes.
The `mcp-container-health.yml` CI job builds and probes MCP, then starts
backend, dashboard, and fallback with the compose healthchecks and waits for
all three to become healthy. Web is not started in this job: the current
self-hosted image workflow publishes only MCP, and the web Dockerfile requires
the absent `pnpm-lock.yaml`, so this checkout cannot build that image as written.
This checkout also has no web route or rewrite for the probe's `/api/health`
path. Its compose probe is covered by the static contract test; implementing web
readiness is outside this revocation fix. Cloudflared has no service healthcheck
and requires a real tunnel token. The container-health job uses no provisioning
or tunnel credentials.

```bash
# Validate docker-compose.yml (requires docker)
bash infra/selfhosted/__tests__/docker-compose.validate.test.sh

# Validate Caddyfile (requires docker)
bash infra/selfhosted/__tests__/caddyfile.validate.test.sh

# Test bootstrap.sh env-var validation (no docker required)
bash infra/selfhosted/__tests__/bootstrap-args.test.sh
```

All tests skip gracefully when docker is not available.

## API-key revocation on local installs

On local-installer deployments (`CRYSTAL_BACKEND=local`), authentication checks
both key stores by the same hash. A `localApiKeys` row with `revokedAt` or
`cloudRevokedAt` denies every REST bearer resolver. An inactive matching
`crystalApiKeys` row makes `local/apiKeys:getByHash` return an effectively
revoked key, which the MCP gateway rejects with 401. So does a missing row for
an installer key (`keyVersion` `local-v1`), because the installer always writes
both rows together: dashboard delete removes the row, and regenerate rewrites
its hash. These are auth-time reads:
there are no dual writes or migration, and previously revoked rows take effect
after upgrade. Auth checks started after the revoking mutation commits refuse
the key; requests already in flight may complete.

Apart from that installer rule, a missing counterpart does not by itself revoke
a key. REST still requires a valid `crystalApiKeys` row, and the gateway still
requires a `localApiKeys` row. Any stored revocation timestamp, including 0,
revokes on both sides.
On hosted deployments (any `CRYSTAL_BACKEND` value other than `local`), REST
ignores `localApiKeys`, while the public `local/apiKeys:getByHash`, `markUsed`,
and `revoke` functions throw `local_backend_only` before reading or writing.
Cloud revocation reconciliation remains an internal mutation.

This rule covers local-installer stacks. The compose bundle does not yet set
`CRYSTAL_BACKEND=local` or seed a REST key owner and entitlement. Its owner model,
self-hosted detection, and existing-stack backfill are a separate product
decision (ILL-367); this fix does not make compose-bundle REST authentication
work. Because the public `local/apiKeys` functions refuse without the flag, the
compose bundle's MCP gateway answers every authenticated request with 503
`local_backend_only` until that decision sets it.

---

## Image distribution (M9)

`.github/workflows/publish-selfhosted-images.yml` builds and publishes
`ghcr.io/memorycrystal/mcp` to GHCR. No tagged release published
`ghcr.io/memorycrystal/web-selfhosted` through that workflow. Commit 67b4170f
added the workflow and commit 7e098a27 removed web-selfhosted from it on the
same day, both before the v0.8.4 tag, because the public mirror excludes
`apps/web`. The compose `web` service still names that image, so a current
`MC_VERSION` cannot pull it. Self-hosting is MCP-only for now (decision
2026-10-07), so no web image will be published.

### How images are built and pushed

- The publish matrix builds `mcp` only, from `mcp-server/Dockerfile`.
- Each platform is built natively on a GitHub-hosted runner: `linux/amd64` on amd64 and `linux/arm64` on arm64. Those digests are merged into one signed index.
- Published to `ghcr.io/memorycrystal/mcp:<version>`.
- `:latest` floats to the most recent stable `vX.Y.Z` tag (no `-rc`/`-beta` suffix).
- After the index is signed and the SBOM attestation is attached, the merge job
  reads each platform manifest by digest. A platform's compressed size is its
  config size plus its layer sizes. The job fails if any platform exceeds 80 MB.
  The separate size-gate workflow has been removed.

### Supply-chain security: cosign verification

The mcp image is signed with cosign keyless signing using GitHub OIDC.
On the experimental path, `bootstrap.sh` still verifies `ghcr.io/memorycrystal/web-selfhosted:${MC_VERSION}`
first and stops when that image is missing. No tagged release published it
through this workflow. The mcp verify command, for a tag that was published:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/memorycrystal/.+$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/memorycrystal/mcp:0.10.0
```

There is no static signing key. Trust is rooted in the Sigstore TUF repository.
No key rotation is needed; Fulcio certificate lifetimes are about 10 minutes.
The same command against `ghcr.io/memorycrystal/web-selfhosted:0.10.0` cannot
succeed: that tag was never published.

### Finding Rekor transparency log entries

Each signed mcp image has a permanent entry in the Sigstore Rekor log. The CI
job summary for each publish run includes a direct link. To find entries manually:

```bash
DIGEST=$(docker inspect ghcr.io/memorycrystal/mcp:0.10.0 \
  --format '{{index .RepoDigests 0}}' | cut -d@ -f2)
open "https://search.sigstore.dev/?hash=${DIGEST}"
```

`docker inspect` of `ghcr.io/memorycrystal/web-selfhosted:0.10.0` fails with
No such object. No tagged release published that image through this workflow,
so there is no local image to inspect.

### Manual verify command (operator use)

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/memorycrystal/.+$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/memorycrystal/mcp:0.10.0
```

Do not point this command at `ghcr.io/memorycrystal/web-selfhosted`. No tagged
release published that image through the publish workflow, and the compose
`web` service that names it cannot pull a current tag.

See `docs/IMAGE_VERSIONING.md` for versioning conventions and the SBOM
attestation retrieval commands.
