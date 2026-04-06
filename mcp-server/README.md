# @memorycrystal/mcp-server

**Note:** This is the deprecated stdio/SSE MCP server. For the current Streamable HTTP server, see `packages/mcp-server/`.

Persistent memory for AI assistants via the Model Context Protocol.

## Install

```bash
npm install -g @memorycrystal/mcp-server
```

## Configure

Set environment variables:
- `MEMORY_CRYSTAL_API_KEY` — your Memory Crystal API key (preferred; legacy alias: `CRYSTAL_API_KEY`)
- `MEMORY_CRYSTAL_API_URL` — your Memory Crystal backend base URL (preferred; legacy aliases: `MEMORY_CRYSTAL_BACKEND_URL`, `CRYSTAL_BASE_URL`)

## Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory-crystal": {
      "command": "crystal-mcp",
      "env": {
        "MEMORY_CRYSTAL_API_KEY": "your-api-key-here",
        "MEMORY_CRYSTAL_API_URL": "https://rightful-mockingbird-389.convex.site"
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
        "MEMORY_CRYSTAL_API_KEY": "your-api-key-here",
        "MEMORY_CRYSTAL_API_URL": "https://rightful-mockingbird-389.convex.site"
      }
    }
  }
}
```

Or run directly:
```bash
MEMORY_CRYSTAL_API_URL=https://rightful-mockingbird-389.convex.site MEMORY_CRYSTAL_API_KEY=your-key crystal-mcp
```

## Codex CLI

Add via the Codex CLI:
```bash
codex mcp add memory-crystal -- crystal-mcp
```

Then set environment variables `MEMORY_CRYSTAL_API_KEY` and `MEMORY_CRYSTAL_API_URL`, or pass inline:
```bash
MEMORY_CRYSTAL_API_URL=https://rightful-mockingbird-389.convex.site MEMORY_CRYSTAL_API_KEY=your-key npx @memorycrystal/mcp-server
```

## Available Tools

21 tools are available in the deprecated stdio/SSE server:

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

## Memory Stores

- **sensory** — immediate context, fades fastest
- **episodic** — events and conversations
- **semantic** — facts and knowledge
- **procedural** — how-to knowledge and workflows
- **prospective** — goals and future intentions

## Memory Categories

`decision` · `lesson` · `person` · `rule` · `event` · `fact` · `goal` · `workflow` · `conversation`
