# AGENTS.md — Memory Crystal Development Context

Read this before touching anything in this repo.

---

## What Memory Crystal Is

Memory Crystal is two things:

1. **A memory plugin for OpenClaw** — captures conversations, extracts facts, recalls context before each AI response. Hooks into OpenClaw via two mechanisms (internal hooks for recall, JavaScript plugin API for capture).

2. **A SaaS product** — hosted memory service with a web dashboard, multi-tenant Convex backend, Polar.sh billing. Web app lives in `apps/web/`.

---

## Repo Structure

```
memorycrystal/                ← monorepo root
  apps/web/               ← Next.js 15 SaaS dashboard (React 19, Tailwind 4)
  convex/                 ← Convex backend (shared)
    schema.ts             ← source of truth for all tables
    crystal/              ← all Convex functions
  mcp-server/             ← MCP server (port 8788)
    src/index.ts
    .env                  ← CONVEX_URL, OPENAI_API_KEY, OBSIDIAN_VAULT_PATH
  plugin/                 ← OpenClaw plugin files (source of truth)
    capture-hook.js
    recall-hook.js
    handler.js
  scripts/                ← seeding, setup, codex task files
  docs/                   ← documentation
  railway.toml            ← Railway deploy config (root → apps/web)
  pnpm-workspace.yaml
```

**Live plugin files** (deployed copies):
```
~/.openclaw/extensions/crystal-memory/    ← unified plugin (recall + capture + tools)
```

After editing `plugin/`, copy to the extension dir and restart the gateway.

---

## The Memory Flow (Plain English)

```
User sends message
  → recall-hook.js fires (before_model_resolve)
      → embeds the query
      → searches crystalMessages (STM) + crystalMemories (LTM)
      → injects top results into system prompt

AI responds
  → capture-hook.js fires (llm_output event)
      → logs user message + AI response to Obsidian/logs/YYYY-MM-DD.md
      → saves both messages to crystalMessages (STM, tier-based TTL)
      → calls GPT-4o-mini to extract up to 3 memories from the turn
      → embeds and dedupes extracted memories
      → saves new memories to crystalMemories (LTM, permanent)
      → writes each memory as a .md file to Obsidian/<store>/
```

---

## Convex Tables

| Table | Purpose | TTL |
|---|---|---|
| `crystalMemories` | Long-term distilled facts | Permanent |
| `crystalMessages` | Raw verbatim messages | Tier-based |
| `crystalSessions` | Session tracking | Manual |
| `crystalCheckpoints` | Memory snapshots | Manual |
| `crystalUserProfiles` | SaaS subscription data | Permanent |
| `crystalApiKeys` | Hashed API keys | Until revoked |

Deployment: set via `CONVEX_URL` env var (see `.env`)

Valid `store` values: `sensory | episodic | semantic | procedural | prospective`
Valid `category` values: `decision | lesson | person | rule | event | fact | goal | workflow | conversation`
Valid `source` values: `conversation | cron | observation | inference | external`

---

## OpenClaw Config Rules

**Never edit `~/.openclaw/openclaw.json` directly inside a running session.**

The safe workflow:
1. Draft the exact `jq` commands or JSON patch needed
2. Review the patch before applying
3. Apply outside the runtime
4. Verify with `jq empty ~/.openclaw/openclaw.json` and `openclaw doctor`

Plugin registration in `openclaw.json`:
- Unified: `plugins.entries.crystal-memory` + `plugins.slots.memory` + `plugins.allow` (entry point: `index.js`)
- Legacy internal hook (`hooks.internal.entries.crystal-memory`) and separate `crystal-capture` extension have been removed.

Valid plugin entry fields: `{ "enabled": true, "config": { ... } }` — no `source`, no `path`.

## Design System (Web App)

Non-negotiable rules for `apps/web/`:

- Background (void): `#1C272F`
- Surface: `#1E2F3D`
- Elevated: `#213A4D`
- Accent: `#2180D6`
- Accent hover: `#4CC1E9`
- Text primary: `#E8F0F8`
- Text secondary: `#7A9AB5`
- Borders: `rgba(255, 255, 255, 0.07)`
- `border-radius: 0` — **everywhere, no exceptions**
- No gradients
- Flat and sharp

---

## Key Commands

```bash
# Deploy Convex functions (from repo root)
npx convex deploy
npx convex dev                        # dev mode with hot reload

# Run MCP server
cd mcp-server && npm run start

# Start web app dev server (from repo root)
npm run dev

# Copy plugin files to live extension (after editing plugin/)
cp plugin/capture-hook.js plugin/recall-hook.js plugin/handler.js ~/.openclaw/extensions/crystal-memory/

# Restart gateway (do NOT run from within a session)
openclaw gateway restart
```

---

## What Not to Do

- Do not run `openclaw gateway restart` from inside an exec session — it kills the session
- Do not edit `~/.openclaw/openclaw.json` directly from within the AI runtime
- Do not add `source` or `path` keys to `plugins.entries` — they are not valid schema fields
- Do not publish MCP server packages without version review
- Do not commit API keys or the `.env` file
