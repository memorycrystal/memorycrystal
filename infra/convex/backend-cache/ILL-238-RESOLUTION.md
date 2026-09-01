# ILL-238 Resolution: Stub Backend Publish

**Date:** 2026-08-20  
**Status:** Fixed (PR #73)  
**Incident:** Actions run 32292929361 published a 338 KB cargo-chef stub instead of a real backend

## Root Cause

1. **`searchlight-coordination.patch` did not compile** — contained 3 rust errors that prevented `cargo check -p search` from succeeding
2. **Dockerfile.backend used `pipefail` only (no `-e`)** — failed cargo compiles still copied chef-cook's dummy binary
3. **No size gate** — workflow published the stub without checking binary size

## Fixes Applied

### 1. Fixed `searchlight-coordination.patch`

Restored full #525 coordination logic that was deleted or broken in previous iterations:

- **VectorSegmentPaths** defined in `segment_cache.rs` with `Hash`/`Eq` impls based on inner `paths`
- **segment_cache** made `pub(crate)` in `searcher/mod.rs` to fix privacy error
- **TextDiskSegmentPaths** restored with `_index_meta`, `_alive_meta`, `_deleted_meta`, `_tracker_meta` `Arc<IndexMeta>` fields
- **generate_value** destructures all four `_meta` fields to keep Arcs alive in cached segments
- **compact()** adapted to extract `.paths` from `VectorSegmentPaths` wrapper (fixes type mismatch in `load_disk_segment` and `merge_disk_segments_hnsw` calls)
- **searcher.rs** identity-key + refcount hunks restored (`TextSegmentKey`, `load_text_segment_paths` returns tuple)
- **IndexTempDirWithSize** manual `Debug` impl (skips non-Debug `CacheCleaner` field)

### 2. Added Fail-Fast Gate

`prepare-context.sh` now overlays `set -e` onto `Dockerfile.backend` SHELL directive:

```bash
# Changed from:
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# To:
SHELL ["/bin/bash", "-e", "-o", "pipefail", "-c"]
```

**Note:** Explicitly avoids `-u` (nounset) to preserve upstream `ARG debug` + `[[ -z "$debug" ]]` idiom.

Script also verifies the `sed` command actually modified the file (fails if sed is a no-op).

### 3. Added Binary Size Gate

`publish-convex-backend-cache.yml` now:

1. Builds with `push: false` and `load: true`
2. Extracts `convex-local-backend` and checks size
3. **Fails** if under 10MB (stub is 338KB, real backend is ~70MB)
4. Only pushes if size check passes

## Verification

Applied both patches to clean checkout at `4ac3025d0d15b765181e0fc120d9d1323ead752c`:

```bash
set -o pipefail; cargo check -p search > /tmp/cargo-check-search.log 2>&1; echo CARGO_EXIT:$? | tee -a /tmp/cargo-check-search.log
```

**Result:**
- ✅ `Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 4.14s`
- ✅ `CARGO_EXIT:0`
- ✅ No `error: could not compile`
- ✅ No `failed to run custom build command`
- ⚠️ 3 warnings (unused imports, dead code) — non-blocking

Full cargo check output (last 40 lines) preserved in PR #73 body.

## Testing

Verified on multiple clean trees:

1. Both patches apply cleanly to `UPSTREAM_REVISION`
2. `cargo check -p search` exits 0 after C++ build dependencies installed (`build-essential`, `libclang-dev`, `libstdc++-14-dev`)
3. Manual file inspection confirms all critical hunks present:
   - `VectorSegmentPaths` struct definition
   - `pub(crate) mod segment_cache` visibility fix
   - Four `_*_meta` Arc fields on `TextDiskSegmentPaths`
   - `TextSegmentKey` identity keying
   - `compact()` adapted to unwrap `VectorSegmentPaths.paths`

## Files Modified

- `infra/convex/backend-cache/searchlight-coordination.patch` — restored full #525 coordination logic (563 lines)
- `infra/convex/backend-cache/prepare-context.sh` — added `-e` overlay with sed verification
- `.github/workflows/publish-convex-backend-cache.yml` — added binary size gate
- `infra/convex/backend-cache/README.md` — documented incident and gates
- `infra/convex/backend-cache/FOLLOWUP-525.md` — updated implementation status
- `infra/convex/backend-cache/VERIFY.md` — added verification instructions

## Production Status

**DO NOT MERGE YET.**  
**DO NOT TRIGGER PUBLISH.**  
**DO NOT CHANGE RAILWAY.**

Awaiting final review and approval before:
1. Merging PR #73
2. Triggering `publish-convex-backend-cache.yml` workflow
3. Promoting verified image to Railway production

## References

- **Upstream revision:** `4ac3025d0d15b765181e0fc120d9d1323ead752c`
- **Upstream issue:** https://github.com/get-convex/convex-backend/issues/525
- **PR:** https://github.com/illumin8ca/memorycrystal/pull/73
- **Actions run (stub):** 32292929361
- **Stub digest:** `sha256:f59136c6...`
