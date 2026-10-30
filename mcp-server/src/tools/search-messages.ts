import { applyRecallContentLimit } from "../contract/toolContract.js";
import { stdioTool } from "../contract/stdioTool.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, getConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";
import { redactSecrets } from "../lib/sanitize.js";
import { parseOptionalIntegerLimit, parseOptionalString } from "./validation.js";

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
  fromMs?: number;
  toMs?: number;
  startDate?: string;
  endDate?: string;
  offset?: number;
};

export const searchMessagesTool: Tool = {
  ...stdioTool("crystal_search_messages"),
  name: "crystal_search_messages",
};

// A code-point cut: never half of a surrogate pair in an excerpt.
const trimText = (value: string, maxChars: number): string => applyRecallContentLimit(value, maxChars).content;

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

  const limit = parseOptionalIntegerLimit(input.limit, { min: 1, max: 100 }) ?? 10;
  const channel = parseOptionalString(input.channel, "channel");
  const sessionKey = parseOptionalString(input.sessionKey, "sessionKey");
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const sinceMs = num(input.sinceMs);
  const fromMs = num(input.fromMs);
  const toMs = num(input.toMs);
  const startDate = str(input.startDate);
  const endDate = str(input.endDate);
  const offset =
    typeof input.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.trunc(input.offset))
      : undefined;

  return { query, limit, channel, sessionKey, sinceMs, fromMs, toMs, startDate, endDate, offset };
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
      fromMs: parsed.fromMs,
      toMs: parsed.toMs,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      offset: parsed.offset,
    })) as SearchMessagesResponse | STMMessage[];
  } else {
    response = (await getConvexClient().action(
      "crystal/messages:searchMessages" as any,
      {
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

  const pagination =
    !Array.isArray(response) && response && typeof response === "object"
      ? (response as { pagination?: unknown }).pagination
      : undefined;
  const window =
    !Array.isArray(response) && response && typeof response === "object"
      ? (response as { window?: unknown }).window
      : undefined;

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
            // Paging + window echoed back so the caller can walk the full set
            // (pagination.hasMore/nextOffset) rather than assuming the first
            // page is complete, and never assert a window is empty from one page.
            pagination,
            window,
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
