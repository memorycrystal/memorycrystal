import {
  AMBIGUOUS_BARE_CHANNEL_SCOPES,
  isNonKnowledgeBaseMemoryVisibleInChannel,
} from "./knowledgeBases";

export const UNSCOPED_CHANNEL_SKIP_REASON = "unscoped_channel" as const;
export const UNSCOPED_CHANNEL_TELEMETRY_KIND = "unscoped_channel" as const;
export const UNSCOPED_CHANNEL_ALARM_USER_ID = "__system__" as const;
export const UNSCOPED_CHANNEL_RESIDUAL_POLICY = "delete" as const;

// Terminal skips that may keep a distilled artifact. unscoped_channel is
// terminal but never capsule-worthy: a capsule on the same bare channel is
// the 2026-07-02 leak mechanism.
export const CAPSULE_WORTHY_SKIP_REASONS: ReadonlySet<string> = new Set([
  "low_signal",
  "no_durable_memory",
  "blocked_by_content_scanner",
]);

const RESERVED_SCOPE_IDS = new Set(["main", "default", "unknown"]);
const SAFE_SCOPE_ID = /^[A-Za-z0-9_.@-]{2,128}$/;
const TELEMETRY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type WriteChannelResolution = {
  channel?: string;
  resolved: boolean;
  family?: string;
};

export function isCapsuleWorthySkipReason(reason?: string): boolean {
  return Boolean(reason && CAPSULE_WORTHY_SKIP_REASONS.has(reason));
}

export function isProactiveDistillationChannelEligible(channel?: string): boolean {
  const normalized = channel?.trim();
  if (!normalized) return false;
  if (!normalized.includes(":") && AMBIGUOUS_BARE_CHANNEL_SCOPES.has(normalized.toLowerCase())) {
    return false;
  }
  return isNonKnowledgeBaseMemoryVisibleInChannel(normalized, normalized);
}

export function isAmbiguousBareChannel(channel?: string): boolean {
  const normalized = channel?.trim();
  if (!normalized || normalized.includes(":")) return false;
  return AMBIGUOUS_BARE_CHANNEL_SCOPES.has(normalized.toLowerCase());
}

export function isSafeScopeId(value?: string): boolean {
  const trimmed = value?.trim();
  if (!trimmed || RESERVED_SCOPE_IDS.has(trimmed.toLowerCase())) return false;
  return SAFE_SCOPE_ID.test(trimmed);
}

function parseMetadataRecord(metadata?: string): Record<string, unknown> | null {
  const raw = metadata?.trim();
  if (!raw || raw[0] !== "{") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function metadataScopeId(family: string, metadata?: string): string {
  const record = parseMetadataRecord(metadata);
  if (!record) return "";
  const from = record.from && typeof record.from === "object" && !Array.isArray(record.from)
    ? (record.from as Record<string, unknown>)
    : null;
  const groupId = firstString(record.groupId, record.group_id);
  if ((family === "discord" || family === "slack") && isSafeScopeId(groupId)) {
    return `group:${groupId}`;
  }
  const peerId = firstString(
    record.peerId,
    record.peer_id,
    record.senderId,
    record.sender_id,
    record.authorId,
    record.author_id,
    from?.id,
  );
  return isSafeScopeId(peerId) ? peerId : "";
}

function sessionScopeId(family: string, sessionKey?: string): string {
  const value = sessionKey?.trim();
  if (!value) return "";
  const parts = value.split(":").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2) {
    const [prefix, id] = parts;
    if (prefix.toLowerCase() === family && isSafeScopeId(id)) return id;
    // provider:peerId (telegram:511172388) may stamp a peer-capable family.
    if (family !== "discord" && family !== "slack" && isSafeScopeId(id)) return id;
    return "";
  }
  if ((family === "discord" || family === "slack") && parts.length >= 3) {
    if (parts[0].toLowerCase() === family && parts[1].toLowerCase() === "group" && isSafeScopeId(parts[2])) {
      return `group:${parts[2]}`;
    }
  }
  // agent:<agentId>:<provider>:<account>:direct:<peerId>
  if (parts.length === 6 && parts[0] === "agent" && parts[4] === "direct" && isSafeScopeId(parts[5])) {
    if (family === "discord" || family === "slack") return "";
    return parts[5];
  }
  return "";
}

function candidateChannel(family: string, suffix: string): string {
  return `${family}:${suffix}`;
}

/**
 * Promote a bare ambiguous family (`peer-coach`, `discord`, …) to
 * `family:id` when sessionKey or metadata already names a safe peer/group.
 * Never invents a scope. Already-eligible channels are left alone.
 */
export function resolveWriteChannel(input: {
  channel?: string;
  sessionKey?: string;
  metadata?: string;
}): WriteChannelResolution {
  const channel = input.channel?.trim() || undefined;
  if (!channel) return { channel, resolved: false };
  if (isProactiveDistillationChannelEligible(channel)) {
    return { channel, resolved: false };
  }
  if (!isAmbiguousBareChannel(channel)) {
    return { channel, resolved: false };
  }

  const family = channel.toLowerCase();
  const suffix = metadataScopeId(family, input.metadata) || sessionScopeId(family, input.sessionKey);
  if (!suffix) return { channel, family, resolved: false };

  const promoted = candidateChannel(family, suffix);
  if (!isProactiveDistillationChannelEligible(promoted)) {
    return { channel, family, resolved: false };
  }
  return { channel: promoted, family, resolved: true };
}

export function unscopedChannelAlarmExpiresAt(now: number): number {
  return now + TELEMETRY_TTL_MS;
}

export function buildUnscopedChannelAlarmPayload(input: {
  count: number;
  channels: string[];
}): string {
  const unique = [...new Set(input.channels.filter(Boolean))].sort();
  return JSON.stringify({
    reason: UNSCOPED_CHANNEL_SKIP_REASON,
    residualPolicy: UNSCOPED_CHANNEL_RESIDUAL_POLICY,
    count: input.count,
    channels: unique,
  });
}
