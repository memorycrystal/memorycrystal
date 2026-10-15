/**
 * Channel classification for the operator scope report (ILL-304 R1 req 9),
 * unscoped standalone message surfaces (ILL-320 A04), and the recall message
 * lane (ILL-311 R4). The allowlist loaded by {@link loadWorkChannelAllowlist}
 * is consumed by the R4 recall visibility flag as well.
 */
import {
  AMBIGUOUS_BARE_CHANNEL_SCOPES,
  PEER_CAPABLE_SCOPES,
} from "./knowledgeBases";

/**
 * Coding-agent ids that publish a filesystem session channel, plus the legacy
 * hook `host` prefixes shipped installers write (`plugins/shared` and
 * `platforms.json` `hooks.host`). Excludes openclaw, hermes, claude-desktop,
 * and generic-mcp.
 */
export const DEV_SESSION_FAMILIES: readonly string[] = [
  "claude-code",
  "codex-cli",
  "codex-desktop",
  "opencode",
  "factory-droid",
  "cursor",
  "grok",
  "claude",
  "codex",
  "factory",
];

export const PEER_MESSAGING_FAMILIES: readonly string[] = [
  "telegram",
  "whatsapp",
  "signal",
  "sms",
  "imessage",
  "messenger",
  "instagram",
  "manychat",
  "email",
];

const DEV_SESSION_FAMILY_SET = new Set(DEV_SESSION_FAMILIES);
const PEER_MESSAGING_FAMILY_SET = new Set(PEER_MESSAGING_FAMILIES);

export type ChannelClass = "global" | "work" | "private";

export type PrivateBucket =
  | "peerMessaging"
  | "numericOrPhone"
  | "email"
  | "group"
  | "ambiguousOrPeerScope"
  | "other";

export type SanitizedAllowlist = {
  labels: Set<string>;
  rejectedCount: number;
};

function isNonAsciiDigit(char: string): boolean {
  return /\p{Nd}/u.test(char) && !/[0-9]/.test(char);
}

export function hasNonAsciiDigit(value: string): boolean {
  for (const char of value) {
    if (isNonAsciiDigit(char)) return true;
  }
  return false;
}

function isPhoneLike(value: string): boolean {
  const compact = value.replace(/[\s()-]/g, "");
  return /^\+?[0-9]{7,}$/.test(compact);
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Allowlist entries that would name a peer, a group, or an ambiguous scope are ignored. */
export function allowlistEntryRejected(entry: string): boolean {
  const normalized = entry.trim().toLowerCase();
  if (!normalized) return true;
  if (hasNonAsciiDigit(normalized)) return true;
  if (PEER_CAPABLE_SCOPES.has(normalized)) return true;
  if (AMBIGUOUS_BARE_CHANNEL_SCOPES.has(normalized)) return true;
  if (PEER_MESSAGING_FAMILY_SET.has(normalized)) return true;
  if (/^[0-9]+$/.test(normalized)) return true;
  if (isPhoneLike(normalized)) return true;
  if (isEmailLike(normalized)) return true;
  if (normalized.includes("group")) return true;
  return false;
}

export function sanitizeAllowlist(allowlist: readonly string[]): SanitizedAllowlist {
  const labels = new Set<string>();
  let rejectedCount = 0;
  for (const entry of allowlist) {
    if (allowlistEntryRejected(entry)) {
      rejectedCount += 1;
      continue;
    }
    labels.add(entry.trim().toLowerCase());
  }
  return { labels, rejectedCount };
}

function isFilesystemPath(rest: string): boolean {
  if (!rest) return false;
  if (rest.startsWith("/") || rest.startsWith("~")) return true;
  return /^[A-Za-z]:[\\/]/.test(rest);
}

/**
 * `global` when empty; `work` for a dev-session filesystem channel or an
 * approved bare label; otherwise `private`.
 */
export function classifyChannel(
  channel: string | null | undefined,
  allowlist: readonly string[],
): ChannelClass {
  const trimmed = (channel ?? "").trim();
  if (!trimmed) return "global";
  if (hasNonAsciiDigit(trimmed)) return "private";
  const colon = trimmed.indexOf(":");
  if (colon >= 0) {
    const family = trimmed.slice(0, colon).trim().toLowerCase();
    const rest = trimmed.slice(colon + 1);
    if (DEV_SESSION_FAMILY_SET.has(family) && isFilesystemPath(rest)) return "work";
    return "private";
  }
  const { labels } = sanitizeAllowlist(allowlist);
  if (labels.has(trimmed.toLowerCase())) return "work";
  return "private";
}

export function channelFamily(channel: string | null | undefined): string | null {
  const trimmed = (channel ?? "").trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return null;
  const family = trimmed.slice(0, colon).trim().toLowerCase();
  return family || null;
}

export function isDevSessionFamily(family: string | null | undefined): boolean {
  return Boolean(family && DEV_SESSION_FAMILY_SET.has(family));
}

/** Bare labels safe to show to an operator. Peer-shaped labels stay in bucket counts. */
export function isReportableBareLabel(channel: string | null | undefined): boolean {
  const trimmed = (channel ?? "").trim();
  if (!trimmed || trimmed.includes(":")) return false;
  return !allowlistEntryRejected(trimmed);
}

export function privateBucket(channel: string | null | undefined): PrivateBucket {
  const trimmed = (channel ?? "").trim().toLowerCase();
  if (!trimmed) return "other";
  if (trimmed.includes("@")) return "email";
  if (trimmed.includes("group")) return "group";
  const family = (channelFamily(trimmed) ?? trimmed).trim();
  if (PEER_MESSAGING_FAMILY_SET.has(family) || PEER_MESSAGING_FAMILY_SET.has(trimmed)) {
    return "peerMessaging";
  }
  if (PEER_CAPABLE_SCOPES.has(family) || PEER_CAPABLE_SCOPES.has(trimmed)) {
    return "ambiguousOrPeerScope";
  }
  if (AMBIGUOUS_BARE_CHANNEL_SCOPES.has(family) || AMBIGUOUS_BARE_CHANNEL_SCOPES.has(trimmed)) {
    return "ambiguousOrPeerScope";
  }
  const segments = trimmed.split(":");
  if (segments.some((segment) => /^[0-9]+$/.test(segment) || isPhoneLike(segment) || hasNonAsciiDigit(segment))) {
    return "numericOrPhone";
  }
  return "other";
}

// ── Work‑channel allowlist loader (ILL‑320 A04, reused by ILL‑311 R4) ──

/** Rejected‑count summaries keyed by raw env value so we log at most once. */
const _allowlistRejectLog: Map<string, number> = new Map();

/**
 * Sanitized bare labels from `RECALL_WORK_CHANNEL_LABELS` (comma‑separated).
 * An empty or unset var yields an empty allowlist.
 *
 * Rejected entries (peers, phone‑like, email, groups, `openclaw`, `hermes`,
 * and bare numeric labels) are counted and logged at most once per distinct
 * env value so noisy scans don't repeat.
 */
export function loadWorkChannelAllowlist(): readonly string[] {
  const raw = (process.env.RECALL_WORK_CHANNEL_LABELS ?? "").trim();
  if (!raw) return [];
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const sanitized = sanitizeAllowlist(entries);
  const prevRejected = _allowlistRejectLog.get(raw);
  if (sanitized.rejectedCount > 0 && prevRejected !== sanitized.rejectedCount) {
    _allowlistRejectLog.set(raw, sanitized.rejectedCount);
    console.info(
      `[channelClassifier] RECALL_WORK_CHANNEL_LABELS: ` +
        `${sanitized.rejectedCount} allowlist entries rejected; ` +
        `${sanitized.labels.size} accepted.`,
    );
  }
  return Array.from(sanitized.labels);
}

/** Resets the reject‑log for tests. */
export function _resetAllowlistRejectLogForTests(): void {
  _allowlistRejectLog.clear();
}
