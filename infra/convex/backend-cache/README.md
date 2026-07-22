# Convex search archive cache build

The official self-hosted backend revision pinned in `UPSTREAM_REVISION` fixes
its in-process search archive cache at 500 MiB. Memory Crystal's imported
production search indexes exceed that working set, causing repeated archive
eviction, extraction, and 47-72 second recall requests.

`archive-cache.patch` preserves the official 500 MiB default and adds one
bounded runtime variable:

```text
CONVEX_SEARCH_ARCHIVE_CACHE_MIB=24576
```

Prepare an auditable build context with:

```bash
infra/convex/backend-cache/prepare-context.sh /tmp/convex-backend-build
```

Build with the upstream `self-hosted/docker-build/Dockerfile.backend`. Publish
the result by immutable digest and record both the upstream revision and patch
hash in `infra/convex/VERSIONS.md` before production promotion.

The GitHub Actions workflow `.github/workflows/publish-convex-backend-cache.yml`
performs that build for `linux/amd64` and publishes it to GHCR. If production
uses the GHCR artifact, reference the resulting digest, not a mutable tag.
GitHub package visibility is managed in the package settings UI; the Packages
REST API does not provide a visibility-update endpoint.

The Railway staging build may need its Dockerfile cache mounts normalized to
Railway's `id=s/<service-id>-<target-path>` syntax, and the upstream Docker
`VOLUME /convex/data` line removed. These are builder-only changes; Railway's
existing volume remains mounted at `/convex/data`.

The production gate remains the migration runbook's full reconciliation,
100-request recall soak, capture/read/delete canary, deliberate backend restart,
and post-restart log inspection. A successful image build is not promotion
evidence by itself.

Do not change Railway backend variables while the service is backed by a local
source upload. Railway can create a new deployment from the service's prior
source configuration and silently restore the unpatched official binary. When
using Railway's source-build path, verify the deployment's immutable image
digest and confirm every new deployment logs the configured archive-cache size
before allowing traffic. A GHCR promotion must instead pin the published image
digest before changing variables.
