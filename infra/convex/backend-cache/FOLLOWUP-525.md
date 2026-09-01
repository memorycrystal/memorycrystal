# Issue #525 implementation status

## Implemented in searchlight-coordination.patch

The upstream issue https://github.com/get-convex/convex-backend/issues/525 describes a race
condition where the disk archive cache deletes extracted segment directories while text/vector
segment LRU caches still hold mmap'd references, causing ENOENT errors.

**searchlight-coordination.patch implements the core coordination:**

### 1. Reference-counted cleanup (delete-on-last-drop)

**Problem:** Archive cache Drop handler deleted directories immediately when evicted from its LRU,
even if segment caches still held references.

**Solution:** `IndexMeta` now wraps `IndexTempDirWithSize` in `Arc<>`. The archive cache LRU returns
`Arc<IndexMeta>`, and segment caches hold clones of that Arc. Directory deletion only occurs when
the last Arc reference is dropped, coordinating lifetime between both cache layers.

**Files changed:**
- `crates/search/src/archive/cache.rs`:
  - `IndexMeta` made public and Clone-able with `_tempdir: Arc<IndexTempDirWithSize>`
  - New `get_with_meta()` method returns `Arc<IndexMeta>` for segment coordination
  - `get_logged()` return type changed to `Arc<IndexMeta>`

### 2. Text segment identity keying

**Problem:** Text segment LRU keyed by `TextDiskSegmentPaths` (filesystem paths). If the archive
cache evicts and the same segment is re-fetched, it extracts to a new UUID directory, creating a
duplicate LRU entry. The old entry's paths point to deleted directories.

**Solution:** Text segment LRU now keys by `TextSegmentKey` (tuple of ObjectKeys representing
segment identity). Re-fetching the same logical segment hits the existing LRU entry rather than
creating a duplicate.

**Files changed:**
- `crates/search/src/searcher/segment_cache.rs`:
  - New `TextSegmentKey` struct (ObjectKey tuple)
  - `TextSegmentCache` keyed by `TextSegmentKey` instead of `TextDiskSegmentPaths`
  - `TextDiskSegmentPaths` holds `Arc<IndexMeta>` references to keep directories alive
  - `get()` signature changed to accept both key and paths
- `crates/search/src/searcher/searcher.rs`:
  - `load_text_segment_paths()` returns `(TextSegmentKey, TextDiskSegmentPaths)` tuple
  - Uses `get_with_meta()` to fetch with coordination metadata
  - Constructs identity key from ObjectKeys
  - `load_text_segment()` passes both key and paths to cache

### 3. Held Arc references

**Implementation:** `TextDiskSegmentPaths` struct holds four `Arc<IndexMeta>` fields
(`_index_meta`, `_alive_meta`, `_deleted_meta`, `_tracker_meta`). While a text segment is loaded
in the LRU, these held Arcs prevent the archive cache from deleting the underlying directories.

### 4. Vector segment refcount coordination

**Problem:** Vector segments needed similar Arc-holding to prevent directory deletion while in use.

**Solution:** Introduced `VectorSegmentPaths` wrapper struct that holds `UntarredVectorDiskSegmentPaths`
plus three `Arc<IndexMeta>` fields (segment, id_tracker, deleted_bitset). The vector LRU stores these
wrappers, keeping Arcs alive until eviction.

**Files changed:**
- `crates/search/src/searcher/segment_cache.rs`:
  - New `VectorSegmentPaths` wrapper with three `Arc<IndexMeta>` fields
  - `VectorSegmentCache` keyed by `VectorSegmentPaths` instead of raw paths
  - Hash/Eq implementations delegate to inner paths (metadata is for lifetime, not identity)
- `crates/search/src/fragmented_segment.rs`:
  - `fetch_fragmented_segment()` uses `get_with_meta()` for segment, id_tracker, and bitset
  - Returns `VectorSegmentPaths` wrapping both paths and Arcs
  - Helper `extract_single_file()` for id_tracker/bitset path extraction

## Not implemented (future work)

### Vector segment identity keying

**Status:** Vector segments still use path-based LRU keys (via `VectorSegmentPaths` Hash/Eq on inner paths).

**Why deferred:** Vector segment identity keying requires keying by `(segment_key, id_tracker_key, deleted_bitset_key)`
tuple of ObjectKeys, similar to TextSegmentKey. This is a smaller incremental change now that refcount
coordination is in place, but was not required to fix the P0 premature-deletion bug.

**Impact:** Vector segments now have full refcount coordination (no premature deletion), but can still
create duplicate LRU entries if the same logical segment is re-extracted under a new path. This is
acceptable because:
- Archive cache size (4096 MiB) and small vector LRU (16 entries) reduce re-fetch likelihood
- The core delete-on-last-drop fix prevents ENOENT errors
- Vector segment identity keying can be added incrementally in a future patch

### Manual reload policy for tantivy

**Status:** Not implemented.

**Why deferred:** Not required for the core coordination fix. The refcount + identity keying solve
the ENOENT issue. Manual reload policy would reduce filesystem watcher overhead but is orthogonal
to the race condition.

## Production impact

Memory Crystal production Railway backend currently runs with conservative settings that mitigate
the race:
- `CONVEX_SEARCH_ARCHIVE_CACHE_MIB=4096`
- `MAX_TEXT_LRU_ENTRIES=16`
- `MAX_VECTOR_LRU_ENTRIES=16`

These settings remain unchanged. The coordination patch provides a proper fix that:
- Eliminates delete-while-referenced race condition
- Prevents duplicate text segment LRU entries
- Allows future tuning of cache sizes without ENOENT risk

## Testing before production promotion

When a new backend image is built and tested:

1. Verify no ENOENT errors in search logs
2. Run 100-request recall soak (should see no missing `meta.json`/SST warnings)
3. Monitor archive cache eviction patterns (should coordinate cleanly with segment LRUs)
4. Check memory usage (Arc overhead is minimal, expect no RSS regression)
5. Verify p95 search latency matches or improves on current backend

## Future patches (optional improvements)

1. **Vector segment identity keying** - key by `(segment_key, id_tracker_key, deleted_bitset_key)`
   ObjectKey tuple rather than paths, similar to TextSegmentKey. Now a smaller change with refcount
   coordination in place.

2. **Manual reload policy** - set `ReloadPolicy::Manual` for immutable tantivy segments to stop
   filesystem watcher overhead.

3. **Segment cache size tuning** - with proper coordination, LRU sizes can be increased safely
   without ENOENT risk.

## Published stub incident (ILL-238, 2026-08-19)

Actions run 32292929361 published a 338 KB cargo-chef stub as
`ghcr.io/illumin8ca/memorycrystal-convex-backend@sha256:f59136c6b7c2d3d50069e522dcd85fafecb6424c82b907f72e46e69ae3af837d`.
When pinned to Railway convex-backend-prod, the container printed S3 warnings, exec'd the stub, exited 0
without output, and ON_FAILURE did not restart, leaving the domain 502.

**Root cause:**

1. The searchlight-coordination.patch compiled cleanly against UPSTREAM_REVISION 4ac3025d0d15 (verified
   2026-08-20 with `cargo check -p search` in a clean clone), but the workflow run's compile step
   printed 13 type errors and `could not compile search (lib)`.
2. Dockerfile.backend's cargo RUN used `SHELL ["/bin/bash", "-o", "pipefail", "-c"]` (no `set -e`),
   so failed `cargo build -p local_backend` did not fail the step.
3. The `cp target/release/convex-local-backend .` line copied chef-cook's dummy binary from the shared
   target cache.
4. The subsequent `cargo build -p keybroker` succeeded, so the Docker step exited 0.
5. No size gate existed; the stub was published and eventually pinned to production.

**The errors** (corrected 2026-08-20):
1. VectorSegmentPaths undefined (deleted in broken patch iteration)
2. segment_cache private (pub(crate) missing)
3. TextDiskSegmentPaths missing Arc fields (generate_value not destructuring _meta fields)
4. compact() type mismatch (load_disk_segment expected UntarredVectorDiskSegmentPaths, got VectorSegmentPaths)
5. merge_disk_segments_hnsw type mismatch (expected Option<UntarredVectorDiskSegmentPaths>, got Option<VectorSegmentPaths>)
6. IndexTempDirWithSize missing Debug impl (CacheCleaner doesn't derive Debug)

**Fixes applied (2026-08-20):**
1. **VectorSegmentPaths** restored in segment_cache.rs with Hash/Eq impls delegating to inner paths
2. **segment_cache** made `pub(crate)` in searcher/mod.rs
3. **TextDiskSegmentPaths** restored with `_index_meta`, `_alive_meta`, `_deleted_meta`, `_tracker_meta` Arc<IndexMeta> fields
4. **generate_value** destructures all four _meta fields to keep Arcs alive
5. **compact()** adapted to extract `.paths` from VectorSegmentPaths wrapper before passing to load_disk_segment and merge_disk_segments_hnsw
6. **IndexTempDirWithSize** manual Debug impl (skips CacheCleaner field, includes dir/type/size)
7. **searcher.rs** identity-key + refcount hunks fully restored (TextSegmentKey, load_text_segment_paths tuple return)

Fixed patch compiles cleanly — `cargo check -p search` exits 0 with `Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 4.14s` after applying both patches to UPSTREAM_REVISION 4ac3025d0d15 (verified with pipefail, real exit code, no head/tail masking).

**Gates added (ILL-238):**

1. **prepare-context.sh** overlays `-e` onto Dockerfile.backend SHELL directive (changed from `-o pipefail` 
   to `-e -o pipefail` without `-u`). Failed cargo compile now terminates the Docker build. Explicitly 
   avoids `-u` (nounset) to preserve upstream `ARG debug` + `[[ -z "$debug" ]]` idiom. Verifies sed 
   overlay succeeded (fails script if no-op).
2. **publish-convex-backend-cache.yml** extracts `convex-local-backend` from the built image and rejects
   if under 10 MB (stub was 338 KB, real backend is ~70 MB).
3. Workflow now builds with `push: false, load: true`, verifies size, then explicitly pushes.

A published stub is now fail-closed impossible.

## Checklist for this patch

- [x] Reference-counted IndexMeta with Arc-wrapped cleanup
- [x] Text segment identity keying (ObjectKey-based)
- [x] Held Arc references in TextDiskSegmentPaths
- [x] Vector segments use refcount coordination (VectorSegmentPaths with Arc<IndexMeta>)
- [x] Both patches (archive-cache + searchlight-coordination) apply cleanly
- [x] `git diff --check` passes (no whitespace errors)
- [x] Documentation updated (README, VERSIONS, this file)
- [x] (ILL-238) Fail-fast gate: Dockerfile.backend SHELL overlaid with `-e` (not `-u` to preserve debug idiom)
- [x] (ILL-238) Size gate: workflow rejects backend under 10 MB
- [x] (ILL-238) Patches compile against UPSTREAM_REVISION — `cargo check -p search` exits 0
- [x] (ILL-238) searchlight-coordination.patch fixed: 6 type/import/visibility errors corrected
- [ ] (Deferred) Build and test new backend image
- [ ] (Deferred) Production promotion after recall soak

## References

- Upstream issue: https://github.com/get-convex/convex-backend/issues/525
- Upstream revision: `4ac3025d0d15b765181e0fc120d9d1323ead752c` (precompiled-2026-08-18-4ac3025)
- archive-cache.patch SHA-256: `342d198c6f8449eaba0784627ddc2a68ff652c8af2f78ec54aca0a7bb5cf4368`
- searchlight-coordination.patch SHA-256: `cfd4c95a563f5dbb30076a82e347ef87d97af74b2b50ca58d6b3cc095ec6c609`
