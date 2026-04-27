import { ConvexClient } from "../lib/convexClient.js";

type KnowledgeBaseRecord = {
  _id: string;
  name: string;
  isActive: boolean;
  scope?: string;
};

type ListKnowledgeBasesOptions = {
  includeInactive?: boolean;
  channel?: string;
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
  if (options.channel) {
    searchParams.set("scope", options.channel);
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
  return knowledgeBases.find((knowledgeBase) => knowledgeBase.name.trim().toLowerCase() === normalized) ?? null;
}
