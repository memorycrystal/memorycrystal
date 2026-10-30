const minLimit = 1;
const maxLimit = 20;
const DEFAULT_LIMIT_FALLBACK = 12;

/** Fleet-wide default recall limit. Invalid env values fall back to 12. */
export const resolveDefaultLimit = (): number => {
  const raw = process.env.MEMORY_CRYSTAL_MAX_MEMORIES;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.max(parsed, minLimit), maxLimit);
    }
  }
  return DEFAULT_LIMIT_FALLBACK;
};

export const normalizeTagList = (tags: string[]) =>
  tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);

/** recallMemories ceiling (20). HTTP recall clamps separately to 50. */
export function clampActionRecallLimit(requested: number): number {
  return Math.min(Math.max(requested, minLimit), maxLimit);
}

/** HTTP `/api/mcp/recall` limit: truncating clamp to 1..50, else the fleet default. */
export function clampHttpRecallLimit(rawLimit: unknown): number {
  const requestedLimit = Number(rawLimit ?? resolveDefaultLimit());
  return Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50)
    : resolveDefaultLimit();
}
