#!/usr/bin/env node
import express, { type Request } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

type ApiRequestOptions = {
  method?: "GET" | "POST";
  path: string;
  apiKey?: string;
  body?: unknown;
};

const DEFAULT_API_URL: string | undefined = undefined;
const DEFAULT_PORT = 3100;

const memoryStores = ["sensory", "episodic", "semantic", "procedural", "prospective"] as const;
const memoryCategories = [
  "decision", "lesson", "person", "rule", "event", "fact", "goal", "workflow", "conversation",
] as const;
const recallModes = ["general", "decision", "project", "people", "workflow", "conversation"] as const;

function getApiBaseUrl(): string {
  const url = process.env.MEMORY_CRYSTAL_API_URL || DEFAULT_API_URL;
  if (!url) {
    throw new Error("MEMORY_CRYSTAL_API_URL environment variable is required");
  }
  return url.replace(/\/+$/, "");
}

function getApiKeyFromRequest(req: Request): string | undefined {
  const authHeader = req.header("authorization") || req.header("Authorization");
  const envApiKey = process.env.MEMORY_CRYSTAL_API_KEY?.trim();

  if (authHeader) {
    const [scheme, token] = authHeader.split(/\s+/, 2);
    if (scheme?.toLowerCase() === "bearer" && token?.trim()) {
      return token.trim();
    }
  }

  return envApiKey || undefined;
}

async function callMemoryCrystalApi<T>({ method = "POST", path, apiKey, body }: ApiRequestOptions): Promise<T> {
  if (!apiKey) {
    throw new Error(
      "Missing API key. Set MEMORY_CRYSTAL_API_KEY on the server or send Authorization: Bearer <key>."
    );
  }

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });

  const rawText = await response.text();
  let payload: unknown = null;

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = rawText;
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new Error(`Memory Crystal API error (${response.status}): ${message}`);
  }

  return payload as T;
}

function toTextResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Response trimming — keep MCP payloads lean for LLM context windows
// ---------------------------------------------------------------------------

function truncate(text: string | undefined, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function filterTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => typeof t === "string" && !t.startsWith("source:"));
}

function trimMemory(m: any, contentMax = 300) {
  return {
    _id: m._id,
    memoryId: m._id ?? m.memoryId ?? m.id,
    title: m.title,
    content: truncate(m.content, contentMax),
    store: m.store,
    category: m.category,
    tags: filterTags(m.tags),
    score: m.score,
    createdAt: m.createdAt,
  };
}

function trimMessage(msg: any, contentMax = 200) {
  return {
    messageId: msg.messageId ?? msg._id,
    role: msg.role,
    content: truncate(msg.content, contentMax),
    channel: msg.channel,
    sessionKey: msg.sessionKey,
    timestamp: msg.timestamp,
    score: msg.score,
  };
}

function trimRecallResponse(raw: any, contentMax = 300) {
  return {
    memories: (raw.memories ?? []).map((m: any) => trimMemory(m, contentMax)),
    messageMatches: (raw.messageMatches ?? []).slice(0, 3).map((m: any) => trimMessage(m)),
  };
}

function withQuery(path: string, params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function createServer(req: Request): McpServer {
  const apiKey = getApiKeyFromRequest(req);

  const server = new McpServer(
    {
      name: "memory-crystal-streamable-http",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Use these tools to search, save, checkpoint, and inspect Memory Crystal data through the hosted API.",
    }
  );

  // 1. crystal_recall — Semantic search over memories
  server.registerTool(
    "crystal_recall",
    {
      title: "Recall memories",
      description: "Semantic recall over stored Memory Crystal memories.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        mode: z.enum(recallModes).optional().describe(
          "Recall mode preset. 'decision' prioritizes decisions/lessons. 'project' pulls goals/workflows/facts. 'people' focuses on person memories. 'workflow' pulls procedural rules. 'conversation' pulls recent context. Default: 'general'."
        ),
        stores: z.array(z.enum(memoryStores)).optional().describe("Filter by memory stores"),
        categories: z.array(z.enum(memoryCategories)).optional().describe("Filter by categories"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        limit: z.number().int().min(1).max(20).default(5).optional().describe("Maximum results"),
        includeArchived: z.boolean().optional().describe("Include archived memories"),
        includeAssociations: z.boolean().default(true).optional().describe("Include associated memories"),
      },
    },
    async ({ query, mode, stores, categories, tags, limit, includeArchived, includeAssociations }) => {
      const raw = await callMemoryCrystalApi({
        path: "/api/mcp/recall",
        apiKey,
        body: { query, mode, stores, categories, tags, limit, includeArchived, includeAssociations },
      });
      return toTextResult(trimRecallResponse(raw));
    }
  );

  // 2. crystal_remember — Save a memory
  server.registerTool(
    "crystal_remember",
    {
      title: "Remember",
      description: "Create a Memory Crystal memory.",
      inputSchema: {
        title: z.string().min(5).max(80).describe("Short descriptive title"),
        content: z.string().min(1).describe("Memory content"),
        store: z.enum(memoryStores).describe("Memory store"),
        category: z.enum(memoryCategories).describe("Memory category"),
        tags: z.array(z.string()).optional().describe("Tags for the memory"),
        confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1"),
        valence: z.number().min(-1).max(1).optional().describe("Emotional valence -1 to 1"),
        arousal: z.number().min(0).max(1).optional().describe("Arousal level 0-1"),
        channel: z.string().optional().describe("Channel identifier"),
      },
    },
    async ({ title, content, store, category, tags, confidence, valence, arousal, channel }) => {
      const result = await callMemoryCrystalApi({
        path: "/api/mcp/capture",
        apiKey,
        body: { title, content, store, category, tags, confidence, valence, arousal, channel },
      });
      return toTextResult(result);
    }
  );

  // 3. crystal_recent — Get recent messages
  server.registerTool(
    "crystal_recent",
    {
      title: "Recent messages",
      description: "Fetch the most recent short-term messages.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).optional().describe("Maximum messages"),
        channel: z.string().optional().describe("Filter by channel"),
      },
    },
    async ({ limit, channel }) => {
      const raw = await callMemoryCrystalApi<any>({
        path: "/api/mcp/recent-messages",
        apiKey,
        body: { limit, channel },
      });
      return toTextResult({
        messages: (raw.messages ?? []).map((m: any) => trimMessage(m, 300)),
      });
    }
  );

  // 4. crystal_search_messages — Search conversation logs
  server.registerTool(
    "crystal_search_messages",
    {
      title: "Search messages",
      description: "Semantic search over short-term memory messages.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(50).default(10).optional().describe("Maximum results"),
        sinceMs: z.number().optional().describe("Only messages after this timestamp (ms)"),
        channel: z.string().optional().describe("Filter by channel"),
      },
    },
    async ({ query, limit, sinceMs, channel }) => {
      const raw = await callMemoryCrystalApi<any>({
        path: "/api/mcp/search-messages",
        apiKey,
        body: { query, limit, sinceMs, channel },
      });
      return toTextResult({
        messages: (raw.messages ?? []).map((m: any) => trimMessage(m, 300)),
      });
    }
  );

  // 5. crystal_what_do_i_know — Topic summary (recall-based)
  server.registerTool(
    "crystal_what_do_i_know",
    {
      title: "What do I know",
      description: "Broad topic scan over Memory Crystal memories. Returns a summary of everything known about a topic.",
      inputSchema: {
        topic: z.string().min(3).describe("Topic to scan"),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
        stores: z.array(z.enum(memoryStores)).optional().describe("Filter by stores"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
      },
    },
    async ({ topic, limit, stores, tags }) => {
      const raw = await callMemoryCrystalApi({
        path: "/api/mcp/recall",
        apiKey,
        body: { query: topic, limit, stores, tags },
      });
      return toTextResult(trimRecallResponse(raw, 500));
    }
  );

  // 6. crystal_why_did_we — Decision archaeology (recall-based)
  server.registerTool(
    "crystal_why_did_we",
    {
      title: "Why did we",
      description: "Decision archaeology across Memory Crystal decision memories.",
      inputSchema: {
        decision: z.string().min(3).describe("The decision to investigate"),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
      },
    },
    async ({ decision, limit }) => {
      const raw = await callMemoryCrystalApi({
        path: "/api/mcp/recall",
        apiKey,
        body: {
          query: decision,
          categories: ["decision"],
          limit: limit ?? 8,
          mode: "decision",
        },
      });
      return toTextResult(trimRecallResponse(raw, 500));
    }
  );

  // 7. crystal_who_owns — Find who owns a topic/project (recall-based)
  server.registerTool(
    "crystal_who_owns",
    {
      title: "Who owns",
      description: "Find who owns, manages, or is assigned to an entity. Returns ownership context from memories.",
      inputSchema: {
        topic: z.string().min(1).describe("The entity or topic to look up ownership for"),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
      },
    },
    async ({ topic, limit }) => {
      const raw = await callMemoryCrystalApi({
        path: "/api/mcp/recall",
        apiKey,
        body: {
          query: `who owns ${topic}`,
          categories: ["person"],
          limit: limit ?? 5,
          mode: "people",
        },
      });
      return toTextResult(trimRecallResponse(raw));
    }
  );

  // 8. crystal_explain_connection — Explain connection between concepts (recall-based)
  server.registerTool(
    "crystal_explain_connection",
    {
      title: "Explain connection",
      description: "Explain how two concepts or entities are connected based on stored memories.",
      inputSchema: {
        from: z.string().min(1).describe("First entity"),
        to: z.string().min(1).describe("Second entity"),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
      },
    },
    async ({ from, to, limit }) => {
      const raw = await callMemoryCrystalApi({
        path: "/api/mcp/recall",
        apiKey,
        body: {
          query: `connection between ${from} and ${to}`,
          limit: limit ?? 5,
        },
      });
      return toTextResult(trimRecallResponse(raw));
    }
  );

  // 9. crystal_dependency_chain — Show dependency chain (recall-based)
  server.registerTool(
    "crystal_dependency_chain",
    {
      title: "Dependency chain",
      description: "Trace the dependency chain for a goal, project, or task based on stored memories.",
      inputSchema: {
        topic: z.string().min(1).describe("The goal, project, or task to trace dependencies for"),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
      },
    },
    async ({ topic, limit }) => {
      const raw = await callMemoryCrystalApi({
        path: "/api/mcp/recall",
        apiKey,
        body: {
          query: `dependencies for ${topic}`,
          limit: limit ?? 5,
          mode: "project",
        },
      });
      return toTextResult(trimRecallResponse(raw, 500));
    }
  );

  // 10. crystal_forget — Archive a memory
  server.registerTool(
    "crystal_forget",
    {
      title: "Forget memory",
      description: "Archive (soft-delete) a Memory Crystal memory by ID.",
      inputSchema: {
        memoryId: z.string().min(1).describe("The memory ID to archive"),
        permanent: z.boolean().optional().describe("Permanently delete instead of archiving"),
      },
    },
    async ({ memoryId, permanent }) => {
      const result = await callMemoryCrystalApi({
        path: "/api/mcp/forget",
        apiKey,
        body: { memoryId, permanent },
      });
      return toTextResult(result);
    }
  );

  // 11. crystal_stats — Get stats
  server.registerTool(
    "crystal_stats",
    {
      title: "Memory stats",
      description: "Get Memory Crystal health and usage statistics.",
    },
    async () => {
      const result = await callMemoryCrystalApi({
        method: "GET",
        path: "/api/mcp/stats",
        apiKey,
      });
      return toTextResult(result);
    }
  );

  // 12. crystal_checkpoint — Create checkpoint
  server.registerTool(
    "crystal_checkpoint",
    {
      title: "Create checkpoint",
      description: "Create or list Memory Crystal checkpoints.",
      inputSchema: {
        label: z.string().min(1).describe("Checkpoint label/summary"),
        description: z.string().optional().describe("Longer description"),
      },
    },
    async ({ label, description }) => {
      const result = await callMemoryCrystalApi({
        path: "/api/mcp/checkpoint",
        apiKey,
        body: { label, description },
      });
      return toTextResult(result);
    }
  );

  // 13. crystal_wake — Get wake briefing
  server.registerTool(
    "crystal_wake",
    {
      title: "Wake briefing",
      description: "Get an opening briefing for the current memory session.",
      inputSchema: {
        channel: z.string().optional().describe("Channel identifier"),
      },
    },
    async ({ channel }) => {
      const raw = await callMemoryCrystalApi<any>({
        path: "/api/mcp/wake",
        apiKey,
        body: { channel },
      });
      return toTextResult({
        briefing: raw.briefing,
        lastCheckpoint: raw.lastCheckpoint
          ? { label: raw.lastCheckpoint.label, createdAt: raw.lastCheckpoint.createdAt }
          : null,
        recentMemories: (raw.recentMemories ?? []).slice(0, 5).map((m: any) => trimMemory(m, 200)),
        recentMessages: (raw.recentMessages ?? []).slice(0, 5).map((m: any) => trimMessage(m, 150)),
      });
    }
  );

  // 14. crystal_preflight — Pre-flight check (recall-based)
  server.registerTool(
    "crystal_preflight",
    {
      title: "Pre-flight check",
      description: "Run a pre-flight check before a destructive or production action. Returns relevant rules, lessons, and decisions as a checklist.",
      inputSchema: {
        action: z.string().min(3).describe("Description of the action you are about to take"),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
      },
    },
    async ({ action, limit }) => {
      const raw = await callMemoryCrystalApi({
        path: "/api/mcp/recall",
        apiKey,
        body: {
          query: action,
          categories: ["rule", "lesson", "decision"],
          limit: limit ?? 10,
        },
      });
      return toTextResult(trimRecallResponse(raw, 400));
    }
  );

  // 15. crystal_trace — Trace memory back to source conversation
  server.registerTool(
    "crystal_trace",
    {
      title: "Crystal Trace",
      description:
        "Trace a memory back to its source conversation. Returns the conversation snapshot that created this memory.",
      inputSchema: {
        memoryId: z.string().min(1).describe("The memory ID to trace"),
      },
    },
    async ({ memoryId }) => {
      try {
        const result = await callMemoryCrystalApi({
          path: "/api/mcp/trace",
          apiKey,
          body: { memoryId },
        });
        return toTextResult(result);
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // 16. crystal_list_knowledge_bases — List KBs
  server.registerTool(
    "crystal_list_knowledge_bases",
    {
      title: "List knowledge bases",
      description: "List available Memory Crystal knowledge bases, including scoped collections.",
      inputSchema: {
        includeInactive: z.boolean().optional().describe("Include inactive knowledge bases"),
        scope: z.string().optional().describe("Optional scope filter"),
        agentId: z.string().optional().describe("Optional agent filter"),
      },
    },
    async ({ includeInactive, scope, agentId }) => {
      const result = await callMemoryCrystalApi({
        method: "GET",
        path: withQuery("/api/knowledge-bases", { includeInactive, scope, agentId }),
        apiKey,
      });
      return toTextResult(result);
    }
  );

  // 17. crystal_query_knowledge_base — Query KB
  server.registerTool(
    "crystal_query_knowledge_base",
    {
      title: "Query knowledge base",
      description: "Search a specific Memory Crystal knowledge base.",
      inputSchema: {
        knowledgeBaseId: z.string().min(1).describe("Knowledge base id"),
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
        agentId: z.string().optional().describe("Optional agent context"),
        channel: z.string().optional().describe("Optional scope/channel context"),
      },
    },
    async ({ knowledgeBaseId, query, limit, agentId, channel }) => {
      const result = await callMemoryCrystalApi({
        path: `/api/knowledge-bases/${knowledgeBaseId}/query`,
        apiKey,
        body: { query, limit, agentId, channel },
      });
      return toTextResult(result);
    }
  );

  // 18. crystal_import_knowledge — Import KB chunks
  server.registerTool(
    "crystal_import_knowledge",
    {
      title: "Import knowledge",
      description: "Import reference chunks into a specific Memory Crystal knowledge base.",
      inputSchema: {
        knowledgeBaseId: z.string().min(1).describe("Knowledge base id"),
        chunks: z.array(
          z.object({
            content: z.string().min(1).describe("Chunk content"),
            metadata: z.object({
              title: z.string().optional(),
              sourceUrl: z.string().optional(),
              chunkIndex: z.number().optional(),
              totalChunks: z.number().optional(),
              sourceType: z.string().optional(),
            }).optional(),
          })
        ).min(1).describe("Knowledge chunks to import"),
      },
    },
    async ({ knowledgeBaseId, chunks }) => {
      const result = await callMemoryCrystalApi({
        path: `/api/knowledge-bases/${knowledgeBaseId}/import`,
        apiKey,
        body: { chunks },
      });
      return toTextResult(result);
    }
  );

  return server;
}

async function handleMcpRequest(req: Request, res: express.Response) {
  const server = createServer(req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
        id: null,
      });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

const host = process.env.HOST || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const app = createMcpExpressApp({ host });

app.use(express.json({ limit: "1mb" }));

// MCP client compatibility middleware:
// 1. Patch Accept header — SDK returns 406 unless both application/json and
//    text/event-stream are present. Some clients (e.g. Codex) send narrower values.
// 2. Log request metadata for discovery diagnostics (no secrets or bodies).
app.use("/mcp", (req, res, next) => {
  const originalAccept = req.headers.accept || "";
  const needs = [];
  if (!originalAccept.includes("application/json")) needs.push("application/json");
  if (!originalAccept.includes("text/event-stream")) needs.push("text/event-stream");
  if (needs.length) {
    req.headers.accept = originalAccept
      ? `${originalAccept}, ${needs.join(", ")}`
      : needs.join(", ");
  }

  // Extract MCP method name from JSON-RPC body (if parsed)
  const mcpMethod =
    req.body?.method || (Array.isArray(req.body) ? req.body[0]?.method : undefined) || "-";
  const hasAuth = Boolean(req.headers.authorization);

  res.on("finish", () => {
    console.log(
      `[mcp] ${req.method} ${mcpMethod} accept=${originalAccept || "(none)"} ` +
        `auth=${hasAuth} status=${res.statusCode} content-type=${res.getHeader("content-type") || "-"}`
    );
  });

  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "memory-crystal-streamable-http",
    apiUrl: getApiBaseUrl(),
  });
});

app.post("/mcp", handleMcpRequest);
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST for Streamable HTTP MCP requests.",
    },
    id: null,
  });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  });
});

app.listen(port, host, () => {
  console.log(`Memory Crystal MCP server listening on http://${host}:${port}/mcp`);
});
