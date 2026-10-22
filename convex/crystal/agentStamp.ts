export function normalizeAgentStamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120) : undefined;
}

function metadataObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    if (!value.trim()) return {};
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (value === undefined) return {};
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function readAgentStamp(metadata: unknown): {
  state: "stamped" | "unstamped" | "malformed"; agent?: string;
} {
  const parsed = metadataObject(metadata);
  if (!parsed) return { state: "malformed" };
  const agent = normalizeAgentStamp(parsed.agentId);
  return agent ? { state: "stamped", agent } : { state: "unstamped" };
}

export function sharedMarkers(memory: { category?: string; tags?: string[]; metadata?: unknown }) {
  return {
    person: memory.category === "person",
    tag: (memory.tags ?? []).some(tag => tag.trim().toLowerCase() === "visibility:shared"),
    metadata: metadataObject(memory.metadata)?.visibility === "shared",
  };
}

/** Lower-cased label, or null when the row is unstamped or malformed. */
export function agentStampKey(metadata: unknown): string | null {
  const stamp = readAgentStamp(metadata);
  return stamp.state === "stamped" && stamp.agent ? stamp.agent.toLowerCase() : null;
}

/**
 * First source's normalized label when every present source carries that same
 * label (case-insensitive). Order is the caller's order. Missing, unstamped,
 * malformed, or disagreeing sources yield undefined.
 */
export function unanimousAgentStamp(
  messages: ReadonlyArray<{ metadata?: unknown } | null | undefined>,
): string | undefined {
  let label: string | undefined;
  for (const message of messages) {
    const stamp = readAgentStamp(message?.metadata);
    if (stamp.state !== "stamped" || !stamp.agent) return undefined;
    if (label === undefined) {
      label = stamp.agent;
      continue;
    }
    if (label.toLowerCase() !== stamp.agent.toLowerCase()) return undefined;
  }
  return label;
}

export const AGENT_STAMP_METADATA_ERROR =
  "metadata must be a JSON object to keep the agent stamp";

export type PreservedAgentStamp =
  | { ok: true; metadata: string }
  | { ok: false; error: typeof AGENT_STAMP_METADATA_ERROR };

/** Drop a top-level agentId from object metadata. Anything else is stored verbatim. */
function dropClaimedAgentId(nextMetadata: string): string {
  if (!nextMetadata.trim()) return nextMetadata;
  let parsed: unknown;
  try {
    parsed = JSON.parse(nextMetadata);
  } catch {
    return nextMetadata;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return nextMetadata;
  if (!Object.prototype.hasOwnProperty.call(parsed, "agentId")) return nextMetadata;
  const copy = { ...(parsed as Record<string, unknown>) };
  delete copy.agentId;
  return JSON.stringify(copy);
}

/**
 * Wholesale metadata replacement, except the agentId key: a stamped row keeps
 * its stored label, an unstamped row loses a claimed agentId, and non-object
 * metadata cannot replace a stamped row.
 */
export function withPreservedAgentStamp(
  previousMetadata: unknown,
  nextMetadata: string,
): PreservedAgentStamp {
  const previous = readAgentStamp(previousMetadata);
  if (previous.state !== "stamped" || !previous.agent) {
    return { ok: true, metadata: dropClaimedAgentId(nextMetadata) };
  }
  const replacement = metadataObject(nextMetadata);
  if (!replacement) return { ok: false, error: AGENT_STAMP_METADATA_ERROR };
  return { ok: true, metadata: JSON.stringify({ ...replacement, agentId: previous.agent }) };
}

export function preservedMetadataOrThrow(previousMetadata: unknown, nextMetadata: string): string {
  const preserved = withPreservedAgentStamp(previousMetadata, nextMetadata);
  if (!preserved.ok) throw new Error(preserved.error);
  return preserved.metadata;
}
