# Memory Crystal Streamable HTTP MCP Server

Standalone MCP server that wraps Memory Crystal's hosted HTTP API and exposes it over the MCP Streamable HTTP transport.

## Features

Exposes 18 MCP tools:

| Tool | API Endpoint |
|------|-------------|
| `crystal_recall` | `POST /api/mcp/recall` |
| `crystal_remember` | `POST /api/mcp/capture` |
| `crystal_recent` | `POST /api/mcp/recent-messages` |
| `crystal_search_messages` | `POST /api/mcp/search-messages` |
| `crystal_what_do_i_know` | `POST /api/mcp/recall` |
| `crystal_why_did_we` | `POST /api/mcp/recall` (mode: decision) |
| `crystal_who_owns` | `POST /api/mcp/recall` (mode: people) |
| `crystal_explain_connection` | `POST /api/mcp/recall` |
| `crystal_dependency_chain` | `POST /api/mcp/recall` (mode: project) |
| `crystal_preflight` | `POST /api/mcp/recall` (categories: rule, lesson, decision) |
| `crystal_forget` | `POST /api/mcp/forget` |
| `crystal_stats` | `GET /api/mcp/stats` |
| `crystal_checkpoint` | `POST /api/mcp/checkpoint` |
| `crystal_wake` | `POST /api/mcp/wake` |
| `crystal_trace` | `POST /api/mcp/trace` |
| `crystal_list_knowledge_bases` | `GET /api/knowledge-bases` |
| `crystal_query_knowledge_base` | `POST /api/knowledge-bases/:knowledgeBaseId/query` |
| `crystal_import_knowledge` | `POST /api/knowledge-bases/:knowledgeBaseId/import` |

## Config

Environment variables:

- `MEMORY_CRYSTAL_API_KEY` — optional at process level, but required unless the client sends `Authorization: Bearer <key>`
- `MEMORY_CRYSTAL_API_URL` — required in the current implementation; points at your Memory Crystal backend base URL such as `https://<your-deployment>.convex.site`
- `PORT` — optional, defaults to `3100`
- `HOST` — optional, defaults to `0.0.0.0`

## Install

From the monorepo root:

```bash
npm install
npm run build --workspace packages/mcp-server
```

## Run

```bash
MEMORY_CRYSTAL_API_URL=https://rightful-mockingbird-389.convex.site \
MEMORY_CRYSTAL_API_KEY=your_api_key_here \
npm run start --workspace packages/mcp-server
```

Server endpoints:

- MCP: `http://localhost:3100/mcp`
- Health: `http://localhost:3100/health`

## Claude Code

```bash
claude mcp add memory-crystal --transport http http://localhost:3100/mcp
```

If you want the server to rely on header-based auth instead of an env var, make sure your client includes:

```http
Authorization: Bearer <your-memory-crystal-api-key>
```

## Codex CLI

```bash
codex mcp add memory-crystal --url http://localhost:3100/mcp
```

## Deploy

This package is a plain Node HTTP service and can be deployed on Railway, Fly.io, Render, or any container/runtime that can run:

```bash
npm run start --workspace packages/mcp-server
```

### Railway (monorepo)

This repo already has a root `railway.toml` for the web app, so the MCP service must use its own config file.

Use these **service settings** in Railway for the `mcp-server` service:

- **Root Directory:** `/packages/mcp-server`
- **Railway Config File:** `/packages/mcp-server/railway.toml`
- **Port:** `3100`

The package-local `railway.toml` handles:

- build: `npm install && npm run build`
- start: `node dist/index.js`
- healthcheck: `/health`
- watch path: `/packages/mcp-server/**`

Why this matters: Railway will otherwise pick up the repo-root `railway.toml` and boot the Next.js web app instead of the MCP server.

## Notes

- The server uses the official `@modelcontextprotocol/sdk` Streamable HTTP transport.
- It is implemented as a stateless HTTP MCP endpoint at `/mcp`.
- All backend requests to Memory Crystal are authenticated with `Authorization: Bearer <apiKey>`.
