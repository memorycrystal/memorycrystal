import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getConvexClient } from "../lib/convexClient.js";

type CrystalStatsInput = {
  channel?: string;
};

export const statsTool: Tool = {
  name: "crystal_stats",
  description:
    "Get health metrics and store statistics for Memory Crystal. Use to understand memory usage, strength distribution, and capture activity. Returns counts by store, recent capture rate, and strongest memories.",
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

const ensureStatsInput = (value: unknown): CrystalStatsInput => {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object") {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  if (input.channel !== undefined && typeof input.channel !== "string") {
    throw new Error("channel must be a string");
  }

  return {
    channel: input.channel as string | undefined,
  };
};

const buildBlock = (stats: Record<string, unknown>) =>
  [
    "## Memory Crystal Stats",
    `- Total memories: ${stats.totalMemories}`,
    `- Archived memories: ${stats.archivedCount}`,
    `- Average strength: ${typeof stats.avgStrength === "number" ? stats.avgStrength.toFixed(3) : "n/a"}`,
    `- Captures last 24h: ${stats.recentCaptures}`,
    "",
    "## Store counts",
    ...Object.entries((stats.byStore as Record<string, number>) ?? {}).map(
      ([key, value]) => `- ${key}: ${value}`
    ),
    "",
    "## Strongest",
    ...(Array.isArray(stats.strongest)
      ? (stats.strongest as Array<Record<string, unknown>>).map(
          (entry, index) =>
            `${index + 1}. ${String(entry.title)} (${String(entry.store)}) — ${String(entry.strength)}`
        )
      : []),
  ].join("\n");

export const handleStatsTool = async (args: unknown = null): Promise<CallToolResult> => {
  try {
    const parsed = ensureStatsInput(args);
    const stats = (await getConvexClient().query("crystal/stats:getMemoryStats" as any, {
      channel: parsed.channel,
    })) as Record<
      string,
      unknown
    >;

    return {
      content: [
        {
          type: "text",
          text: buildBlock(stats),
        },
        {
          type: "text",
          text: JSON.stringify(stats, null, 2),
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
