# Plugin AGENTS

## Package Identity

- Purpose: OpenClaw plugin that registers 14 `crystal_*` memory tools + 2 legacy compatibility tools (`memory_search`, `memory_get`) + 3 local tools (`crystal_grep`, `crystal_describe`, `crystal_expand`). Handles recall injection, capture hooks, media asset capture, and context compaction.
- Scope: `plugin/` — runtime code, hooks, utilities, and local tools.

## Setup Commands

- Install plugin wiring: `npm run crystal:enable`
- Verify plugin runtime: `npm run test:smoke`
- Full install path: `npm run crystal:bootstrap`
- Disable wiring: `npm run crystal:disable`

## Conventions

- `index.js` is the canonical entry point for the modern OpenClaw plugin API (`api.registerHook`, `api.registerTool`).
- `handler.js` is the legacy entry point for older `openclaw-hook.json` (schemaVersion 1) systems.
- `openclaw-hook.json` is the legacy manifest; modern registration uses `openclaw.plugin.json`.
- Keep handler output deterministic and JSON-safe.
- All remote calls go through the REST API (`/api/mcp/*`), not MCP protocol.
- Config fields are passed via OpenClaw plugin config: `apiKey`, `convexUrl`, `dbPath`, `openaiApiKey`, `defaultRecallLimit`, `defaultRecallMode`.

### DO / DON'T

- DO: `plugin/index.js` — main entry, tool registration, hooks
- DO: `plugin/handler.js` — legacy hook handler (spawns capture-hook.js / recall-hook.js)
- DO: `plugin/capture-hook.js` — capture hook (llm_output)
- DO: `plugin/recall-hook.js` — recall hook (before_model_resolve)
- DO: `plugin/openclaw-hook.json` — legacy manifest
- DON'T: Delete `handler.js` — still used by older OpenClaw installations
- DON'T: Change hook field names in `openclaw-hook.json` without updating `scripts/crystal-enable.sh`

## Touch Points / Key Files

- `./index.js` — main plugin entry (modern API)
- `./handler.js` — legacy hook handler
- `./capture-hook.js` — capture hook implementation
- `./recall-hook.js` — recall hook implementation
- `./openclaw-hook.json` — legacy manifest
- `./utils/crystal-utils.js` — shared utilities
- `./compaction/crystal-assembler.js` — context compaction
- `./tools/crystal-local-tools.js` — local tools (crystal_grep, crystal_describe, crystal_expand)
- `./../scripts/crystal-enable.sh`
- `./../scripts/crystal-disable.sh`

## Registered Tools (14 crystal_* + 2 legacy + 3 local)

**crystal_* tools** (all call `/api/mcp/*` REST endpoints):
`crystal_recall`, `crystal_remember`, `crystal_recent`, `crystal_search_messages`, `crystal_what_do_i_know`, `crystal_why_did_we`, `crystal_who_owns`, `crystal_explain_connection`, `crystal_dependency_chain`, `crystal_preflight`, `crystal_checkpoint`, `crystal_stats`, `crystal_forget`, `crystal_wake`

**Legacy compatibility tools**: `memory_search`, `memory_get`

**Local tools** (registered lazily from `tools/crystal-local-tools.js`): `crystal_grep`, `crystal_describe`, `crystal_expand`

## JIT Index Hints

- Find all registered tools: `rg -n "name: \"crystal_\|name: \"memory_" plugin/index.js`
- Find hook registrations: `rg -n "api.registerHook" plugin/index.js`
- Find config fields: `rg -n "apiKey\|convexUrl\|dbPath\|openaiApiKey\|defaultRecallLimit\|defaultRecallMode" plugin/index.js`
- Validate legacy handler: `rg -n "startup\|postTurn\|captureHooks\|recallHooks" plugin/handler.js`
- Local tools: `rg -n "crystal_grep\|crystal_describe\|crystal_expand" plugin/tools/crystal-local-tools.js`

## Common Gotchas

- `scripts/crystal-enable.sh` writes command maps based on `mcp-server/dist/index.js`; rebuild before enable when tool logic changes.
- `openclaw` CLI is optional in some environments; scripts should still complete wiring files even when restart command is unavailable.
- `crystal_forget` is registered but returns an error — the backend endpoint has not been deployed yet. Use the dashboard to manage memories.
- `handler.js` is legacy but must not be deleted — older OpenClaw installations still use it via `openclaw-hook.json`.

## Pre-PR Checks

- `npm run crystal:enable -- --dry-run`
- `npm run crystal:disable -- --dry-run`
- `node plugin/index.test.js`
