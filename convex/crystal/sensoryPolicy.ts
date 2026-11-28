export function isProtectedSensoryCapture(memory: { tags?: string[]; source?: string; knowledgeBaseId?: unknown }) {
  if (memory.knowledgeBaseId) return true;
  const tags = (memory.tags ?? []).map((tag) => String(tag).trim().toLowerCase());
  if (tags.some((tag) => tag.startsWith("sensory-mode:"))) return true;
  if (tags.some((tag) => tag.includes("media") || tag.includes("raw_import") || tag.includes("external_observation") || tag.includes("special_capture"))) return true;
  return memory.source === "external" && !tags.includes("auto-capture");
}
