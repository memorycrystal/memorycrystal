import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

export const ideasTool: Tool = {
  name: "crystal_ideas",
  description:
    "View recent discoveries your memory has made -- cross-memory connections, patterns, and insights found between sessions.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "all", "starred"],
        description:
          "Filter by idea status. 'pending' shows unread discoveries, 'starred' shows saved ones, 'all' shows everything. Default: 'pending'.",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of ideas to return. Default: 5.",
      },
    },
    additionalProperties: false,
  },
};

interface Idea {
  _id: string;
  title: string;
  summary: string;
  ideaType: string;
  confidence: number;
  status: string;
  sourceMemoryIds: string[];
  createdAt: number;
  starredAt?: number;
}

function formatIdea(idea: Idea, index: number): string {
  const typeEmoji: Record<string, string> = {
    connection: "🔗",
    pattern: "🔄",
    contradiction_resolved: "✅",
    insight: "💡",
    action_suggested: "🎯",
  };
  const emoji = typeEmoji[idea.ideaType] || "💡";
  const confidence = Math.round(idea.confidence * 100);
  const date = new Date(idea.createdAt).toLocaleDateString("en-CA");
  const sourceCount = Array.isArray(idea.sourceMemoryIds) ? idea.sourceMemoryIds.length : 0;
  const starred = idea.status === "starred" ? " ⭐" : "";

  return [
    `${index + 1}. ${emoji} ${idea.title}${starred}`,
    `   ${idea.summary}`,
    `   Type: ${idea.ideaType} | Confidence: ${confidence}% | Sources: ${sourceCount} memories | ${date}`,
    `   ID: ${idea._id}`,
  ].join("\n");
}

export const handleIdeasTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
    const status = typeof input.status === "string" ? input.status : "pending";
    const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 5;

    let client: ConvexClient;
    try {
      client = new ConvexClient();
    } catch {
      return {
        isError: true,
        content: [{ type: "text", text: "⚠️ Memory Crystal not configured. Set MEMORY_CRYSTAL_API_URL and MEMORY_CRYSTAL_API_KEY." }],
      };
    }

    let ideas: Idea[];
    try {
      const result = await client.post<{ ideas: Idea[] }>("/api/organic/ideas", { status, limit });
      ideas = Array.isArray(result?.ideas) ? result.ideas : [];
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || String(err);
      // Graceful degradation if endpoint doesn't exist yet
      if (msg.includes("404") || msg.includes("Not Found") || msg.includes("not found")) {
        return {
          content: [{ type: "text", text: "Organic Ideas are not yet available on this server. The feature is coming soon." }],
        };
      }
      throw err;
    }

    if (ideas.length === 0) {
      const emptyMsg = status === "pending"
        ? "No pending discoveries right now. Your memory is still working in the background."
        : status === "starred"
          ? "No starred ideas yet. Star ideas you find valuable to save them."
          : "No ideas found.";
      return { content: [{ type: "text", text: emptyMsg }] };
    }

    const formatted = ideas.map(formatIdea).join("\n\n");
    const header = `## Memory Discoveries (${status}, ${ideas.length} result${ideas.length === 1 ? "" : "s"})`;
    const footer = "\nUse crystal_idea_action to star, dismiss, or mark ideas as read.";

    return {
      content: [{ type: "text", text: [header, "", formatted, footer].join("\n") }],
    };
  } catch (err: unknown) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${(err as { message?: string })?.message || String(err)}` }],
    };
  }
};
