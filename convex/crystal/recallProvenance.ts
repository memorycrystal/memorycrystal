/**
 * ILL-104 — shared provenance & staleness helpers for recall payloads.
 *
 * Both recall surfaces annotate memories with the same logic:
 *  - the `recallMemories` action (`recall.ts`, used by the SDK/no-API-key path), and
 *  - the `/api/mcp/recall` HTTP endpoint (`mcp.ts:mcpRecall`, used by `crystal_recall`
 *    under API-key auth and by the OpenClaw plugin).
 *
 * Keeping the age/staleness math here (and the batched contradiction lookup in
 * `recall.ts:getContradictedOlderSideMemoryIds`) means both paths surface
 * identical provenance so the consuming model sees it regardless of transport.
 * Pure functions only — no clock, no I/O.
 */

// Staleness thresholds (days) by store. Volatile stores (sensory/episodic) age
// fastest; durable knowledge (semantic/procedural) slowest; prospective sits in
// between. These only FLAG status for the model; they do not change ranking.
export const STALENESS_THRESHOLD_DAYS: Record<string, number> = {
  sensory: 14,
  episodic: 45,
  prospective: 90,
  semantic: 240,
  procedural: 240,
};
export const DEFAULT_STALENESS_THRESHOLD_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Compact, token-efficient age label from a creation timestamp. */
export const formatMemoryAge = (createdAt: number | undefined, now: number): string => {
  if (typeof createdAt !== "number") return "unknown";
  const days = Math.max(0, Math.floor((now - createdAt) / MS_PER_DAY));
  if (days < 1) return "today";
  if (days < 60) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
};

/** True when a memory is older than its store's staleness threshold. */
export const isMemoryAgeStale = (
  store: string,
  createdAt: number | undefined,
  now: number,
): boolean => {
  if (typeof createdAt !== "number") return false;
  const ageDays = (now - createdAt) / MS_PER_DAY;
  return ageDays > (STALENESS_THRESHOLD_DAYS[store] ?? DEFAULT_STALENESS_THRESHOLD_DAYS);
};

/** Minimal shape both recall paths expose on a memory for annotation. */
export type ProvenanceMemory = {
  memoryId?: string;
  _id?: string;
  store?: string;
  createdAt?: number;
  source?: string;
  supersededByMemoryId?: string;
};

/**
 * Add the ILL-104 provenance/staleness fields to a memory. `contradictedIds` is
 * the set of ids flagged as the older side of an unresolved contradiction
 * (computed once, batched, by `getContradictedOlderSideMemoryIds`).
 */
export const applyProvenanceToMemory = <T extends ProvenanceMemory>(
  memory: T,
  contradictedIds: Set<string>,
  now: number,
): T & { age: string; stale: boolean; contradicted: boolean; superseded: boolean } => {
  const id = String(memory.memoryId ?? memory._id ?? "");
  return {
    ...memory,
    age: formatMemoryAge(memory.createdAt, now),
    stale: isMemoryAgeStale(memory.store ?? "", memory.createdAt, now),
    contradicted: contradictedIds.has(id),
    superseded: Boolean(memory.supersededByMemoryId),
  };
};
