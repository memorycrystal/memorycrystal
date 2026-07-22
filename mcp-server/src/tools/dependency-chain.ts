import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, getConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";

type DependencyChainInput = {
  entity: string;
  topic?: string;
  maxDepth?: number;
  channel?: string;
  sessionKey?: string;
  agentId?: string;
  projectId?: string;
  repoSlug?: string;
};

type ChainEntry = {
  depth: number;
  label: string;
  nodeType: string;
  relationType: string;
  confidence: number;
  evidenceMemoryIds: string[];
};

type DependencyChainResponse = {
  entity: string;
  chain: ChainEntry[];
  totalNodes: number;
  primarySource?: string;
  fallbackUsed?: boolean;
};

const clampDepth = (value: number | undefined) =>
  value === undefined ? 3 : Math.min(Math.max(Math.floor(value), 1), 5);

export const dependencyChainTool: Tool = {
  name: "crystal_dependency_chain",
  description:
    "Trace the dependency chain for a goal, project, or task in your knowledge graph. Returns a tree of dependencies with depth and evidence. Use when asking 'what does X depend on?', 'what are the dependencies for Y?'",
  inputSchema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        description: "The goal, project, or task to trace dependencies for",
      },
      topic: {
        type: "string",
        description: "Alias for entity. Accepted for parity with hosted/streamable MCP clients.",
      },
      maxDepth: {
        type: "number",
        description: "Maximum depth to traverse (1-5, default: 3)",
      },
      channel: {
        type: "string",
      },
      sessionKey: {
        type: "string",
      },
      agentId: {
        type: "string",
      },
      projectId: {
        type: "string",
      },
      repoSlug: {
        type: "string",
      },
    },
    anyOf: [{ required: ["entity"] }, { required: ["topic"] }],
    additionalProperties: false,
  },
};

const ensureDependencyChainInput = (value: unknown): DependencyChainInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  const entity = typeof input.entity === "string" ? input.entity : input.topic;
  if (typeof entity !== "string" || entity.trim().length === 0) {
    throw new Error("entity or topic is required");
  }

  if (input.maxDepth !== undefined && !Number.isFinite(Number(input.maxDepth))) {
    throw new Error("maxDepth must be a number");
  }

  const { channel, sessionKey, agentId, projectId, repoSlug, topic } = input;
  if (topic !== undefined && typeof topic !== "string") {
    throw new Error("topic must be a string");
  }
  if (channel !== undefined && typeof channel !== "string") {
    throw new Error("channel must be a string");
  }
  if (sessionKey !== undefined && typeof sessionKey !== "string") {
    throw new Error("sessionKey must be a string");
  }
  if (agentId !== undefined && typeof agentId !== "string") {
    throw new Error("agentId must be a string");
  }
  if (projectId !== undefined && typeof projectId !== "string") {
    throw new Error("projectId must be a string");
  }
  if (repoSlug !== undefined && typeof repoSlug !== "string") {
    throw new Error("repoSlug must be a string");
  }

  return {
    entity,
    maxDepth: input.maxDepth === undefined ? undefined : clampDepth(Number(input.maxDepth)),
    channel: channel as string | undefined,
    sessionKey: sessionKey as string | undefined,
    agentId: agentId as string | undefined,
    projectId: projectId as string | undefined,
    repoSlug: repoSlug as string | undefined,
  };
};

const hasGraphResult = (response: DependencyChainResponse) =>
  (response.chain?.length ?? 0) > 0;

const recallFallback = async (
  client: ConvexClient,
  parsed: DependencyChainInput,
  limit: number,
) =>
  client.post("/api/mcp/recall", {
    query: `dependencies for ${parsed.entity}`,
    limit,
    mode: "project",
    channel: parsed.channel,
    sessionKey: parsed.sessionKey,
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    repoSlug: parsed.repoSlug,
  });

const toLevelLines = (chain: ChainEntry[]) => {
  const grouped = new Map<number, ChainEntry[]>();
  for (const entry of chain) {
    const existing = grouped.get(entry.depth) ?? [];
    existing.push(entry);
    grouped.set(entry.depth, existing);
  }

  const out: string[] = [];
  for (const depth of Array.from(grouped.keys()).sort((a, b) => a - b)) {
    const entries = grouped.get(depth) ?? [];
    out.push(`Level ${depth}:`);
    for (const entry of entries) {
      out.push(
        `  • ${entry.label} [${entry.nodeType}] — ${entry.relationType} (confidence: ${entry.confidence.toFixed(2)})`
      );
      if (entry.evidenceMemoryIds.length > 0) {
        const preview = entry.evidenceMemoryIds.slice(0, 3);
        const overflow = entry.evidenceMemoryIds.length > 3 ? ` (+${entry.evidenceMemoryIds.length - 3} more)` : "";
        out.push(`    Evidence IDs: ${preview.join(", ")}${overflow}`);
      }
    }
    out.push("");
  }

  return out;
};

export const handleDependencyChainTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureDependencyChainInput(args);

    const maxDepth = parsed.maxDepth;

    if (hasApiKeyAuth()) {
      const client = new ConvexClient();
      const graph = (await client.post("/api/mcp/graph/dependency-chain", {
        entity: parsed.entity,
        maxDepth,
        channel: parsed.channel,
        sessionKey: parsed.sessionKey,
        agentId: parsed.agentId,
        projectId: parsed.projectId,
        repoSlug: parsed.repoSlug,
      })) as DependencyChainResponse;
      const result = hasGraphResult(graph)
        ? { ...graph, primarySource: "graph", fallbackUsed: false }
        : {
            primarySource: "recall_fallback",
            fallbackUsed: true,
            graph,
            fallbackMemories: (await recallFallback(client, parsed, maxDepth ?? 5) as any)?.memories ?? [],
          };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    const response = (await getConvexClient().action("crystal/graphQuery:dependencyChain" as any, {
      entity: parsed.entity,
      maxDepth,
      channel: parsed.channel,
      agentId: parsed.agentId,
      projectId: parsed.projectId,
      repoSlug: parsed.repoSlug,
    })) as DependencyChainResponse;

    const chain = response.chain ?? [];
    const resolvedDepth = maxDepth ?? 3;

    const lines = [`🔗 Dependency chain for "${parsed.entity}" (depth: ${resolvedDepth}):`, ""];

    if (chain.length === 0) {
      lines.push("No dependency relationships found.");
    } else {
      lines.push(...toLevelLines(chain));
      lines.push(`Total: ${response.totalNodes} nodes in chain`);
    }

    return {
      content: [
        {
          type: "text",
          text: lines.join("\n"),
        },
      ],
    };
  } catch (err: unknown) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${(err as { message?: string })?.message || String(err)}`,
        },
      ],
    };
  }
};
