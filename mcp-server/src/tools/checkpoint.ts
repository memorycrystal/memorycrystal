import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { parseOptionalIntegerLimit, parseOptionalString } from "./validation.js";

export type CrystalCheckpointInput = {
  mode?: "create" | "list";
  label?: string;
  description?: string;
  memoryIds?: string[];
  sessionId?: string;
  semanticSummary?: string;
  tags?: string[];
  limit?: number;
  createdBy?: "gerald" | "andy";
  channel?: string;
};

export const checkpointTool: Tool = {
  name: "crystal_checkpoint",
  description:
    "Create a manual Memory Checkpoint only when the user explicitly asks for a checkpoint or backup. Checkpoints are bounded durable-memory backups; automatic conversation provenance uses snapshots instead.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["create", "list"],
      },
      label: {
        type: "string",
      },
      description: {
        type: "string",
      },
      memoryIds: {
        type: "array",
        items: { type: "string" },
      },
      sessionId: {
        type: "string",
      },
      semanticSummary: {
        type: "string",
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
      },
      createdBy: {
        type: "string",
        enum: ["gerald", "andy"],
      },
      channel: {
        type: "string",
      },
    },
    additionalProperties: false,
  },
};

const ensureInput = (value: unknown): CrystalCheckpointInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  const mode = input.mode === undefined ? "create" : input.mode;
  if (mode !== "create" && mode !== "list") {
    throw new Error("mode must be create or list");
  }

  const label = input.label;
  if (mode === "create" && (typeof label !== "string" || label.trim().length === 0)) {
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
    mode,
    label: typeof label === "string" ? label : undefined,
    description: typeof input.description === "string" ? input.description : undefined,
    memoryIds,
    sessionId: parseOptionalString(input.sessionId, "sessionId"),
    semanticSummary: typeof input.semanticSummary === "string" ? input.semanticSummary : undefined,
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : undefined,
    limit: parsedLimit,
    createdBy: input.createdBy === "andy" || input.createdBy === "gerald" ? input.createdBy : undefined,
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
        sessionId: parsed.sessionId,
        limit: parsed.limit ?? 20,
        channel: parsed.channel,
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
      label: parsed.label ?? "checkpoint",
      description: parsed.description,
      sessionId: parsed.sessionId,
      memoryIds: parsed.memoryIds,
      tags: parsed.tags,
      channel: parsed.channel,
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
