import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

const validActions = ["star", "dismiss", "read"] as const;

export const ideaActionTool: Tool = {
  name: "crystal_idea_action",
  description:
    "Take action on a memory discovery -- star it as valuable, dismiss it, or mark it as read.",
  inputSchema: {
    type: "object",
    properties: {
      ideaId: {
        type: "string",
        minLength: 1,
        description: "The ID of the idea to act on.",
      },
      action: {
        type: "string",
        enum: validActions,
        description: "Action to take: 'star' saves as valuable, 'dismiss' hides it, 'read' marks as acknowledged.",
      },
    },
    required: ["ideaId", "action"],
    additionalProperties: false,
  },
};

const actionToStatus: Record<string, string> = {
  star: "starred",
  dismiss: "dismissed",
  read: "read",
};

export const handleIdeaActionTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    if (typeof args !== "object" || args === null) {
      throw new Error("Invalid arguments");
    }

    const { ideaId, action } = args as Record<string, unknown>;

    if (typeof ideaId !== "string" || ideaId.trim().length === 0) {
      throw new Error("ideaId is required");
    }
    if (typeof action !== "string" || !validActions.includes(action as (typeof validActions)[number])) {
      throw new Error(`action must be one of: ${validActions.join(", ")}`);
    }

    const status = actionToStatus[action];

    let client: ConvexClient;
    try {
      client = new ConvexClient();
    } catch {
      return {
        isError: true,
        content: [{ type: "text", text: "⚠️ Memory Crystal not configured. Set MEMORY_CRYSTAL_API_URL and MEMORY_CRYSTAL_API_KEY." }],
      };
    }

    try {
      await client.post("/api/organic/ideas/update", {
        ideaId: ideaId.trim(),
        status,
      });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || String(err);
      if (msg.includes("404") || msg.includes("Not Found") || msg.includes("not found")) {
        return {
          content: [{ type: "text", text: "Organic Ideas are not yet available on this server. The feature is coming soon." }],
        };
      }
      throw err;
    }

    const confirmations: Record<string, string> = {
      star: `⭐ Idea starred as valuable.`,
      dismiss: `Idea dismissed.`,
      read: `Idea marked as read.`,
    };

    return {
      content: [{ type: "text", text: confirmations[action] || "Done." }],
    };
  } catch (err: unknown) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${(err as { message?: string })?.message || String(err)}` }],
    };
  }
};
