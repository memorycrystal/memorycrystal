import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { writeMemoryToObsidian } from "../lib/obsidian.js";

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

export type MemoryStore = (typeof memoryStores)[number];
export type MemoryCategory = (typeof memoryCategories)[number];

export type CrystalRememberInput = {
  store: MemoryStore;
  category: MemoryCategory;
  title: string;
  content: string;
  tags?: string[];
  confidence?: number;
  valence?: number;
  arousal?: number;
  channel?: string;
};

type WriteToolResult = {
  contradiction?: unknown;
  contradictionCheck?: unknown;
  [key: string]: unknown;
};

export const rememberTool: Tool = {
  name: "crystal_remember",
  description: "Create a Memory Crystal memory using semantic embedding + vector storage.",
  inputSchema: {
    type: "object",
    properties: {
      store: {
        type: "string",
        enum: memoryStores,
      },
      category: {
        type: "string",
        enum: memoryCategories,
      },
      title: {
        type: "string",
        minLength: 5,
        maxLength: 80,
      },
      content: {
        type: "string",
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      valence: {
        type: "number",
        minimum: -1,
        maximum: 1,
      },
      arousal: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      channel: {
        type: "string",
      },
    },
    required: ["store", "category", "title", "content"],
    additionalProperties: false,
  },
};

const ensureMemoryInput = (value: unknown): CrystalRememberInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  const { store, category, title, content, tags, confidence, valence, arousal, channel } = input;

  if (typeof store !== "string" || !memoryStores.includes(store as MemoryStore)) {
    throw new Error("Invalid store");
  }
  if (typeof category !== "string" || !memoryCategories.includes(category as MemoryCategory)) {
    throw new Error("Invalid category");
  }
  if (typeof title !== "string" || title.length < 5 || title.length > 80) {
    throw new Error("Title must be between 5 and 80 characters");
  }
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Content is required");
  }
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((item) => typeof item === "string"))) {
    throw new Error("Tags must be an array of strings");
  }
  if (confidence !== undefined && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
    throw new Error("Confidence must be between 0 and 1");
  }
  if (valence !== undefined && (typeof valence !== "number" || valence < -1 || valence > 1)) {
    throw new Error("Valence must be between -1 and 1");
  }
  if (arousal !== undefined && (typeof arousal !== "number" || arousal < 0 || arousal > 1)) {
    throw new Error("Arousal must be between 0 and 1");
  }
  if (channel !== undefined && typeof channel !== "string") {
    throw new Error("channel must be a string");
  }

  return {
    store: store as MemoryStore,
    category: category as MemoryCategory,
    title,
    content,
    tags: tags as string[] | undefined,
    confidence: confidence as number | undefined,
    valence: valence as number | undefined,
    arousal: arousal as number | undefined,
    channel: channel as string | undefined,
  };
};

export const handleRememberTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureMemoryInput(args);
    const client = new ConvexClient();
    const result = await client.post<WriteToolResult & { ok: boolean; id: string }>("/api/mcp/capture", {
      title: parsed.title,
      content: parsed.content,
      store: parsed.store,
      category: parsed.category,
      tags: parsed.tags,
      channel: parsed.channel,
    });

    const memoryId = result.id;

    let obsidianPath = "";
    if (process.env.OBSIDIAN_VAULT_PATH) {
      obsidianPath = await writeMemoryToObsidian({
        id: String(memoryId),
        store: parsed.store,
        category: parsed.category,
        title: parsed.title,
        content: parsed.content,
        tags: parsed.tags ?? [],
        confidence: parsed.confidence ?? 0.7,
        strength: 1,
        source: "conversation",
        valence: parsed.valence ?? 0,
        arousal: parsed.arousal ?? 0.3,
        channel: parsed.channel,
        createdAt: Date.now(),
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...result,
            memoryId,
            title: parsed.title,
            store: parsed.store,
            category: parsed.category,
            obsidianPath,
          }, null, 2),
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
