import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";

type CrystalHealthInput = {
  limit?: number;
};

export const healthTool: Tool = {
  name: "crystal_health",
  description:
    "Get a hygiene worklist for Memory Crystal: the specific stale and never-recalled memory IDs grouped by severity (30/60/90-day idle, never-recalled) with triage context (title, store, age, last-accessed, strength). Use this to drive cleanup on a concrete list instead of re-scanning.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max stale rows to scan and return (1-500, default 200).",
      },
    },
    additionalProperties: false,
  },
};

const ensureHealthInput = (value: unknown): CrystalHealthInput => {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object") {
    throw new Error("Invalid arguments");
  }
  const input = value as Record<string, unknown>;
  if (input.limit !== undefined && typeof input.limit !== "number") {
    throw new Error("limit must be a number");
  }
  return { limit: input.limit as number | undefined };
};

const buildBlock = (health: Record<string, unknown>): string => {
  const counts = (health.counts as Record<string, number>) ?? {};
  const buckets = (health.buckets as Record<string, Array<Record<string, unknown>>>) ?? {};
  const lines: string[] = [
    "## Memory Crystal Hygiene Worklist",
    `- Stale >=30d: ${counts.stale30 ?? 0}`,
    `- Stale >=60d: ${counts.stale60 ?? 0}`,
    `- Stale >=90d: ${counts.stale90 ?? 0}`,
    `- Never recalled (stale): ${counts.neverRecalled ?? 0}`,
  ];
  if (health.pageTruncated) {
    lines.push(`- (more stale rows exist beyond the ${health.limit}-row page)`);
  }
  for (const name of ["stale90", "stale60", "stale30", "neverRecalled"]) {
    const rows = buckets[name] ?? [];
    if (!rows.length) continue;
    lines.push("", `## ${name} (${rows.length})`);
    for (const row of rows.slice(0, 25)) {
      lines.push(
        `- ${String(row.id)} — "${String(row.title)}" (${String(row.store)}) idle ${String(row.idleDays)}d, strength ${String(row.strength)}`,
      );
    }
  }
  return lines.join("\n");
};

export const handleHealthTool = async (
  args: unknown = null,
): Promise<CallToolResult> => {
  try {
    const parsed = ensureHealthInput(args);
    if (!hasApiKeyAuth()) {
      throw new Error(
        "crystal_health requires API-key authentication (the hygiene worklist is served over the HTTP endpoint).",
      );
    }
    const client = new ConvexClient();
    const health = (await client.post("/api/mcp/health", {
      limit: parsed.limit,
    })) as Record<string, unknown>;

    return {
      content: [
        { type: "text", text: buildBlock(health) },
        { type: "text", text: JSON.stringify(health, null, 2) },
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
