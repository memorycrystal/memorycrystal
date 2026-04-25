import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getConvexClient, ConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";

export type CrystalWakeInput = {
  channel?: string;
};

export const wakeTool: Tool = {
  name: "crystal_wake",
  description: "Get an opening briefing for the current memory session.",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
      },
    },
    additionalProperties: false,
  },
};

const buildBlock = (briefing: string, openGoals: unknown[], recentDecisions: unknown[]) => [
  briefing,
  "",
  "Open goals",
  ...(openGoals.length === 0 ? ["- none"] : openGoals.map((memory) => `- ${(memory as { title: string }).title}`)),
  "",
  "Recent decisions",
  ...(recentDecisions.length === 0
    ? ["- none"]
    : recentDecisions.map((memory) => `- ${(memory as { title: string }).title}`)),
].join("\n");

const ensureInput = (value: unknown): CrystalWakeInput => {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const input = value as Record<string, unknown>;
  if (input.channel !== undefined && typeof input.channel !== "string") {
    throw new Error("channel must be a string");
  }

  return {
    channel: input.channel?.toString(),
  };
};

export const handleWakeTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureInput(args);

    let response:
      | {
          briefing: string;
          openGoals?: unknown[];
          recentDecisions?: unknown[];
        }
      | undefined;

    // Route API-key authenticated requests (whether from env or per-request SSE
    // context) through the HTTP endpoint which carries the key as a bearer token.
    // The SDK fallback below only works for JWT auth, and would otherwise throw
    // "Unauthenticated" for any SSE client using an API key.
    if (hasApiKeyAuth()) {
      const client = new ConvexClient();
      response = (await client.post("/api/mcp/wake", {
        channel: parsed.channel,
      })) as {
        briefing: string;
        openGoals?: unknown[];
        recentDecisions?: unknown[];
      };
    } else {
      response = (await getConvexClient().action("crystal/wake:getWakePrompt" as any, {
        channel: parsed.channel,
      })) as {
        briefing: string;
        openGoals?: unknown[];
        recentDecisions?: unknown[];
      };
    }

    const payload = {
      briefing: response.briefing,
      openGoals: Array.isArray(response.openGoals) ? response.openGoals : [],
      recentDecisions: Array.isArray(response.recentDecisions) ? response.recentDecisions : [],
    };

    const textBlock = buildBlock(payload.briefing, payload.openGoals, payload.recentDecisions);

    return {
      content: [
        { type: "text", text: textBlock },
        { type: "text", text: JSON.stringify(payload, null, 2) },
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
