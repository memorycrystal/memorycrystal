# Verification guide for backend patches

This document explains how to verify that both patches apply and compile cleanly against the pinned
UPSTREAM_REVISION before publishing.

## Quick verification (CI or local)

```bash
# Prepare patched context
CONTEXT="/tmp/convex-backend-verify"
rm -rf "$CONTEXT"
infra/convex/backend-cache/prepare-context.sh "$CONTEXT"

# Sparse-checkout search crate and dependencies
cd "$CONTEXT"
git sparse-checkout set crates

# Verify search crate compiles (13 errors reported in ILL-238 stub incident)
cargo check -p search
```

If `cargo check -p search` exits 0, both patches compile cleanly.

## What the patches change

**archive-cache.patch:**
- Adds `CONVEX_SEARCH_ARCHIVE_CACHE_MIB` environment variable (500-65536 MiB, default 500)
- Modifies `crates/search/src/searcher/in_process.rs`

**searchlight-coordination.patch (issue #525):**
- `crates/search/src/archive/cache.rs` - Arc-wrapped IndexMeta with refcount coordination
- `crates/search/src/searcher/segment_cache.rs` - TextSegmentKey, VectorSegmentPaths, held Arc references
- `crates/search/src/searcher/searcher.rs` - TextSegmentKey construction, get_with_meta() calls
- `crates/search/src/fragmented_segment.rs` - VectorSegmentPaths construction

Both patches apply cleanly to UPSTREAM_REVISION `4ac3025d0d15b765181e0fc120d9d1323ead752c`.

## ILL-238 stub incident compile errors

Actions run 32292929361 reported 13 compile errors in the `search` crate, then published a stub anyway
because Dockerfile.backend used `pipefail` only (no `set -e`). The errors have been verified fixed
as of 2026-08-20:

- **PathBuf not in scope** - Fixed: imports present in fragmented_segment.rs, searcher.rs
- **private segment_cache module** - Fixed: types used within searcher module only
- **get_logged() signature** - Fixed: returns `Arc<IndexMeta>`
- **VectorSegmentPaths wrapper** - Fixed: defined in segment_cache.rs
- **IndexMeta missing Debug** - Fixed: derived via `#[derive(Clone, Debug)]` (Debug not required, but present)
- **pattern match missing fields** - Fixed: `_index_meta`, `_alive_meta`, `_deleted_meta`, `_tracker_meta` present in TextDiskSegmentPaths

## Full build test (Docker required)

To test the complete Docker build with fail-fast gate:

```bash
CONTEXT="/tmp/convex-backend-full"
rm -rf "$CONTEXT"
infra/convex/backend-cache/prepare-context.sh "$CONTEXT"

cd "$CONTEXT"

# Verify SHELL directive was modified
grep "SHELL.*pipefail" self-hosted/docker-build/Dockerfile.backend
# Expected: SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# Build with official Dockerfile (requires Docker + 120GB free disk)
docker build \
  -f self-hosted/docker-build/Dockerfile.backend \
  -t memorycrystal-convex-backend:test \
  --build-arg VERGEN_GIT_SHA="$(git rev-parse HEAD)" \
  --build-arg VERGEN_GIT_COMMIT_TIMESTAMP="$(git show -s --format=%cI HEAD)" \
  .

# Verify backend binary size
docker run --rm memorycrystal-convex-backend:test stat -c%s /convex/convex-local-backend
# Expected: tens of megabytes (20-60 MB typical after stripping)
# Stub from ILL-238: 337,776 bytes (338 KB)
```

If the build fails due to a cargo error, the `-euo` SHELL overlay causes immediate failure rather
than copying a stub.

## Continuous verification

The publish workflow `.github/workflows/publish-convex-backend-cache.yml` performs:

1. **Build** with Dockerfile.backend (fail-fast via overlaid `-euo pipefail`)
2. **Size check** - Extract `convex-local-backend`, reject if under 10 MB
3. **Push** - Only push if size check passes

A published stub is fail-closed impossible with these gates.

## References

- Upstream issue: https://github.com/get-convex/convex-backend/issues/525
- ILL-238: https://linear.app/illumin8/issue/ILL-238
- Published stub SHA256: `f59136c6b7c2d3d50069e522dcd85fafecb6424c82b907f72e46e69ae3af837d`
- Failed workflow: https://github.com/illumin8ca/memorycrystal/actions/runs/32292929361
