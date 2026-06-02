import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, getConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";
import { getEmbedAdapter } from "../lib/embed.js";
import { redactSecrets } from "../lib/sanitize.js";

type STMMessage = {
  _id?: string;
  role?: string;
  content?: string;
  channel?: string;
  sessionKey?: string;
  timestamp?: number;
  score?: number;
};

type MessageTurn = {
  channel?: string;
  messages?: STMMessage[];
  [key: string]: unknown;
};

type SearchMessagesResponse = {
  messages?: STMMessage[];
  turns?: MessageTurn[];
};

export type CrystalSearchMessagesInput = {
  query: string;
  limit?: number;
  channel?: string;
  sessionKey?: string;
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
      sessionKey: {
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

const filterMessagesByScope = (messages: STMMessage[], channel?: string, sessionKey?: string): STMMessage[] => {
  if (!channel && !sessionKey) return messages;
  return messages.filter((message) =>
    (!channel || message?.channel === channel) &&
    (!sessionKey || message?.sessionKey === sessionKey)
  );
};

const filterTurnsByScope = (turns: MessageTurn[], channel?: string, sessionKey?: string): MessageTurn[] => {
  if (!channel && !sessionKey) return turns;
  const filtered: MessageTurn[] = [];
  for (const turn of turns) {
    const messages = Array.isArray(turn.messages)
      ? filterMessagesByScope(turn.messages, channel, sessionKey)
      : [];
    if (messages.length > 0) {
      filtered.push({
        ...turn,
        channel: turn.channel === channel ? turn.channel : messages[0]?.channel,
        sessionKey: turn.sessionKey === sessionKey ? turn.sessionKey : messages[0]?.sessionKey,
        messages,
      });
    }
  }
  return filtered;
};

const redactMessage = (message: STMMessage): STMMessage => ({
  ...message,
  content: typeof message.content === "string" ? redactSecrets(message.content) : message.content,
});

const redactTurn = (turn: MessageTurn): MessageTurn => ({
  ...turn,
  messages: Array.isArray(turn.messages) ? turn.messages.map(redactMessage) : [],
});

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
  const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey : undefined;
  const sinceMs = typeof input.sinceMs === "number" && Number.isFinite(input.sinceMs) ? input.sinceMs : undefined;

  return { query, limit, channel, sessionKey, sinceMs };
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
  let response: SearchMessagesResponse | STMMessage[];
  if (hasApiKeyAuth()) {
    const client = new ConvexClient();
    response = (await client.post("/api/mcp/search-messages", {
      query: parsed.query,
      limit: parsed.limit,
      channel: parsed.channel,
      sessionKey: parsed.sessionKey,
      sinceMs: parsed.sinceMs,
    })) as SearchMessagesResponse | STMMessage[];
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
        sessionKey: parsed.sessionKey,
        sinceMs: parsed.sinceMs,
      }
    )) as SearchMessagesResponse | STMMessage[];
  }

  const messages = Array.isArray(response)
    ? response
    : Array.isArray(response?.messages)
      ? response.messages
      : [];
  const filteredMessages = filterMessagesByScope(messages, parsed.channel, parsed.sessionKey).map(redactMessage);
  const turns = !Array.isArray(response) && Array.isArray(response.turns)
    ? filterTurnsByScope(response.turns, parsed.channel, parsed.sessionKey).map(redactTurn)
    : [];

  return {
    content: [
      {
        type: "text",
        text: formatSearchResults(filteredMessages, parsed.query),
      },
      {
        type: "text",
        text: JSON.stringify(
          {
            query: parsed.query,
            results: filteredMessages,
            turns,
            limit: parsed.limit,
            channel: parsed.channel,
            sessionKey: parsed.sessionKey,
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
