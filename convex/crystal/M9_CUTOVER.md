# v0.9.0 durable-memory migration and vector cutover

This is a release-operator runbook, not evidence that Railway was migrated.
Historical Convex Cloud coverage and the old reconcile streak are invalid.
Every count, parity result, backup identifier, health reading, and approval must
come from the production Railway deployment during the separate release flow.

## Hard rules

- Never hard-delete authored or derived state before a fresh backup has a
  verified manifest SHA-256 and `leanMigration.begin` has bound the migration
  to that immutable backup ID.
- Run the authored-state migration on the intermediate schema where legacy
  Organic tables still exist. Final v0.9.0 intentionally removes them.
- Save every dry-run/page result and cursor. A retry resubmits the last cursor;
  `crystalLeanMigrationItems.by_source` prevents a second conversion.
- Any missing owner, invalid conflict, count error, orphan, duplicate, model or
  dimension mismatch fails the gate. Do not reinterpret missing tables as zero.
- Before temporarily holding both LTM indexes, confirm projected side-index
  headroom plus 20%. Abort on degraded health or RSS approaching 10 GB; do not
  raise the 12 GB cap.

## Phase 0 — baseline and backup

Record deploy/image, cron/index manifests, row counts, recall metrics, warm soak,
RSS, health, provider calls, egress, and cost. Create and verify a fresh backup
using the standard backup runbook. Record backup ID, manifest SHA-256, timestamp,
and restore target. Deploy the intermediate migration build with writes frozen
and crons quiescent, then call `leanMigration.begin` as admin.

Rollback: remove the intermediate deploy and unfreeze only if no apply page ran.
After apply, retain the backup and ledger; converted memories are additive and
tagged, so resume or remove only from the reviewed ledger.

## Phase A — dry-run and preserve authored state

For `organicIdeas`, `organicSkillSuggestions`, then `organicEnsembles`, call
`leanMigration.migrateAuthoredPage` with `dryRun:true`, starting at cursor null
and following `continueCursor` until `isDone`. Archive page counts and review
every error and invalid conflict.

Before changing phase, call the authenticated `leanMigration.recordAuthoredInventory`
action with no count arguments. It independently paginates all three live source
tables and persists the measured totals; `converting` is refused until this pass
finishes. Keep source writes frozen throughout inventory and conversion.

Set phase `converting`, repeat with `dryRun:false`. Each page atomically writes
its memory, unique item-ledger row, counters, and cursor marker, so resubmitting
the last cursor after an interruption skips already-ledgered rows. Apply pages
are refused after phase `verified`. Starred ideas become
same-owner semantic memories carrying the original row and
`migrated:organic-starred`. Accepted/modified skills reuse a valid same-owner
activated memory or become procedural memories. Only an explicit resolved
single-winner conflict with valid same-owner members and no contradictory
supersession is applied; other conflicts remain untouched and are reported.

Require per source: `source == converted + skipped + errors`, and `errors == 0`.
Inspect ledger targets, then set phase `verified`. The action independently
paginates the live item ledger and rejects a concurrent state revision before
committing the transition. Inventory, completed source enumeration, outcome
totals, and ledger totals must all match. Missing tables return `source_removed`
and fail this phase.

## Phase B — retire legacy state

Set phase `retiring_derived` with `approveDerivedRetirement:true`. This refuses
to proceed unless backup and authored counts reconcile. Page each allow-listed
table through `leanMigration.retireDerivedPage`; keep deletion counts/cursors.
Mixed authored/derived tables go last, after ledger targets are verified. Re-run
from null to prove zero remaining.

Do not delete explicit prospective triggers, durable provenance/source IDs,
checkpoints, KBs, assets, or research state.

Rollback: restore the verified backup and matching pre-migration deploy together.
Never combine a restored old database with the final schema.

## Phase C — temporary two-index vector gate

After removed indexes free RAM and the headroom gate is recorded, deploy an
intermediate schema containing both LTM indexes. Backfill exactly one side row
per active vectorized memory through `memoryVectors`; never restore the periodic
reconcile cron.

With writes still frozen, run `memoryVectorAudit.repairStaleSideRows` first with `dryRun:true`, then with
`dryRun:false` in bounded pages, saving each result and `continueCursor`. The
repair deletes side rows whose parent is missing, archived, or an active
unvectorized empty sentinel; it also collapses only byte-identical valid active
duplicates while preserving one canonical row. Divergent or malformed active
groups remain untouched and block cutover. Resume until `isDone:true`, restart
from cursor null to prove idempotence, then require a final dry-run to report
`archived:0`, `orphans:0`, `emptySentinels:0`, `duplicatesNormalized:0`,
`blockers:0`, and `deleted:0`.

Then run `memoryVectorAudit.reconcileIntermediateVectors`. This bounded pass
mirrors inline-only rows to the side table and side-only rows back to the
temporary inline field, while refusing duplicates, invalid vectors, scope
mismatches, payload mismatches, or vectorized memories missing both forms. It
exists only to make the intermediate dual-index snapshot complete; it is not a
replacement for the removed periodic reconcile worker.

Run `memoryVectorAudit.auditSideTable`. Require zero duplicates, orphans,
missing/mismatched owners, KB mismatch, model mismatch, and dimension mismatch.
Independently compare active-vectorized memory count to side-row count. Run
`verifyTopKParity` on the goldset plus at least 100 representative production
queries, or `verifyTopKParitySample` over sampled side rows; require `ok:true`
with `code:"ok"`. Record recall and RSS/health.

The parity gate is tie-, ANN- and hydration-aware (ILL-346). Strict ordered
top-K equality is reported as `legacyMatched` / `mismatchCount` / `mismatches`
for information only and never decides. For every query the gate fetches
`limit + 10` raw hits from each index, hydrates them with a reason for every
drop (`hydrationDropped` per side: `archived`, `owner`, `missing_side`,
`missing_memory`), truncates to `limit`, then rescores the union exactly
against the query with the side vector after requiring exactly one valid side
row per ID, a non-archived owner-matching memory row, and byte-identical
inline and side vectors (`vector_drift`). Each query is classified as
`exact_match`, `tie_equivalent` (order differs only inside equal-score groups,
ε = 1e-6), `side_better_or_equal`, `side_worse` (including a sampled self-hit
missing on the side only, `selfMissingSide`), or `coverage_gap`. `ok` requires
all of: (a) zero coverage gaps, which fail hard with `code:"coverage_gap"` and
counts in `gapReasons`; (b) mean side recall ≥ mean inline recall − 0.01;
(c) queries with side recall < 0.8 ≤ max(2, ceil(5% of checked));
(d) `side_worse` ≤ max(2, ceil(5% of checked)); (e) mean side exact cosine ≥
the inline value − 0.002. Any other failure reports `code:"quality_regression"`
with the failing checks in `failedChecks`. The thresholds are named constants
in `memoryVectorParity.ts` and are provisional until the post-deploy
distribution is recorded; retune them from that evidence, never waive them.

Amendment v2.1: sampled self-group hits have exact score ≥ 1 − ε. Let
`s_inline` and `s_side` count their occupied slots in each list. Exclude them
and evaluate `k′ = max(0, limit − max(s_inline, s_side))`, never subtracting
the distinct self IDs in the union. A self hit absent from both lists is
`self_missing_both`; an empty union before exclusions is `empty_union`.
Both are coverage gaps. A single empty list is classified `side_worse`.
For the remaining union, group sorted scores into maximal adjacent ε runs.
At `k_eff = min(k′, union size)`, separate groups strictly above the boundary
from its entire tie group. With `b = k_eff − |Above|`, recall is
`(|L ∩ Above| + min(|L ∩ Boundary|, b)) / k_eff`. Extra boundary hits cannot
replace better neighbours. When `k_eff = 0`, recall is null and excluded from
aggregates; valid self-only queries classify by the self rule. Cosine means
exclude self-group hits and use each list's first `min(k′, length)` neighbours.

Hydration is action-driven in batches of at most **3 raw hits** (thus at most
3 full memory documents, below the 8-document cap). Batches for one query now
run concurrently, with at most **8 batches in flight**; pages are aggregated
in batch order. Each hit can read one memory, one raw side row and two side rows
for duplicate detection. Even if **every document is 1 MiB**, each internal
query still reads at most **12,582,912 bytes (12 MiB)**, leaving 4 MiB below the
16 MiB transaction limit. Concurrency changes total action round trips only;
the per-transaction byte bound is unchanged. Source sampling uses the same
three-row bound, one pagination per query, with up to 834 pages per direction
(preserving the previous roughly 2,500-row scan cap). The action preserves
order, accounts for all raw drops, then truncates globally and deduplicates
validation gaps for the final union. No vectors or memory content leave
internal hydration; public reports contain aggregates and only
`verifyTopKParity` may include at most 20 legacy mismatch ID rows.

The operator driver independently recomputes checks (a)–(e). All class and gap
counters, checked/sample counts, recall statistics, cosine means, low-recall
count, code and failed checks must be present and valid; missing counters never
become zero. Class counts must sum to checked and zero gaps require zero gap
reasons. Neither `ok:true` nor an empty `failedChecks` overrides a failed
threshold. Null aggregates (including a sample containing only self groups)
keep the driver's cleanup gate closed; collect informative neighbour evidence.

Scope: this parity check is a **sampled tripwire** only (`coverageScope`). For
ILL-238's physical inline cleanup the required coverage gates remain
`auditSideTable`, the active-count equality check, and
`auditInlineEmbeddingsRemoved`; parity never substitutes for them.

After parity passes, run `stripInlineEmbeddings` first with `dryRun:true`, then
with `dryRun:false`, saving every result and `continueCursor`. The pass removes
an empty authored-migration sentinel only when `embeddingSource` is `none`; it
removes a real vector only when exactly one valid same-scope side row contains
the byte-identical vector. Any missing/duplicate/invalid/mismatched side row is
a hard stop. Re-run from cursor null idempotently, then run
`auditInlineEmbeddingsRemoved` and require `remaining:0` and `ok:true`. This is
the mandatory document-migration gate before Phase D removes the field from the
schema.

Rollback before final cutover: route reads back to inline vectors and remove the
temporary side index. Preserve side rows for diagnosis.

This phase must be its own deployable commit. That commit contains the optional
`crystalMemories.embedding` field and `crystalMemories.by_embedding` together
with `crystalMemoryEmbeddings.by_embedding` and `verifyTopKParity`. Deploy it,
run the action successfully, and attach the output before forming the cutover
commit. A source tree or history that removes the old index in the same commit
that introduces the parity action is not valid migration evidence.

## Phase D — irreversible final schema

Only after fresh Phase-C evidence and the zero-inline-field audit pass, route every retained vector lifecycle
operation through `memoryVectors`, then deploy final v0.9.0. The side index is
the sole LTM vector index; inline vectors, old index, dual-write/reconcile,
message vectors, and retired tables are absent. Repeat side audit, vector/cascade/
isolation tests, recall quality, warm soak, and resource checks. Set migration
phase `complete`; retain state, item ledger, and backup post-release.

Rollback after Phase D requires restoring the verified backup and previous
application/schema deploy as one unit. Code-only rollback cannot recreate data.

Form the later cutover commit by removing only the intermediate inline
`embedding` field/index and changing the two schema-contract tests back to
assert a single side-table index. Do not squash it into the Phase-C commit.

## Repository artifact versus live gates

The repository supplies fail-closed migration/audit functions, shared vector
access, final schema, tests, and this sequence. Production backup, Railway
counts, temporary-index RAM headroom, parity, soaks, deploys, mirrors, tags, and
releases remain reserved for `memory-crystal-release`.
