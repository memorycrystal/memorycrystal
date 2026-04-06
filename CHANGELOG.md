# Changelog

All notable changes to Memory Crystal are documented here.

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
- **Blocked bare-prefix memory leakage** — memories stored under a bare channel prefix (e.g. `coach:`) no longer leak into peer-specific channels (`coach:alice`).
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
- **`channelScope` config** — set `"channelScope": "coach"` (or any string) to automatically namespace all captures and recalls as `{channelScope}:{peerId}`. Peer ID is derived from Telegram sender, Discord user, or session key. Enables multi-tenant and per-client memory isolation without any additional code.
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
