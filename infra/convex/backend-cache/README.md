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

## Current revision

- **Upstream:** `4ac3025d0d15b765181e0fc120d9d1323ead752c` (precompiled-2026-08-18-4ac3025)
- **Patches:**
  - `archive-cache.patch` (SHA-256 recorded in VERSIONS.md)
  - `searchlight-coordination.patch` (issue #525 refcount coordination, SHA-256 recorded in VERSIONS.md)

## Implemented: Archive cache coordination (#525)

The upstream backend has a race condition (https://github.com/get-convex/convex-backend/issues/525)
where the disk archive cache can delete extracted segment directories while the
text/vector segment LRU caches still hold mmap'd references to them, leading to
ENOENT search failures.

**searchlight-coordination.patch implements:**

1. **Reference-counted cleanup** - `IndexMeta` now wraps `IndexTempDirWithSize` in `Arc<>`.
   The archive cache and segment LRU caches both hold `Arc<IndexMeta>`. Directory deletion
   only occurs when the last Arc reference is dropped, preventing premature cleanup.

2. **Text segment identity keying** - `TextSegmentCache` now keys by `TextSegmentKey`
   (ObjectKey tuple) rather than filesystem paths. This prevents duplicate LRU entries
   when the same logical segment is re-extracted to a new UUID directory.

3. **Held references** - `TextDiskSegmentPaths` holds `Arc<IndexMeta>` references to
   keep archive directories alive while segments are loaded in the text segment LRU.

**Not included:**
- Vector segment identity keying remains path-based (less invasive for streaming fetcher)
- Manual reload policy for tantivy segments (not required for core coordination)

The patch is conservative and focused on the delete-on-last-drop + text identity-key core.
Vector segments benefit from refcount coordination but still use path-based LRU keys.

Memory Crystal production settings remain:
- `CONVEX_SEARCH_ARCHIVE_CACHE_MIB=4096`
- `MAX_TEXT_LRU_ENTRIES=16`
- `MAX_VECTOR_LRU_ENTRIES=16`

## Published stub incident (ILL-238, 2026-08-19)

Actions run 32292929361 published a 338 KB cargo-chef stub (`sha256:f59136c6`) instead of a real backend.
When pinned to Railway production, the container exited 0 with no output and the domain 502'd.

**Root cause:** Dockerfile.backend used `pipefail` only (no `set -e`), so failed cargo compiles still
copied chef-cook's dummy binary. No size gate existed to block stub publication.

**Gates added:**

1. **prepare-context.sh** now overlays `set -e` onto Dockerfile.backend's SHELL directive (changed from
   `-o pipefail` to `-e -o pipefail` without `-u` to preserve upstream `ARG debug` behavior).
   Failed cargo compile terminates the Docker build.
2. **publish-convex-backend-cache.yml** extracts `convex-local-backend` from the built image and rejects
   if under 10 MB (stub was 338 KB; real backend is tens of MB after stripping).
3. Workflow builds with `push: false, load: true`, verifies size, then explicitly pushes.

A published stub is now fail-closed impossible. Both patches compile cleanly against UPSTREAM_REVISION
(verified 2026-08-20 with `cargo check -p search`).
