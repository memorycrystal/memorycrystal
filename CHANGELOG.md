# Changelog

All notable changes to Memory Crystal are documented here.

## Unreleased

No unreleased changes.

## [0.8.0] — 2026-04-25

### Major — Local Convex developer backend

- Docker-primary local Convex is now a first-class developer workflow. `infra/convex/docker-compose.yml` starts a pinned self-hosted Convex backend, HTTP-actions endpoint, and dashboard on ports `3210`, `3211`, and `6791`, with version pins recorded in `infra/convex/VERSIONS.md`.
- Root `npm run convex:local:*` commands now cover `up`, `down`, `reset`, `doctor`, `seed`, auth-key provisioning, deployment-env provisioning, and per-consumer env overlay writing.
- Managed local overlays retarget the web app, MCP server, scripts, and OpenClaw plugin together while preserving production/cloud defaults. `scripts/crystal-enable.sh` now detects `CRYSTAL_BACKEND=local` and propagates the local HTTP-actions URL and bearer token to plugin config.
- Local seed fixtures and canaries provide deterministic Memory Crystal data for local vector-search validation without touching production. The seed path supports dry-run validation, explicit local-backend checks, fixture embeddings, and a gated vector divergence test.
- Local side-effect guards now include deployment-env stubs and dry-run email logging so local crons/actions can be exercised without sending real email or relying on live production credentials.
- `docs/LOCAL_DEV.md` documents setup, seeding, health checks, rollback to cloud defaults, troubleshooting, and version-pin updates for contributors who want local Convex.

### Included from the 0.7.17 capture-observability lane

#### Added — Capture observability

- `crystal_capture_stalled` telemetry. Plugin tracks per-session pending user messages and emits to the new `POST /api/mcp/metric` endpoint when a session accumulates more than the calibrated `N_pending` unpaired messages for longer than `T_age` minutes. Signal lands in the new `crystalTelemetry` Convex table for dashboard querying. Groundwork for a follow-up structural fix to LTM extraction on listener/router gateways.
- `crystal-doctor --smoke` full callback dump. Lists every registered callback name + count, distinguishing "hook registered but never fires" from "hook not registered."

#### Fixed — Pre-existing dual-fire duplicates

- Assistant-side `logMessage` now dedupes within the plugin via an in-memory LRU keyed by `(sessionKey, sha1(assistText))`. Gateways that fire both `llm_output` and `message_sent` for the same assistant turn no longer write duplicate `crystalMessages` rows. No schema change.

#### Compatibility

No breaking changes. 0.7.17 plugin against a 0.7.16-era backend swallows the `/api/mcp/metric` 404 silently; STM capture and LTM extraction paths are unchanged. Mixed fleet note: tenants with both 0.7.16 and 0.7.17 installs active will still have historical duplicates from the pre-LRU era in `crystalMessages`; a follow-up backfill will dedupe via content hash.

### Included hardening since 0.7.18

- JSONL first-turn recovery now has documented operator tooling: `crystal-doctor` flags recent transcripts with `SessionStart` but no `UserPromptSubmit`, and the dry-run `crystal-backfill-from-jsonl.mjs` utility can recover reviewed Claude Code first turns through backend-deduped MCP writes.
- Release automation now requires guarded annotated release tags for approved versions, so `v0.8.0` and future tags are part of the release contract.

### Compatibility

Production and the managed Convex cloud workflow remain the default. The local backend path is opt-in and additive; no existing installed plugin needs to switch unless the operator chooses local/self-hosted development.

## [0.7.18] — 2026-04-25

### Fixed — Capture telemetry retention and validation

- `crystalTelemetry` now carries an expiry timestamp, the daily cleanup job removes expired telemetry rows, and `/api/mcp/metric` validates metric kind, payload size, and scope length before insert. Audit metadata records payload bytes without storing the payload itself.
- Assistant-message dedupe refreshes LRU recency before pruning, so active sessions keep their duplicate guard entry while older entries age out first.

### Fixed — Organic contradiction flow

- Organic tick processing now waits for ensemble writes before contradiction scanning while keeping resonance and procedural extraction independent. Recently resolved conflict pairs act as a 30-day cooldown gate, and the daily contradiction alert budget is checked before expensive LLM work.

### Fixed — MCP contradiction passthrough

- `crystal_remember`, `crystal_update`, `crystal_edit`, and `crystal_supersede` now preserve backend `contradiction` and `contradictionCheck` metadata in runtime MCP responses. The hosted streamable HTTP MCP server shares the same structured/text result helper so contradiction metadata reaches clients consistently.

### Changed — Release and dashboard hygiene

- Brain dashboard loading now uses the full page skeleton instead of a small centered placeholder.
- Public mirror sync now treats the private `packages/` workspace as excluded content; the public mirror contract remains `apps/docs/`, `convex/`, `plugin/`, `mcp-server/`, and `shared/`.

### Scoped deferral — LTM extraction/backfill

This release is a hardening patch; the structural LTM extraction/content-hash backfill remains deferred to a follow-up release so the release notes do not silently overclaim this patch.

## [0.7.16] — 2026-04-21

### Infrastructure (amended 2026-04-21)

- **Default Convex HTTP host updated to `https://convex.memorycrystal.ai`.** OAuth consent, MCP endpoints, and the plugin's default `convexUrl` now use the Memory Crystal custom domain instead of the Convex-generated `rightful-mockingbird-389.convex.site` subdomain. **Existing installs require no action** — Convex keeps the old subdomain active indefinitely, so plugins already in the field continue to work; they organically upgrade on next installer run. OAuth provider callback URIs accept both hosts during a 2-week transition, after which the old URI is removed from Google/GitHub consoles.

### Security (amended 2026-04-21)

Patches 10 Dependabot advisories (2 HIGH, 8 MEDIUM) via transitive dependency pins in the root `package.json` `overrides` block. **Supply-chain hygiene — no runtime exposure confirmed.** Call-graph trace of `@modelcontextprotocol/sdk@1.29.0` found no `getCookie`/`setCookie`/`hono/cookie` imports in production paths. The MCP SDK's `streamableHttp` transport imports `getRequestListener` from `@hono/node-server`, but Memory Crystal does not invoke `serveStatic` (CVE-2026-39406), `toSSG` (CVE-2026-39408), `ipRestriction` (CVE-2026-39409), the `hono` cookie helpers (CVE-2026-39410), or the `vite` dev server (CVE-2026-39363/39364/39365). Released for clean advisory baseline.

- **vite 7.3.1 → 7.3.2** — GHSA-p9ff-h696-f583 (CVE-2026-39363 dev server WebSocket file read), GHSA-v2wj-q39q-566r (CVE-2026-39364 `server.fs.deny` bypass), CVE-2026-39365 (path traversal in optimized deps `.map`)
- **hono 4.12.9 → 4.12.14** — CVE-2026-39407 (repeated-slash middleware bypass in `serveStatic`), CVE-2026-39408 (path traversal in `toSSG`), CVE-2026-39409 (IPv4-mapped-IPv6 matching in `ipRestriction`), CVE-2026-39410 (non-breaking-space prefix bypass in `getCookie`), missing cookie-name validation in `setCookie`, GHSA-458j-xx4x-4375 (JSX SSR HTML injection)
- **@hono/node-server 1.19.11 → 1.19.13** — CVE-2026-39406 (repeated-slash middleware bypass in `serveStatic`)

Pulled via `@modelcontextprotocol/sdk` (hono family) and `vitest` (vite). Applied via root `package.json` `overrides` because npm workspaces + existing lockfile refuse to bump a satisfied transitive without an override hint. No version bump — lockfile-only change against the existing 0.7.16 release.

### Cost controls and memory mutation tools

- **Convex bandwidth mitigation.** Trigger lookup now uses indexed trigger rows instead of broad memory scans, and production trigger backfill is resumable across users and memory pages.
- **Organic Pulse Engine guardrails.** Organic scheduled pulse intervals now clamp to one hour or longer, with supported tiers of 1h, 2h, 4h, 8h, 12h, and 24h. Faster legacy tiers are shown disabled in the dashboard.
- **Per-user Pulse Engine toggle.** Each user can pause or resume their own Organic Pulse Engine without affecting other tenants; scheduled and conversation pulses respect the per-user enabled flag.
- **Maintenance read reductions.** Duplicate checks, salience promotion, consolidation, and decay now use targeted indexes/read budgets to reduce Convex database bandwidth.
- **Native memory update and supersede tools.** Added first-class `crystal_update` and `crystal_supersede` / `crystal_supercede` tool surfaces, with atomic successor creation, old-memory archival, and queryable lineage fields.

## [0.7.15] — 2026-04-19

### Peer isolation hardening

- **Peer-first `guardChannel` fallback.** Recall, session KB listing, MCP filter-visible-memories, and both knowledge-base query paths (`runKnowledgeBaseQuery`, `getKBMemoriesInternal`) no longer fall back to `MANAGEMENT_CHANNEL_SENTINEL` when a peer caller omits `channel`. Missing channel now fails-closed on KBs with a concrete peer scope instead of silently upgrading to management-level visibility. This closes the `?? MANAGEMENT_CHANNEL_SENTINEL` bypass pattern the existing guard comment warned against.
- **`getKBMemoriesInternal` chunk-level peer scope filter.** The internal KB-chunk reader now mirrors `runKnowledgeBaseQuery`'s admission rules — trailing-colon channels fail closed, candidates are over-fetched and post-filtered by peer so permissive shared KBs no longer leak cross-peer chunks on `by_knowledge_base` index reads.
- **Shared-mode agent writes distinguish agents under the same scope.** When `agentScopePolicies` marks `mode: "shared"`, `crystal_remember` now resolves the write channel to `scope:main-<agentId>` so two shared agents under the same scope stop bleeding captures into one bucket. Read path uses the same resolution for symmetry. Single-shared-agent installs stay on `scope:main` (backward compatible).
- **KB-scoped BM25 candidate pool.** `runKnowledgeBaseQuery` now forwards `knowledgeBaseId` into `searchMemoriesByText`; lexical candidates are filtered to the target KB instead of competing with the user's entire corpus.

### MCP server hardening

- **API-key paths forward `channel` filter.** `crystal_why_did_we`, `crystal_who_owns`, `crystal_dependency_chain`, and `crystal_explain_connection` now forward `channel` on the API-key / HTTP recall branch. Hosted MCP consumers previously saw unscoped, cross-channel results from these four tools.
- **Server-side error logs sanitized.** `crystal_recall`, `crystal_trace`, and the HTTP listener run error messages through an inline redactor that scrubs Bearer tokens, `sk-*` keys, and `?api_key=/?token=/?secret=` query-string values before writing to stderr.
- **`stdio` is the default MCP mode.** `CRYSTAL_MCP_MODE` defaults to `stdio` to match common client expectations (Claude Code, Codex CLI). Operators who want the HTTP listener must set `CRYSTAL_MCP_MODE=http` explicitly.
- **Obsidian writer hardened.** Category is now validated against the Convex enum, and filenames include the memory `id` suffix to prevent same-millisecond slug collisions from silently overwriting prior notes.
- **No-context Convex client cached.** In stdio mode the HTTP client is cached at module scope instead of being reconstructed on every tool call.

### Plugin hardening

- **Pressure-log Maps bounded.** `pressureEventState` and `hostCompactState` now evict via a stale-first / oldest-first policy when they exceed `MAX_SESSION_MAP_SIZE=500`, with `PRESSURE_STATE_MAX_AGE_MS=2h` staleness. Closes a slow heap-growth path on long-lived gateway processes.
- **Normalized agent-scope policies cached.** `normalizeAgentScopePolicies` memoizes its Map via a WeakMap keyed by the plugin config object, so repeated per-turn channel resolution reuses the cached map instead of rebuilding.
- **`crystal_search_messages` forwards `agentId`.** Parity with `memory_search` for agent-scoped routing.
- **Memory-formatter regex footgun removed.** `SENTENCE_BOUNDARY_RE` lives inside `truncateMemoryContent` (fresh regex per call), eliminating the stateful `/g` module-scope regex.

### Web hardening

- **`/api/mcp-auth` proxy no longer forwards `cookie` / `set-cookie`.** The proxy uses `Authorization: Bearer` only; blanket cookie forwarding created a confused-deputy credential-relay risk that the updated allowlist rules out. Future cookie needs must be explicitly allowlisted by name.
- **Polar checkout `plan` param validated against an allowlist** (`free`, `pro`, `ultra`, `starter`) before `PRODUCT_IDS` lookup. Invalid plans redirect to `/pricing?checkoutError=config` without reflecting the attacker-supplied plan value.
- **Login `redirectTo` guard.** The login page now rejects any `redirectTo` that does not start with a single `/` (blocks `//`, `/\\`, and non-relative paths) and falls back to `/dashboard`.
- **Install-assets allowlist pruned.** Removed `openclaw-hook.json` dead entry.

### DevEx / operational hardening

- **`morrowPurge.scanCandidates` bounded.** Previously unbounded `.collect()` calls on `crystalWakeState`, `crystalNodes`, `crystalRelations`, `organicEnsembles`, `organicEnsembleMemberships`, `organicProspectiveTraces`, `organicTickState` (plus cutoff-bounded `organicIdeas`, `organicSkillSuggestions`, `organicRecallLog`) now `.take(SCAN_ROW_CAP)` with a `warn()` when the cap is hit, matching the existing pattern for `crystalMemories`/`crystalMessages` scans.
- **`kbCounterReconcile` uses the full composite-index predicate.** `countKnowledgeBaseChunksPage` now scopes by `(knowledgeBaseId, userId, archived)` instead of scan-and-filter. TOCTOU window between read and patch is documented in the module header.

## [0.7.14] — 2026-04-16

### Memory / peer isolation hardening

- **Stricter per-user knowledge-base isolation.** Knowledge bases attached to peer-capable agents (e.g. Telegram coach bots) now enforce strict per-peer scoping by default. Tenants relying on cross-peer shared KBs on peer-capable agents must opt-in via the new `peerScopePolicy: "permissive"` flag. See migration notes.
- **New `kbPeerScopeBackfill` migration** — run `npx convex run crystal/migrations/kbPeerScopeBackfill '{}'` to inspect peer-capable KBs lacking scope and flag them for review. Backfill completed in staging.
- **Observability metrics added** — `mc.metric.kb-peer-block` and `mc.metric.kb-chunk-drop` emit at guard/filter boundaries; metrics route through minimal `metric()` helper at `convex/crystal/metrics.ts` with structured `[mc.metric]` log prefix for Convex log drain.
- **Kill-switch available** — setting env `MC_KB_PEER_STRICT=false` on the Convex deployment reverts to legacy (agentIds-only) visibility behavior without redeploy. Default (unset) is strict — this is the posture operators need.

### Knowledge base correctness fixes

- **KB counter drift fixed.** `archiveKnowledgeBaseMemoryInternal` now decrements the parent KB's `memoryCount` and `totalChars` on archive. Previously every per-memory archive (including `deleteKnowledgeBase`) leaked counter state, leading to inflated metadata over time.
- **KB vector recall scoped at the index.** `runKnowledgeBaseQuery` now filters the `crystalMemories.by_embedding` vector search by `knowledgeBaseId` and `archived=false`. Previously the top-N nearest-neighbor search ran across the whole user corpus and small KB chunks were crowded out before the post-filter ran, collapsing `vectorScore` to 0 for legitimate KB hits on accounts with thousands of memories.
- **One-shot reconciliation tool.** New `crystal/kbCounterReconcile:reconcileAllKnowledgeBases` action with `applyMode: "dry-run" | "apply"`. Paginated and safe to re-run; reports drift and worst offenders before patching. Used to repair historical drift in prod.
- **`crystal_trace` reason wording.** Memories written via direct API (e.g. `crystal_remember`) used to be reported as "predates conversation tracking"; the handler now distinguishes direct-API writes (`source=external|cron|observation|inference`) from genuinely pre-tracking memories.

## [0.7.13] — 2026-04-15

### Plugin / per-turn recall unblocked

- **Per-turn Convex recall now fires in `reduced` mode** — `assemble()` previously gated the Convex-backed recall on `mode === "full"`, which meant every default install (`localStoreEnabled: false`) silently dropped per-turn memory injection and answered from training-data inference instead. Only `"hook-only"` should skip recall; `"reduced"` and `"full"` now both fetch. Extracted the decision into `shouldFetchConvexContext(mode)` with a regression test (`plugin/recall-mode.test.js`) so this can't return silently.

### Plugin / context-engine stability

- **Hard assemble-path injection ceiling** — `assemble()` enforces `ASSEMBLE_MAX_INJECTION_CHARS = 12_000` across the injected system context + local messages combined. Oldest local messages drop first, then `convexContext` is truncated. Prevents runaway per-turn growth on hot long-lived sessions regardless of host compaction behavior.
- **Tier-aware per-memory cap with sentence-boundary slicing** — recall content caps at 1200 chars for knowledge-base chunks (book/course/podcast excerpts) and 600 chars for auto-extracted notes, replacing the previous flat 350-char trim. Truncation prefers paragraph breaks and sentence terminators (`.`, `!`, `?`) inside the cap window so KB definitions no longer end mid-sentence.
- **Transient-channel metadata** — `assemble()` returns additive `contextUsage: { crystalInjectedChars, crystalInjectedMessageCount, ephemeral: true }` alongside the existing `{messages, used}` contract. Hosts that honor it can exclude Crystal injection from session persistence; no-op if the host ignores.
- **Rate-limited pressure telemetry** — new `plugin/pressure-log.js` emits one `crystal_pressure` log line per session per minute when injection is trimmed or exceeds 60% of the ceiling. Schema includes `hostCompactInvoked` + `hostCompactTokensReclaimed` so we can attribute whether the host compaction trigger fired at all.

### Plugin / safer defaults for hot lanes

- **`localSummaryInjection` defaults to `false`** — local-store summary injection compounds on long-lived agent sessions; opt in per-agent when you actually want it. Existing installs that explicitly set the key keep their behavior.
- **`defaultRecallLimit` defaults to `4`** (down from 8). Lower fan-in keeps per-turn injection volume bounded under the new ceiling without degrading recall quality on focused queries.

### Installer + updater

- **Installer and all three update scripts include `pressure-log.js` and `memory-formatter.js`.** Without this, 0.7.13 installs copied `index.js` but not its new dependencies and crashed with `Cannot find module './pressure-log'` at load.
- **Web-served `/install-assets/plugin/` route allows the two new modules.** The route maintains an explicit allowlist; 0.7.13 installs 404'd on the new files until the allowlist caught up.
- **Post-install verification now checks the `context-engine` capability binding and the `before_agent_start` hook** instead of grepping for specific tool names. OpenClaw's context-aware tool factory (shipped in 0.7.12) produces anonymous closures, so the old name-based grep always failed on 0.7.12+ installs even when the plugin was healthy.
- **Updater parity maintained** across `plugin/update.sh`, `scripts/update.sh`, and `apps/web/public/update.sh` (byte-identical).

### Convex / recall ranking

- **KB ranking weight restored** — `knowledgeBaseWeight` at `0.25` (default) and `0.26` / `0.18` across mode presets, restoring full margin for the "half rap"-class fix from 0.7.12. The new tier-aware per-memory cap means the higher weight no longer compounds the per-turn byte budget.
- **Convex client bumped to `^1.35.1`** across root, `apps/web`, and `mcp-server` workspaces.

## [0.7.12] — 2026-04-14

### Plugin / OpenClaw compatibility

- **Tool-context session fallback restored** — Memory Crystal now registers its cloud-backed tools through OpenClaw’s context-aware tool factory so `sessionKey`, delivery context, and other runtime fields survive into tool execution even when the tool runner passes a sparse execute-time ctx. This fixes shared main-agent recall for stock OpenClaw main sessions like `agent:main:main`.
- **Shared-lane recall unblocked** — `crystal_recall`, `crystal_search_messages`, `crystal_what_do_i_know`, `crystal_why_did_we`, `crystal_debug_recall`, `crystal_preflight`, `crystal_recent`, `crystal_wake`, and `memory_search` now work in sessions whose channel uses a `main`, `default`, or `unknown` peer suffix. Previously these tools hard-errored with `Cannot resolve a safe channel scope for this session`. Captures remain strict so multi-peer content still cannot cross-pollinate a named scope.
- **Shared agent recall fallback** — read-path recall now reuses scoped `:main` / `:default` / `:unknown` channels for trusted `agent:*` sessions, so shared agent lanes like `agent:main:main` can recall their own scoped memory without weakening write-path isolation.
- **Optional `channel` parameter** on the read-path tools lets callers pin a session-specific channel explicitly when the automatic resolver can't infer one.
- **Regression coverage for OpenClaw default main scope** — plugin tests now prove that context-aware registration preserves shared-lane recall even when execute-time ctx is empty.

### Plugin / install hardening

- **Backend persistence hardened** — `scripts/crystal-enable.sh` now treats explicit memory-backend overrides as the deliberate top-priority migration lever, keeps persisted plugin `convexUrl` authoritative over generic `CONVEX_URL` drift, validates `/api/mcp/stats` before persisting a backend, rejects HTTP 404 targets by default, and wires the selected backend into both plugin config and hook command env. This prevents generic `CONVEX_URL` drift from silently repointing Memory Crystal at a non-MCP Convex deployment.
- **Doctor backend provenance** — `crystal_doctor` now reports backend source and classifies route validation failures more clearly.
- **Updater parity restored** — `plugin/update.sh`, `scripts/update.sh`, and `apps/web/public/update.sh` are aligned again so every published updater pulls from the same public mirror source.

### Dashboard

- **Knowledge base detail guard** — the KB detail panel now surfaces a clear `no longer available on the server` notice when the list row refers to a KB the backend detail query returns as `null`, instead of spinning on a permanent `Loading…` state.

## [0.7.9] — 2026-04-13

### Plugin recall and prompt shaping

- **Compact recall evidence by default** — standard prompt injection now uses a small `Relevant Memory Evidence` block instead of stacking large recall/message-history sections on every turn.
- **Tool guidance reduced to once per session** — the long Memory Crystal tool-discipline block now appears on first injection only, instead of being repeated on every prompt.
- **Wake briefing trimmed** — first-turn wake context is still injected for continuity, but the plugin now inserts a shorter version to reduce prompt overhead.
- **Message-history lookup narrowed** — `search-messages` is now reserved for explicit history / factual-recall prompts like “what did we work on” or names / birthdays, while generic questions stay on the cheaper semantic-recall path.
- **Full debug surface added** — new `crystal_debug_recall` returns the raw wake / recall / search / recent bundle plus the rendered hook sections for debugging and retrieval inspection.

### MCP transport and runtime

- **Legacy SSE transport removed** — the old SSE/session MCP surface is gone. Hosted Memory Crystal now standardizes on Streamable HTTP `/mcp`, while command-launched local MCP uses explicit `stdio` wiring.
- **Local transport contract clarified** — deprecated local MCP docs and examples now distinguish `stdio` for command-launched clients from explicit `http` mode for the local network listener.
- **Runtime tooling aligned** — generated hook configs, doctor checks, and environment examples now emit `stdio`/`http` intentionally instead of legacy `sse`.

### Knowledge bases

- **Dashboard crash fix** — the Knowledge Bases page now tolerates legacy or malformed knowledge-base rows with missing counters or timestamps instead of crashing on `toLocaleString`.
- **Server-side normalization** — knowledge-base list/detail queries now backfill missing `memoryCount`, `totalChars`, `createdAt`, and `updatedAt` values before returning data to clients.

### Auth and backend hardening

- **API-key hosted parity fixes** — API-key recall semantics now preserve intended filters and hosted graph-style tools no longer degrade API-key clients into hard errors.
- **Device auth and impersonation hardening** — device authorization now rate-limits brute-force attempts, and impersonation targets are revalidated when effective user resolution runs.
- **Cleanup and purge convergence** — association cleanup and morrow purge execution now iterate to completion instead of stopping after one pass.
- **Email path fixes** — missing email template variables no longer leak raw `{{placeholder}}` text, and admin email log listing no longer full-table scans.

### Installers

- **Codex TOML repair** — the Codex installer now merges `codex_hooks = true` into an existing `[features]` table instead of appending a duplicate table that breaks `config.toml`.
- **Dry-run safety improvement** — hook-config dry runs now redact secret values instead of dumping credentials to stdout.
- **Full install/uninstall verification sweep** — OpenClaw, Claude Code, Codex CLI, and Factory Droid install/uninstall flows were rechecked in temp-home simulations, including safe `--purge` cleanup behavior.

## [0.7.8] — 2026-04-11

### Integrations and installers

- **Hook-based MCP installs for Claude Code, Codex CLI, and Factory Droid** — shared Memory Crystal hooks now install with browser-based device auth, scoped channel/session propagation, and safer host config merging.
- **Installer hardening** — Codex / Claude / Droid hook installers preserve unrelated hooks and repair invalid Codex hook layouts instead of clobbering existing config.
- **Safe uninstall coverage** — public uninstall scripts now exist for OpenClaw, Claude Code, Codex CLI, and Factory Droid, with safe defaults and explicit purge paths.

### Recall and memory reliability

- **Peer-scoped coach recall fixes** — malformed scoped writes are normalized, same-peer raw message fallback is restored at session start, and cross-client leakage protections remain intact.
- **SessionStart noise reduction** — startup hooks now emit a compact memory-active summary instead of dumping the full wake briefing and long-form instruction block.
- **Gateway-safe local store mitigation** — local SQLite compaction is now explicit via `localStoreEnabled`, defaults off for non-opted-in runtimes, and uses WAL/file-cache guardrails when enabled.

### Knowledge bases and release workflow

- **Knowledge base imports auto-chunk raw text** — pasted or uploaded raw text now splits automatically while preserving explicit JSON chunk arrays and delimiter-based chunk boundaries.
- **Release workflow improvements** — docs, public assets, and branch alignment are now part of the release lane instead of an afterthought.
- **HTTP auth / MCP test refresh** — stale API-key mock paths were updated to match the current auth contract so release audit runs are green again.

## [0.7.6] — 2026-04-04

### Backend — Gemini cost guardrails

- **Cron throttling** — graph enrichment backfill reduced from 200 memories/5 min to 25 memories/hr (~96% cut). STM embedder interval widened from 5 min to 15 min. Asset embedder interval widened from 5 min to 30 min.
- **Circuit breaker** — graph enrichment aborts after 3 consecutive Gemini failures instead of burning quota against a failing API.
- **Daily Gemini call cap** — new `GEMINI_DAILY_CALL_CAP` env var (off by default). When set, an atomic counter in `crystalGeminiDailyUsage` blocks further Gemini calls once the cap is reached for the UTC day. Checked in graph enrichment, `embedText`, and `embedMemory`.
- **Embedding error logging** — `embedText` now logs status code, model name, and truncated error payload. `batchEmbedTexts` returns all-null on 429/5xx to prevent amplification; falls back to individual calls on other errors.

### Backend — Unified CRYSTAL_API_KEY

- **Single API key env var** — `CRYSTAL_API_KEY` is now the primary env var for Gemini access. `GEMINI_API_KEY` remains as a backward-compatible fallback. All 12+ consumers (Convex actions, MCP server, plugin, scripts) updated to resolve `CRYSTAL_API_KEY ?? GEMINI_API_KEY`.
- **Updated .env.example** — documents `CRYSTAL_API_KEY` as the preferred key alongside `GEMINI_EMBEDDING_MODEL`.

### Backend — Tier-aware Gemini controls

- **Per-tier Gemini policy** — `GeminiTierConfig` added to `shared/tierLimits.ts`. Free=no managed Gemini (cap 0), Pro/Starter=managed with 500 calls/day cap, Ultra/Unlimited=managed unlimited with BYOK support.
- **Per-user guardrail** — `geminiGuardrail.incrementAndCheck` now accepts `userId`, resolves the user's tier, and enforces the tier-specific daily cap. Global `GEMINI_DAILY_CALL_CAP` env var still works as an override (lowest cap wins).
- **BYOK for Ultra** — new `geminiApiKey` and `geminiDailyCap` fields in `organicTickState` schema. Ultra users can supply their own key and set a custom daily cap.

### Plugin — Peer-scoped recall fixes

- **Replaced ad-hoc channel filter** with `isNonKnowledgeBaseMemoryVisibleInChannel` for consistent peer-scoped recall isolation.
- **Blocked bare-prefix memory leakage** — memories stored under a bare channel prefix (e.g. `agent:`) no longer leak into peer-specific channels (`agent:user-1`).
- **Surface agent-prefix memories** — memories stored with the agent's own prefix are now correctly returned in peer channel recalls.
- **Exclude global memories from scoped channels** — unscoped memories no longer appear in peer-scoped recall results.

### Installer — update.sh sync

- **PLUGIN_FILES list reconciled** — removed stale `openclaw-hook.json` entry from `scripts/update.sh` to match `plugin/update.sh`.

## [0.7.5] — 2026-04-03

### Backend — Gemini-native embeddings and isolation hardening

- **Unified embeddings on Gemini** — all embedding paths now use Gemini exclusively; OpenAI embedding codepath hard-disabled.
- **Stale-vector remediation** — new CLI-callable actions re-embed memories still using 1536-dim OpenAI vectors to 3072-dim Gemini vectors.
- **Per-client memory isolation** — hard channel filter and KB scope field enforce strict per-client boundaries in multi-tenant peer-scoped sessions.
- **Write-tool 404 fix** — `crystal_remember`, `crystal_checkpoint`, and `crystal_forget` now route through HTTP endpoints correctly.
- **Retrieval quality fixes** — embedding dimension mismatches, hybrid search scoring, and channel visibility bugs resolved.

## [0.7.4] — 2026-04-03

### Plugin — Memory leak fixes

- **intentCache TTL enforcement** — `intentCache` now enforces a 30-minute TTL at read time. Stale intents are deleted and treated as absent rather than persisting indefinitely across long sessions.
- **sessionRecallCache stale eviction** — When the 4-hour recall cache TTL expires, stale entries are now actively deleted from both `sessionRecallCache` and `sessionRecallCacheTimestamps` instead of just skipping injection.
- **conversationPulse fetch body disposal** — Fire-and-forget fetch now explicitly cancels the response body (`r.body?.cancel?.()`) to avoid socket lingering in Node.js.

### Installer — migrate.sh content field fix

- **Fixed `migrate.sh` sending wrong field name** — The import payload was sending `text` but `mcpCapture` expects `content`. Every memory import attempt since launch was silently 400ing. Fixed — re-run `migrate.sh` to actually import your memories.

## [0.7.3] — 2026-04-03

### Plugin — Memory leak fix

- **`clearSessionState()` helper added** — consolidates all per-session Map cleanup into a single function. Previously, `session_end` and `dispose()` each had incomplete, hand-rolled lists of deletes that missed several Maps (`pendingUserMessages`, `sessionConfigs`, `wakeInjectedSessions`, `seenCaptureSessions`, `intentCache`). With each session leaving behind stale entries, long-running gateways accumulated unbounded Map growth.
- **`session_end` hook updated** — now calls `clearSessionState(sessionKey)` which clears all 13 per-session caches atomically.
- **`dispose()` updated** — now explicitly clears all Maps including `pendingUserMessages`, `sessionConfigs`, `wakeInjectedSessions`, `seenCaptureSessions`, `intentCache`, and `reinforcementTurnCounters`.

## [0.7.2] — 2026-04-03

### Plugin — OpenClaw 2026.3.31 compatibility fix

- **Fixed `command:new` / `command:reset` hook names** — OpenClaw 2026.3.31 removed these as valid typed-hook names for plugins. Replaced with `session_start` (fires on new session) and `before_reset` (fires before `/reset`). Reflection still triggers correctly on both events.
- **Auto-updater: public mirror fallback** — `update.sh` now pulls from `memorycrystal/memorycrystal` (`stable` branch) when no GitHub auth token is present. Users without access to the private repo can now auto-update without setting up a token.

---

## [0.5.4] — 2026-03-24

### Consolidated release (0.5.1–0.5.4)

### New Features
- **Dashboard docs rewrite** — full tool reference, install guide, and MCP config docs
- **One-command MCP installers** — for Codex, Claude Code, and Factory
- **Codex API key persistence** — persisted to shell profile
- **Releases dashboard tab** — moved to `/dashboard/releases`

### Bug Fixes
- **`before_tool` hook renamed to `before_tool_call`** — matches OpenClaw's actual API
- **Polar billing portal** — uses customer session API instead of broken static URL
- **API key regeneration** — patches in-place instead of creating new row
- **Telemetry queries** — capped to 500 docs to stay under Convex 8MB read limit
- **Admin delete** — now removes all authAccounts per user (email + OAuth)
- **Trial button** — updated from 14-day to 7-day
- **Route conflict** — dashboard releases moved to `/dashboard/releases`

---

## [0.5.2] — 2026-03-23

### New Features
- **Token-budgeted recent message window** — after compaction, the agent now gets a chronological window of recent messages (up to 7k chars / ~5k tokens) injected alongside semantic recall. Fetches the last 30 messages from `/api/mcp/recent-messages`, keeps the most recent that fit the budget. Solves the "forgot what we discussed 30 minutes ago" problem. Complements semantic recall — long-term memory + short-term continuity, both active.

### Bug Fixes
- **`/crystal` install route** — `request.url` on Railway returns `localhost:8080` (internal host), causing redirects to send curl clients to `https://localhost:8080/install.sh`. Fixed to use the `Host` header instead, which Cloudflare forwards correctly as the public domain.
- **`/crystal/update` route** — same fix as `/crystal`.
- **TypeScript: `accessCount` union type** — `ctx.db.get(id as any)` returns the full table union type which doesn't include `accessCount`. Cast result to `{ accessCount?: number } | null` so Railway's type-checked build passes.
- **Hero section dots** — traffic-light buttons in `TabbedInstallCommand` were rendering square due to `span` sizing. Moved dots to `TerminalAnimation` only (removed from install card entirely), bumped to `w-3 h-3` + `flex-shrink-0`.

### Layout
- **Hero section redesign** — H1 + subtitle now span full width above the two-column grid. Install command card (left) and terminal animation (right) sit below. Terminal uses fixed height instead of `max-h` for visual stability.

---

## [0.5.0] — 2026-03-20

### New Features
- **Action triggers** — `actionTriggers` field on memories enables the new `/api/mcp/triggers` endpoint and `before_tool` hook. Memories tagged with triggers are surfaced automatically before matching tool calls, keeping guardrails and lessons in scope during execution.
- **Circuit breaker** — plugin warns when an agent saves 3+ lessons on the same topic in a single session, preventing runaway self-correction loops.
- **Guardrails in wake briefing** — high-strength `lesson` and `rule` memories are automatically injected into the session wake briefing so guardrails are active from turn one.
- **Install script: 3 backend modes** — `install.sh` now prompts for Cloud, Self-hosted Convex, or Local-only SQLite. No Convex account required for local-only installs.

### Bug Fixes
- **Local-only mode (`apiKey: "local"`)** — `request()` now returns `null` immediately for local-only mode instead of attempting Convex calls with a fake bearer token. `crystalRequest()` throws a clear "not available in local-only mode" error. `buildBeforeAgentContext` skips all remote calls. Previously, local-only mode would attempt Convex requests with `Authorization: Bearer local` and get 401s on every turn.
- **Guardrails channel-agnostic** — `getGuardrailMemories` now queries across all channels by strength, not just the current channel. Guardrails were silently missing for new channels/sessions.
- **Guardrails in HTTP wake handler** — guardrail injection was dead code for plugin users (only fired in the direct HTTP path); now correctly wired for all wake briefing paths.
- **Session key fallback** — circuit breaker uses a stable session key fallback, preventing false positives when session ID is unavailable early in a turn.

---

## [0.4.2] — 2026-03-18

### Bug Fixes
- **`ingestBatch` rename** — context engine `ingest` method renamed to `ingestBatch` to match OpenClaw's actual API contract. The ingest hook was silently never firing because OpenClaw calls `ingestBatch()`. This is the root cause fix for context not being accumulated in the local store.
- **`tokenBudget` field name** — `assemble` and `afterTurn` now read `payload.tokenBudget` instead of `payload.budget` to match what OpenClaw actually sends.
- **Leaf compaction threshold** — lowered from 20,000 tokens to 4,000. Sessions were overflowing the context window before ever hitting the compaction trigger. At 4k, compaction fires after ~15-20 exchanges.
- **`assemble` tail-replacement** — when local summaries exist, `assemble` now replaces the older portion of the raw message history with summaries and keeps only the last 6 messages raw. Previously summaries were prepended but all raw messages still passed through, so context usage never actually dropped.
- **JSON schema fix** — removed invalid `"required": false` from `channelScope` property in `openclaw.plugin.json` (must be omitted for optional fields; was crashing gateway config validator on update).

---

## [0.4.1] — 2026-03-18

### Bug Fixes
- **Install script** — updated to download all 13 v0.4.0 files including subdirectory structure (`store/`, `compaction/`, `tools/`, `utils/`); was broken since v0.4.0 only fetched 7 flat files from v0.2.x
- **Update script** — same fix; added `compaction/package.json` to file list
- **Install-assets route** — renamed `[file]` to `[...file]` catch-all to serve subdirectory paths; fixed path resolution from `process.cwd()` to `import.meta.url` anchor; added `compaction/package.json` to allowlist
- **Non-ASCII characters** — stripped box-drawing chars from install.sh success banner

### New Features
- **`channelScope` config** — set `"channelScope": "myapp"` (or any string) to automatically namespace all captures and recalls as `{channelScope}:{peerId}`. Peer ID is derived from Telegram sender, Discord user, or session key. Enables multi-tenant and per-client memory isolation without any additional code.
- **`migrate.sh --ingest-dir`** — new flags for bulk ingesting arbitrary directories into Memory Crystal: `--ingest-dir DIR` (repeatable), `--store`, `--category`, `--tags`, `--channel`. When `--ingest-dir` is set, skips OpenClaw memory scan and processes the specified paths only.

### Dependencies
- `better-sqlite3` npm install step added to both `install.sh` and `update.sh` (graceful fallback if unavailable)

---

## [0.4.0] — 2026-03-17

### Highlights
- **Phase 2 context engine** — Memory Crystal now owns compaction (`ownsCompaction: true`). Local SQLite layer (L1) + Convex cloud (L2) two-tier architecture live
- **Local compaction DAG** — hierarchical leaf → condensed summarization with 3-level LLM escalation (normal → aggressive → deterministic truncation fallback)
- **Budget-aware context assembly** — fresh tail always protected; summaries XML-wrapped as `<crystal_summary>` blocks injected before Convex recall
- **Three new local tools** — `crystal_grep`, `crystal_describe`, `crystal_expand` registered lazily once SQLite store initializes
- **Cross-platform SQLite** — `better-sqlite3` with `createRequire` + dynamic import fallback; graceful no-op stub if unavailable (Windows, Linux ARM, all platforms)
- **Interface bug fixes** — 5 runtime bugs patched: wrong assembleContext arg, createSummarizer wrong import, missing messageId/summaryId fields, missing getMessageById/getSummary methods, wrong API key for summarizer

### Plugin
- **`plugin/index.js`** — Phase 2 hooks: `ingest` writes to local store, `assemble` prepends local summaries + Convex recall, `compact` runs DAG sweep before Convex checkpoint, `afterTurn` runs incremental leaf compaction
- **`plugin/utils/crystal-utils.js`** — extracted helpers (extractUserText, extractAssistantText, shouldCapture, isCronOrIsolated, normalizeContextEngineMessage, etc.)
- **`plugin/store/crystal-local-store.js`** — SQLite-backed session store; tables: conversations, messages, summaries, summary_parents, summary_messages, context_items; `checkSqliteAvailability()` export; `getMessageById()` + `getSummary()` methods
- **`plugin/compaction/crystal-summarizer.js`** — LLM summarization factory, 3-level escalation, LEAF_PROMPT / CONDENSED_PROMPT builders, `estimateTokens`, `formatTimestamp`
- **`plugin/compaction/crystal-assembler.js`** — budget-constrained context assembly, fresh tail protection, XML-wrapped summary injection
- **`plugin/compaction/crystal-compaction.js`** — `CrystalCompactionEngine`: `evaluate`, `compactLeaf`, `compact` (full sweep)
- **`plugin/tools/crystal-local-tools.js`** — `crystal_grep`, `crystal_describe`, `crystal_expand` via `createLocalTools(store)`
- **`openaiApiKey`** config field added — separate from Convex API key, falls back to `OPENAI_API_KEY` env var
- **All files under 500 lines** — 41/41 tests passing

---

## [0.3.0] — 2026-03-16

### Highlights
- **Agent tool guidance** — every session now receives a compact behavioral guide explaining when and how to use each Memory Crystal tool, so agents use memory proactively without being prompted
- **Crystal Grep** — BM25 full-text search activated on `crystal_search_messages`; find verbatim past wording across all retained messages
- **Structured message capture** — turns now stored with role, session ID, and turn metadata for conversation threading
- **Recall ranking** — context-aware reranking with recency decay, graph boost, and session continuity scoring
- **Message embeddings** — immediate enqueue on capture + starvation fix ensures all messages are semantically searchable
- **Auto-update infrastructure** — `release` branch + `scripts/update.sh` for streamlined client rollouts

### Plugin (`plugin/index.js`)
- **Agent tool guidance injected**: `before_agent_start` now injects a `## Memory Crystal — How to Use Your Tools` section with per-tool behavioral guidance (when to call each tool, what it's for). Excluded from cron/isolated sessions.
- **Structured turn capture**: messages now stored with `role`, `turnIndex`, `sessionId`, and `channelKey` metadata
- **Noise filter**: heartbeat ACKs, greetings, HEARTBEAT_OK, short confirmations excluded from capture
- **Reflection hooks**: `command:new` and `command:reset` trigger `triggerReflection()` at session boundaries

### Convex — Messages (`convex/crystal/messages.ts`)
- **Crystal Grep**: `searchMessagesByTextForUser` uses the existing `search_content` BM25 index — exact phrase hits boosted, quoted queries stripped, all retained messages searchable (not just recent 50-200)
- **Hybrid message search**: `searchMessageMatches` now merges indexed lexical + semantic + recency fallback

### Convex — Recall (`convex/crystal/recall.ts`)
- **Context-aware reranking**: 5-component weighted score `vectorScore×0.35 + strength×0.30 + recency×0.20 + accessScore×0.10 + bm25Boost×0.05`
- **Graph node boost**: memories with high-confidence graph links get `+0.05` post-processing boost
- **Session continuity**: memories from the same project/context ranked higher

### Convex — Reflection (`convex/crystal/reflection.ts`)
- **Distillation pipeline**: nightly job extracts decisions, lessons, summaries, open loops from sensory/episodic memories and writes distilled semantic/procedural memories

### Security
- Hardcoded API key removed from `plugin/index.js`; always sourced from plugin config

### Security
- **Removed hardcoded API key** from plugin/index.js; API key is now always sourced from plugin config (`ctx.config.apiKey`), never from a fallback literal.

### Plugin (`plugin/index.js`)
- **Noise filter**: Added `shouldCapture()` guard in `llm_output` hook — heartbeat ACKs, short greetings, simple confirmations, and HEARTBEAT_OK are not written to memory.
- **Reflection hooks**: Plugin now registers `command:new` and `command:reset` hooks that fire `triggerReflection()` on session boundaries, calling `/api/mcp/reflect` with a 4-hour window (fire-and-forget).

### Plugin (`plugin/recall-hook.js`)
- **Adaptive recall skip**: Added `shouldRecall()` guard — empty queries, slash commands, greetings, short acks, pure emoji, and heartbeat patterns skip the embedding+recall round-trip entirely.
- **BM25 hybrid search wiring**: `searchMemories()` now passes `query` string to Convex `recallMemories` action alongside the embedding vector, enabling hybrid vector+BM25 scoring.
- **Session dedup**: Added `sessionMemoryCache` with 4-hour TTL. Memory IDs returned per session are tracked; subsequent recalls for the same session exclude already-seen memories via `recentMemoryIds` arg.

### Convex — Schema (`convex/schema.ts`)
- **BM25 search indexes**: Added `searchIndex("search_content", ...)` and `searchIndex("search_title", ...)` to `crystalMemories` table, enabling full-text search over memory content and title fields with `userId` and `archived` filter fields.

### Convex — Recall (`convex/crystal/recall.ts`)
- **Hybrid scoring formula**: `recallMemories` action now uses a 5-component weighted score:
  `vectorScore × 0.35 + strength × 0.30 + recency × 0.20 + accessScore × 0.10 + bm25Boost × 0.05`
- **Knowledge graph node boost**: After initial ranking, memories with at least one `crystalMemoryNodeLinks` entry with `linkConfidence > 0.7` receive a `+0.05` post-processing score boost.
- **Parallel association lookup**: `buildAssociationCandidates` calls are now batched via `Promise.all()` across all top results (was sequential).
- **Associations on by default**: `includeAssociations` now defaults to `true` if not supplied.
- **BM25 search internal query**: Added `searchMemoriesByText` internalQuery that runs parallel `search_content` + `search_title` Convex search indexes and returns deduplicated results with boost metadata.
- **Schema fields added to requestSchema**: Added `query` (optional string) and `recentMemoryIds` (optional string array) to the `recallMemories` args schema — previously `query` was accessed via `(args as any).query` and `recentMemoryIds` was silently undefined.
- **Graph node lookup query**: Added `getNodesForMemories` internalQuery used to identify graph-linked memories for the node boost post-processing step.

### Convex — Reflection (`convex/crystal/reflection.ts`) — NEW FILE
- **Reflection/distillation pipeline**: New module implementing memory distillation via OpenAI `gpt-4o-mini`.
  - `getRecentMemoriesForReflection` (internalQuery): fetches recent `sensory`/`episodic` memories within a configurable time window.
  - `runReflectionForUser` (internalAction): calls OpenAI to extract decisions, lessons, session summary, and open loops from recent memories; writes each as a new distilled memory (`episodic/decision`, `semantic/lesson`, `episodic/event`, `prospective/goal`).
  - `runReflection` (public action): iterates all users and calls `runReflectionForUser`; used by cron and `/api/mcp/reflect`.

### Convex — HTTP (`convex/http.ts`)
- **`/api/mcp/reflect` route**: New POST route registered, backed by `mcpReflect` handler in `mcp.ts`.

### Convex — Crons (`convex/crons.ts`)
- **Daily reflection cron**: Added `crons.daily("crystal-reflect", { hourUTC: 4, minuteUTC: 30 }, ...)` to run memory distillation for all users daily after the STM expiry job.

### Convex — MCP (`convex/crystal/mcp.ts`)
- **`mcpReflect` HTTP handler**: New handler that authenticates, rate-limits, and calls `runReflectionForUser` for the authenticated user with configurable `windowHours` and optional `sessionId`.

### MCP Server (`mcp-server/src/tools/recall.ts`)
- **Pass `query` to Convex**: `handleRecallTool` now includes `query: parsed.query` in the `recallMemories` action args, enabling BM25 hybrid search from the MCP path (was embedding-only).

---

## Deployment Notes

To deploy to production:

```bash
# Deploy Convex backend (schema + functions)
npx convex deploy

# Or for local dev:
npx convex dev

# MCP server (if running standalone):
cd mcp-server && npm run build && npm start
```

**Environment variables required:**
- `GEMINI_API_KEY` — required for embeddings and graph enrichment (Gemini-native since v0.7.5)
- `CONVEX_URL` — Convex deployment URL (set in mcp-server `.env`)
- `GEMINI_DAILY_CALL_CAP` — optional daily Gemini API call limit (off by default, added in v0.7.6)
