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
  - `export-cleanup-notfound.patch` (ILL-349, SHA-256 recorded in VERSIONS.md; tolerates only NotFound while deleting expired export blobs)
- **Overlays applied by `prepare-context.sh`:**
  - Dockerfile.backend `SHELL` fail-fast (`-e`, ILL-238)
  - `run_backend.sh` startup temp cleanup (`run_backend-tmp-cleanup.overlay.sh`, ILL-347)

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

## Startup temp cleanup overlay (ILL-347)

The upstream entrypoint (`ENTRYPOINT ["./run_backend.sh"]`) sets
`TMPDIR="$DATA_DIR/tmp"` on the persistent volume, and the backend creates its
search archive cache and Node executor dirs there with `TempDir::new()`.
They are removed only on drop, so every killed, OOM'd or redeployed container
strands one (23 dead dirs, 43 GB, on 2026-09-29).

`prepare-context.sh` inserts `run_backend-tmp-cleanup.overlay.sh` directly
after `mkdir -p "$TMPDIR" "$STORAGE_DIR"` in `run_backend.sh`, before the
`exec`. It runs `find "$TMPDIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +` and
prints `startup temp cleanup: removed N entries from <dir>`. Prepare fails if
the anchor is not found exactly once or the overlay lands outside the
`mkdir`..`exec` window.

The publish workflow tags the result `<revision[0:12]>-cache-<context_sha[0:12]>`.
The `context_sha` is derived from the `sha256sum` lines for patches in the
order listed by `prepare-context.sh`'s `git apply` commands, followed by the
`sha256sum` lines for `*.overlay.sh`, `prepare-context.sh` and
`UPSTREAM_REVISION`, sorted by path. Branch builds append
`-candidate-<sha>` to the tag. After a push, it reads the manifest digest from
GHCR, pulls the image by digest and verifies the entrypoint carries the cleanup.

## Expired export cleanup (ILL-349)

`export-cleanup-notfound.patch` changes only
`SystemTableCleanupWorker::cleanup_expired_exports`: a missing local export blob
is logged at warning level and the already-selected export row deletion is
committed. Other storage errors still abort cleanup. The patch preserves
upstream's delete-then-commit order and does not change
`LocalDirStorage::delete_object` or other storage paths. Failed and Canceled
exports carry no object key; their partial blobs remain ILL-347 GC's concern.

The patch is applied after `archive-cache.patch` and
`searchlight-coordination.patch`. Its focused Rust test runs from the
`workflow_dispatch` build workflow. The resulting image is a candidate for
ILL-352; no production image is promoted here. Candidate digest: see ILL-352.

**Candidate digest:** recorded in the PR and in Linear (ILL-352), never in this
file. This is a candidate for ILL-352, not a promotion. The operator GC tool and the
pre-promotion checks are in `docs/operations/backend-storage.md`.

## Operator health check

Run `scripts/ops/backend-health.mjs [--hours N]` using the private fixture's
`backendHealth` block. `--hours` defaults to 24. A value between 0 and 1 is
accepted but reports exit 1 (failed). The check prints counts and timestamps
only. Exit **0** means the window is covered,
the latest backend process has a worker start, and no failure or restart
evidence was found. Exit **1** means a window under 1 hour, a worker-death or
forced-disable line, a restart in the window, or (with complete coverage) no
worker start after the latest backend process start. These positive failure
signals still produce exit 1 when coverage is incomplete. A restart is multiple
starts for one process in the window, or an in-window start that is not the
current process's first start since it began. Starts before the requested
window are history and do not fail the check. Starts are assigned at backend
process-start boundaries, using a matching instance ID to keep an old
instance's stragglers with that process and to split restarts that reuse an ID.
For a matching ID, the latest preceding process start for that instance is
preferred, with time-order fallback when none precedes the worker start. An ID
matching no process-start row is unassigned when any process-start row carries
an ID. Worker starts without IDs, and unmatched IDs when no process-start row
carries an ID, use the latest preceding process by time order.

Exit **2** means setup/configuration or Railway transport/response failure.
Exit **3** means unknown because worker or process-start logs do not cover the
whole window and no failure evidence was observed. Railway retains roughly
seven days of logs; a process older than retention cannot be proven healthy and
returns exit 3 without failure evidence. The reported current-process worker
start count is informational and includes up to 501 rows: the 500-row page
limit plus one. Only the current process receives a separate lookup for its
pre-window worker starts. A non-current process that restarts its worker once
inside the window without a died line is not flagged; a died line still fails.
See [the backend storage runbook](../../../docs/operations/backend-storage.md)
for operational details.

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
