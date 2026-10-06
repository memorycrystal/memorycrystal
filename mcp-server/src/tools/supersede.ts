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

type CrystalSupersedeInput = {
  oldMemoryId: string;
  title: string;
  content: string;
  store?: (typeof memoryStores)[number];
  category?: (typeof memoryCategories)[number];
  tags?: string[];
  metadata?: string;
  confidence?: number;
  strength?: number;
  valence?: number;
  arousal?: number;
  actionTriggers?: string[];
  channel?: string;
  scopeChannel?: string;
  agentId?: string;
  reason?: string;
  allowRedactedContent?: true;
};

type WriteToolResult = {
  contradiction?: unknown;
  contradictionCheck?: unknown;
  [key: string]: unknown;
};

export const supersedeTool: Tool = {
  ...stdioTool("crystal_supersede"),
  name: "crystal_supersede",
};

const optionalNumber = (value: unknown, name: string, min?: number, max?: number): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  if (min !== undefined && value < min) throw new Error(`${name} must be >= ${min}`);
  if (max !== undefined && value > max) throw new Error(`${name} must be <= ${max}`);
  return value;
};

const ensureSupersedeInput = (value: unknown): CrystalSupersedeInput => {
  if (typeof value !== "object" || value === null) throw new Error("Invalid arguments");
  const input = value as Record<string, unknown>;
  if (typeof input.oldMemoryId !== "string" || input.oldMemoryId.trim().length === 0) {
    throw new Error("oldMemoryId is required");
  }
  if (typeof input.title !== "string" || input.title.trim().length < 5) throw new Error("title is required");
  if (typeof input.content !== "string" || input.content.trim().length === 0) throw new Error("content is required");
  if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every((item) => typeof item === "string"))) {
    throw new Error("tags must be an array of strings");
  }
  if (input.actionTriggers !== undefined && (!Array.isArray(input.actionTriggers) || !input.actionTriggers.every((item) => typeof item === "string"))) {
    throw new Error("actionTriggers must be an array of strings");
  }
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
    oldMemoryId: input.oldMemoryId.trim(),
    title: input.title.trim(),
    content: input.content,
    store: input.store as (typeof memoryStores)[number] | undefined,
    category: input.category as (typeof memoryCategories)[number] | undefined,
    tags: input.tags as string[] | undefined,
    metadata: typeof input.metadata === "string" ? input.metadata : undefined,
    confidence: optionalNumber(input.confidence, "confidence", 0, 1),
    strength: optionalNumber(input.strength, "strength", 0, 1),
    valence: optionalNumber(input.valence, "valence", -1, 1),
    arousal: optionalNumber(input.arousal, "arousal", 0, 1),
    actionTriggers: input.actionTriggers as string[] | undefined,
    channel: typeof input.channel === "string" ? input.channel : undefined,
    scopeChannel: input.scopeChannel as string | undefined,
    agentId: input.agentId as string | undefined,
    reason: typeof input.reason === "string" ? input.reason : undefined,
    // Forwarded only when true (ILL-360); undefined is dropped by JSON.stringify.
    allowRedactedContent: input.allowRedactedContent === true ? true : undefined,
  };
};

export const handleSupersedeTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureSupersedeInput(args);
    const client = new ConvexClient();
    const result = await client.post<
      WriteToolResult & { success: boolean; oldMemoryId: string; newMemoryId: string; action: string }
    >(
      "/api/mcp/supersede",
      // ILL-319: forward the same scope and resolved agentId as crystal_recall.
      { ...parsed, agentId: resolveAgentId(parsed.agentId, parsed.scopeChannel ?? parsed.channel) }
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...result,
              success: result.success,
              action: result.action,
              oldMemoryId: result.oldMemoryId,
              newMemoryId: result.newMemoryId,
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
