import { normalizeMemoryContentForHash } from "../contentHash";

const RECALL_NEAR_DUP_PREFIX = 160;

/** Presentation-layer collapse key. Runs after visibility gates. */
export function recallDedupeKey(memory: any, collapseNearDuplicates: boolean): string {
  const normContent = normalizeMemoryContentForHash(String(memory?.dedupeText ?? memory?.content ?? ""));
  if (!normContent) return ` id:${String(memory?._id ?? "")}`;
  if (collapseNearDuplicates) {
    const normTitle = normalizeMemoryContentForHash(String(memory?.title ?? ""));
    if (normTitle.length >= 8 && normContent.length >= RECALL_NEAR_DUP_PREFIX) {
      return `nd:${normTitle}::${normContent.slice(0, RECALL_NEAR_DUP_PREFIX)}`;
    }
  }
  return normContent;
}
