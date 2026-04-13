import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, getConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";

type DependencyChainInput = {
  entity: string;
  maxDepth?: number;
};

type ChainEntry = {
  depth: number;
  label: string;
  nodeType: string;
  relationType: string;
  confidence: number;
  evidenceMemoryIds: string[];
};

type DependencyChainResponse = {
  entity: string;
  chain: ChainEntry[];
  totalNodes: number;
};

const clampDepth = (value: number | undefined) =>
  value === undefined ? 3 : Math.min(Math.max(Math.floor(value), 1), 5);

export const dependencyChainTool: Tool = {
  name: "crystal_dependency_chain",
  description:
    "Trace the dependency chain for a goal, project, or task in your knowledge graph. Returns a tree of dependencies with depth and evidence. Use when asking 'what does X depend on?', 'what are the dependencies for Y?'",
  inputSchema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        description: "The goal, project, or task to trace dependencies for",
      },
      maxDepth: {
        type: "number",
        description: "Maximum depth to traverse (1-5, default: 3)",
      },
    },
    required: ["entity"],
    additionalProperties: false,
  },
};

const ensureDependencyChainInput = (value: unknown): DependencyChainInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.entity !== "string" || input.entity.trim().length === 0) {
    throw new Error("entity is required");
  }

  if (input.maxDepth !== undefined && !Number.isFinite(Number(input.maxDepth))) {
    throw new Error("maxDepth must be a number");
  }

  return {
    entity: input.entity,
    maxDepth: input.maxDepth === undefined ? undefined : clampDepth(Number(input.maxDepth)),
  };
};

const toLevelLines = (chain: ChainEntry[]) => {
  const grouped = new Map<number, ChainEntry[]>();
  for (const entry of chain) {
    const existing = grouped.get(entry.depth) ?? [];
    existing.push(entry);
    grouped.set(entry.depth, existing);
  }

  const out: string[] = [];
  for (const depth of Array.from(grouped.keys()).sort((a, b) => a - b)) {
    const entries = grouped.get(depth) ?? [];
    out.push(`Level ${depth}:`);
    for (const entry of entries) {
      out.push(
        `  • ${entry.label} [${entry.nodeType}] — ${entry.relationType} (confidence: ${entry.confidence.toFixed(2)})`
      );
      if (entry.evidenceMemoryIds.length > 0) {
        const preview = entry.evidenceMemoryIds.slice(0, 3);
        const overflow = entry.evidenceMemoryIds.length > 3 ? ` (+${entry.evidenceMemoryIds.length - 3} more)` : "";
        out.push(`    Evidence IDs: ${preview.join(", ")}${overflow}`);
      }
    }
    out.push("");
  }

  return out;
};

export const handleDependencyChainTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureDependencyChainInput(args);

    const maxDepth = parsed.maxDepth;

    // Hosted/API-key clients use the same recall-backed fallback described in the
    // docs and wired in the SSE transport. Keep the SDK graph-query path for JWT
    // clients, but do not degrade API-key users to an error.
    if (hasApiKeyAuth()) {
      const client = new ConvexClient();
      const result = await client.post("/api/mcp/recall", {
        query: `dependencies for ${parsed.entity}`,
        limit: maxDepth ?? 5,
        mode: "project",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    const response = (await getConvexClient().action("crystal/graphQuery:dependencyChain" as any, {
      entity: parsed.entity,
      maxDepth,
    })) as DependencyChainResponse;

    const chain = response.chain ?? [];
    const resolvedDepth = maxDepth ?? 3;

    const lines = [`🔗 Dependency chain for "${parsed.entity}" (depth: ${resolvedDepth}):`, ""];

    if (chain.length === 0) {
      lines.push("No dependency relationships found.");
    } else {
      lines.push(...toLevelLines(chain));
      lines.push(`Total: ${response.totalNodes} nodes in chain`);
    }

    return {
      content: [
        {
          type: "text",
          text: lines.join("\n"),
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
