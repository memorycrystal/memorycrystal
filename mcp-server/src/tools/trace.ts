import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

export const traceTool: Tool = {
  name: "crystal_trace",
  description:
    "Trace a memory back to its source conversation. Use when you need to understand where a memory came from or verify its provenance. Returns the conversation snapshot that created this memory.",
  inputSchema: {
    type: "object",
    properties: {
      memoryId: {
        type: "string",
        minLength: 1,
        description: "The memory ID to trace",
      },
    },
    required: ["memoryId"],
    additionalProperties: false,
  },
};

export const handleTraceTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    if (typeof args !== "object" || args === null) {
      throw new Error("Invalid arguments");
    }

    const { memoryId } = args as Record<string, unknown>;
    if (typeof memoryId !== "string" || memoryId.trim().length === 0) {
      throw new Error("memoryId is required");
    }

    const client = new ConvexClient();
    const result = await client.post("/api/mcp/trace", { memoryId: memoryId.trim() });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
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
