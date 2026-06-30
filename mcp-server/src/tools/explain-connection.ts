import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, getConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";

type ExplainConnectionInput = {
  entityA: string;
  entityB: string;
  from?: string;
  to?: string;
  channel?: string;
  sessionKey?: string;
  agentId?: string;
  projectId?: string;
  repoSlug?: string;
};

type RelationResult = {
  fromLabel: string;
  toLabel: string;
  relationType: string;
  confidence: number;
  evidenceMemoryIds: string[];
};

type PathResult = {
  type: "A_to_X_to_B" | "A_from_X_to_B";
  viaLabel: string;
  viaNodeType: string;
  path: {
    first: RelationResult;
    second: RelationResult;
  };
};

type ExplainConnectionResponse = {
  entityA: string;
  entityB: string;
  directRelations: RelationResult[];
  indirectPaths: PathResult[];
  supportingMemories: Array<{ title: string; store: string }>;
  primarySource?: string;
  fallbackUsed?: boolean;
};

export const explainConnectionTool: Tool = {
  name: "crystal_explain_connection",
  description:
    "Explain how two entities are connected in your knowledge graph. Returns direct relationships, indirect paths, and supporting memories. Use when asking 'how are X and Y related?', 'what connects A to B?'",
  inputSchema: {
    type: "object",
    properties: {
      entityA: {
        type: "string",
        description: "First entity",
      },
      entityB: {
        type: "string",
        description: "Second entity",
      },
      from: {
        type: "string",
        description: "Alias for entityA. Accepted for parity with hosted/streamable MCP clients.",
      },
      to: {
        type: "string",
        description: "Alias for entityB. Accepted for parity with hosted/streamable MCP clients.",
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
    anyOf: [
      { required: ["entityA", "entityB"] },
      { required: ["from", "to"] },
    ],
    additionalProperties: false,
  },
};

const ensureExplainConnectionInput = (value: unknown): ExplainConnectionInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  const entityA = typeof input.entityA === "string" ? input.entityA : input.from;
  const entityB = typeof input.entityB === "string" ? input.entityB : input.to;
  if (typeof entityA !== "string" || entityA.trim().length === 0) {
    throw new Error("entityA or from is required");
  }

  if (typeof entityB !== "string" || entityB.trim().length === 0) {
    throw new Error("entityB or to is required");
  }

  const { channel, sessionKey, agentId, projectId, repoSlug, from, to } = input;
  if (from !== undefined && typeof from !== "string") {
    throw new Error("from must be a string");
  }
  if (to !== undefined && typeof to !== "string") {
    throw new Error("to must be a string");
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
    entityA,
    entityB,
    channel: channel as string | undefined,
    sessionKey: sessionKey as string | undefined,
    agentId: agentId as string | undefined,
    projectId: projectId as string | undefined,
    repoSlug: repoSlug as string | undefined,
  };
};

const hasGraphResult = (response: ExplainConnectionResponse) =>
  (response.directRelations?.length ?? 0) > 0 ||
  (response.indirectPaths?.length ?? 0) > 0;

const recallFallback = async (
  client: ConvexClient,
  parsed: ExplainConnectionInput,
  limit = 5,
) =>
  client.post("/api/mcp/recall", {
    query: `connection between ${parsed.entityA} and ${parsed.entityB}`,
    limit,
    channel: parsed.channel,
    sessionKey: parsed.sessionKey,
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    repoSlug: parsed.repoSlug,
  });

export const handleExplainConnectionTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureExplainConnectionInput(args);

    if (hasApiKeyAuth()) {
      const client = new ConvexClient();
      const graph = (await client.post("/api/mcp/graph/explain-connection", {
        entityA: parsed.entityA,
        entityB: parsed.entityB,
        channel: parsed.channel,
        sessionKey: parsed.sessionKey,
        agentId: parsed.agentId,
        projectId: parsed.projectId,
        repoSlug: parsed.repoSlug,
      })) as ExplainConnectionResponse;
      const result = hasGraphResult(graph)
        ? { ...graph, primarySource: "graph", fallbackUsed: false }
        : {
            primarySource: "recall_fallback",
            fallbackUsed: true,
            graph,
            fallbackMemories: (await recallFallback(client, parsed) as any)?.memories ?? [],
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

    const response = (await getConvexClient().action("crystal/graphQuery:explainConnection" as any, {
      entityA: parsed.entityA,
      entityB: parsed.entityB,
      channel: parsed.channel,
      agentId: parsed.agentId,
      projectId: parsed.projectId,
      repoSlug: parsed.repoSlug,
    })) as ExplainConnectionResponse;

    const entityA = parsed.entityA.trim();
    const entityB = parsed.entityB.trim();

    const lines = [`🔗 Connection: ${entityA} ↔ ${entityB}`, ""];

    if (response.directRelations.length === 0) {
      lines.push("No direct relationships found.");
    } else {
      lines.push("Direct relationships:");
      for (const relation of response.directRelations) {
        lines.push(`  • ${relation.fromLabel} ${relation.relationType} ${relation.toLabel} (confidence: ${relation.confidence.toFixed(2)})`);
        if (relation.evidenceMemoryIds.length > 0) {
          lines.push(`    Evidence IDs: ${relation.evidenceMemoryIds.join(", ")}`);
        }
      }
    }

    if (response.indirectPaths.length === 0) {
      lines.push("", "No indirect paths found.");
    } else {
      lines.push("", "Indirect paths:");
      for (const path of response.indirectPaths) {
        if (path.type === "A_to_X_to_B") {
          lines.push(
            `  • ${path.path.first.fromLabel} -> ${path.viaLabel} -> ${path.path.second.toLabel} (${path.path.first.relationType}, ${path.path.second.relationType})`
          );
        } else {
          lines.push(`  • ${path.path.first.fromLabel} -> ${path.viaLabel} -> ${path.path.second.toLabel} (${path.path.first.relationType}, ${path.path.second.relationType})`);
        }
      }
    }

    if (response.supportingMemories.length === 0) {
      lines.push("", "No supporting memories found.");
    } else {
      lines.push("", "Supporting memories:");
      for (const memory of response.supportingMemories) {
        lines.push(`  • "${memory.title}" (${memory.store})`);
      }
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
