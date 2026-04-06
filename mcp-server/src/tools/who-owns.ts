import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getConvexClient } from "../lib/convexClient.js";

type WhoOwnsInput = {
  entity: string;
};

type WhoOwnsOwner = {
  label: string;
  nodeType: string;
  relationType: string;
  confidence: number;
  evidenceMemoryIds: string[];
};

type WhoOwnsOwnedBy = {
  label: string;
  nodeType: string;
  relationType: string;
  confidence: number;
};

type WhoOwnsResponse = {
  entity: string;
  owners: WhoOwnsOwner[];
  ownedBy: WhoOwnsOwnedBy[];
};

export const whoOwnsTool: Tool = {
  name: "crystal_who_owns",
  description:
    "Find who owns, manages, or is assigned to an entity in your knowledge graph. Returns ownership chains and evidence memories. Use when asking 'who owns X?', 'who manages Y?', 'who is responsible for Z?'",
  inputSchema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        description: "The entity name to look up (e.g. 'API', 'backend', 'authentication system', 'Sarah')",
      },
    },
    required: ["entity"],
    additionalProperties: false,
  },
};

const formatEvidence = (entries: string[]) => {
  if (entries.length === 0) {
    return "Evidence: none";
  }

  const firstThree = entries.slice(0, 3);
  const overflow = entries.length > 3 ? ` (+${entries.length - 3} more)` : "";
  return `Evidence: ${firstThree.join(", ")}${overflow}`;
};

const ensureWhoOwnsInput = (value: unknown): WhoOwnsInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid arguments");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.entity !== "string" || input.entity.trim().length === 0) {
    throw new Error("entity is required");
  }

  return {
    entity: input.entity,
  };
};

export const handleWhoOwnsTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureWhoOwnsInput(args);

    const response = (await getConvexClient().action("crystal/graphQuery:whoOwns" as any, {
      entity: parsed.entity,
    })) as WhoOwnsResponse;

    const normalizedEntity = parsed.entity.trim();
    const lines = [`🔍 Ownership for "${normalizedEntity}":`, ""];

    if ((response.owners?.length ?? 0) === 0) {
      lines.push("No ownership relationships found.");
    } else {
      lines.push("Owners (things that own the entity):");
      for (const owner of response.owners ?? []) {
        lines.push(`  • ${owner.label} [${owner.nodeType}] — ${owner.relationType} (confidence: ${owner.confidence.toFixed(2)})`);
        if (owner.evidenceMemoryIds.length > 0) {
          lines.push(`    ${formatEvidence(owner.evidenceMemoryIds)}`);
        }
      }
    }

    if ((response.ownedBy?.length ?? 0) === 0) {
      lines.push("", "Owned by (things the entity owns/leads): none");
    } else {
      lines.push("", "Owned by (things the entity owns/leads):");
      for (const owned of response.ownedBy ?? []) {
        lines.push(`  • ${owned.label} [${owned.nodeType}] — ${owned.relationType} (confidence: ${owned.confidence.toFixed(2)})`);
      }
    }

    if ((response.owners?.length ?? 0) === 0 && (response.ownedBy?.length ?? 0) === 0) {
      lines.push("", `No ownership relationships found for "${normalizedEntity}". Try a different entity name.`);
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
