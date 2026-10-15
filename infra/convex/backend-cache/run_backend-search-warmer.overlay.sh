# shellcheck shell=bash
# --- ILL-441: search page-cache warmer (Memory Crystal) ---
# Searchlight serves vector and text segments from memory-mapped files it
# extracts under $TMPDIR (qdrant segments use mmap storage; in-memory storage is
# unsupported upstream). On Railway the shared host reclaims this container's
# idle page cache within about a minute, and the volume is capped at 70 MB/s
# and 3000 IOPS, so the first recall after a quiet minute re-read its segments
# from disk and took up to ~15 s. Re-reading the extracted files on a short
# interval keeps them resident; a pass over cached pages takes well under a
# second. The resident set is roughly the archive cache
# (MAX_ARCHIVE_CACHE_SIZE_BYTES, plus entries pinned by open searches) plus
# the small Node executor and transient index-build dirs under $TMPDIR.
# SEARCH_CACHE_WARM_INTERVAL_SECONDS sets the interval in whole seconds. 0, a
# value with a leading zero, or anything else that is not a plain positive
# integer disables the warmer.
search_cache_warm_interval="${SEARCH_CACHE_WARM_INTERVAL_SECONDS:-15}"
if [[ "$search_cache_warm_interval" =~ ^[1-9][0-9]*$ ]]; then
    (
        set +e
        while :; do
            sleep "$search_cache_warm_interval"
            find "$TMPDIR" -mindepth 2 -type f -print0 2>/dev/null \
                | xargs -0 -r nice -n 19 cat > /dev/null 2>&1
        done
    ) &
    echo "search cache warmer: every ${search_cache_warm_interval}s over ${TMPDIR}"
else
    echo "search cache warmer: disabled (SEARCH_CACHE_WARM_INTERVAL_SECONDS=${search_cache_warm_interval})"
fi
# --- end ILL-441 ---
