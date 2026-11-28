import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { parseOptionalIntegerLimit, parseOptionalString } from "./validation.js";

export type CrystalCheckpointInput = {
  mode?: "create" | "list";
  label?: string;
  description?: string;
  memoryIds?: string[];
  sessionId?: string;
  sessionKey?: string;
  semanticSummary?: string;
  tags?: string[];
  limit?: number;
  createdBy?: string;
  channel?: string;
};

export const checkpointTool: Tool = {
  ...stdioTool("crystal_checkpoint"),
  name: "crystal_checkpoint",
};

const ensureInput = (value: unknown): CrystalCheckpointInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  const mode = input.mode;
  // Only an omitted mode means create; null is invalid, as on the hosted server.
  const effectiveMode = mode === undefined ? "create" : mode;
  if (effectiveMode !== "create" && effectiveMode !== "list") {
    throw new Error("mode must be create or list");
  }

  const label = input.label;
  if (effectiveMode === "create" && (typeof label !== "string" || label.trim().length === 0)) {
    throw new Error("label is required for create mode");
  }

  const parsedLimit = parseOptionalIntegerLimit(input.limit, { min: 1, max: 100 });

  const memoryIds =
    input.memoryIds === undefined
      ? undefined
      : Array.isArray(input.memoryIds)
        ? (() => {
            const validIds = Array.isArray(input.memoryIds) ? input.memoryIds.filter((id) => typeof id === "string" && id.length > 0) : [];
            return validIds;
          })()
        : (() => {
            throw new Error("memoryIds must be array of ids");
          })();

  const channel = parseOptionalString(input.channel, "channel");

  return {
    mode: mode as CrystalCheckpointInput["mode"],
    label: typeof label === "string" ? label : undefined,
    description: typeof input.description === "string" ? input.description : undefined,
    memoryIds,
    sessionKey: parseOptionalString(input.sessionKey, "sessionKey"),
    sessionId: parseOptionalString(input.sessionId, "sessionId"),
    semanticSummary: typeof input.semanticSummary === "string" ? input.semanticSummary : undefined,
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : undefined,
    limit: parsedLimit,
    createdBy: typeof input.createdBy === "string" ? input.createdBy : undefined,
    channel,
  };
};

export const handleCheckpointTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureInput(args);
    const client = new ConvexClient();

    if (parsed.mode === "list") {
      const checkpoints = await client.post<unknown>("/api/mcp/checkpoint", {
        mode: "list",
        label: parsed.label,
        description: parsed.description,
        memoryIds: parsed.memoryIds,
        sessionId: parsed.sessionId,
        sessionKey: parsed.sessionKey,
        semanticSummary: parsed.semanticSummary,
        tags: parsed.tags,
        limit: parsed.limit ?? 20,
        channel: parsed.channel,
        createdBy: parsed.createdBy,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(checkpoints, null, 2),
          },
        ],
      };
    }

    const result = await client.post<{
      ok: boolean;
      id?: string;
      checkpointId?: string;
      memoryCount?: number;
      allowance?: number;
      retainedCount?: number;
      snapshotCap?: number;
      tier?: string;
    }>("/api/mcp/checkpoint", {
      mode: parsed.mode,
      label: parsed.label ?? "checkpoint",
      description: parsed.description,
      sessionId: parsed.sessionId,
      sessionKey: parsed.sessionKey,
      memoryIds: parsed.memoryIds,
      semanticSummary: parsed.semanticSummary,
      tags: parsed.tags,
      channel: parsed.channel,
      limit: parsed.limit,
      createdBy: parsed.createdBy,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...result,
              checkpointId: result.checkpointId ?? result.id,
              mode: "create",
              label: parsed.label,
            },
            null,
            2
          ),
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
