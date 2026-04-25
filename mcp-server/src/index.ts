#!/usr/bin/env node
// Prevent API keys or auth tokens from leaking into server logs via error messages.
const sanitizeErrorForLog = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9+/_=.-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]")
    .replace(/(\?|&)(api_?key|token|secret)=[^&\s]+/gi, "$1$2=[REDACTED]");
};

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleRecallTool, recallTool } from "./tools/recall.js";
import { handleRememberTool, rememberTool } from "./tools/remember.js";
import { handleCheckpointTool, checkpointTool } from "./tools/checkpoint.js";
import { handleForgetTool, forgetTool } from "./tools/forget.js";
import { handleStatsTool, statsTool } from "./tools/stats.js";
import { handleWhatDoIKnowTool, whatDoIKnowTool } from "./tools/what-do-i-know.js";
import { handleWhyDidWeTool, whyDidWeTool } from "./tools/why-did-we.js";
import { handleWakeTool, wakeTool } from "./tools/wake.js";
import { handleRecentTool, recentTool } from "./tools/recent.js";
import { handleSearchMessagesTool, searchMessagesTool } from "./tools/search-messages.js";
import { handleWhoOwnsTool, whoOwnsTool } from "./tools/who-owns.js";
import { handleExplainConnectionTool, explainConnectionTool } from "./tools/explain-connection.js";
import { handleDependencyChainTool, dependencyChainTool } from "./tools/dependency-chain.js";
import { handlePreflightTool, preflightTool } from "./tools/preflight.js";
import { handleTraceTool, traceTool } from "./tools/trace.js";
import { editTool, handleEditTool } from "./tools/edit.js";
import { handleUpdateTool, updateTool } from "./tools/update.js";
import { handleSupersedeTool, supercedeTool, supersedeTool } from "./tools/supersede.js";
import { handleIdeasTool, ideasTool } from "./tools/ideas.js";
import { handleIdeaActionTool, ideaActionTool } from "./tools/idea-action.js";
import { handleImportKnowledgeTool, importKnowledgeTool } from "./tools/import-knowledge.js";
import { handleListKnowledgeBasesTool, listKnowledgeBasesTool } from "./tools/list-knowledge-bases.js";
import { handleQueryKnowledgeBaseTool, queryKnowledgeBaseTool } from "./tools/query-knowledge-base.js";
import { createMcpRequestContext, runWithMcpRequestContext } from "./lib/convexClient.js";

type AuthHeaderCarrier =
  | { headers: { get(name: string): string | null } }
  | { headers: Record<string, string | string[] | undefined> };

function readAuthorizationHeader(req: AuthHeaderCarrier): string | null {
  const headers = req.headers as { get?: (name: string) => string | null; authorization?: string | string[] | undefined };
  if (typeof headers.get === "function") {
    return headers.get("authorization");
  }

  const authorization = headers.authorization;
  return typeof authorization === "string" ? authorization : Array.isArray(authorization) ? authorization[0] ?? null : null;
}

export function readBearerToken(req: AuthHeaderCarrier): string | null {
  const authorization = readAuthorizationHeader(req);
  if (!authorization) {
    return null;
  }

  const [scheme, credentials] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !credentials) {
    return null;
  }

  return credentials;
}

export function isAuthorizedMcpRequest(req: AuthHeaderCarrier, token?: string): boolean {
  if (!token) {
    return true;
  }

  const credentials = readBearerToken(req);
  return credentials === token;
}

type RateLimitBucket = {
  count: number;
  windowStart: number;
};

const STREAMABLE_HTTP_RATE_LIMIT_WINDOW_MS = 60_000;
const parsedStreamableHttpRateLimit = Number(process.env.CRYSTAL_MCP_HTTP_RATE_LIMIT_PER_MINUTE);
const STREAMABLE_HTTP_RATE_LIMIT =
  Number.isFinite(parsedStreamableHttpRateLimit) && parsedStreamableHttpRateLimit > 0
    ? parsedStreamableHttpRateLimit
    : 60;
const streamableHttpRateLimitBuckets = new Map<string, RateLimitBucket>();

export function consumeStreamableHttpQuota(rateLimitKey: string, now = Date.now()) {
  // Sweep expired buckets to prevent unbounded Map growth from unique tokens
  if (streamableHttpRateLimitBuckets.size > 100) {
    for (const [key, b] of streamableHttpRateLimitBuckets) {
      if (now - b.windowStart >= STREAMABLE_HTTP_RATE_LIMIT_WINDOW_MS) {
        streamableHttpRateLimitBuckets.delete(key);
      }
    }
  }

  const bucket = streamableHttpRateLimitBuckets.get(rateLimitKey);
  if (!bucket || now - bucket.windowStart >= STREAMABLE_HTTP_RATE_LIMIT_WINDOW_MS) {
    streamableHttpRateLimitBuckets.set(rateLimitKey, { count: 1, windowStart: now });
    return { allowed: true, remaining: STREAMABLE_HTTP_RATE_LIMIT - 1 };
  }

  if (bucket.count >= STREAMABLE_HTTP_RATE_LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: STREAMABLE_HTTP_RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart),
    };
  }

  bucket.count += 1;
  return { allowed: true, remaining: STREAMABLE_HTTP_RATE_LIMIT - bucket.count };
}

function createMcpServer() {
  const server = new Server(
    {
      name: "crystal-mcp-server",
      version: "0.3.1",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        rememberTool,
        recallTool,
        recentTool,
        searchMessagesTool,
        whatDoIKnowTool,
        whyDidWeTool,
        whoOwnsTool,
        explainConnectionTool,
        dependencyChainTool,
        preflightTool,
        traceTool,
        editTool,
        updateTool,
        supersedeTool,
        supercedeTool,
        forgetTool,
        statsTool,
        checkpointTool,
        wakeTool,
        ideasTool,
        ideaActionTool,
        listKnowledgeBasesTool,
        queryKnowledgeBaseTool,
        importKnowledgeTool,
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "crystal_remember":
        return handleRememberTool(args);
      case "crystal_recall":
        return handleRecallTool(args);
      case "crystal_recent":
        return handleRecentTool(args);
      case "crystal_search_messages":
        return handleSearchMessagesTool(args);
      case "crystal_what_do_i_know":
        return handleWhatDoIKnowTool(args);
      case "crystal_why_did_we":
        return handleWhyDidWeTool(args);
      case "crystal_who_owns":
        return handleWhoOwnsTool(args);
      case "crystal_explain_connection":
        return handleExplainConnectionTool(args);
      case "crystal_dependency_chain":
        return handleDependencyChainTool(args);
      case "crystal_preflight":
        return handlePreflightTool(args);
      case "crystal_trace":
        return handleTraceTool(args);
      case "crystal_edit":
        return handleEditTool(args);
      case "crystal_update":
        return handleUpdateTool(args);
      case "crystal_supersede":
      case "crystal_supercede":
        return handleSupersedeTool(args);
      case "crystal_forget":
        return handleForgetTool(args);
      case "crystal_stats":
        return handleStatsTool(args);
      case "crystal_checkpoint":
        return handleCheckpointTool(args);
      case "crystal_wake":
        return handleWakeTool(args);
      case "crystal_ideas":
        return handleIdeasTool(args);
      case "crystal_idea_action":
        return handleIdeaActionTool(args);
      case "crystal_list_knowledge_bases":
        return handleListKnowledgeBasesTool(args);
      case "crystal_query_knowledge_base":
        return handleQueryKnowledgeBaseTool(args);
      case "crystal_import_knowledge":
        return handleImportKnowledgeTool(args);
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  });

  return server;
}

async function runStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttp() {
  const host = process.env.CRYSTAL_MCP_HOST ?? "127.0.0.1";
  const parsedPort = Number(process.env.CRYSTAL_MCP_PORT);
  const port = Number.isFinite(parsedPort) ? parsedPort : 8788;
  const mcpToken =
    process.env.MC_MCP_TOKEN ??
    process.env.MEMORY_CRYSTAL_API_KEY ??
    process.env.CRYSTAL_API_KEY;

  const httpServer = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (reqUrl.pathname === "/mcp") {
      const originalAccept = req.headers.accept ?? "";
      const needs = [];
      if (!originalAccept.includes("application/json")) needs.push("application/json");
      if (!originalAccept.includes("text/event-stream")) needs.push("text/event-stream");
      if (needs.length) {
        req.headers.accept = originalAccept ? `${originalAccept}, ${needs.join(", ")}` : needs.join(", ");
      }
    }

    if (req.method === "POST" && reqUrl.pathname === "/mcp") {
      try {
        if (!isAuthorizedMcpRequest(req, mcpToken)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const bearerToken = readBearerToken(req);
        const rateLimitKey = bearerToken ?? "anonymous";
        const rateLimit = consumeStreamableHttpQuota(rateLimitKey);
        if (!rateLimit.allowed) {
          const retryAfterSeconds = Math.max(1, Math.ceil((rateLimit.retryAfterMs ?? 0) / 1000));
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfterSeconds),
          });
          res.end(JSON.stringify({ error: "Rate limit exceeded" }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }

        const rawBody = Buffer.concat(chunks).toString("utf8");
        const body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

        res.on("close", () => {
          void transport.close();
        });

        await runWithMcpRequestContext(createMcpRequestContext(bearerToken), async () => {
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[mcp-http] Failed to process /mcp request", sanitizeErrorForLog(err));
        if (!res.writableEnded) {
          const status = err instanceof SyntaxError ? 400 : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: status === 400 ? "Invalid JSON body" : "Failed to process MCP request" }));
        }
      }
      return;
    }

    if (req.method === "GET" && reqUrl.pathname === "/mcp") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed. Use POST for Streamable HTTP MCP requests.",
          },
          id: null,
        })
      );
      return;
    }

    if (req.method === "DELETE" && reqUrl.pathname === "/mcp") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
      return;
    }

    if (req.method === "GET" && reqUrl.pathname === "/health") {
      if (!isAuthorizedMcpRequest(req, mcpToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: "http", endpoint: "/mcp" }));
      return;
    }

    res.writeHead(404).end("Not found");
  });

  httpServer.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Memory Crystal MCP HTTP listening on http://${host}:${port}/mcp`);
  });
}

const mode = (process.env.CRYSTAL_MCP_MODE ?? "stdio").toLowerCase();
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  if (mode === "stdio") {
    await runStdio();
  } else {
    await runHttp();
  }
}
