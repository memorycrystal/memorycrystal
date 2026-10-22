import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveAgentId } from "../lib/agentId.js";

// Prevent API keys or auth tokens from leaking into server logs via error messages.
const sanitizeErrorForLog = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9+/_=.-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]")
    .replace(/(\?|&)(api_?key|token|secret)=[^&\s]+/gi, "$1$2=[REDACTED]");
};

export const traceTool: Tool = {
  ...stdioTool("crystal_trace"),
  name: "crystal_trace",
};

export const handleTraceTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    if (typeof args !== "object" || args === null) {
      throw new Error("Invalid arguments");
    }

    const { memoryId, channel, agentId } = args as Record<string, unknown>;
    if (typeof memoryId !== "string" || memoryId.trim().length === 0) {
      throw new Error("memoryId is required");
    }
    if (channel !== undefined && typeof channel !== "string") {
      throw new Error("channel must be a string");
    }
    if (agentId !== undefined && typeof agentId !== "string") {
      throw new Error("agentId must be a string");
    }

    const client = new ConvexClient();
    // ILL-319: same resolved agentId as crystal_recall for the by-id gate.
    const result = await client.post("/api/mcp/trace", {
      memoryId: memoryId.trim(),
      channel,
      agentId: resolveAgentId(agentId as string | undefined, channel as string | undefined),
    });

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
