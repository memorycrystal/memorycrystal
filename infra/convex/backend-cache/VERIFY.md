# Verification guide for the backend cache image

This document explains how to verify the pinned upstream revision and the two
overlays in `prepare-context.sh` before publishing. This revision has no local
patches.

## Pinned revision

- **Upstream:** `96d219cc87e438b945ab92925d26a60939f646cd` (`precompiled-2026-10-07-96d219c`)
- **DATABASE_VERSION:** 133 (`crates/migrations_model/src/lib.rs`)
- **Data migrations:** 130 backfills `persistenceIndexId` on Database indexes in `_index` in batches of 1,000. 133 deletes legacy schema-validation progress documents with no `validation_id` and drops `by_schema_id`. Migrations 127, 128, 129, 131, and 132 are empty.
- **Patches:** none. Archive-cache configuration (`MAX_ARCHIVE_CACHE_SIZE_BYTES`, default `bytesize::mib(500)`), searchlight refcount coordination (upstream #57610 / issue #525), and expired-export NotFound handling (upstream `a16dada1`, idempotent `LocalDirStorage::delete_object`) are in this revision.
- **Overlays:** Dockerfile.backend `SHELL` fail-fast (ILL-238), the `run_backend.sh` startup temp cleanup (ILL-347) and the search page-cache warmer (ILL-441).

This revision has run in production since 2026-10-07 (ILL-352 Part C). The Part B rehearsal stopped before its upgrade stage.

## Quick verification

`prepare-context.sh` checks out `UPSTREAM_REVISION` and fails closed if either overlay cannot be applied. The image compile runs in `.github/workflows/publish-convex-backend-cache.yml` (workflow_dispatch). Do not treat a local `cargo` check as the publish gate.

```bash
CONTEXT="/tmp/convex-backend-verify"
rm -rf "$CONTEXT"
infra/convex/backend-cache/prepare-context.sh "$CONTEXT"
```

After it exits 0:

- `self-hosted/docker-build/Dockerfile.backend` contains `SHELL ["/bin/bash", "-e", "-o", "pipefail", "-c"]`. At this revision upstream already has that line, so the overlay's guard leaves it in place. The `-e` is what stops a failed cargo compile from copying a cargo-chef stub.
- `self-hosted/docker-build/run_backend.sh` contains `startup temp cleanup: removed` exactly once, after `mkdir -p "$TMPDIR" "$STORAGE_DIR"` and before `exec ./convex-local-backend`.
- `self-hosted/docker-build/run_backend.sh` contains `echo "search cache warmer: every` exactly once, after the cleanup and before `exec ./convex-local-backend`.
- The script prints both overlay lines and does not apply a patch.

## What upstream carries instead of the retired patches

**Archive cache.** `crates/search/src/searcher/searchlight_knobs.rs` defines `MAX_ARCHIVE_CACHE_SIZE_BYTES`. The default is 500 MiB (`bytesize::mib(500)`, 524288000 bytes). `InProcessSearcher::new` passes that value into the archive cache. Production must set `MAX_ARCHIVE_CACHE_SIZE_BYTES` (bytes) in place of `CONVEX_SEARCH_ARCHIVE_CACHE_MIB` (MiB), converted from the live Railway value: MiB × 1048576.

**Searchlight coordination (#57610, issue #525).** `CachedArchive` holds `Arc<IndexMeta>`, so an extracted directory is deleted when the last handle drops. Segment caches are keyed by storage keys and hold those handles.

**Expired export NotFound (`a16dada1`).** `remove_local_object` treats a missing file as success when the storage root exists. `cleanup_expired_exports` calls `delete_object`. That commit has no unit test, and this revision has no `system_table_cleanup::export_cleanup_tests` module. The publish workflow does not run an ILL-349 cargo test.

## ILL-238 stub incident

Actions run 32292929361 published a 338 KB cargo-chef stub because Dockerfile.backend used `pipefail` only (no `set -e`). The publish workflow still extracts `convex-local-backend` and rejects a binary under 10 MB. See `ILL-238-RESOLUTION.md`.

## Full build

The publish workflow builds with `self-hosted/docker-build/Dockerfile.backend` for `linux/amd64`, checks the binary size (ILL-238), pushes, then pulls by digest and checks that the entrypoint contains the startup temp cleanup (ILL-347). A published stub fails that size gate.

## References

- Upstream issue: https://github.com/get-convex/convex-backend/issues/525
- Upstream archive-cache knob: `MAX_ARCHIVE_CACHE_SIZE_BYTES` in `crates/search/src/searcher/searchlight_knobs.rs`
- Upstream coordination: commit `bf09681d31b1` (#57610)
- Upstream export delete: commit `a16dada1` (#57613)
- ILL-238: https://linear.app/illumin8/issue/ILL-238
- ILL-352 production upgrade record: on the ILL-352 issue.
- Published stub SHA256: `f59136c6b7c2d3d50069e522dcd85fafecb6424c82b907f72e46e69ae3af837d`
- Failed workflow: https://github.com/illumin8ca/memorycrystal/actions/runs/32292929361
