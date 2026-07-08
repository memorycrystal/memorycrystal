# @memorycrystal/mcp-server

**Note:** This is the deprecated local stdio/HTTP MCP server. For the current hosted Streamable HTTP server, see `packages/mcp-server/`.

Persistent memory for AI assistants via the Model Context Protocol.

## Install

```bash
npm install -g @memorycrystal/mcp-server
```

## Configure

Set environment variables:
- `MEMORY_CRYSTAL_API_KEY` — your Memory Crystal API key
- `MEMORY_CRYSTAL_API_URL` — your Memory Crystal backend base URL
- `CRYSTAL_MCP_MODE=stdio` — required for command-launched local MCP clients so `crystal-mcp` speaks stdio instead of starting the local HTTP listener

`CRYSTAL_API_KEY` is no longer supported. If your client or shell still sets it,
upgrade Memory Crystal and replace it with `MEMORY_CRYSTAL_API_KEY`.
`MEMORY_CRYSTAL_BACKEND_URL` and `CRYSTAL_BASE_URL` are also retired; use
`MEMORY_CRYSTAL_API_URL`.

## Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory-crystal": {
      "command": "crystal-mcp",
      "env": {
        "CRYSTAL_MCP_MODE": "stdio",
        "MEMORY_CRYSTAL_API_KEY": "your-api-key-here",
        "MEMORY_CRYSTAL_API_URL": "https://convex.memorycrystal.ai"
      }
    }
  }
}
```

## Claude Code

Add to `.claude/mcp.json` in your project:

```json
{
  "mcpServers": {
    "memory-crystal": {
      "command": "crystal-mcp",
      "env": {
        "CRYSTAL_MCP_MODE": "stdio",
        "MEMORY_CRYSTAL_API_KEY": "your-api-key-here",
        "MEMORY_CRYSTAL_API_URL": "https://convex.memorycrystal.ai"
      }
    }
  }
}
```

Or run directly:
```bash
CRYSTAL_MCP_MODE=stdio MEMORY_CRYSTAL_API_URL=https://convex.memorycrystal.ai MEMORY_CRYSTAL_API_KEY=your-key crystal-mcp
```

## Codex CLI

Add via the Codex CLI:
```bash
codex mcp add memory-crystal -- crystal-mcp
```

Then set environment variables `CRYSTAL_MCP_MODE=stdio`, `MEMORY_CRYSTAL_API_KEY`, and `MEMORY_CRYSTAL_API_URL`, or pass inline:
```bash
CRYSTAL_MCP_MODE=stdio MEMORY_CRYSTAL_API_URL=https://convex.memorycrystal.ai MEMORY_CRYSTAL_API_KEY=your-key npx @memorycrystal/mcp-server
```

## Available Tools

21 tools are available in the deprecated local stdio/HTTP server:

| Tool | Description |
|------|-------------|
| `crystal_wake` | Get a contextual briefing at session start |
| `crystal_remember` | Save a memory (decision, lesson, goal, etc.) |
| `crystal_recall` | Semantic search across your memories |
| `crystal_recent` | Get recently accessed memories |
| `crystal_search_messages` | Search conversation history |
| `crystal_what_do_i_know` | Summarize what's known about a topic |
| `crystal_why_did_we` | Explain the reasoning behind past decisions |
| `crystal_who_owns` | Find who owns or manages an entity |
| `crystal_explain_connection` | Explain how two concepts are connected |
| `crystal_dependency_chain` | Trace dependencies for a goal or project |
| `crystal_preflight` | Pre-flight check before destructive actions |
| `crystal_trace` | Trace a memory back to its source conversation |
| `crystal_edit` | Edit or refine an existing memory |
| `crystal_checkpoint` | Save a session checkpoint |
| `crystal_forget` | Archive (soft-delete) a memory |
| `crystal_stats` | Get memory usage stats |
| `crystal_ideas` | View Organic idea discoveries |
| `crystal_idea_action` | Star, dismiss, or mark an Organic idea as read |
| `crystal_list_knowledge_bases` | List available knowledge bases, including inactive collections when needed |
| `crystal_query_knowledge_base` | Search within a specific knowledge base |
| `crystal_import_knowledge` | Import reference chunks into a knowledge base |

`crystal_recent`, `crystal_search_messages`, recall message matches, and wake/session summaries derived from recent messages redact likely secrets before returning output. Newly captured messages become searchable after the active turn completes, not during same-turn tool execution.

### Tool-search discoverability (operators)

All tools above are registered unconditionally — the server never hides them behind lazy/tool-search gating. If your host client (e.g. some Hermes/agent configurations) enables tool-search that hides infrequently-used tools, make sure the core memory tools stay surfaced so the agent can always reach them: **`crystal_recall`, `crystal_remember`, `crystal_preflight`** are the always-on core. Add them to any client-side tool allowlist / "always available" set. Recall now defaults to **12** results when `limit` is omitted (hard max stays 20).

## Retrieval guidance

- Use `crystal_recall` and reasoning helpers for graph-aware blended memory context.
- Use `crystal_query_knowledge_base` for named manuals, voice guides, transcripts, runbooks, and imported reference corpora.
- Use `crystal_search_messages` for exact retained transcript wording.
- Use `crystal_preflight` before risky actions and pass `projectId` or `repoSlug` for repo-specific work.
- Pass `agentId`, `channel`, `projectId`, or `repoSlug` whenever the client knows the agent/client/repo boundary.
- Treat KB `sourceRole` values such as `voice_style`, `persona_guardrail`, `canonical_reference`, and `client_context` as provenance and ranking signals.

## Memory Stores

- **sensory** — short-lived observation capsules; lower-authority fallback context, not raw transcript storage
- **episodic** — events and conversations
- **semantic** — facts and knowledge
- **procedural** — how-to knowledge and workflows
- **prospective** — goals and future intentions

## Memory Categories

`decision` · `lesson` · `person` · `rule` · `event` · `fact` · `goal` · `workflow` · `conversation`
