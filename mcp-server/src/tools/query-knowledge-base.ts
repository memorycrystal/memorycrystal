import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveKnowledgeBaseByName } from "./knowledge-base-utils.js";
import { parseOptionalIntegerLimit, parseOptionalString } from "./validation.js";

type QueryKnowledgeBaseInput = {
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  query: string;
  limit?: number;
  agentId?: string;
  channel?: string;
};

export const queryKnowledgeBaseTool: Tool = {
  name: "crystal_query_knowledge_base",
  description: "Search within a specific Memory Crystal knowledge base.",
  inputSchema: {
    type: "object",
    properties: {
      knowledgeBaseId: { type: "string" },
      knowledgeBaseName: { type: "string" },
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      agentId: { type: "string" },
      channel: { type: "string" },
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
  };
}

export async function handleQueryKnowledgeBaseTool(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(args);
    const client = new ConvexClient();

    let knowledgeBaseId = input.knowledgeBaseId;
    if (!knowledgeBaseId && input.knowledgeBaseName) {
      const existing = await resolveKnowledgeBaseByName(input.knowledgeBaseName, client, {
        channel: input.channel,
        agentId: input.agentId,
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
      agentId: input.agentId,
      channel: input.channel,
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
