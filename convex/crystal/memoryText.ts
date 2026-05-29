export const RAW_CONTENT_TOMBSTONE = "[raw sensory content wiped by retention policy]";

export function isRawContentTombstone(content: string | null | undefined): boolean {
  return (content ?? "").trim() === RAW_CONTENT_TOMBSTONE;
}

export function getMemoryEffectiveText(memory: {
  content?: string | null;
  summary?: string | null;
  recallText?: string | null;
  rawContentWipedAt?: number | null;
}): string {
  const recallText = memory.recallText?.trim();
  if (recallText) return recallText;

  const summary = memory.summary?.trim();
  if (summary) return summary;

  const content = memory.content?.trim() ?? "";
  if (!content || isRawContentTombstone(content) || memory.rawContentWipedAt) return "";
  return content;
}

export function getMemoryDisplayText(memory: {
  content?: string | null;
  summary?: string | null;
  recallText?: string | null;
  rawContentWipedAt?: number | null;
}): string {
  return getMemoryEffectiveText(memory) || RAW_CONTENT_TOMBSTONE;
}
