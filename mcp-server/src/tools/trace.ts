import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

// Prevent API keys or auth tokens from leaking into server logs via error messages.
const sanitizeErrorForLog = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9+/_=.-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]")
    .replace(/(\?|&)(api_?key|token|secret)=[^&\s]+/gi, "$1$2=[REDACTED]");
};

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
    console.error("[crystal_trace] error:", sanitizeErrorForLog(err));
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Failed to trace memory. Please retry.",
        },
      ],
    };
  }
};
