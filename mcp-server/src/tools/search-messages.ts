import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, getConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";
import { getEmbedAdapter } from "../lib/embed.js";

type STMMessage = {
  _id?: string;
  role?: string;
  content?: string;
  channel?: string;
  sessionKey?: string;
  timestamp?: number;
  score?: number;
};

export type CrystalSearchMessagesInput = {
  query: string;
  limit?: number;
  channel?: string;
  sinceMs?: number;
};

export const searchMessagesTool: Tool = {
  name: "crystal_search_messages",
  description: "Semantic search over short-term memory messages.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
      },
      limit: {
        type: "number",
        minimum: 1,
        default: 10,
      },
      channel: {
        type: "string",
      },
      sinceMs: {
        type: "number",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const clampLimit = (value: unknown): number => {
  if (!Number.isFinite(Number(value))) {
    return 10;
  }
  const parsed = Number(value);
  return parsed <= 0 ? 10 : Math.floor(parsed);
};

const trimText = (value: string, maxChars: number): string =>
  value.length > maxChars ? value.slice(0, maxChars) : value;

const ensureSearchMessagesInput = (value: unknown): CrystalSearchMessagesInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("query is required");
  }

  const input = value as Record<string, unknown>;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    throw new Error("query is required");
  }

  const limit = clampLimit(input.limit);
  const channel = typeof input.channel === "string" ? input.channel : undefined;
  const sinceMs = typeof input.sinceMs === "number" && Number.isFinite(input.sinceMs) ? input.sinceMs : undefined;

  return { query, limit, channel, sinceMs };
};

const formatSearchResults = (messages: STMMessage[], query: string): string => {
  const lines = messages.map((message, index) => {
    const role = typeof message.role === "string" && message.role.length > 0 ? message.role : "unknown";
    const content = typeof message.content === "string" ? message.content : "";
    const scoreValue = typeof message.score === "number" && Number.isFinite(message.score) ? message.score : 0;
    const timestampValue =
      typeof message.timestamp === "number" ? new Date(message.timestamp).toLocaleString() : "Invalid time";

    return `${index + 1}. [${role}] ${trimText(content, 200)} (score: ${scoreValue.toFixed(2)})\n   timestamp: ${timestampValue}`;
  });

  return ["## Message Search Results", `Query: ${query}`, "", ...lines].join("\n");
};

const handleSearchMessages = async (args: unknown): Promise<CallToolResult> => {
  const parsed = ensureSearchMessagesInput(args);

  // API-key clients go through the HTTP endpoint which embeds server-side.
  let response: { messages: STMMessage[] } | STMMessage[];
  if (hasApiKeyAuth()) {
    const client = new ConvexClient();
    response = (await client.post("/api/mcp/search-messages", {
      query: parsed.query,
      limit: parsed.limit,
      channel: parsed.channel,
      sinceMs: parsed.sinceMs,
    })) as { messages: STMMessage[] } | STMMessage[];
  } else {
    const adapter = getEmbedAdapter();
    let embedding: number[] | null;

    try {
      embedding = await adapter.embed(parsed.query);
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "⚠️ Memory Crystal recall degraded: embedding service unavailable. Please retry.",
          },
        ],
      };
    }

    if (embedding === null) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "⚠️ Memory Crystal recall degraded: embedding service unavailable. Please retry.",
          },
        ],
      };
    }

    response = (await getConvexClient().action(
      "crystal/messages:searchMessages" as any,
      {
        embedding,
        query: parsed.query,
        limit: parsed.limit,
        channel: parsed.channel,
        sinceMs: parsed.sinceMs,
      }
    )) as { messages: STMMessage[] } | STMMessage[];
  }

  const messages = Array.isArray(response)
    ? response
    : Array.isArray(response?.messages)
      ? response.messages
      : [];

  return {
    content: [
      {
        type: "text",
        text: formatSearchResults(messages, parsed.query),
      },
      {
        type: "text",
        text: JSON.stringify(
          {
            query: parsed.query,
            results: messages,
            limit: parsed.limit,
            channel: parsed.channel,
            sinceMs: parsed.sinceMs,
          },
          null,
          2
        ),
      },
    ],
  };
};

export const handleSearchMessagesTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    return await handleSearchMessages(args);
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
