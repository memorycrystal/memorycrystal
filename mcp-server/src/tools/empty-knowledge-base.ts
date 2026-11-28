import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveKnowledgeBaseByName } from "./knowledge-base-utils.js";

export const emptyKnowledgeBaseTool: Tool = {
  ...stdioTool("crystal_empty_knowledge_base"),
  name: "crystal_empty_knowledge_base",
};

export async function handleEmptyKnowledgeBaseTool(args: unknown): Promise<CallToolResult> {
  try {
    const input = (args ?? {}) as Record<string, unknown>;
    const client = new ConvexClient();

    let knowledgeBaseId =
      typeof input.knowledgeBaseId === "string" ? input.knowledgeBaseId.trim() : undefined;
    const knowledgeBaseName =
      typeof input.knowledgeBaseName === "string" ? input.knowledgeBaseName.trim() : undefined;

    if (!knowledgeBaseId && knowledgeBaseName) {
      const existing = await resolveKnowledgeBaseByName(knowledgeBaseName, client, {});
      if (!existing) throw new Error("Knowledge base not found");
      knowledgeBaseId = existing._id;
    }
    if (!knowledgeBaseId) throw new Error("knowledgeBaseId or knowledgeBaseName is required");

    const result = await client.post(`/api/knowledge-bases/${knowledgeBaseId}/empty`, {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "Failed to empty knowledge base",
        },
      ],
    };
  }
}
