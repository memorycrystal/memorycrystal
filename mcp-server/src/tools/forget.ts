import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

export type CrystalForgetInput = {
  memoryId: string;
  permanent?: boolean;
  reason?: string;
  channel?: string;
};

export const forgetTool: Tool = {
  name: "crystal_forget",
  description:
    "Archive or permanently delete a memory. Use archive (permanent=false, the default) to soft-delete so the memory can be recovered. Use permanent=true only when you are certain the memory should be irretrievably deleted.",
  inputSchema: {
    type: "object",
    properties: {
      memoryId: {
        type: "string",
      },
      permanent: {
        type: "boolean",
        description: "If true, permanently and irretrievably deletes the memory. Default is false (soft archive).",
      },
      reason: {
        type: "string",
      },
      channel: {
        type: "string",
      },
    },
    required: ["memoryId"],
    additionalProperties: false,
  },
};

const ensureForgetInput = (value: unknown): CrystalForgetInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.memoryId !== "string" || input.memoryId.length === 0) {
    throw new Error("memoryId is required");
  }

  if (input.permanent !== undefined && typeof input.permanent !== "boolean") {
    throw new Error("permanent must be a boolean");
  }
  if (input.reason !== undefined && typeof input.reason !== "string") {
    throw new Error("reason must be a string");
  }
  if (input.channel !== undefined && typeof input.channel !== "string") {
    throw new Error("channel must be a string");
  }

  return {
    memoryId: input.memoryId,
    permanent: input.permanent,
    reason: input.reason,
    channel: input.channel,
  };
};

export const handleForgetTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureForgetInput(args);
    const client = new ConvexClient();

    const result = await client.post<{ success?: boolean; action?: string; archived?: boolean }>("/api/mcp/forget", {
      memoryId: parsed.memoryId,
      permanent: parsed.permanent,
      reason: parsed.reason,
      channel: parsed.channel,
    });

    const payload = {
      success: result.success !== false,
      action: result.action ?? (result.archived ? "archived" : "unknown"),
      archived: result.archived === true,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
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
