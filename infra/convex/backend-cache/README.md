# Convex backend cache build

The self-hosted backend revision pinned in `UPSTREAM_REVISION` is upstream
`96d219cc87e438b945ab92925d26a60939f646cd`
(`precompiled-2026-10-07-96d219c`). `DATABASE_VERSION` is 133. The in-process
search archive cache defaults to 500 MiB and is configurable. Memory Crystal's
imported production search indexes exceed that default, so production raises
the cache with the upstream variable below.

Prepare an auditable build context with:

```bash
infra/convex/backend-cache/prepare-context.sh /tmp/convex-backend-build
```

`prepare-context.sh` checks out that revision and applies the two overlays
below. It applies no patches.

Build with the upstream `self-hosted/docker-build/Dockerfile.backend`. Publish
the result by immutable digest and record the upstream revision in
`infra/convex/VERSIONS.md` before production promotion.

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
source configuration and silently restore an older binary. When using Railway's
source-build path, verify the deployment's immutable image digest and confirm
every new deployment logs the configured archive-cache size before allowing
traffic. A GHCR promotion must pin the published image digest before changing
variables.

## Current revision

- **Upstream:** `96d219cc87e438b945ab92925d26a60939f646cd` (precompiled-2026-10-07-96d219c)
- **DATABASE_VERSION:** 133 (`crates/migrations_model/src/lib.rs`)
- **Data migrations:** 130 backfills `persistenceIndexId` on every Database index in `_index`, in batches of 1,000. 133 deletes legacy schema-validation progress documents that have no `validation_id` and drops the system index `by_schema_id`. Migrations 127, 128, 129, 131, and 132 are empty.
- **Patches:** none. Archive-cache configuration, searchlight refcount coordination (upstream #57610, issue #525), and expired-export NotFound handling (upstream `a16dada1`) are in this revision.
- **Overlays applied by `prepare-context.sh`:**
  - Dockerfile.backend `SHELL` fail-fast (`-e`, ILL-238). This revision's Dockerfile already contains `SHELL ["/bin/bash", "-e", "-o", "pipefail", "-c"]`, so the overlay's guard leaves that line in place.
  - `run_backend.sh` startup temp cleanup (`run_backend-tmp-cleanup.overlay.sh`, ILL-347)
  - `run_backend.sh` search page-cache warmer (`run_backend-search-warmer.overlay.sh`, ILL-441)
- **Production:** running since 2026-10-07 19:21Z (ILL-352 Part C), image `sha256:3f7c7ec1…`. Migrations 129 to 133 completed at 19:21:51Z. The Part B rehearsal stopped before its upgrade stage; see the ILL-352 issue.
- **Production before 2026-10-07:** the 2026-08-20 build of upstream `4ac3025d0d15b765181e0fc120d9d1323ead752c` (`DATABASE_VERSION` 128) with `archive-cache.patch`, `searchlight-coordination.patch`, and the ILL-238 `SHELL` overlay. The ILL-349 `export-cleanup-notfound.patch` and the ILL-347 overlay were added later and never ran in production. Moving production to this revision runs migrations 129 to 133.

## Archive cache size (upstream)

`InProcessSearcher::new` passes `MAX_ARCHIVE_CACHE_SIZE_BYTES` from
`crates/search/src/searcher/searchlight_knobs.rs`. The variable name is
`MAX_ARCHIVE_CACHE_SIZE_BYTES`. The default is
`NonZeroU64::new(bytesize::mib(500u64)).unwrap()` (500 MiB, 524288000 bytes).
`cmd_util::env::env_config` parses the value with `FromStr` as a positive
decimal integer of bytes. A missing variable uses the default. An invalid
value logs a warning and falls back to the default.

The retired local patch read `CONVEX_SEARCH_ARCHIVE_CACHE_MIB` (integer MiB,
default 500, clamped to 500..=65536, and a bad value failed startup).
Production must replace `CONVEX_SEARCH_ARCHIVE_CACHE_MIB` with
`MAX_ARCHIVE_CACHE_SIZE_BYTES`. The value is bytes: previous MiB × 1024 × 1024.
This repo records two figures for that budget: 24576 MiB at the July 2026
Railway cutover and 4096 MiB in `FOLLOWUP-525.md`. Neither is authoritative.
Part C converts the live Railway value: 4096 MiB is 4294967296 bytes, and
24576 MiB is 25769803776 bytes. This note does not read Railway.
`MAX_TEXT_LRU_ENTRIES` and `MAX_VECTOR_LRU_ENTRIES` keep those names.

## Search archive coordination (upstream #57610)

Upstream commit `bf09681d31b1` ("Keep extracted search archives on disk while
segment caches use them", #57610) is an ancestor of this revision. It fixes
upstream issue #525: the disk archive cache could delete an extracted segment
directory while a text or vector segment LRU still held it.

`CachedArchive` in `crates/search/src/archive/cache.rs` holds `Arc<IndexMeta>`.
The extracted directory stays on disk until the last handle drops. Evicting the
manager's own entry drops only that reference. `TextSegmentCache` is keyed by
`FragmentedTextStorageKeys` and `VectorSegmentCache` by
`FragmentedSegmentStorageKeys`, and each loaded segment keeps a
`Vec<CachedArchive>`. The local `searchlight-coordination.patch` is retired.

## Search page-cache warmer overlay (ILL-441)

Searchlight serves vector and text segments from files it extracts under
`$TMPDIR` and memory-maps. Upstream qdrant segments use mmap storage only
("VectorStorageType::Memory is unsupported"), so query speed depends on the
page cache. Measured on Railway production, 2026-10-08:
- the shared host reclaimed this container's idle page cache within about a
  minute (a 103 MB segment file read back in 18 ms after 20 s, but needed
  disk reads again after 60 s);
- the volume is capped by `io.max` at 70 MB/s and 3000 IOPS.

So the first recall after a quiet minute re-read its segments from disk and
took up to about 15 s, which tripped the Hermes 8 s prefetch budget.
`mlock` (8 MB limit) and tmpfs (62 MB `/dev/shm`, no `CAP_SYS_ADMIN`) are not
available in the container.

`prepare-context.sh` inserts `run_backend-search-warmer.overlay.sh` directly
after the ILL-347 cleanup, before the `exec`. It starts a background loop that
re-reads every extracted file under `$TMPDIR` (depth 2 and below) every
`SEARCH_CACHE_WARM_INTERVAL_SECONDS` (default 15; `0` disables it), and prints
`search cache warmer: every Ns over <dir>`. The ILL-347 cleanup empties `$TMPDIR`
at startup, so after a restart the cache refills on demand and the warmer
follows it. On production a hand-started copy took about 36 s for its first pass
over an already extracted 3.3 GB cache (partly cached), then 0.4–0.6 s per pass.

The warmer keeps every file under `$TMPDIR` at depth 2 and below resident: roughly the archive
cache (`MAX_ARCHIVE_CACHE_SIZE_BYTES`, which production sets to 6 GiB
(6442450944), plus entries pinned by open searches, which upstream lets exceed
the limit), plus the small Node executor and transient index-build dirs.
`nice` lowers its CPU priority (and the I/O priority derived from it), but it
limits neither memory nor the volume's throughput cap; if the host reclaims
faster than the warmer re-reads, passes go back to the throttled volume, so watch memory and
recall latency after changes. `SEARCH_CACHE_WARM_INTERVAL_SECONDS=0` disables
it (restart required). The hot set measured 3.3 GB on 2026-10-08,
with `MAX_VECTOR_LRU_ENTRIES=64` and `MAX_TEXT_LRU_ENTRIES=64`.

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
The `context_sha` hashes `sha256sum` lines for patches named by
`prepare-context.sh` `git apply` lines, in that order, then the `sha256sum`
lines for `*.overlay.sh`, `prepare-context.sh` and `UPSTREAM_REVISION`, sorted
by path. This revision has no apply lines, so the hash covers the overlay, the
prepare script, and the pin. Branch builds append `-candidate-<sha>` to the
tag. After a push, it reads the manifest digest from GHCR, pulls the image by
digest and verifies the entrypoint carries the cleanup.

## Expired export cleanup (upstream a16dada1)

Upstream `a16dada1` ("Make LocalDirStorage::delete_object idempotent", #57613)
adds `remove_local_object`. A missing file is success when the storage root
exists. Any other error, including a missing storage root, still fails the
delete. `SystemTableCleanupWorker::cleanup_expired_exports` calls
`delete_object` and then commits the export-row deletion. That commit added no
`#[test]`, and this revision has no `system_table_cleanup::export_cleanup_tests`
module, so the publish workflow does not run an ILL-349 cargo test. The local
`export-cleanup-notfound.patch` is retired. Failed and Canceled exports carry
no object key; their partial blobs remain ILL-347 GC's concern.

Promotion is a separate Railway step; ILL-352 promoted `sha256:3f7c7ec1…` on
2026-10-07. A new build stays a candidate until it is promoted the same way.

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
