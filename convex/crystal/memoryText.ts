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

/**
 * Whether compact ("telegraphic") recall is enabled. Default TRUE per the
 * cross-surface contract: when on and a candidate carries recallText, recall
 * injects recallText in place of content; otherwise it falls back to content.
 * Only MEMORY_CRYSTAL_COMPACT_RECALL="false" disables it.
 *
 * Single source of truth for every read path (recallMemories action, the
 * /api/mcp/recall HTTP route, and the KB query) so the toggle behaves the same
 * on the wire regardless of which surface a client calls.
 */
export const isCompactRecallEnabled = (): boolean => {
  const raw = process.env.MEMORY_CRYSTAL_COMPACT_RECALL;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "false") {
    return false;
  }
  return true;
};

/**
 * Select the text a recalled memory should expose to the client.
 *
 * - Compact ON (default): prefer the compact recallText when present and
 *   non-empty, else fall back to the memory's effective content.
 * - Compact OFF: always use the effective content (summary/content), never the
 *   compact form.
 *
 * `getMemoryEffectiveText` already resolves tombstones and the summary/content
 * precedence; we only layer the recallText toggle on top so wiped/empty rows
 * still collapse to "" and remain filtered out upstream.
 */
export const resolveRecallContent = (
  memory: {
    content?: string | null;
    summary?: string | null;
    recallText?: string | null;
    rawContentWipedAt?: number | null;
  },
  compactEnabled: boolean,
): string => {
  if (compactEnabled) {
    const compact = memory.recallText?.trim();
    if (compact) return compact;
  }
  // Fall back to summary/content precedence. When compact is disabled we must
  // NOT let getMemoryEffectiveText silently re-select recallText, so strip it
  // for the fallback computation.
  const effective = getMemoryEffectiveText(
    compactEnabled ? memory : { ...memory, recallText: undefined },
  );
  if (effective) return effective;
  // Compact-off edge case: a row whose only surviving text is recallText (e.g.
  // content wiped by sensory retention while recallText persists) passes the
  // upstream getMemoryEffectiveText filter but would collapse to "" here. Fall
  // back to recallText so we never surface an empty-content result — the filter
  // and the content resolver stay consistent about which rows carry text.
  return memory.recallText?.trim() ?? "";
};
