# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Memory Crystal — persistent cognitive memory for AI assistants. Two products in one monorepo:

1. **OpenClaw plugin** — captures conversations, extracts memories via GPT-4o-mini, recalls context before each AI response via vector search
2. **SaaS dashboard** — Next.js 15 + Convex web app with Polar.sh billing, deployed to Railway

## Commands

```bash
# Web app (from repo root)
npm run dev                           # Next.js dev server (apps/web)
npm run build                         # build web app
cd apps/web && npm run lint           # ESLint

# Convex backend
npx convex dev                        # dev mode with hot reload
npx convex deploy                     # deploy to production

# MCP server
cd mcp-server && npm run build        # compile TypeScript (tsc)
cd mcp-server && npm run start        # start MCP server (stdio + SSE)

# Plugin deployment — after editing plugin/, copy to live extension dirs:
cp plugin/capture-hook.js plugin/recall-hook.js plugin/handler.js ~/.openclaw/extensions/crystal-memory/
cp plugin/capture-hook.js ~/.openclaw/extensions/crystal-capture/
# Then restart gateway OUTSIDE of any AI session:
# openclaw gateway restart
```

## Architecture

### Monorepo layout (npm + pnpm workspaces)

| Directory | What | Stack |
|---|---|---|
| `apps/web/` | SaaS dashboard | Next.js 15, React 19, Tailwind 4, Convex Auth, Polar.sh SDK |
| `convex/` | Backend (shared by all consumers) | Convex (schema, mutations, queries, crons, auth) |
| `convex/crystal/` | All Memory Crystal Convex functions | 35 modules: memories, recall, capture, sessions, wake, graph, etc. |
| `mcp-server/` | MCP server (14 tools) | TypeScript, @modelcontextprotocol/sdk, OpenAI SDK |
| `plugin/` | OpenClaw hooks (source of truth) | Plain JS, spawns Node child processes |
| `scripts/` | Bootstrap, enable/disable, doctor, e2e, seeding | Shell + JS |

### Memory flow

```
User message → recall-hook.js (before_model_resolve)
  → embed query → vector search STM + LTM → inject into system prompt

AI response → capture-hook.js (llm_output)
  → log transcript to Obsidian/logs/YYYY-MM-DD.md
  → save raw messages to STM (crystalMessages, tier-based TTL: Free 7d / Pro 30d / Ultra 90d)
  → GPT-4o-mini extracts up to 3 memories per turn
  → embed + dedupe → save to LTM (crystalMemories, permanent)
  → write .md notes to Obsidian vault by store
```

### Two memory layers

- **STM** (`crystalMessages`) — raw verbatim messages, tier-based TTL (Free 7d / Pro 30d / Ultra 90d), vector-indexed
- **LTM** (`crystalMemories`) — extracted facts/decisions/lessons, permanent, vector-indexed

### Knowledge graph (planned expansion)

`crystalNodes` + `crystalRelations` + `crystalMemoryNodeLinks` + `crystalAssociations` — typed graph connecting memories to entities (people, projects, goals, decisions)

### OpenClaw plugin registration

- **Recall**: `hooks.internal.entries.crystal-memory` → `handler.js` → fires `before_model_resolve`
- **Capture**: `plugins.entries.crystal-capture` → `index.js` → fires `llm_output` + `message_received`

Live copies deploy to `~/.openclaw/extensions/crystal-memory/` and `~/.openclaw/extensions/crystal-capture/`.

### Web app routes (`apps/web/app/`)

- `(auth)/` — login/signup (Convex Auth)
- `(dashboard)/` — memories, messages, checkpoints, settings, main dashboard
- `api/polar/` — Polar.sh billing webhook
- `pricing/`, `changelog/`, `docs/`, `roadmap/` — marketing pages

## Convex Schema

Source of truth: `convex/schema.ts`

Valid enum values (enforced by Convex validators):
- **store**: `sensory | episodic | semantic | procedural | prospective`
- **category**: `decision | lesson | person | rule | event | fact | goal | workflow | conversation`
- **source**: `conversation | cron | observation | inference | external`
- **nodeType**: `person | project | goal | decision | concept | tool | event | resource | channel`

## Design System (apps/web/)

Non-negotiable — enforced across all web UI:

- Background (void): `#1C272F`, Surface: `#1E2F3D`, Elevated: `#213A4D`
- Accent: `#2180D6`, Accent hover: `#4CC1E9`
- Text primary: `#E8F0F8`, Text secondary: `#7A9AB5`
- Borders: `rgba(255, 255, 255, 0.07)`
- **`border-radius: 0` everywhere — no exceptions**
- No gradients — flat and sharp

## Environment Variables

Required in `mcp-server/.env` (and in OpenClaw hook env):

| Variable | Purpose |
|---|---|
| `CONVEX_URL` | Convex deployment URL |
| `OPENAI_API_KEY` | Embeddings (text-embedding-3-small) + extraction (gpt-4o-mini) |
| `OBSIDIAN_VAULT_PATH` | Absolute path to Obsidian vault |
| `CRYSTAL_ROOT` | Absolute path to this repo |
| `CRYSTAL_ENV_FILE` | Absolute path to `mcp-server/.env` |

## Constraints

- Never edit `~/.openclaw/openclaw.json` from within a running AI session — draft `jq` patches, have user apply outside runtime
- Never run `openclaw gateway restart` from inside an exec session (kills the session)
- `plugins.entries` only accepts `{ "enabled": true }` — no `source` or `path` keys
- Memory Crystal is MIT licensed. The OpenClaw plugin is distributed via the plugin registry; do not publish MCP server packages without version review.
- Railway deployment uses `railway.toml` at repo root, builds from `apps/web/`
