<!-- This repository is the open-source mirror of Memory Crystal. The hosted service and web app are maintained separately. -->

<p align="center">
  <a href="https://memorycrystal.ai">
    <img src="https://raw.githubusercontent.com/memorycrystal/memorycrystal/main/assets/icon.svg" alt="Memory Crystal" width="80" height="80">
  </a>
</p>

<h1 align="center">Memory Crystal</h1>

<p align="center">
  <strong>Your AI finally remembers.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/@memorycrystal/crystal-memory"><img src="https://img.shields.io/npm/v/@memorycrystal/crystal-memory?style=for-the-badge&color=cb3837" alt="npm version"></a>
  <a href="https://memorycrystal.ai"><img src="https://img.shields.io/badge/Cloud-Online-brightgreen?style=for-the-badge" alt="Cloud Status"></a>
</p>

<p align="center">
  <a href="https://memorycrystal.ai">Website</a> · <a href="https://memorycrystal.ai/docs">Docs</a> · <a href="https://memorycrystal.ai/dashboard">Dashboard</a> · <a href="https://github.com/memorycrystal/memorycrystal">GitHub</a>
</p>

---

Memory Crystal is a persistent cognitive memory layer for AI assistants. It captures every conversation, extracts what matters, stores it in a vector-indexed knowledge graph, and injects the right memories before each response. Your AI stops forgetting between sessions.

Ships as an [OpenClaw](https://github.com/openclaw/openclaw) plugin, an MCP server for any compatible host, a Next.js dashboard, and a Convex-backed multi-tenant cloud.

---

## 🧠 The Context Engine

This isn't a vector database with a chat wrapper. The Context Engine is an active memory system that runs before every AI response.

```
 User message arrives
        │
        ▼
┌──────────────────────────────────────────────┐
│              CONTEXT ENGINE                   │
│                                               │
│  1. Time-ordered recent window (last ~30 msgs, │
│     7k char budget)                            │
│  2. Semantic search + BM25 text search across  │
│     STM + LTM                                  │
│  3. Temporal hybrid retrieval — date-aware     │
│     candidate injection                        │
│  4. Knowledge graph boost — connected memories │
│     ranked higher                              │
│  5. Multi-signal reranker (vector, strength,   │
│     freshness, access, salience, continuity,   │
│     text match)                                │
│  6. Diversity filter — deduplicate near-       │
│     identical results                          │
│  7. Context budget gating — fit results to     │
│     model context window                       │
│  8. Inject top memories + recent context into  │
│     model context                              │
│  9. Reinforcement injection — re-surface key   │
│     memories after 5+ turns                    │
│                                               │
└──────────────────────────────────────────────┘
        │
        ▼
  AI responds with full context
        │
        ▼
┌──────────────────────────────────────────────┐
│            MEMORY EXTRACTION                  │
│                                               │
│  1. Capture raw message → STM                  │
│  2. LLM extracts durable memories → LTM       │
│  3. Async graph enrichment connects memories   │
│                                               │
└──────────────────────────────────────────────┘
```

Every response is informed by what came before. Every conversation feeds the next one.

## 🔮 Two Memory Layers

| Layer | What it stores | Retention |
|---|---|---|
| **Short-term (STM)** | Raw messages, verbatim | Rolling window (7–90 days by tier) |
| **Long-term (LTM)** | Extracted facts, decisions, lessons, people, rules | Forever, vector-indexed |

STM gives your AI perfect short-term recall. LTM gives it permanent knowledge. Both are searched together, every turn.

## 🕸️ Knowledge Graph

Memories don't exist in isolation. An async background job connects related memories into a graph — decisions link to the lessons that informed them, people link to the projects they worked on, rules link to the events that created them.

When the Context Engine searches, memories with strong graph connections to the current topic get ranked higher. Your AI doesn't just remember facts — it understands relationships.

## 📚 Knowledge Bases

Knowledge Bases are first-class immutable reference collections for documentation, policies, runbooks, and imported source material. They sit beside conversational memory, so your agent can keep learned context and stable reference data separate.

- **Immutable reference data** — imported chunks stay stable instead of being rewritten by ongoing conversation
- **Scope-aware privacy** — tenant and scope filters keep KBs private to the right workspace, client, or agent lane
- **Fast migration path** — bulk import for normal ingest, plus bulk-insert for high-volume backfills without blocking on embedding
- **Background enrichment** — embedding and graph backfill schedule themselves after import so large KBs can finish in the background

## 🗄️ Five Memory Stores

| Store | Purpose | Example |
|---|---|---|
| `sensory` | Raw observations and signals | "Andy sounds frustrated about the deploy" |
| `episodic` | Events and experiences | "We shipped v2 on March 15" |
| `semantic` | Facts and knowledge | "The API uses Convex for the backend" |
| `procedural` | Silent patterns, runbooks, and how-to memory | "Deploy with `npm run convex:deploy`" |
| `prospective` | Plans and future intentions | "Need to add billing webhooks next sprint" |

Each store has different retention rules and search weights. The Context Engine knows which stores matter for which questions.
Approved skills can be promoted on top of procedural memory, but procedurals remain the quiet execution layer by default.

## 🏷️ Nine Memory Categories

`decision` · `lesson` · `person` · `rule` · `event` · `fact` · `goal` · `workflow` · `conversation`

Memories are tagged on extraction so recall is precise. Ask "why did we choose Convex?" and you get decisions. Ask "how do I deploy?" and you get procedures.

## 🎯 Adaptive Recall

Six recall modes, automatically selected based on context:

- **General** — broad recall across STM + LTM for open-ended questions
- **Decision** — prioritize decisions, lessons, and rules before risky changes
- **Project** — pull goals, workflows, dependencies, and active implementation context
- **People** — focus on ownership, collaborators, and relationship context
- **Workflow** — surface procedures, rules, and reusable how-to memory
- **Conversation** — favor recent conversational continuity and session context

The Context Engine picks the right mode. You don't configure anything.

---

## ⚡ Quick Start

```bash
curl -fsSL https://memorycrystal.ai/crystal | bash
```

This installs the OpenClaw plugin and sets up your memory backend. Choose during install:

- **Cloud** — hosted at memorycrystal.ai, zero config
- **Self-hosted** — your own Convex deployment, full data sovereignty
- **Local** — SQLite only, no cloud, context engine only

After install, your AI has memory. Every conversation is captured, extracted, and searchable.

---

## 🛠️ Memory Tools

24 tools exposed across the MCP servers and the OpenClaw plugin:

| Tool | What it does |
|---|---|
| `crystal_set_scope` | Override Memory Crystal channel scope for the current session |
| `crystal_list_knowledge_bases` | List available knowledge bases, including scoped/private collections |
| `crystal_query_knowledge_base` | Search a specific knowledge base for reference answers and source chunks |
| `crystal_import_knowledge` | Import reference chunks into a knowledge base for durable retrieval |
| `memory_search` | Search long-term memory and return `crystal/<id>.md` paths for follow-up reads |
| `memory_get` | Read a full memory by `memoryId` or `crystal/<id>.md` path |
| `crystal_remember` | Store a memory manually — decisions, facts, lessons, anything worth keeping |
| `crystal_recall` | Semantic search across all long-term memory |
| `crystal_what_do_i_know` | Snapshot of everything known about a topic |
| `crystal_why_did_we` | Decision archaeology — understand why a past decision was made |
| `crystal_checkpoint` | Save a memory snapshot at a milestone |
| `crystal_search_messages` | Search verbatim conversation history with hybrid BM25 + vector search over STM |
| `crystal_preflight` | Pre-flight check before risky actions — returns relevant rules and lessons |
| `crystal_recent` | Fetch recent messages for short-term context |
| `crystal_edit` | Update an existing memory's title, content, tags, store, or category |
| `crystal_forget` | Archive or permanently delete a memory |
| `crystal_stats` | Memory and usage statistics |
| `crystal_trace` | Trace a memory back to the source conversation snapshot that created it |
| `crystal_wake` | Session startup — loads briefing and guardrails |
| `crystal_who_owns` | Find who owns a file, module, or area |
| `crystal_explain_connection` | Explain the relationship between two concepts |
| `crystal_dependency_chain` | Trace dependency chains between entities |
| `crystal_ideas` | List active Organic ideas and discoveries |
| `crystal_idea_action` | Star, dismiss, mark read, or otherwise act on Organic ideas |

These tools work in any MCP-compatible host (Claude Desktop, Cursor, Windsurf, etc.) or automatically within OpenClaw.

## 🌐 API

Memory Crystal exposes the same core memory surface over authenticated HTTP:

| Endpoint | What it does |
|---|---|
| `POST /api/mcp/capture` | Create a memory directly |
| `POST /api/mcp/recall` | Run hybrid recall over conversational and durable memory |
| `POST /api/mcp/search-messages` | Search short-term message history |
| `GET /api/knowledge-bases` | List knowledge bases, with optional scope and agent filters |
| `POST /api/knowledge-bases` | Create a knowledge base with tenant/scope isolation |
| `POST /api/knowledge-bases/:knowledgeBaseId/import` | Import chunks and schedule embedding/enrichment backfill |
| `POST /api/knowledge-bases/:knowledgeBaseId/bulk-insert` | Insert large migrations without embedding overhead on the request path |
| `POST /api/knowledge-bases/:knowledgeBaseId/query` | Query a single knowledge base directly |

Knowledge-base endpoints honor per-user tenancy and optional `scope` boundaries so reference data can stay isolated by client, workspace, or agent lane.

---

## 📦 Architecture

```
memorycrystal/
├── plugin/                 OpenClaw plugin (crystal-memory)
│   ├── index.js            Plugin entry, hooks into conversation lifecycle
│   ├── context-budget.js   Model-aware injection budget calculator
│   └── store/              Local SQLite store (offline fallback)
├── mcp-server/             MCP server (@memorycrystal/mcp-server)
│   └── src/index.ts        Exposes crystal_* tools over MCP protocol
├── packages/
│   └── mcp-server/         Streamable HTTP MCP server variant
├── apps/
│   └── web/                Next.js 15 dashboard (React 19, Tailwind 4)
│       ├── Memories viewer, session browser, API key management
│       └── Device flow auth (RFC 8628-style)
├── convex/                 Backend (Convex)
│   ├── schema.ts           Multi-tenant schema
│   └── crystal/            Capture, recall, sessions, graph enrichment
│       ├── knowledgeBases.ts  Knowledge base lifecycle, imports, queries, backfill scheduling
│       └── knowledgeHttp.ts   HTTP endpoints for KB list/create/import/bulk-insert/query
└── scripts/                Install, bootstrap, doctor, enable/disable
```

## 🧪 Testing

**Backend tests** (`convex/crystal/__tests__/`) — current core coverage using [Vitest](https://vitest.dev) + [convex-test](https://docs.convex.dev/testing):

| File | Covers |
|---|---|
| `message-search.test.ts` | Message vector search |
| `messageEmbeddings.test.ts` | Embedding generation and storage |
| `messageTurns.test.ts` | Multi-turn message handling |
| `multitenancy.test.ts` | Cross-tenant isolation |
| `recall-ranking.test.ts` | Recall result ranking and scoring |
| `temporal-recall.test.ts` | Temporal query parsing and date-aware recall |
| `edge-cases.test.ts` | Edge cases for temporal parsing, diversity, and similarity scoring |
| `organic-http-auth.test.ts` | Organic endpoint bearer auth enforcement |

**Plugin tests** (`plugin/`) — focused coverage for runtime injection and reinforcement behavior:

| File | Covers |
|---|---|
| `plugin/context-budget.test.js` | Model-aware injection budgets and section trimming |
| `plugin/reinforcement.test.js` | Reinforcement injection thresholds and budget limits |

**Integration tests** (`packages/mcp-server/test/`) — end-to-end tests against the MCP server HTTP API.

```bash
# Run unit tests
npx vitest                            # all unit tests (watch mode)
npx vitest run                        # single run (CI)

# Run integration tests (requires MEMORY_CRYSTAL_API_KEY env var)
node packages/mcp-server/test/integration.test.js

# Smoke test (plugin health check)
npm run test:smoke

# Capture end-to-end test
npm run test:capture-e2e
```

---

## 🔐 Security

- **Multi-tenant isolation** — each user's memories and scoped knowledge bases are isolated at the database level; owner checks run on every retrieval
- **API keys** — SHA-256 hashed at rest; plaintext keys are never stored; transient device-flow tokens cleared after retrieval
- **Bearer auth** — all API and MCP endpoints require `Authorization: Bearer <key>`
- **Per-key rate limiting** — rate limits enforced per API key on all endpoints
- **Audit logging** — all API actions (admin, impersonation, data access) are logged to `crystalAuditLog`
- **Content security scanner** — regex-based scanning on all memory create and update paths blocks prompt injection, encoded payloads, and credential patterns
- **Prompt injection mitigation** — recalled memories are injected as informational context only; wake briefings include a security header instructing the model to treat recalled content as non-directive
- **Sanitized prompt injection** — all memory and message content runs through `sanitizeForInjection()` before system prompt inclusion
- **Auto-updater integrity** — `plugin/update.sh` verifies SHA-256 checksums against `checksums.txt` when available; update aborts on mismatch
- **Device flow auth** — RFC 8628-style device code flow for CLI key provisioning
- **Local mode** — SQLite fallback, your data never leaves your machine

---

## 🏠 Self-Hosted Setup

Run everything on your own infrastructure. You need:

1. A [Convex](https://convex.dev) project (free tier works)
2. [OpenClaw](https://github.com/openclaw/openclaw) installed
3. Node.js 18+

> **Important:** The default config points to the hosted Convex deployment. To self-host, you **must** deploy your own Convex backend and set the `CONVEX_DEPLOYMENT` environment variable so all data stays on your infrastructure.

```bash
# Clone the repo
git clone https://github.com/memorycrystal/memorycrystal.git
cd memorycrystal
npm install

# 1. Create a Convex project at https://dashboard.convex.dev and note
#    your deployment name (e.g. "your-project-123")

# 2. Deploy the schema and functions to YOUR Convex backend
CONVEX_DEPLOYMENT=prod:your-project-123 npx convex deploy

# 3. Set env vars for the plugin / MCP server
#    In mcp-server/.env (and your shell):
#      CONVEX_URL=https://your-project-123.convex.cloud
#      GEMINI_API_KEY=<your-gemini-api-key>

# 4. Enable the plugin and verify
npm run crystal:enable
npm run crystal:doctor
```

If you skip setting `CONVEX_DEPLOYMENT` / `CONVEX_URL`, the system will fall back to the hosted cloud backend at `<your-deployment>.convex.cloud`, which is not self-hosting.

Full guide: [docs/02-setup-guides/INSTALL.md](docs/02-setup-guides/INSTALL.md)

---

## 💰 Pricing

| Plan | Price | Memories | Support |
|---|---|---|---|
| **Free** | $0 | 500 memories, 3 channels, 7d STM | Community |
| **Pro** | $29/mo | 25,000 managed | Email |
| **Ultra** | $79/mo | Unlimited managed | Priority |
| **Enterprise** | Custom | Custom limits, SLAs | Dedicated |

Free gives you a managed starter tier. Paid plans raise capacity and support, and self-hosting remains available if you want full data sovereignty.

---

## 🤝 Contributing

Memory Crystal is MIT open source. PRs welcome.

```bash
git clone https://github.com/memorycrystal/memorycrystal.git
cd memorycrystal
npm install
npm run dev
```

---

## Star History

<a href="https://www.star-history.com/?repos=memorycrystal%2Fmemorycrystal&type=date&legend=top-left">
 <picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=memorycrystal/memorycrystal&type=date&theme=dark&legend=top-left" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=memorycrystal/memorycrystal&type=date&legend=top-left" />
  <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=memorycrystal/memorycrystal&type=date&legend=top-left" />
 </picture>
</a>

---

## 📄 License

[MIT](LICENSE) — do whatever you want with it.

The hosted service at [memorycrystal.ai](https://memorycrystal.ai) is operated by Illumin8 Inc. The "Memory Crystal" name and brand are trademarks of Illumin8 Inc.
