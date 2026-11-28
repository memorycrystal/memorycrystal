import {
  inferSourceRoleFromKnowledgeBase,
  normalizeSourceRole,
  type SourceRole,
  type SourceRoleSource,
} from "../recallRanking";

// mcp.ts keeps no copies of these helpers. It imports parseJsonObject from here
// and reaches normalizeProjectId through httpFields.normalizeProjectContext.

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

export function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^proj_[a-f0-9]{12,64}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function extractProjectIdFromMetadata(value: unknown): string | undefined {
  return normalizeProjectId(parseJsonObject(value).projectId);
}

export function getMemoryProjectId(memory: any): string | undefined {
  return normalizeProjectId(memory?.projectId) ?? extractProjectIdFromMetadata(memory?.metadata);
}

export function resolveKnowledgeBaseSourceRole(kb: any): {
  sourceRole: SourceRole;
  sourceRoleSource: SourceRoleSource;
} {
  const explicit = normalizeSourceRole(kb?.sourceRole);
  if (explicit) return { sourceRole: explicit, sourceRoleSource: "metadata" };
  return {
    sourceRole: inferSourceRoleFromKnowledgeBase({
      name: typeof kb?.name === "string" ? kb.name : undefined,
      tags: Array.isArray(kb?.tags) ? kb.tags.map(String) : [],
    }),
    sourceRoleSource: "heuristic",
  };
}

export function getMemorySourceRole(memory: any): {
  sourceRole: SourceRole;
  sourceRoleSource: SourceRoleSource;
} {
  const explicit = normalizeSourceRole(memory?.sourceRole);
  if (explicit) {
    return {
      sourceRole: explicit,
      sourceRoleSource: memory?.sourceRoleSource === "heuristic" ? "heuristic" : "metadata",
    };
  }
  const metadataRole = normalizeSourceRole(parseJsonObject(memory?.metadata).sourceRole);
  if (metadataRole) return { sourceRole: metadataRole, sourceRoleSource: "metadata" };
  if (memory?.knowledgeBaseId || memory?.knowledgeBaseName) {
    return {
      sourceRole: inferSourceRoleFromKnowledgeBase({
        name: memory?.knowledgeBaseName,
        tags: Array.isArray(memory?.tags) ? memory.tags.map(String) : [],
      }),
      sourceRoleSource: "heuristic",
    };
  }
  if (memory?.category === "conversation") {
    return { sourceRole: "message_history", sourceRoleSource: "heuristic" };
  }
  return { sourceRole: "unknown", sourceRoleSource: "default" };
}

export function sourceRoleCounts(memories: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const memory of memories) {
    const { sourceRole } = getMemorySourceRole(memory);
    counts[sourceRole] = (counts[sourceRole] ?? 0) + 1;
  }
  return counts;
}
