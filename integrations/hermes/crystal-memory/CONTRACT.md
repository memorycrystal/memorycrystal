# Hermes Contract Matrix

This file records the Hermes runtime contract used by the Memory Crystal plugin.

Current status: the active Hermes Agent provider source was not available in this
workspace when this adapter was implemented. The production package therefore
ships a dual-mode adapter:

- `provider` mode when the runtime exposes `ctx.register_memory_provider`
- `hooks` mode when the runtime exposes `ctx.register_hook`
- `degraded` mode when neither lifecycle surface is available

The checked-in contract fixture is `scripts/hermes-plugin-contract-smoke.test.mjs`.
Replace or augment that fixture with assertions derived from the real Hermes
source once the source package is available.

| Hermes surface | Expected shape | Memory Crystal behavior | Verification |
| --- | --- | --- | --- |
| Plugin registration | `register(ctx)` | Selects one active lifecycle mode and registers status commands | `scripts/hermes-plugin-contract-smoke.test.mjs` |
| Provider registration | `ctx.register_memory_provider(provider)` | Registers `MemoryCrystalProvider` in `auto` or `provider` mode | provider fixture in contract smoke and Python unit tests |
| Hook registration | `ctx.register_hook(name, fn)` | Registers pre/post LLM, tool guardrail, and session hooks when provider is unavailable | hook fixture in contract smoke and Python unit tests |
| Status command | `ctx.register_command(...)` or `ctx.register_cli_command(...)` | Exposes `crystal_status` without secrets | Python unit tests |
| Provider initialize | `initialize(session_id, **kwargs)` | Stores session metadata and channel scope | Python unit tests |
| Provider recall | `prefetch(...)` / `queue_prefetch(...)` | Short-timeout automatic wake/recall with exact-query cache, stale fallback, and circuit breaker | Python unit tests |
| Provider capture | `sync_turn(user_content, assistant_content, ...)` | Enqueues bounded completed-turn capture through `/api/mcp/turn` with stable turn IDs and shutdown flush | Python unit tests and backend HTTP tests |
| Provider memory writes | `on_memory_write(action, target, content, metadata)` | Mirrors durable writes to `/api/mcp/capture` with required `title`, `content`, and `channel` plus safe target/category mapping | Python unit tests |
| Provider session lifecycle | `on_session_end`, `on_pre_compress`, `on_delegation` | Creates `/api/mcp/snapshot` provenance records for automatic lifecycle events, or memories when safe and explicitly configured; Memory Checkpoints remain explicit tool/user actions | Python unit tests |
| Provider tools | `get_tool_schemas`, `handle_tool_call` | Provides a small exact-schema fallback bridge when Hermes asks providers for tools; default `fallback` mode hides these schemas when the `memory_crystal` MCP server is configured | Python unit tests |
| Provider doctor | `crystal_doctor` | Emits human-readable pass/warn/fail diagnostics while `crystal_status` remains JSON-oriented | Python unit tests |

Ship note: broad tool parity still comes primarily from the Hermes MCP server
configuration that the universal installer writes. Provider tools are a fallback
for Hermes runtimes that collect tools from memory providers.
