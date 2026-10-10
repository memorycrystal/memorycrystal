import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveAgentId } from "../lib/agentId.js";

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
  scopeChannel?: string;
  agentId?: string;
  allowRedactedContent?: true;
};

type WriteToolResult = {
  contradiction?: unknown;
  contradictionCheck?: unknown;
  [key: string]: unknown;
};

export const updateTool: Tool = {
  ...stdioTool("crystal_update"),
  name: "crystal_update",
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
  if (input.channel !== undefined && typeof input.channel !== "string") throw new Error("channel must be a string");
  if (input.scopeChannel !== undefined && typeof input.scopeChannel !== "string") throw new Error("scopeChannel must be a string");
  if (input.agentId !== undefined && typeof input.agentId !== "string") throw new Error("agentId must be a string");
  if (input.allowRedactedContent !== undefined && typeof input.allowRedactedContent !== "boolean") {
    throw new Error("allowRedactedContent must be a boolean");
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
    scopeChannel: input.scopeChannel as string | undefined,
    agentId: input.agentId as string | undefined,
    // Forwarded only when true (ILL-360); undefined is dropped by JSON.stringify.
    allowRedactedContent: input.allowRedactedContent === true ? true : undefined,
  };
};

export const handleUpdateTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureUpdateInput(args);
    const client = new ConvexClient();
    // ILL-319: forward the same scope and resolved agentId as crystal_recall so
    // the by-id visibility gate sees what recall would see.
    const result = await client.post<WriteToolResult & { success: boolean; memoryId: string }>("/api/mcp/update", {
      ...parsed,
      agentId: resolveAgentId(parsed.agentId, parsed.scopeChannel ?? parsed.channel),
    });

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
