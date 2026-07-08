import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveKnowledgeBaseByName } from "./knowledge-base-utils.js";

export const listKnowledgeBaseMemoriesTool: Tool = {
  name: "crystal_list_knowledge_base_memories",
  description:
    "Enumerate ALL chunks in a Memory Crystal knowledge base with real cursor pagination and memory ids. Unlike crystal_query_knowledge_base (relevance-capped), this walks the entire KB, so you can inspect, clean, or update it programmatically — each returned id works with crystal_update (edit content in place) and crystal_forget (delete). Page by passing the previous response's continueCursor until isDone is true.",
  inputSchema: {
    type: "object",
    properties: {
      knowledgeBaseId: { type: "string" },
      knowledgeBaseName: { type: "string" },
      cursor: {
        type: "string",
        description: "Pass the previous response's continueCursor to fetch the next page.",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
    },
    additionalProperties: false,
  },
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
      if (!existing) throw new Error(`Knowledge base not found: ${knowledgeBaseName}`);
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
