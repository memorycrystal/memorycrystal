import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveAgentId } from "../lib/agentId.js";
import { ConvexClient } from "../lib/convexClient.js";
import {
  listKnowledgeBases,
  type KnowledgeBaseRecord,
} from "./knowledge-base-utils.js";

type AccessAction = "add" | "remove" | "set" | "open";

type SetKnowledgeBaseAccessInput = {
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  action: AccessAction;
  agentId?: string;
  agentIds?: string[];
  channel?: string;
};

type AccessResponse = {
  updated: boolean;
  knowledgeBaseId: string;
  access: {
    mode: "open" | "closed" | "restricted";
    agentIds: string[] | null;
  };
};

export const setKnowledgeBaseAccessTool: Tool = {
  name: "crystal_set_knowledge_base_access",
  description:
    "Manage which agents can search a Memory Crystal knowledge base. Access states: open (agentIds omitted), closed (empty allowlist), or restricted (one or more agentIds). add/remove default to this client's agent identity when agentId is omitted.",
  inputSchema: {
    type: "object",
    properties: {
      knowledgeBaseId: { type: "string" },
      knowledgeBaseName: { type: "string" },
      action: { type: "string", enum: ["add", "remove", "set", "open"] },
      agentId: { type: "string" },
      agentIds: { type: "array", items: { type: "string" } },
      channel: { type: "string" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

function normalizeAgentIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parseInput(args: unknown): SetKnowledgeBaseAccessInput {
  if (!args || typeof args !== "object") throw new Error("Invalid arguments");
  const input = args as Record<string, unknown>;
  const action = input.action;
  if (action !== "add" && action !== "remove" && action !== "set" && action !== "open") {
    throw new Error("action must be one of: add, remove, set, open");
  }

  const knowledgeBaseId = typeof input.knowledgeBaseId === "string" ? input.knowledgeBaseId.trim() : "";
  const knowledgeBaseName = typeof input.knowledgeBaseName === "string" ? input.knowledgeBaseName.trim() : "";
  if (!knowledgeBaseId && !knowledgeBaseName) {
    throw new Error("knowledgeBaseId or knowledgeBaseName is required");
  }
  if (action === "set" && !Array.isArray(input.agentIds)) {
    throw new Error("agentIds is required when action is set");
  }

  return {
    knowledgeBaseId: knowledgeBaseId || undefined,
    knowledgeBaseName: knowledgeBaseName || undefined,
    action,
    agentId: typeof input.agentId === "string" ? input.agentId.trim() || undefined : undefined,
    agentIds: Array.isArray(input.agentIds)
      ? normalizeAgentIds(input.agentIds.filter((value): value is string => typeof value === "string"))
      : undefined,
    channel: typeof input.channel === "string" ? input.channel.trim() || undefined : undefined,
  };
}

async function resolveKnowledgeBase(
  client: ConvexClient,
  input: SetKnowledgeBaseAccessInput,
): Promise<KnowledgeBaseRecord> {
  // Deliberately use the account-management list (no agentId filter), so an
  // agent can discover a closed/restricted KB by name before assigning itself.
  const knowledgeBases = await listKnowledgeBases(client, { includeInactive: true });
  if (input.knowledgeBaseId) {
    const match = knowledgeBases.find((knowledgeBase) => knowledgeBase._id === input.knowledgeBaseId);
    if (!match) throw new Error("Knowledge base not found");
    return match;
  }
  const normalizedName = input.knowledgeBaseName!.toLowerCase();
  const matches = knowledgeBases.filter(
    (knowledgeBase) => knowledgeBase.name.trim().toLowerCase() === normalizedName,
  );
  if (matches.length === 0) throw new Error(`Knowledge base not found: ${input.knowledgeBaseName}`);
  if (matches.length > 1) throw new Error("Multiple knowledge bases have that name; use knowledgeBaseId");
  return matches[0];
}

export async function handleSetKnowledgeBaseAccessTool(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(args);
    const client = new ConvexClient();
    const knowledgeBase = await resolveKnowledgeBase(client, input);

    let body: { agentIds: string[] | null };
    if (input.action === "open") {
      body = { agentIds: null };
    } else if (input.action === "set") {
      body = { agentIds: input.agentIds! };
    } else {
      const targetAgentId = resolveAgentId(input.agentId, input.channel);
      if (!targetAgentId) {
        throw new Error(
          "agentId is required because no MEMORY_CRYSTAL_AGENT_ID, CRYSTAL_AGENT_ID, or channel-derived identity is available",
        );
      }
      const currentAgentIds = knowledgeBase.agentIds ?? [];
      body = {
        agentIds: input.action === "add"
          ? normalizeAgentIds([...currentAgentIds, targetAgentId])
          : currentAgentIds.filter((agentId) => agentId !== targetAgentId),
      };
    }

    const result = await client.patch<AccessResponse>(
      `/api/knowledge-bases/${knowledgeBase._id}`,
      body,
    );
    return {
      content: [{ type: "text", text: JSON.stringify({ name: knowledgeBase.name, ...result }, null, 2) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: error instanceof Error ? error.message : "Failed to update knowledge base access",
      }],
    };
  }
}
