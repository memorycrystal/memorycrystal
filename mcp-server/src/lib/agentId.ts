/**
 * Resolve the agentId to forward to the backend for scoped KB visibility.
 *
 * Resolution order (cross-surface contract):
 *   1. explicit `agentId` argument passed by the caller
 *   2. explicit env override (`MEMORY_CRYSTAL_AGENT_ID` / `CRYSTAL_AGENT_ID`)
 *   3. derived from the calling channel/session context (channel prefix before
 *      the first `:` — e.g. `"support-coach:<peerId>"` -> `"support-coach"`)
 *   4. omit (undefined) — the backend has a guard so omission still works
 *
 * Peer-scoped callers (e.g. a coach agent on Telegram/Discord) pass only a `channel`; without
 * this, the backend derives the agentId from the channel prefix at ranking time
 * and can miss agent-scoped KBs. Passing it here lets us keep the resolution
 * explicit and consistent across recall / wake / preflight / query_knowledge_base.
 */
export function resolveAgentId(
  explicit?: string,
  channel?: string,
): string | undefined {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) {
    return trimmedExplicit;
  }

  const envAgentId =
    process.env.MEMORY_CRYSTAL_AGENT_ID?.trim() ||
    process.env.CRYSTAL_AGENT_ID?.trim();
  if (envAgentId) {
    return envAgentId;
  }

  const derived = deriveAgentIdFromChannel(channel);
  if (derived) {
    return derived;
  }

  return undefined;
}

/**
 * Derive an agentId from a channel string by taking the prefix before the first
 * `:` separator. Mirrors the backend's `deriveAgentIdFromChannel` so a
 * peer-scoped channel like `"support-coach:<peerId>"` resolves to `"support-coach"`.
 */
export function deriveAgentIdFromChannel(channel?: string): string | undefined {
  const trimmed = channel?.trim();
  if (!trimmed) {
    return undefined;
  }
  const prefix = trimmed.split(":", 1)[0]?.trim();
  return prefix ? prefix : undefined;
}
