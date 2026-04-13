import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

type ToolHandler = (args: Record<string, unknown> | undefined) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;

const getClient = () => new ConvexClient();

const crystalCapture: Tool = {
  name: "crystal_capture",
  description: "Capture a memory into Memory Crystal",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      store: { type: "string" },
      category: { type: "string" },
      tags: { type: "array", items: { type: "string" } }
    },
    required: ["title", "content", "store", "category", "tags"],
    additionalProperties: false
  }
};

const crystalRecall: Tool = {
  name: "crystal_recall",
  description: "Recall memories from Memory Crystal",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" }
    },
    required: ["query"],
    additionalProperties: false
  }
};

const crystalCheckpoint: Tool = {
  name: "crystal_checkpoint",
  description: "Create a session checkpoint",
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      description: { type: "string" }
    },
    required: ["label"],
    additionalProperties: false
  }
};

const crystalWake: Tool = {
  name: "crystal_wake",
  description: "Get wake briefing for a channel/session",
  inputSchema: {
    type: "object",
    properties: {
      channel: { type: "string" }
    },
    additionalProperties: false
  }
};

const crystalStats: Tool = {
  name: "crystal_stats",
  description: "Get Memory Crystal stats",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const tools: Tool[] = [crystalCapture, crystalRecall, crystalCheckpoint, crystalWake, crystalStats];

export const toolHandlers: Record<string, ToolHandler> = {
  async crystal_capture(args) {
    const response = await getClient().post("/api/mcp/capture", {
      title: args?.title,
      content: args?.content,
      store: args?.store,
      category: args?.category,
      tags: args?.tags,
    });
    return textResult(response);
  },

  async crystal_recall(args) {
    const response = await getClient().post("/api/mcp/recall", {
      query: args?.query,
      limit: args?.limit,
    });
    return textResult(response);
  },

  async crystal_checkpoint(args) {
    const response = await getClient().post("/api/mcp/checkpoint", {
      label: args?.label,
      description: args?.description,
    });
    return textResult(response);
  },

  async crystal_wake(args) {
    const response = await getClient().post("/api/mcp/wake", {
      channel: args?.channel,
    });
    return textResult(response);
  },

  async crystal_stats() {
    const response = await getClient().get("/api/mcp/stats");
    return textResult(response);
  },
};

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
