# M9 — Inline embedding drop (cost cutover)

Goal: stop every `crystalMemories` doc read from dragging the 24 KB inline
`embedding`. The vector search moves to `crystalMemoryEmbeddings`, then the
inline field is dropped so doc hydration is cheap.

**Why phased:** dropping `crystalMemories.embedding` is irreversible and breaks
all recall if the side table isn't 100% populated first. Each phase is gated.

## Coverage — VERIFIED 100% (2026-07-09), but read this first

Coverage is **directly verified** by `verifySideTableCoverage` (scans the side
table, counts rows missing `userId`). As of 2026-07-09: `total 78865, missing 0`.

**The clean-pass streak gate (`getCutoverReadiness`) is NOT trustworthy** and
must not gate Phase C. A manual drive racing the cron shared the reconcile
cursor and produced a **false green at 97.85%**. Two root causes were fixed:
1. `reconcilePage` skipped rows whose parent memory had an empty inline
   embedding (cleared on content edit) *before* backfilling the existing
   side-table row's scalar → ~223 rows never scoped. Fixed: scalar-backfill the
   existing row before the empty-embedding skip.
2. **1,501 orphan rows** (parent memory deleted, but the side-table row lingered
   — memory delete does not cascade to `crystalMemoryEmbeddings`). Cleaned up by
   `backfillMissingSideTableScalars` (deletes orphans, patches live stragglers).

**Phase C precondition (MUST):** re-run `backfillMissingSideTableScalars` then
`verifySideTableCoverage` and require `missingUserId === 0` immediately before
dropping the inline field. Do NOT trust `getCutoverReadiness`.

**Phase B precondition (SHOULD):** make memory deletion cascade-delete the
`crystalMemoryEmbeddings` row, else orphans re-accumulate and coverage drifts
below 100% over time. Until then, the backfill tool doubles as orphan cleanup.

## Phase A — DONE (branch `feat/m9-embedding-cutover`)

- `crystalMemoryEmbeddings` gains `userId` + `knowledgeBaseId` scalar mirrors
  and a `by_embedding` vector index filtered on `[userId, knowledgeBaseId]`
  (the only filters any live vectorSearch uses — never `archived`, which is
  excluded post-hydration).
- All three writers (`reconcilePage`, `mcp.upsertEmbeddingTableRow`,
  `assets.upsertMemoryEmbedding`) populate the scalars.
- `reconcilePage` also **backfills** scalars onto rows copied before the
  columns existed, counted separately (`backfilled`) but folded into the
  clean-pass cutover gate.
- **Autonomous:** the reconcile cron drives coverage to 100% on its own. The
  gate (`getCutoverReadiness`) only goes green after 2 consecutive full passes
  with zero inserts AND zero backfills.

## Phase B — read switch (do when coverage is green; NOT before)

Gate behind `EMBEDDING_TABLE_AS_PRIMARY` (default false). Behind the flag:

1. Add a resolver `vectorSearchMemoryIds(ctx, {vector, limit, userId?, knowledgeBaseId?})`:
   flag ON → `ctx.vectorSearch("crystalMemoryEmbeddings", "by_embedding", …)`
   then map `row.memoryId`; flag OFF → current `crystalMemories` search.
   Returns uniform `[{ memoryId, score }]`.
2. Migrate the 5 vectorSearch sites: `recall.ts:~769`, `mcp.ts:~2054`,
   `knowledgeBases.ts:~2993`, `associations.ts:~314`, `consolidate.ts:~366`.
3. Migrate the stored-embedding **readers** (they use a memory's own embedding
   as a query vector / for copy) to read from the side table when flag ON:
   `associations.ts` (`source.embedding`), `consolidate.ts` (`episodic.embedding`),
   `organic/contradictions.ts:~743` (`targetMemory.embedding`),
   `adminKnowledgeBaseCopy.ts:~884` (already has a side-table fallback).
4. Migrate the write-clears (`memories.ts:~626`, `mcp.ts:~6125`,
   `if (contentChanged) patch.embedding = []`) to also clear/patch the side row.
5. **Parity check:** run vector search both ways for a sample of queries and
   assert identical top-K memoryIds before flipping the flag on.

## Phase C — drop the inline field (irreversible; last)

Only after B is live (flag ON) and parity verified:

1. Migration: patch every `crystalMemories` row to remove `embedding`
   (and `embeddingModel` if present). Full-table rewrite — one-time cost.
2. Remove `embedding` from the `crystalMemories` schema + delete its
   `by_embedding` vector index.
3. Turn off `MC_EMBEDDING_DUAL_WRITE_ENABLED` (nothing writes inline anymore).

## Coverage gate — the one hard rule

Do not run Phase C until `verifySideTableCoverage` reports `missingUserId: 0`
on a fresh run (after a fresh `backfillMissingSideTableScalars`). The
clean-pass streak (`getCutoverReadiness`) is advisory only — it false-greened
once. If coverage can't reach 100%, the inline field stays and we keep working
(higher cost) rather than break recall.
