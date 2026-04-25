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
  "skill",
  "workflow",
  "conversation",
] as const;

type CrystalUpdateInput = {
  memoryId: string;
  title?: string;
  content?: string;
  metadata?: string;
  tags?: string[];
  store?: (typeof memoryStores)[number];
  category?: (typeof memoryCategories)[number];
  confidence?: number;
  strength?: number;
  valence?: number;
  arousal?: number;
  actionTriggers?: string[];
  channel?: string;
};

type WriteToolResult = {
  contradiction?: unknown;
  contradictionCheck?: unknown;
  [key: string]: unknown;
};

export const updateTool: Tool = {
  name: "crystal_update",
  description:
    "Update an existing Memory Crystal memory in place. Use to correct or enrich a memory when it remains the same fact, preference, rule, or decision.",
  inputSchema: {
    type: "object",
    properties: {
      memoryId: { type: "string", minLength: 1 },
      title: { type: "string" },
      content: { type: "string" },
      metadata: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      store: { type: "string", enum: [...memoryStores] },
      category: { type: "string", enum: [...memoryCategories] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      strength: { type: "number", minimum: 0, maximum: 1 },
      valence: { type: "number", minimum: -1, maximum: 1 },
      arousal: { type: "number", minimum: 0, maximum: 1 },
      actionTriggers: { type: "array", items: { type: "string" } },
      channel: { type: "string" },
    },
    required: ["memoryId"],
    additionalProperties: false,
  },
};

const optionalNumber = (value: unknown, name: string, min?: number, max?: number): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  if (min !== undefined && value < min) throw new Error(`${name} must be >= ${min}`);
  if (max !== undefined && value > max) throw new Error(`${name} must be <= ${max}`);
  return value;
};

export const ensureUpdateInput = (value: unknown): CrystalUpdateInput => {
  if (typeof value !== "object" || value === null) throw new Error("Invalid arguments");
  const input = value as Record<string, unknown>;
  if (typeof input.memoryId !== "string" || input.memoryId.trim().length === 0) {
    throw new Error("memoryId is required");
  }
  if (input.title !== undefined && typeof input.title !== "string") throw new Error("title must be a string");
  if (input.content !== undefined && typeof input.content !== "string") throw new Error("content must be a string");
  if (input.metadata !== undefined && typeof input.metadata !== "string") throw new Error("metadata must be a string");
  if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every((item) => typeof item === "string"))) {
    throw new Error("tags must be an array of strings");
  }
  if (input.actionTriggers !== undefined && (!Array.isArray(input.actionTriggers) || !input.actionTriggers.every((item) => typeof item === "string"))) {
    throw new Error("actionTriggers must be an array of strings");
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
    metadata: input.metadata as string | undefined,
    tags: input.tags as string[] | undefined,
    store: input.store as (typeof memoryStores)[number] | undefined,
    category: input.category as (typeof memoryCategories)[number] | undefined,
    confidence: optionalNumber(input.confidence, "confidence", 0, 1),
    strength: optionalNumber(input.strength, "strength", 0, 1),
    valence: optionalNumber(input.valence, "valence", -1, 1),
    arousal: optionalNumber(input.arousal, "arousal", 0, 1),
    actionTriggers: input.actionTriggers as string[] | undefined,
    channel: input.channel as string | undefined,
  };
};

export const handleUpdateTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureUpdateInput(args);
    const client = new ConvexClient();
    const result = await client.post<WriteToolResult & { success: boolean; memoryId: string }>("/api/mcp/update", parsed);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...result,
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
      content: [{ type: "text", text: `Error: ${(err as { message?: string })?.message || String(err)}` }],
    };
  }
};
