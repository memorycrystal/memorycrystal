import { ConvexClient } from "../lib/convexClient.js";

export type KnowledgeBaseRecord = {
  _id: string;
  name: string;
  isActive: boolean;
  scope?: string;
  agentIds?: string[];
};

type ListKnowledgeBasesOptions = {
  includeInactive?: boolean;
  channel?: string;
  scope?: string;
  agentId?: string;
};

export async function listKnowledgeBases(
  client = new ConvexClient(),
  options: ListKnowledgeBasesOptions = {}
) {
  const searchParams = new URLSearchParams();
  if (options.includeInactive) {
    searchParams.set("includeInactive", "true");
  }
  const scope = options.scope || options.channel;
  if (scope) {
    searchParams.set("scope", scope);
  }
  if (options.agentId) {
    searchParams.set("agentId", options.agentId);
  }
  const query = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
  const response = await client.get<{ knowledgeBases: KnowledgeBaseRecord[] }>(`/api/knowledge-bases${query}`);
  return response.knowledgeBases ?? [];
}

export async function resolveKnowledgeBaseByName(
  name: string,
  client = new ConvexClient(),
  options: ListKnowledgeBasesOptions = {}
) {
  const knowledgeBases = await listKnowledgeBases(client, {
    ...options,
    includeInactive: options.includeInactive ?? true,
  });
  const normalized = name.trim().toLowerCase();
  const matches = knowledgeBases.filter((knowledgeBase) => knowledgeBase.name.trim().toLowerCase() === normalized);
  if (matches.length > 1) throw new Error("Ambiguous name; use knowledgeBaseId");
  return matches[0] ?? null;
}
