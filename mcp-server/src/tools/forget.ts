import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveAgentId } from "../lib/agentId.js";

export type CrystalForgetInput = {
  memoryId: string;
  permanent?: boolean;
  reason?: string;
  channel?: string;
  agentId?: string;
};

export const forgetTool: Tool = {
  ...stdioTool("crystal_forget"),
  name: "crystal_forget",
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
  if (input.agentId !== undefined && typeof input.agentId !== "string") {
    throw new Error("agentId must be a string");
  }

  return {
    memoryId: input.memoryId,
    permanent: input.permanent,
    reason: input.reason,
    channel: input.channel,
    agentId: input.agentId,
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
      // ILL-319: same resolved agentId as crystal_recall for the by-id gate.
      agentId: resolveAgentId(parsed.agentId, parsed.channel),
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
