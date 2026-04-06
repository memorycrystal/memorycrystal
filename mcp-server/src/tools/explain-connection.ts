import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getConvexClient } from "../lib/convexClient.js";

type ExplainConnectionInput = {
  entityA: string;
  entityB: string;
};

type RelationResult = {
  fromLabel: string;
  toLabel: string;
  relationType: string;
  confidence: number;
  evidenceMemoryIds: string[];
};

type PathResult = {
  type: "A_to_X_to_B" | "A_from_X_to_B";
  viaLabel: string;
  viaNodeType: string;
  path: {
    first: RelationResult;
    second: RelationResult;
  };
};

type ExplainConnectionResponse = {
  entityA: string;
  entityB: string;
  directRelations: RelationResult[];
  indirectPaths: PathResult[];
  supportingMemories: Array<{ title: string; store: string }>;
};

export const explainConnectionTool: Tool = {
  name: "crystal_explain_connection",
  description:
    "Explain how two entities are connected in your knowledge graph. Returns direct relationships, indirect paths, and supporting memories. Use when asking 'how are X and Y related?', 'what connects A to B?'",
  inputSchema: {
    type: "object",
    properties: {
      entityA: {
        type: "string",
        description: "First entity",
      },
      entityB: {
        type: "string",
        description: "Second entity",
      },
    },
    required: ["entityA", "entityB"],
    additionalProperties: false,
  },
};

const ensureExplainConnectionInput = (value: unknown): ExplainConnectionInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.entityA !== "string" || input.entityA.trim().length === 0) {
    throw new Error("entityA is required");
  }

  if (typeof input.entityB !== "string" || input.entityB.trim().length === 0) {
    throw new Error("entityB is required");
  }

  return {
    entityA: input.entityA,
    entityB: input.entityB,
  };
};

export const handleExplainConnectionTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureExplainConnectionInput(args);

    const response = (await getConvexClient().action("crystal/graphQuery:explainConnection" as any, {
      entityA: parsed.entityA,
      entityB: parsed.entityB,
    })) as ExplainConnectionResponse;

    const entityA = parsed.entityA.trim();
    const entityB = parsed.entityB.trim();

    const lines = [`🔗 Connection: ${entityA} ↔ ${entityB}`, ""];

    if (response.directRelations.length === 0) {
      lines.push("No direct relationships found.");
    } else {
      lines.push("Direct relationships:");
      for (const relation of response.directRelations) {
        lines.push(`  • ${relation.fromLabel} ${relation.relationType} ${relation.toLabel} (confidence: ${relation.confidence.toFixed(2)})`);
        if (relation.evidenceMemoryIds.length > 0) {
          lines.push(`    Evidence IDs: ${relation.evidenceMemoryIds.join(", ")}`);
        }
      }
    }

    if (response.indirectPaths.length === 0) {
      lines.push("", "No indirect paths found.");
    } else {
      lines.push("", "Indirect paths:");
      for (const path of response.indirectPaths) {
        if (path.type === "A_to_X_to_B") {
          lines.push(
            `  • ${path.path.first.fromLabel} -> ${path.viaLabel} -> ${path.path.second.toLabel} (${path.path.first.relationType}, ${path.path.second.relationType})`
          );
        } else {
          lines.push(`  • ${path.path.first.fromLabel} -> ${path.viaLabel} -> ${path.path.second.toLabel} (${path.path.first.relationType}, ${path.path.second.relationType})`);
        }
      }
    }

    if (response.supportingMemories.length === 0) {
      lines.push("", "No supporting memories found.");
    } else {
      lines.push("", "Supporting memories:");
      for (const memory of response.supportingMemories) {
        lines.push(`  • "${memory.title}" (${memory.store})`);
      }
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
