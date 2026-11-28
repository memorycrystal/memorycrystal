---
name: crystal-architect
description: Document a codebase into a Memory Crystal knowledge base with re-runnable, self-updating architecture notes. Use when asked to "document this repo", "architect notes", or to refresh existing architecture documentation in memory.
---

# Crystal Architect

Turn the current repository into a maintained KB of architecture notes that
future sessions (and other agents) can query. Re-running refreshes in place —
never duplicates.

## Rules

- KB name: `Architecture: <repo-name>` (create once via
  `crystal_create_knowledge_base`; find it first with `crystal_list_knowledge_bases`).
- Every chunk uses a deterministic dedupeKey:
  - `arch:overview` — one chunk: purpose, stack, layout, entry points.
  - `arch:<relative-dir-or-module>` — one chunk per major module/directory.
  - `arch:decisions` — key architectural decisions and their whys.
- Chunks are SUMMARIES in your own words (what it does, key files, contracts,
  gotchas) — never raw file dumps. Keep each chunk under ~4,000 characters.
- Bound the corpus: cover the top-level modules and load-bearing subsystems,
  not every file. Target 10-40 chunks for a typical repo. State what you
  deliberately skipped in `arch:overview`.

## Procedure

1. Orient: list the repo tree (top 2 levels), read the README/docs entry
   points, identify module boundaries.
2. `crystal_list_knowledge_bases` — reuse the existing Architecture KB if
   present; note existing chunks via `crystal_list_knowledge_base_memories`.
3. Write/refresh chunks via `crystal_import_knowledge` with the dedupeKeys
   above. Unchanged modules may be skipped; changed ones get re-imported
   (same key → in-place update).
4. Verify: enumerate the KB — every chunk has an `arch:*` dedupeKey and the
   count matches your plan. Re-running immediately must not change the count.
5. Save one conversational memory (`crystal_remember`) noting the KB name and
   that architecture notes live there, so plain recall can route future
   questions to `crystal_query_knowledge_base`.
