# crystal-memory — OpenClaw Plugin

Persistent memory for AI agents. Captures conversations, extracts durable memories, and injects relevant context before every response.

## Install

Memory Crystal supports the current OpenClaw plugin contract and requires
OpenClaw 2026.6.1 or newer.

```bash
curl -fsSL https://memorycrystal.ai/crystal | bash
```

Or install manually from this repo:

```bash
mkdir -p ~/.openclaw/extensions/crystal-memory
rsync -a \
  --exclude node_modules \
  --exclude '*.test.js' \
  plugin/ ~/.openclaw/extensions/crystal-memory/

cd ~/.openclaw/extensions/crystal-memory && npm install
```

Then enable the plugin in `~/.openclaw/openclaw.json` under `plugins.slots.memory`.

## Configuration

All schema-backed config is defined in `openclaw.plugin.json` under `configSchema.properties`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiKey` | string | — | Memory Crystal API key |
| `convexUrl` | string | `https://convex.memorycrystal.ai` | Convex backend URL |
| `defaultRecallMode` | string | `general` | Default recall mode (`general`, `decision`, `project`, `people`, `workflow`, `conversation`) |
| `defaultRecallLimit` | number | `8` | Memories to recall per query (`1`-`20`) |
| `debugRecallOutput` | boolean | `false` | Debug mode: inject and echo the full wake/recall/search/recent payload for recall-style prompts |
| `channelScope` | string | — | Namespace prefix for tenant, client, or agent isolation |
| `agentScopePolicies` | array | — | Per-agent peer/shared scope policies; peer policies may opt into `acceptOpenclawSessionKey` for exact OpenClaw direct-session peer derivation |
| `localStoreEnabled` | boolean | `false` | Enable the optional local SQLite compaction store |
| `contextEngineMode` | string | `reduced` | Context-engine participation level: `full`, `reduced`, or `hook-only` |
| `localSummaryInjection` | boolean | `true` | Enable local summary injection |
| `localSummaryMaxTokens` | number | `2000` | Max tokens for local summaries |

Backend precedence is now explicit:

1. explicit memory backend override (`CRYSTAL_CONVEX_URL` / `MEMORY_CRYSTAL_API_URL`)
2. persisted plugin config `convexUrl`
3. generic `CONVEX_URL` as bootstrap fallback only
4. managed default (`https://convex.memorycrystal.ai`)

`scripts/crystal-enable.sh` validates `/api/mcp/stats` before persisting a backend. Explicit memory overrides can intentionally replace a persisted backend on re-enable, while generic `CONVEX_URL` can no longer silently override persisted plugin config. Targets that return HTTP 404 are rejected unless you explicitly opt into `--allow-unvalidated-backend` for trusted self-hosted/private-network installs.

When `debugRecallOutput` is enabled, the plugin stops trimming the injected recall context for recall-style prompts and tells the model to print the full debug payload before answering. This is intentionally verbose and inefficient; it is meant for one-off debugging sessions, not normal use.

Normal prompt behavior is optimized for lower context overhead:

- `PREAMBLE_BACKEND` stays always-on but intentionally short
- `PREAMBLE_TOOLS` is injected once per session, not every turn
- wake briefings are injected on first turn and trimmed before insertion
- recall uses a compact `Relevant Memory Evidence` block by default
- exact message search is reserved for explicit history / factual-recall prompts
- trusted shared agent sessions like `agent:main:main` can now reuse their own scoped `:main` read channel for recall without weakening write-path isolation

Peer-scoped OpenClaw deployments that only receive the peer id in the session key
can opt in per policy:

```json
{
  "agentScopePolicies": [
    {
      "agentId": "coach",
      "scope": "peer-coach",
      "mode": "peer",
      "acceptOpenclawSessionKey": true
    }
  ]
}
```

This accepts direct session keys shaped like
`agent:<agentId>:<channel>:<account>:direct:<peerId>`, plus live provider-peer
keys such as `telegram:<peerId>` when the hook context already identifies a
matching `agentId` or account id. If a provider-peer key arrives without a
matched peer policy, the plugin fails closed unless OpenClaw supplies an exact
scoped channel key such as `peer-coach:<peerId>`. It is disabled by default, does
not enable arbitrary session-key parsing, and all channel-scoped
message-search/debug payloads are exact-channel filtered before surfacing.

## Files

| File | Purpose |
|------|---------|
| `index.js` | Main plugin entry point for the modern OpenClaw plugin API |
| `context-budget.js` | Model-aware context budget calculator |
| `openclaw.plugin.json` | Plugin manifest and config schema |
| `package.json` | npm metadata and optional dependencies |
| `compaction/` | Context compaction and summarization helpers |
| `tools/` | Local tool implementations |
| `utils/` | Shared plugin utilities |
| `store/` | Local SQLite-backed storage files |

## Hooks

The plugin registers hooks for these OpenClaw lifecycle events:

- `before_agent_start` — inject compact memory context, first-turn wake, and session-scoped tool guidance
- `before_tool_call` — surface action-trigger warnings before risky tools
- `before_dispatch` — rate limiting, proactive recall, and reinforcement injection
- `message_received` — capture incoming user messages
- `llm_output` — capture assistant responses and extract durable memories
- `message_sending` — pre-send assistant capture fallback for gateway builds that do not dispatch model-output callbacks
- `message_sent` — post-send assistant capture fallback
- `session_end` — clear per-session state

It also watches `/new` and `/reset` command flows to trigger reflection behavior.

## Knowledge Bases

The plugin benefits from Knowledge Bases automatically through the same Memory Crystal backend used for recall. Use KBs for stable reference material like runbooks, policies, docs, and imported datasets while conversational memory continues to capture learned context.

- Scoped knowledge bases respect the same tenant and channel boundaries as the rest of Memory Crystal.
- KB management and direct query/import flows live on the MCP and HTTP API surfaces.
- Plugin recall can combine durable memory with scoped KB-backed reference material when relevant.

## Compaction Lifecycle

Memory Crystal owns the OpenClaw context-engine compaction path and preserves context across compaction boundaries:

- `before_compaction` — snapshot and checkpoint the source conversation before raw turns are condensed
- `after_compaction` — refresh local summary state so recall remains usable after compaction completes

## Procedural vs Skills

- **Procedural memories** are quiet execution patterns: repeated workflows, troubleshooting loops, and operator habits that help recall without needing explicit approval.
- **Skills** are curated artifacts promoted for deliberate agent use. Treat them as reviewed playbooks, not just ambient pattern extraction.

## Tools

`plugin/index.js` registers these tools directly via `api.registerTool()`:

- `crystal_set_scope` — override Memory Crystal channel scope for the current session
- `memory_search` — legacy compatibility search returning `crystal/<id>.md` paths
- `crystal_search_messages` — search short-term conversation logs
- `memory_get` — legacy compatibility read by memory ID or `crystal/<id>.md` path
- `crystal_recall` — semantic search across long-term memory
- `crystal_debug_recall` — inspect the raw recall bundle and rendered hook sections
- `crystal_create_knowledge_base` — create a curated knowledge base
- `crystal_list_knowledge_bases` — list curated knowledge bases
- `crystal_import_knowledge` — import text chunks into a knowledge base
- `crystal_query_knowledge_base` — search inside a knowledge base
- `crystal_remember` — store a durable memory manually
- `crystal_what_do_i_know` — topic knowledge snapshot
- `crystal_why_did_we` — decision archaeology
- `crystal_checkpoint` — milestone memory snapshot
- `crystal_preflight` — pre-flight check returning relevant rules and lessons
- `crystal_recent` — fetch recent memory-backed messages
- `crystal_stats` — memory and usage statistics
- `crystal_forget` — archive or delete a memory
- `crystal_trace` — trace a memory back to its source conversation
- `crystal_wake` — session startup briefing
- `crystal_who_owns` — find ownership context for files, modules, or areas
- `crystal_explain_connection` — explain relationships between concepts
- `crystal_dependency_chain` — trace dependency chains

When the local store is available, the plugin also lazily registers:

- `crystal_grep` — search in-session local history and summaries
- `crystal_describe` — inspect a local summary node
- `crystal_expand` — expand a local summary into underlying context

## Version

Current: `v0.8.13`
