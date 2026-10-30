import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";

type CrystalHealthInput = {
  limit?: number;
};

export const healthTool: Tool = {
  ...stdioTool("crystal_health"),
  name: "crystal_health",
};

const ensureHealthInput = (value: unknown): CrystalHealthInput => {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object") {
    throw new Error("Invalid arguments");
  }
  const input = value as Record<string, unknown>;
  if (input.limit !== undefined && typeof input.limit !== "number") {
    throw new Error("limit must be a number");
  }
  return { limit: input.limit as number | undefined };
};


export const handleHealthTool = async (
  args: unknown = null,
): Promise<CallToolResult> => {
  try {
    const parsed = ensureHealthInput(args);
    if (!hasApiKeyAuth()) {
      throw new Error(
        "crystal_health requires API-key authentication.",
      );
    }
    const client = new ConvexClient();
    const health = (await client.post("/api/mcp/health", {
      limit: parsed.limit,
    })) as Record<string, unknown>;

    return {
      content: [
        { type: "text", text: JSON.stringify(health, null, 2) },
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
