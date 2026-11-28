import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { listKnowledgeBases } from "./knowledge-base-utils.js";

export const listKnowledgeBasesTool: Tool = {
  ...stdioTool("crystal_list_knowledge_bases"),
  name: "crystal_list_knowledge_bases",
};

export async function handleListKnowledgeBasesTool(args: unknown): Promise<CallToolResult> {
  try {
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const includeInactive = Boolean(input.includeInactive);
    const channel = typeof input.channel === "string" ? input.channel : undefined;
    const scope = typeof input.scope === "string" ? input.scope : undefined;
    const agentId = typeof input.agentId === "string" ? input.agentId : undefined;

    const knowledgeBases = await listKnowledgeBases(new ConvexClient(), {
      includeInactive,
      channel,
      scope,
      agentId,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ knowledgeBases }, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "Failed to list knowledge bases",
        },
      ],
    };
  }
}
