import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

const memoryStores = ["sensory", "episodic", "semantic", "procedural", "prospective"] as const;
const memoryCategories = [
  "decision",
  "lesson",
  "person",
  "rule",
  "event",
  "fact",
  "goal",
  "workflow",
  "conversation",
] as const;

type CrystalEditInput = {
  memoryId: string;
  title?: string;
  content?: string;
  tags?: string[];
  store?: (typeof memoryStores)[number];
  category?: (typeof memoryCategories)[number];
};

export const editTool: Tool = {
  name: "crystal_edit",
  description:
    "Update an existing memory in Memory Crystal. Use to correct errors, add new information, or update the status of a memory. Provide the memoryId and only the fields you want to change.",
  inputSchema: {
    type: "object",
    properties: {
      memoryId: {
        type: "string",
        minLength: 1,
        description: "ID of the memory to update",
      },
      title: {
        type: "string",
      },
      content: {
        type: "string",
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      store: {
        type: "string",
        enum: [...memoryStores],
      },
      category: {
        type: "string",
        enum: [...memoryCategories],
      },
    },
    required: ["memoryId"],
    additionalProperties: false,
  },
};

const ensureEditInput = (value: unknown): CrystalEditInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.memoryId !== "string" || input.memoryId.trim().length === 0) {
    throw new Error("memoryId is required");
  }
  if (input.title !== undefined && typeof input.title !== "string") {
    throw new Error("title must be a string");
  }
  if (input.content !== undefined && typeof input.content !== "string") {
    throw new Error("content must be a string");
  }
  if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every((item) => typeof item === "string"))) {
    throw new Error("tags must be an array of strings");
  }
  if (input.store !== undefined && (typeof input.store !== "string" || !memoryStores.includes(input.store as (typeof memoryStores)[number]))) {
    throw new Error("Invalid store");
  }
  if (
    input.category !== undefined &&
    (typeof input.category !== "string" || !memoryCategories.includes(input.category as (typeof memoryCategories)[number]))
  ) {
    throw new Error("Invalid category");
  }

  return {
    memoryId: input.memoryId.trim(),
    title: input.title as string | undefined,
    content: input.content as string | undefined,
    tags: input.tags as string[] | undefined,
    store: input.store as (typeof memoryStores)[number] | undefined,
    category: input.category as (typeof memoryCategories)[number] | undefined,
  };
};

export const handleEditTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureEditInput(args);
    const client = new ConvexClient();
    const result = await client.post<{ success: boolean; memoryId: string }>("/api/mcp/edit", parsed);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: result.success,
              memoryId: result.memoryId,
              message: `Updated memory ${result.memoryId}`,
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
