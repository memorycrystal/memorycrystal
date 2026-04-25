<!-- This repository is the open-source mirror of Memory Crystal. The hosted service and web app are maintained separately. -->

<p align="center">
  <a href="https://memorycrystal.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/memorycrystal/memorycrystal/main/assets/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/memorycrystal/memorycrystal/main/assets/logo-light.svg">
      <img src="https://raw.githubusercontent.com/memorycrystal/memorycrystal/main/assets/logo-light.svg" alt="Memory Crystal" width="320">
    </picture>
  </a>
</p>

<p align="center">
  <strong>Persistent memory for AI agents.</strong><br>
  <sub>Every conversation remembered. Every decision recalled. Every session informed.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/@memorycrystal/crystal-memory"><img src="https://img.shields.io/npm/v/@memorycrystal/crystal-memory?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://memorycrystal.ai"><img src="https://img.shields.io/badge/Cloud-Online-00c853?style=flat-square" alt="Cloud"></a>
  <a href="https://docs.memorycrystal.ai"><img src="https://img.shields.io/badge/Docs-docs.memorycrystal.ai-2180D6?style=flat-square" alt="Docs"></a>
</p>

<p align="center">
  <a href="https://memorycrystal.ai">Website</a> · <a href="https://docs.memorycrystal.ai">Docs</a> · <a href="https://memorycrystal.ai/dashboard">Dashboard</a> · <a href="https://memorycrystal.ai/pricing">Pricing</a>
</p>

---

Your AI forgets everything between sessions — who you are, what you decided, what failed, what works. Memory Crystal fixes that.

It captures conversations in real time, extracts durable knowledge, and injects the right context before every response. One install. No prompting gymnastics. Your AI just *knows*.

```bash
curl -fsSL https://memorycrystal.ai/crystal | bash
```

---

## Works with everything

Install Memory Crystal on any MCP-compatible AI tool in one command:

| Platform | Install |
|---|---|
| **Claude Code** | `curl -fsSL https://memorycrystal.ai/install-claude-mcp.sh \| bash` |
| **Codex CLI** | `curl -fsSL https://memorycrystal.ai/install-codex-mcp.sh \| bash` |
| **Factory Droid** | `curl -fsSL https://memorycrystal.ai/install-droid-mcp.sh \| bash` |
| **OpenClaw** | `curl -fsSL https://memorycrystal.ai/crystal \| bash` |
| **Claude Desktop** | Add the MCP server in settings ([guide](https://docs.memorycrystal.ai/integrations/claude-desktop)) |
| **Any MCP host** | Point at `https://api.memorycrystal.ai/mcp` with a Bearer token |

Each installer authenticates via browser, registers the MCP server, and configures auto-capture hooks — your messages get stored and relevant memories get recalled on every turn, automatically.

---

## How it works

```
  You send a message
       │
       ▼
┌─────────────────────────────────────────┐
│           CONTEXT ENGINE                │
│                                         │
│  Semantic search + BM25 across STM/LTM  │
│  Knowledge graph boost                  │
│  Multi-signal reranker                  │
│  Diversity filter + context budgeting   │
│  → Inject top memories into context     │
└─────────────────────────────────────────┘
       │
       ▼
  AI responds with full context
       │
       ▼
┌─────────────────────────────────────────┐
│         MEMORY EXTRACTION               │
│                                         │
│  Raw message → Short-term memory        │
│  LLM extracts facts/decisions → LTM     │
│  Graph enrichment links related memories│
└─────────────────────────────────────────┘
```

Every response is informed by what came before. Every conversation feeds the next one.

---

## Two memory layers

| Layer | Stores | Retention |
|---|---|---|
| **Short-term (STM)** | Raw messages, verbatim | Rolling window (7–90 days by tier) |
| **Long-term (LTM)** | Facts, decisions, lessons, people, rules | Permanent, vector-indexed |

STM gives perfect recent recall. LTM gives permanent knowledge. Both are searched together on every turn.

## Five memory stores

| Store | Purpose | Example |
|---|---|---|
| `sensory` | Raw signals | *"Andy sounds frustrated about the deploy"* |
| `episodic` | Events | *"We shipped v2 on March 15"* |
| `semantic` | Facts | *"The API uses Convex for the backend"* |
| `procedural` | How-to | *"Deploy with `npm run convex:deploy`"* |
| `prospective` | Plans | *"Add billing webhooks next sprint"* |

## Knowledge graph

Memories don't exist in isolation. An async background job connects related memories — decisions link to the lessons that informed them, people link to their projects, rules link to the events that created them.

When the Context Engine searches, graph-connected memories rank higher. Your AI doesn't just remember facts — it understands relationships.

## Adaptive recall

Six modes, automatically selected:

| Mode | Prioritizes |
|---|---|
| **General** | Broad recall across STM + LTM |
| **Decision** | Decisions, lessons, and rules before risky changes |
| **Project** | Goals, workflows, and implementation context |
| **People** | Ownership, collaborators, and relationships |
| **Workflow** | Procedures, rules, and how-to memory |
| **Conversation** | Recent session context and continuity |

The Context Engine picks the right mode. You don't configure anything.

---

## Knowledge bases

First-class immutable reference collections for docs, policies, runbooks, and imported source material. They sit alongside conversational memory so your agent can keep learned context and stable reference data separate.

- **Immutable** — imported chunks stay stable, not rewritten by conversation
- **Scoped** — tenant and scope filters keep KBs private to the right workspace
- **Bulk import** — standard import or high-volume bulk-insert without blocking on embedding
- **Background enrichment** — embedding and graph backfill run asynchronously

---

## 24 memory tools

Every tool works in any MCP host or automatically within OpenClaw hooks.

| Tool | What it does |
|---|---|
| `crystal_recall` | Semantic search across all long-term memory |
| `crystal_remember` | Store a memory — decisions, facts, lessons |
| `crystal_what_do_i_know` | Everything known about a topic |
| `crystal_why_did_we` | Decision archaeology — why a past choice was made |
| `crystal_preflight` | Pre-flight check before risky actions |
| `crystal_search_messages` | Hybrid search over verbatim conversation history |
| `crystal_checkpoint` | Snapshot memory state at a milestone |
| `crystal_wake` | Session startup — briefing and guardrails |
| `crystal_trace` | Trace a memory back to its source conversation |
| `crystal_who_owns` | Find ownership of a file, module, or area |
| `crystal_explain_connection` | Explain relationships between concepts |
| `crystal_dependency_chain` | Trace dependency chains between entities |
| `crystal_recent` | Recent messages for short-term context |
| `crystal_edit` | Update an existing memory |
| `crystal_forget` | Archive or delete a memory |
| `crystal_stats` | Memory and usage statistics |
| `crystal_set_scope` | Override channel scope for the session |
| `crystal_list_knowledge_bases` | List available knowledge bases |
| `crystal_query_knowledge_base` | Search a knowledge base |
| `crystal_import_knowledge` | Import reference chunks into a KB |
| `crystal_ideas` | List active Organic ideas and discoveries |
| `crystal_idea_action` | Act on Organic ideas |
| `memory_search` | Search LTM and return crystal paths |
| `memory_get` | Read a full memory by ID or path |

---

## HTTP API

All core operations available over authenticated HTTP:

```
POST /api/mcp/capture              Create a memory
POST /api/mcp/recall               Hybrid recall over all memory
POST /api/mcp/search-messages      Search short-term history

GET  /api/knowledge-bases          List knowledge bases
POST /api/knowledge-bases          Create a knowledge base
POST /api/knowledge-bases/:id/import       Import chunks
POST /api/knowledge-bases/:id/bulk-insert  High-volume migration
POST /api/knowledge-bases/:id/query        Query a knowledge base
```

All endpoints require `Authorization: Bearer <api-key>`. Per-key rate limiting enforced.

---

## Architecture

```
memorycrystal/
├── plugin/                 OpenClaw plugin — hooks into conversation lifecycle
├── plugins/shared/         Shared hook script for Claude Code, Codex, Factory
├── mcp-server/             MCP server — 24 tools over stdio or SSE
├── packages/mcp-server/    Streamable HTTP MCP variant
├── convex/                 Backend — schema, capture, recall, graph, sessions
│   └── crystal/            All Memory Crystal Convex functions
├── apps/
│   ├── web/                Next.js 15 dashboard (Tailwind 4, Convex Auth)
│   └── docs/               Mintlify documentation site
├── scripts/                Install, bootstrap, doctor, enable/disable
└── assets/                 Logos and brand assets
```

## Local development

Contributors can run an opt-in Dockerized Convex backend and dashboard locally, then seed fixture data without touching the managed production deployment:

```bash
npm run convex:local:up
npm run convex:local:seed
npm run convex:local:doctor
```

The local stack uses `http://127.0.0.1:3210` for Convex RPC, `http://127.0.0.1:3211` for HTTP actions, and `http://127.0.0.1:6791` for the dashboard. See [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) for setup, switching back to cloud, seed data, and troubleshooting.

## Self-hosted

Run everything on your own infrastructure:

```bash
git clone https://github.com/memorycrystal/memorycrystal.git
cd memorycrystal && npm install

# Deploy to your own Convex project
CONVEX_DEPLOYMENT=prod:your-project-123 npx convex deploy

# Configure
echo 'CONVEX_URL=https://your-project-123.convex.cloud' > mcp-server/.env
echo 'GEMINI_API_KEY=your-key' >> mcp-server/.env

# Enable and verify
npm run crystal:enable
npm run crystal:doctor
```

Full guide: [docs.memorycrystal.ai/configuration/self-hosting](https://docs.memorycrystal.ai/configuration/self-hosting)

---

## Security

- **Multi-tenant isolation** — owner checks on every retrieval, database-level separation
- **API keys** — SHA-256 hashed at rest, plaintext never stored
- **Content scanner** — blocks prompt injection, encoded payloads, credential patterns
- **Prompt injection mitigation** — recalled memories injected as informational context only
- **Rate limiting** — per-key enforcement on all endpoints
- **Audit logging** — all actions logged to `crystalAuditLog`
- **Device flow auth** — RFC 8628-style for CLI key provisioning
- **Local mode** — SQLite fallback, data never leaves your machine

---

## Pricing

| Plan | Price | Memories | STM Retention |
|---|---|---|---|
| **Free** | $0/mo | 500 | 7 days |
| **Pro** | $29/mo | 25,000 | 30 days |
| **Ultra** | $79/mo | Unlimited | 90 days |
| **Enterprise** | Custom | Custom | Custom |

Self-hosting is always free. Paid plans are for the managed cloud at [memorycrystal.ai](https://memorycrystal.ai).

---

## Contributing

Memory Crystal is MIT open source. PRs welcome.

```bash
git clone https://github.com/memorycrystal/memorycrystal.git
cd memorycrystal && npm install && npm run dev
```

## Star History

<a href="https://www.star-history.com/?repos=memorycrystal%2Fmemorycrystal&type=date&legend=top-left">
 <picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=memorycrystal/memorycrystal&type=date&theme=dark&legend=top-left" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=memorycrystal/memorycrystal&type=date&legend=top-left" />
  <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=memorycrystal/memorycrystal&type=date&legend=top-left" />
 </picture>
</a>

---

<p align="center">
  <sub>MIT License — <a href="https://memorycrystal.ai">memorycrystal.ai</a> — Operated by Illumin8 Inc.</sub>
</p>
