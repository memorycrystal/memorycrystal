import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient, getConvexClient, hasApiKeyAuth } from "../lib/convexClient.js";

type WhoOwnsInput = {
  entity: string;
  topic?: string;
  channel?: string;
  sessionKey?: string;
  agentId?: string;
  projectId?: string;
  repoSlug?: string;
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
  evidenceMemoryIds?: string[];
};

type WhoOwnsResponse = {
  entity: string;
  owners: WhoOwnsOwner[];
  ownedBy: WhoOwnsOwnedBy[];
  primarySource?: string;
  fallbackUsed?: boolean;
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
      topic: {
        type: "string",
        description: "Alias for entity. Accepted for parity with hosted/streamable MCP clients.",
      },
      channel: {
        type: "string",
      },
      sessionKey: {
        type: "string",
      },
      agentId: {
        type: "string",
      },
      projectId: {
        type: "string",
      },
      repoSlug: {
        type: "string",
      },
    },
    anyOf: [{ required: ["entity"] }, { required: ["topic"] }],
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
  const entity = typeof input.entity === "string" ? input.entity : input.topic;
  if (typeof entity !== "string" || entity.trim().length === 0) {
    throw new Error("entity or topic is required");
  }

  const { channel, sessionKey, agentId, projectId, repoSlug, topic } = input;
  if (topic !== undefined && typeof topic !== "string") {
    throw new Error("topic must be a string");
  }
  if (channel !== undefined && typeof channel !== "string") {
    throw new Error("channel must be a string");
  }
  if (sessionKey !== undefined && typeof sessionKey !== "string") {
    throw new Error("sessionKey must be a string");
  }
  if (agentId !== undefined && typeof agentId !== "string") {
    throw new Error("agentId must be a string");
  }
  if (projectId !== undefined && typeof projectId !== "string") {
    throw new Error("projectId must be a string");
  }
  if (repoSlug !== undefined && typeof repoSlug !== "string") {
    throw new Error("repoSlug must be a string");
  }

  return {
    entity,
    channel: channel as string | undefined,
    sessionKey: sessionKey as string | undefined,
    agentId: agentId as string | undefined,
    projectId: projectId as string | undefined,
    repoSlug: repoSlug as string | undefined,
  };
};

const hasGraphResult = (response: WhoOwnsResponse) =>
  (response.owners?.length ?? 0) > 0 || (response.ownedBy?.length ?? 0) > 0;

const recallFallback = async (client: ConvexClient, parsed: WhoOwnsInput, limit = 5) =>
  client.post("/api/mcp/recall", {
    query: `who owns ${parsed.entity}`,
    categories: ["person"],
    limit,
    mode: "people",
    channel: parsed.channel,
    sessionKey: parsed.sessionKey,
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    repoSlug: parsed.repoSlug,
  });

export const handleWhoOwnsTool = async (args: unknown): Promise<CallToolResult> => {
  try {
    const parsed = ensureWhoOwnsInput(args);

    if (hasApiKeyAuth()) {
      const client = new ConvexClient();
      const graph = (await client.post("/api/mcp/graph/who-owns", {
        entity: parsed.entity,
        channel: parsed.channel,
        sessionKey: parsed.sessionKey,
        agentId: parsed.agentId,
        projectId: parsed.projectId,
        repoSlug: parsed.repoSlug,
      })) as WhoOwnsResponse;
      const result = hasGraphResult(graph)
        ? { ...graph, primarySource: "graph", fallbackUsed: false }
        : {
            primarySource: "recall_fallback",
            fallbackUsed: true,
            graph,
            fallbackMemories: (await recallFallback(client, parsed) as any)?.memories ?? [],
          };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    const response = (await getConvexClient().action("crystal/graphQuery:whoOwns" as any, {
      entity: parsed.entity,
      channel: parsed.channel,
      agentId: parsed.agentId,
      projectId: parsed.projectId,
      repoSlug: parsed.repoSlug,
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
