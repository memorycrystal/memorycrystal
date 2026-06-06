import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

type CreateKnowledgeBaseInput = {
  name: string;
  description?: string;
  sourceType?: string;
  agentIds?: string[];
  scope?: string;
  peerScopePolicy?: "strict" | "permissive";
};

export const createKnowledgeBaseTool: Tool = {
  name: "crystal_create_knowledge_base",
  description: "Create a Memory Crystal knowledge base.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      sourceType: { type: "string" },
      agentIds: { type: "array", items: { type: "string" } },
      scope: { type: "string" },
      peerScopePolicy: { type: "string", enum: ["strict", "permissive"] },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

function parseInput(args: unknown): CreateKnowledgeBaseInput {
  if (!args || typeof args !== "object") {
    throw new Error("Invalid arguments");
  }

  const input = args as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    throw new Error("name is required");
  }

  return {
    name,
    description: typeof input.description === "string" ? input.description : undefined,
    sourceType: typeof input.sourceType === "string" ? input.sourceType : undefined,
    agentIds: Array.isArray(input.agentIds) ? input.agentIds.filter((value): value is string => typeof value === "string") : undefined,
    scope: typeof input.scope === "string" ? input.scope : undefined,
    peerScopePolicy: input.peerScopePolicy === "strict" || input.peerScopePolicy === "permissive"
      ? input.peerScopePolicy
      : undefined,
  };
}

export async function handleCreateKnowledgeBaseTool(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(args);
    const result = await new ConvexClient().post("/api/knowledge-bases", input);

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
          text: error instanceof Error ? error.message : "Failed to create knowledge base",
        },
      ],
    };
  }
}
