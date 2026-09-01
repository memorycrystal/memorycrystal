import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveKnowledgeBaseByName } from "./knowledge-base-utils.js";
import { resolveAgentId } from "../lib/agentId.js";
import { parseOptionalIntegerLimit, parseOptionalString } from "./validation.js";

type QueryKnowledgeBaseInput = {
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  query: string;
  limit?: number;
  agentId?: string;
  channel?: string;
  includeGraphContext?: boolean;
};

export const queryKnowledgeBaseTool: Tool = {
  name: "crystal_query_knowledge_base",
  description: "Search within a specific Memory Crystal knowledge base. Use for named reference/manual/voice-guide queries instead of broad recall.",
  inputSchema: {
    type: "object",
    properties: {
      knowledgeBaseId: { type: "string" },
      knowledgeBaseName: { type: "string" },
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      agentId: { type: "string", description: "Agent identifier for scoped KB visibility." },
      channel: { type: "string", description: "Channel or peer scope context." },
      includeGraphContext: {
        type: "boolean",
        description: "Include compact graph entities/relations linked to returned KB memories (default: true)",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

function parseInput(args: unknown): QueryKnowledgeBaseInput {
  if (!args || typeof args !== "object") {
    throw new Error("Invalid arguments");
  }

  const input = args as Record<string, unknown>;
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new Error("query is required");
  }

  const knowledgeBaseId = typeof input.knowledgeBaseId === "string" ? input.knowledgeBaseId.trim() : undefined;
  const knowledgeBaseName = typeof input.knowledgeBaseName === "string" ? input.knowledgeBaseName.trim() : undefined;
  if (!knowledgeBaseId && !knowledgeBaseName) {
    throw new Error("knowledgeBaseId or knowledgeBaseName is required");
  }

  return {
    knowledgeBaseId,
    knowledgeBaseName,
    query: input.query.trim(),
    limit: parseOptionalIntegerLimit(input.limit, { min: 1, max: 20 }),
    agentId: parseOptionalString(input.agentId, "agentId"),
    channel: parseOptionalString(input.channel, "channel"),
    includeGraphContext:
      typeof input.includeGraphContext === "boolean"
        ? input.includeGraphContext
        : undefined,
  };
}

export async function handleQueryKnowledgeBaseTool(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(args);
    const client = new ConvexClient();

    // Resolve a concrete agentId so peer-scoped callers (that pass only a
    // channel like `"support-coach:<peerId>"`) still hit agent-scoped KBs
    // instead of falling through the backend's channel-prefix derivation.
    const resolvedAgentId = resolveAgentId(input.agentId, input.channel);

    let knowledgeBaseId = input.knowledgeBaseId;
    if (!knowledgeBaseId && input.knowledgeBaseName) {
      const existing = await resolveKnowledgeBaseByName(input.knowledgeBaseName, client, {
        channel: input.channel,
        agentId: resolvedAgentId,
      });
      if (!existing) {
        throw new Error(`Knowledge base not found: ${input.knowledgeBaseName}`);
      }
      knowledgeBaseId = existing._id;
    }

    if (!knowledgeBaseId) {
      throw new Error("Unable to resolve knowledge base");
    }

    const result = await client.post(`/api/knowledge-bases/${knowledgeBaseId}/query`, {
      query: input.query,
      limit: input.limit,
      agentId: resolvedAgentId,
      channel: input.channel,
      includeGraphContext: input.includeGraphContext ?? true,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "Failed to query knowledge base",
        },
      ],
    };
  }
}
