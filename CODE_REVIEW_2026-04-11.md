# Memory Crystal — Full Repo Code Review (2026-04-11)

> Full read-only audit of v0.7.8 working tree by 8 parallel code-reviewer agents plus targeted spot-checks.
> Use the checkboxes to track progress. Each finding lists file:line, what's wrong, and a concrete fix.

**Totals:** 7 CRITICAL · 32 HIGH · 48 MEDIUM · 28 LOW · ~115 findings.

**Verdict:** REQUEST CHANGES. CRITICALs + tenant-isolation HIGHs are release-blocking and should ship together.

---

## Suggested fix order

1. **Tenant-isolation bundle** — C7 + knowledgeHttp PATCH + `debugCheckScope` + `backfillScopeFromTitle`.
2. **C1** — per-user Gemini guardrail.
3. **C6** — organic LLM spend cap.
4. **C2 + C3** — `reembed` data-loss and infinite-reschedule.
5. **C4 + C5** — retention contract (STM expiry + cleanup pagination).
6. **SSE session hijack + module-level Map** (`apps/web/app/api/mcp/sse/route.ts`).
7. **Polar webhook metadata trust + checkout product-id fallbacks**.
8. **Plugin install shell/JS injection + non-atomic config writes + error-swallowing capture hooks**.
9. **Recall logic bugs** (trace log, prospective threshold, node boost, getNodesForMemories).
10. **Middleware protected-route matcher**.
11. **Sync-public fragile rewrites** — post-rewrite assertions.

---

## User-reported (1)

- [x] **Memory Crystal recall context floods the terminal** — FIXED 2026-04-11
  `plugins/shared/crystal-hooks.mjs:21-50, 220-255` + `plugin/recall-hook.js:177-220`
  The `UserPromptSubmit` hook was dumping unbounded `m.content` for every recalled memory into the hook's `additionalContext` block — pages of scrollback per turn. Fixes:
  1. `MEMORY_PREVIEW_CHARS = 280` — each memory's content is now truncated to a tweet-length preview with `…` ellipsis.
  2. `MAX_SURFACED_MEMORIES = 8` — extras are summarized as `_+N additional memories — expand via crystal_recall_`.
  3. `HOOK_DISPLAY_CEILING_CHARS = 8_000` — hard ceiling on the total injected context regardless of model window size. Previously the only limit was 15% of model context (~360KB for Claude Opus), which worked for the model but overwhelmed the terminal.
  4. Applied to both the Codex shared hook (`crystal-hooks.mjs`) and the OpenClaw `recall-hook.js` formatter.
  5. Live deploy: `~/.memory-crystal/crystal-hooks.mjs` + `~/.openclaw/extensions/crystal-memory/recall-hook.js` both updated so the fix takes effect on the next hook invocation.

## CRITICAL (7)

- [x] **C1 — Gemini guardrail is a single global counter, not per-user** — FIXED 2026-04-11
  `convex/schema.ts:856-867` + `convex/crystal/geminiGuardrail.ts:26-165`
  Added optional `userId` field and `by_user_date` index on `crystalGeminiDailyUsage`. All reads and writes now key on `(userId, dateKey)`. Calls without a userId land in a `_global` bucket so legacy paths still work. Regression test in `geminiGuardrail.test.ts` proves heavy-user starvation is fixed. Legacy pre-migration rows age out in one UTC day.

- [x] **C2 — `reembed` drops original text on Gemini failure and never retries** — FIXED 2026-04-11
  `convex/crystal/reembed.ts:205-494` (all three actions: memories, messages, assets)
  Added `retriesLeft` arg (default 2). When the table is drained and `failed > 0`, schedules a bounded retry pass with `cursor=undefined` — since the stale filter matches `embedding.length === STALE_DIM`, failed records still surface on the next scan. Retries decrement so a persistently broken Gemini endpoint cannot loop forever.

- [x] **C3 — `reembed` `done` flag can terminate before first batch and infinite-reschedule after table end** — FIXED 2026-04-11
  `convex/crystal/reembed.ts:258-268, 354-368, 433-447`
  Simplified the `done` condition to `tableDone` (drop the `totalFound <= limit` guard that spuriously rescheduled with a dead cursor). `nextCursor` is cleared when the table is drained. `continueCursor` is now always fresh when used.

- [x] **C4 — `expireOldMessages` only deletes 200 rows/day with no rescheduling** — FIXED 2026-04-11
  `convex/crystal/messages.ts:490-522`
  When a batch fills (`deleted === EXPIRE_MESSAGES_BATCH`), self-schedules a follow-up `runAfter(0, ...)` so retention converges within one cron tick regardless of backlog size. Keeps the 200-row cap per mutation to stay well inside Convex's per-transaction limits.

- [x] **C5 — `runCleanup` caps each user at 200 memories/day and silently defers the rest** — FIXED 2026-04-11
  `convex/crystal/cleanup.ts:19-32, 157-239`
  `getMemoriesForCleanup` now uses `by_user_created` ordered ASC so the oldest memories (the ones most likely to have expired) are reached first — previously the `by_user` index returned newest-first and any expired sensory row past position 200 was never seen. Added `anyDeferred` flag and a self-scheduled `runAfter(5s, ...)` continuation so retention converges without waiting for the next 24h cron.

- [x] **C6 — Organic subsystem has no per-user LLM spend cap** — FIXED 2026-04-11
  `convex/schema.ts:647-652` + `convex/crystal/organic/tick.ts:521-556, 707-734`
  Added `dailySpendCapUsd` optional field to `organicTickState`. New `getRolling24hSpendUsd` internalQuery sums `estimatedCostUsd` from `organicTickRuns` for the last 24 hours. `processUserTick` now short-circuits with `skipped: budget_exhausted` before any LLM work if the cap is reached. Also honours an env override `GLOBAL_ORGANIC_DAILY_SPEND_CAP_USD` (more restrictive wins). Per-call enforcement (inside label generation, contradictions, etc.) can be layered on later — the top-of-tick guard is the hot path and already prevents Live-mode (0ms) runaway.

- [x] **C7 — `vectorSearchUserFilter` can leak memories across tenants** — FIXED 2026-04-11
  `convex/crystal/organic/ensembles.ts:184-196` + all 5 call sites (ensembles.ts ×4 + contradictions.ts ×1)
  `getMemoriesByIds` now requires a `userId` arg and maps any row whose `userId !== args.userId` to `null`. All organic callers pass `userId` through. Belt-and-suspenders — the vector-index `filterFields` still carry `userId` today, but the post-fetch check prevents silent drift if that ever changes. All 269 tests green.

---

## HIGH (32)

### Tenant isolation / auth

- [x] **knowledgeHttp PATCH bypasses ownership check** — FIXED 2026-04-11
  `convex/crystal/knowledgeHttp.ts:227-253` + `convex/crystal/knowledgeBases.ts:741-770`
  HTTP handler now pre-checks ownership via `getKnowledgeBaseForUserInternal` and returns 404 on foreign IDs. `patchKnowledgeBaseInternal` now requires `userId` and re-verifies `knowledgeBase.userId === args.userId` before the patch. Regression test in `knowledge-bases.test.ts`.

- [x] **`backfillScopeFromTitle` scheduled from HTTP without userId** — FIXED 2026-04-11
  `convex/crystal/knowledgeBases.ts:1675-1705` + `convex/crystal/knowledgeHttp.ts:220-236`
  HTTP handler now pre-checks ownership before scheduling. Internal mutation now requires `userId`, verifies KB ownership, and re-verifies each memory's owner inside the loop. Regression test in `knowledge-bases.test.ts`.

- [x] **`debugCheckScope` is a public query with no ownership check** — FIXED 2026-04-11
  `convex/crystal/knowledgeBases.ts:1707-1726`
  Deleted outright. The debug wrapper had no legitimate use and was an info-disclosure vector.

- [x] **Polar webhook trusts `metadata.userId` when profile resolution fails** — FIXED 2026-04-11
  `convex/crystal/polarWebhook.ts:103-160`
  Cancellation / inactive events now REQUIRE profile resolution via Polar IDs — they refuse to trust `metadata.userId` and return `skipped: cancellation event with unverified userId`. Create/trialing/active events can still use metadata for first-link, but only when the resolved profile either has no existing `polarCustomerId` OR has one that matches the event. Mismatched customer IDs are rejected, closing the hijack vector.

- [x] **`resolveEffectiveUserId` silently returns actor on stray `asUserId`** — FIXED 2026-04-11
  `convex/crystal/impersonation.ts:55-77`
  Throws `"No impersonation session active"` when a non-null `asUserId` is passed but differs from `actorUserId` and no session exists. Self-referencing (`asUserId === actorUserId`) remains a silent no-op so shared UI plumbing can still pass the current user's id harmlessly. The `apiKeys.ts` role re-check during impersonation is deferred — fewer call sites now that the resolver throws.

- [x] **SSE session hijack — POST handler has no auth re-check** — FIXED 2026-04-11
  `apps/web/app/api/mcp/sse/route.ts:721-798`
  POST handler now requires `Authorization: Bearer <key>` and rejects with 401/403 unless the header matches the session's stored `apiKey`. A leaked sessionId can no longer be replayed by a different caller.

- [ ] **SSE sessions Map is not serverless-safe**
  `apps/web/app/api/mcp/sse/route.ts:73, 79-87`
  Module-level Map. Works on Railway (single persistent process) but silently breaks if ever deployed to Vercel/Edge.
  **Fix:** document single-process requirement in `railway.toml`/deployment notes, or move session state to Convex/Redis.

- [x] **Next.js middleware missing several protected routes** — FIXED 2026-04-11
  `apps/web/middleware.ts:7-30`
  Added `/knowledge`, `/account`, `/api-keys`, `/billing`, `/get-started`, `/organic`, `/telemetry` to the `isProtectedRoute` matcher. Unauthenticated requests are now server-side redirected to `/login?redirectTo=<intended>` so deep-link paths survive the bounce.

- [ ] **Dashboard layout drops deep-link path on sign-out** — partially addressed by middleware fix above. The client-side 2s timeout in `layout.tsx:160-167` is now only a fallback (middleware handles the primary case). Low-urgency cleanup remains.
  `apps/web/app/(dashboard)/layout.tsx:160-167`
  Remaining work: update the client-side fallback to also preserve `pathname` via `redirectTo`.

### Correctness / logic

- [x] **Trace log writes wrong trace ID after slicing** — FIXED 2026-04-11
  `convex/crystal/recall.ts:774-799, 891-917`
  Both `logRecallQuery` call sites now derive `traceHit` and `traceId` from `surfacedTrace = finalMemories.find(...)` rather than `traceMatches[0]._id`. The organic learning signal records the trace the user actually saw.

- [x] **Prospective traces bypass score threshold** — FIXED 2026-04-11
  `convex/crystal/recall.ts:691-702`
  Traces are now filtered by the same `>= 0.25` score cut used for the rest of the pipeline, AND the merged `[traces + normal]` set is score-sorted before slicing so a real high-scoring vector hit cannot be evicted by a low-confidence trace.

- [x] **Node boost applied after limit slice** — FIXED 2026-04-11
  `convex/crystal/recall.ts:649-686` + old post-slice block removed at former L754-783
  Graph boost now runs on `rankedFiltered` BEFORE the diversity filter and slice, so well-connected memories can actually promote into the top-N window. Copy-on-write spread ensures we don't mutate shared upstream objects. Old post-slice boost deleted.

- [x] **`getNodesForMemories` ownership check is a no-op** — FIXED 2026-04-11
  `convex/crystal/recall.ts:328-357`
  Ownership is now checked on BOTH sides of the link: `link.userId === args.userId` (previously ignored because we fetched the memory instead of the link row) AND `node.userId === args.userId`. The previous version re-fetched the memory that was already the lookup key, which was a tautology.

- [x] **Tag filter crashes on legacy rows without `tags`** — FIXED 2026-04-11
  `convex/crystal/memories.ts:341`
  Defensive `(memory.tags ?? []).includes(tag)` prevents TypeError on rows missing `tags`.

- [x] **`ttlDays === 0` makes messages expire immediately** — FIXED 2026-04-11
  `convex/crystal/messages.ts:210-233, 266-293`
  Both `logMessage` and `logMessageInternal` now treat a non-positive `ttlDays` (including 0) as "use the tier default". Previously `ttlDays=0` produced `expiresAt = now` and the next expire pass deleted the message. Retention contract now strictly tier-driven.

- [x] **Decay over-fetch doesn't order by last accessed** — FIXED 2026-04-11
  `convex/crystal/decay.ts:41-62, 182-193`
  `getMemoriesForDecay` now uses `by_last_accessed` ordered ASC so the oldest-accessed rows (the real decay tail) are reached first. Previously the unordered `by_user` index returned healthy rows in insertion order, and users with thousands of memories never converged. Also guards against negative `ageDays` from clock skew.

- [x] **Checkpoint take-before-sort is a no-op** — FIXED 2026-04-11
  `convex/crystal/checkpoints.ts:33-46`
  Switched to `by_last_accessed` ordered desc with `.filter(archived=false)`. The 12 snapshotted memories are now the actually-most-recently-accessed rows instead of a deterministic 12 from the head of the `by_user` index.

- [x] **`dependencyChain` dedupe collapses distinct paths** — FIXED 2026-04-11
  `convex/crystal/graphQuery.ts:647-680`
  Dedupe key now includes `relationType`, and evidence memory IDs are merged on collision instead of dropped. Max confidence wins across collisions. Distinct paths that happen to share a leaf label no longer lose their evidence.

- [x] **Legacy KB summaries render "Jan 01, 1970"** — FIXED 2026-04-11
  `convex/crystal/knowledgeBases.ts:385-405`
  `normalizeKnowledgeBaseSummary` now falls back to Convex's auto-populated `_creationTime` when neither `createdAt` nor `updatedAt` are set. Legacy rows sort correctly and render a real date.

- [x] **Infinite-scroll `hasMore` toggles on every subscription tick** — FIXED 2026-04-11
  `apps/web/app/(dashboard)/memories/page.tsx:92-116` + `messages/page.tsx:83-104`
  Both pages now compute `hasMore` from the authoritative `totalCount` (`nextRows.length < pageTotal`) when available, falling back to the old `pageRows.length === PAGE_SIZE` heuristic only when `totalCount` is missing. Re-deliveries of the final page after a mutation no longer flip `hasMore` back on, so the IntersectionObserver can't request `page+1` in a loop.

### Organic subsystem

- [x] **Tick stampede on Live mode** — FIXED 2026-04-11 (partial)
  `convex/crystal/organic/tick.ts:688-702`
  `recentRunDedup` window is now `Math.max(tickIntervalMs * 0.5, 1000)` so Live mode (0ms) retains a 1s dedup floor. Back-to-back duplicate ticks are rejected. The lease-ordering half of the fix (schedule before release) is deferred — that's a larger restructure.

- [x] **Empty centroid re-entry crashes Phase 2 loop** — FIXED 2026-04-11
  `convex/crystal/organic/ensembles.ts:528-562`
  Added an empty-centroid guard that archives the ensemble instead of calling `vectorSearch` with `[]`, plus a per-iteration try/catch around the neighbor search so one failure only skips its own ensemble instead of aborting the Phase 2 loop.

- [x] **Contradiction scan swallows LLM errors as "no contradiction"** — FIXED 2026-04-11
  `convex/crystal/organic/contradictions.ts:29-37, 73-85, 306-321, 411-430`
  Added `llmError` flag to `ContradictionResult`, an `llmErrors` counter in `scanContradictions`, and a `MAX_LLM_ERRORS_BEFORE_ABORT = 3` threshold. OpenRouter outages now short-circuit the scan with a loud warning instead of silently reporting zero finds while burning the full budget.

### Plugin / install

- [x] **Shell/JS injection in install script `node -e` fallback** — FIXED 2026-04-11
  `apps/web/public/install-codex-mcp.sh:264-320`
  `config.json` is now built via `node -e ... "$API_KEY" "$CONVEX_URL"` using `JSON.stringify` — no heredoc interpolation. The hooks.json fallback takes `HOOKS_FILE` and `HOOK_CMD` via `process.argv` instead of string interpolation. The dangerous inline TOML editor fallback was replaced with a graceful manual-fix message since the downloaded helper is the only path that's now used.

- [x] **`ensure-codex-hooks-flag.mjs` idempotency trips on comments/multi-line strings** — FIXED 2026-04-11
  `plugins/shared/ensure-codex-hooks-flag.mjs:1-108`
  New line-by-line scanner tracks `"""` / `'''` multi-line string state and strips inline `#` comments before matching the `[features]` header and `codex_hooks =` assignment. Regression tests cover commented-out assignments, string-literal values, and multi-line string traps.

- [x] **Non-atomic config.toml writes** — FIXED 2026-04-11
  `plugins/shared/ensure-codex-hooks-flag.mjs:96-105`
  All writes now go through `writeFileAtomic` which writes to `${path}.tmp.<pid>.<rand>` and `renameSync`s into place. Ctrl-C mid-write can no longer truncate a Codex config.

- [x] **`HOOK_CMD` breaks on paths with spaces** — FIXED 2026-04-11
  `apps/web/public/install-codex-mcp.sh:275`
  `HOOK_CMD="node \"$CRYSTAL_DIR/crystal-hooks.mjs\""` — the script path is now quoted so paths containing spaces (e.g. `/Users/First Last/`) survive Codex's whitespace command splitter.

- [x] **Capture hooks swallow all errors silently** — FIXED 2026-04-11
  `plugin/capture-hook.js:99-134` + `plugins/shared/crystal-hooks.mjs:82-150`
  Both the OpenClaw and Codex capture paths now call a rate-limited `reportHookError`/`reportCaptureError` reporter that writes one stderr stanza per (context, detail) per minute. 401/429/5xx are surfaced explicitly — silent memory loss is no longer possible on a broken backend. Still fire-and-forget so the host is never blocked.

- [x] **`handler.js` uses `spawnSync` on `llm_output`** — FIXED 2026-04-11 (partial)
  `plugin/handler.js:115-134, 150-170`
  Added `timeout: 10_000` + `killSignal: "SIGKILL"` to both `spawnSync` calls. A hung capture or recall child can no longer lock the OpenClaw gateway thread indefinitely — on timeout the child is killed and the caller falls through to an empty result (user message still goes through). A full async rewrite is deferred because this module is marked LEGACY and any async refactor risks breaking backwards compat for older OpenClaw installations.

### MCP server

- [x] **Obsidian path traversal via `memory.store`** — FIXED 2026-04-11
  `mcp-server/src/lib/obsidian.ts:1-94`
  Added `VALID_STORES` enum guard (rejects any value outside the 5 canonical stores), `path.resolve` + prefix check on the directory, and a second prefix check on the final filename. `..` traversal is no longer reachable from any caller.

- [x] **Obsidian YAML frontmatter injection** — FIXED 2026-04-11
  `mcp-server/src/lib/obsidian.ts:64-94`
  Every string scalar is now written via `JSON.stringify` (valid YAML scalar syntax with full escaping). `id` is asserted against `/^[A-Za-z0-9_-]+$/` before use. Numeric fields go through `Number()` so a garbage input becomes `NaN` instead of injecting YAML keys. Newlines, colons, and `---` in memory fields can no longer break the frontmatter block.

- [x] **MCP server HTTP client drops API-key auth** — FIXED 2026-04-11 (partial)
  `mcp-server/src/lib/convexClient.ts:38-65` + `mcp-server/src/tools/recall.ts:257-325` + `mcp-server/src/tools/wake.ts:61-69`
  Added `hasApiKeyAuth()` helper that detects API-key auth from env OR request context. `recall.ts` and `wake.ts` now route through the HTTP `ConvexClient` (which carries the API key as a bearer token) when `hasApiKeyAuth()` is true, and only fall through to the JWT-only SDK client otherwise. The remaining 9 tool files (`what-do-i-know`, `why-did-we`, `explain-connection`, `dependency-chain`, `stats`, `preflight`, `recent`, `search-messages`, `who-owns`) still fall through — follow-up work is tracked below.

### Scanning / purge

- [x] **`morrowPurge` unbounded `.collect()`** — FIXED 2026-04-11 (hardened)
  `convex/crystal/morrowPurge.ts:256-330`
  Every `.collect()` in `scanCandidates` is now capped at `SCAN_ROW_CAP = 10_000` via `.take(...)` plus a `warn()` helper that logs `[morrowPurge.scanCandidates] hit SCAN_ROW_CAP` when the cap is reached. Power users over the cap trigger a loud warning instructing the operator to run with a shorter window instead of silently aborting mid-query. A full `paginate()` rewrite is still tracked as a follow-up for 10k+ per-user scans, but the current fix prevents data-corruption-style half-applied purges.

- [x] **`emergencyMorrowPurge.execute` is client-callable** — FIXED 2026-04-11 (partial)
  `convex/crystal/emergencyMorrowPurge.ts:1, 128-173`
  Converted `dryRun` from `query` → `internalQuery` and `execute` from `mutation` → `internalMutation`. Both now require `npx convex run` (deploy-key gated) and cannot be called from a public Convex client — even with a leaked `EMERGENCY_MORROW_PURGE_SECRET`. The zombie-graph-record half of the fix (delegating to `morrowPurge.applyPurgePlan`) is still a follow-up.

- [x] **Email crons silently drop users past 5000** — FIXED 2026-04-11
  `convex/crystal/emailCrons.ts:1-121, 146-260`
  Added paginated `listTrialingProfilesPage`, `listAllProfilesPage`, `listApiKeysByUserPage`, `listDashboardTotalsPage` queries (500 rows per page) and a `collectAllPages` helper. All three email cron actions (`checkTrialReminders`, `checkTrialExpired`, `checkEngagement`) now loop through every page instead of capping at the first 5000 rows.

- [x] **`sensoryPurge` cursor ties bug** — FIXED 2026-04-11
  `convex/crystal/sensoryPurge.ts:86-114, 138-200, 205-260`
  `scanMemoryPage` now uses Convex's opaque `paginate()` API which correctly handles rows sharing the same `createdAt` millisecond. Both `purgeSensoryNoise` and `purgeNoisyConversationLogs` callers loop with the opaque cursor instead of the DIY `gt("createdAt", ...)` pattern. Ties at page boundaries no longer skip or re-scan rows.

### Public mirror

- [x] **`sync-public.mjs` silently fails on format drift** — FIXED 2026-04-11
  `scripts/sync-public.mjs:273-330`
  Added a `postRewriteChecks` pass that `grep`s each rewritten file for tokens that MUST have been stripped (`polarSubscriptionId`, `subscriptionStatus:`, `./dashboardTotals`, `getDashboardTotals(`, `polarWebhook`, etc.). The push is aborted with a clear error and the list of leaking files if any check fails. Drift now produces a loud failure instead of silently shipping billing code to the public mirror.

---

## MEDIUM (48 — summary groups)

- [ ] **Recall/memory** — recall cross-user node leak (`recall.ts:540`), dead `channel ? 8 : 5` multiplier (`sessions.ts:109`), `stmEmbedder.ts:57` dimension constant possibly mismatched with schema, `reflection.ts:418` inserts empty embedding before scheduler completes.
- [ ] **Graph/knowledge** — `graph.ts:357-358` associations query missing `by_user` index; `graphQuery.ts:103-159` relations truncated at 200 with no flag; `graph.ts:194-197` capped status counts shown as exact; `knowledgeBases.ts:299-306` filter-after-pagination; `evalStats.ts:312-334` cursor ties; `patchKnowledgeBaseInternal:759-761` `.trim() || foo` preserves empty strings.
- [ ] **Organic** — `policyTuner.ts:510-560` claim ordering race; `ensembles.ts:310-314` multi-ensemble membership ambiguity; `traces.ts:198-222` batch-100 prune with no follow-up; `skillSuggestions.ts:471-482` 100-wide `embedText` fan-out per tick; `tick.ts:1208-1217` 50-row scan for conversation trigger; `tick.ts:789-791, 833` two swallowed-error catches.
- [ ] **MCP server** — SSE transport race on concurrent `/sse` replacing `activeTransport` without await; `checkpoint.ts:91-97` unvalidated `memoryIds` array elements; `import-knowledge.ts:72-78` unchecked `as any` on chunks; leaky error messages in every tool catch block; global `cachedSdkClient` cross-tenant risk.
- [ ] **Peripherals** — `morrowPurge.executePurge:641-656` reports `remaining` but never retries; `cleanup.ts:113-120` association delete capped at 200 per memory; `contentScanner.ts:82` param mutation without returning normalized form; `emailEngine.interpolate` leaks `{{variable}}` literals and doesn't escape subject line; `emailTemplates.listEmailLogs:164` reads entire log table.
- [ ] **Plugin/install** — `curl | bash` with no SRI/checksums; no cleanup trap on failure; env var leakage via `loadRuntimeEnv`; `recall-hook.js:15-38` dead session dedup cache.
- [ ] **Auth/billing** — impersonation sessions never expire; manager→admin escalation via pre-promotion impersonation; `getAuthMethodsForEmail` is an email-enumeration oracle; `authorizeSession` has no rate limit on Convex path; `polarWebhook.ts:60-63` `btoa(secret)` may double-encode.
- [ ] **Web** — auth flow race conditions in login/signup; `mcp-auth` proxy drops cookie forwarding; knowledge page still missing null guards on `memory.title`/`memory.content` in expanded view; `as any` cast on `importChunks` action import.

---

## LOW (28 — selected)

- [ ] `convex/auth.ts:20-22` OTP generation has modulo bias (`buf[0] % 900000`).
- [ ] `convex/email.ts:37, 117` `${code}` interpolated into HTML without escaping (safe today — numeric code).
- [x] `apps/web/app/api/polar/checkout/route.ts:7-13` hardcoded PROD product IDs as env fallbacks — misconfigured staging silently charges against prod. **FIXED 2026-04-11** — removed hard-coded fallbacks; missing env vars now short-circuit to `/pricing?checkoutError=config`.
- [ ] `apps/web/app/api/polar/checkout/route.ts:43-45` silent catch on auth lookup — orphan subscription risk combined with webhook metadata trust.
- [ ] `convex/crystal/temporalParser.ts:122-124` "last Monday" off-by-one when today is Monday.
- [ ] `convex/crystal/wake.ts:197`, `knowledgeHttp.ts:211`, `recent.ts:72`, `ideas.ts:66` missing `Number.isFinite`/bounds.
- [ ] `convex/crystal/organic/tick.ts:1382` `triggerConversationPulse` doesn't pass per-user `openrouterApiKey` — silent billing leak.
- [ ] `mcp-server/src/tools/index.ts:6` module-level `new ConvexClient()` throws at import time if env missing.
- [ ] `apps/web/app/api/contact/route.ts:124-127` leaks SendGrid upstream error text to unauthenticated callers.
- [ ] `scripts/sync-public.mjs:297` `git commit -m` interpolates source commit message — breaks on `"` or `$()`.
- [ ] `plugin/index.js` ~15 empty `catch (_) {}` blocks swallow all errors.
- [ ] `convex/crystal/temporalParser.ts:122-124` off-by-one on "last Monday".
- [ ] `convex/crystal/assets.ts:232-238` `listUnembeddedAssets` takes 100 but cron caps at 20.
- [ ] `convex/crystal/consolidate.ts:221-226` vector search inside per-memory loop.
- [ ] `convex/crystal/messages.ts:420` `score: lexicalScore > 0 ? lexicalScore + 1 : 1` discards zero distinction.
- [ ] `convex/crystal/decay.ts:186` `Math.exp(-0.05 * ageDays)` not guarded against negative `ageDays`.
- [ ] `convex/crystal/graphEnrich.ts:374-378` `by_user` index ordering is undefined — use `by_user_created`.
- [ ] `convex/crystal/associations.ts:256-276` `ctx.vectorSearch` with unchecked `source.embedding` may throw on empty.

---

## Positive observations (selected)

- Tenant isolation is applied at every vector-search post-fetch (belt-and-suspenders).
- `recallRanking.ts:72-77` properly handles `NaN`/`Infinity` via `clamp01`.
- API key verification uses indexed hash lookup — no raw-key compare, no timing leak.
- Device flow clears `apiKey` from DB immediately after retrieval.
- `snapshots.createSnapshot` validates role + content with clear per-index errors.
- `normalizeTotals` clamps every number to ≥0, preventing negative-count bugs.
- Circuit breakers in `backfillKBEmbeddings` and `backfillGraphEnrichment` are correct.
- `contentScanner.ts` uses NFKC normalization before regex matching.
- `sanitize.ts` prompt-injection defense applied consistently across recall tools.
- Shared plugin copies (`plugins/shared/` vs `apps/web/public/plugins/shared/`) are byte-identical.
- Install script validates existing API key before reuse.
- Memories pagination uses dedup-by-id when merging pages.
