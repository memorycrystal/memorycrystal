import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveKnowledgeBaseByName } from "./knowledge-base-utils.js";

export const listKnowledgeBaseMemoriesTool: Tool = {
  ...stdioTool("crystal_list_knowledge_base_memories"),
  name: "crystal_list_knowledge_base_memories",
};

export async function handleListKnowledgeBaseMemoriesTool(args: unknown): Promise<CallToolResult> {
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

    const params = new URLSearchParams();
    if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
      params.set("limit", String(Math.trunc(input.limit)));
    }
    if (typeof input.cursor === "string" && input.cursor) params.set("cursor", input.cursor);
    const qs = params.toString();

    const result = await client.get(
      `/api/knowledge-bases/${knowledgeBaseId}/memories${qs ? `?${qs}` : ""}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            error instanceof Error ? error.message : "Failed to list knowledge base memories",
        },
      ],
    };
  }
}
