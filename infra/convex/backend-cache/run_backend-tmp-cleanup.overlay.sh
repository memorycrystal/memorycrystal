# shellcheck shell=bash
# --- ILL-347: startup temp cleanup overlay (Memory Crystal) ---
# Upstream creates the search archive cache and the Node executor source dir
# with TempDir::new() under $TMPDIR, which run_backend.sh points at the
# persistent volume ($DATA_DIR/tmp). They are removed only on drop, so a
# killed, OOM'd or redeployed container strands them (up to
# CONVEX_SEARCH_ARCHIVE_CACHE_MIB each). This runs before the backend is
# exec'd, when no process in this container can hold an entry open.
if [ -d "$TMPDIR" ]; then
    removed_tmp_entries="$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -print | wc -l)"
    find "$TMPDIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    echo "startup temp cleanup: removed ${removed_tmp_entries} entries from ${TMPDIR}"
fi
# --- end ILL-347 ---
