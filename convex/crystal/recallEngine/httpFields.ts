import { deriveRepoProjectId } from "../projectIdentity";
import { redactSecrets } from "../redactSecrets";
import { normalizeProjectId } from "./sourceRole";

// mcp.ts keeps no copies of these request-field helpers. It imports them for its
// other routes (capture, search-messages, and so on), so recall and those routes
// parse channels, time windows and project context the same way.

export function normalizeChannel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Parse a flexible time input into epoch milliseconds. Accepts a number (ms),
// a numeric string, or an ISO/date string (Date.parse). A plausible seconds-
// precision value is upscaled to ms so agents can pass either. Returns undefined
// when absent or unparseable.
export function parseFlexibleTimeMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const toMs = (n: number): number =>
    n > 0 && n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  if (typeof value === "number") return Number.isFinite(value) ? toMs(value) : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? toMs(n) : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function optionalStringList(...values: unknown[]): string[] | undefined {
  const items: string[] = [];
  for (const value of values) {
    const valuesToRead = Array.isArray(value) ? value : [value];
    for (const item of valuesToRead) {
      if (typeof item !== "string") continue;
      const normalized = item.trim();
      if (normalized) items.push(normalized);
    }
  }
  const unique = Array.from(new Set(items));
  return unique.length ? unique : undefined;
}

export function normalizeRepoSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\\")) return undefined;
  const parts = trimmed.split("/");
  if (parts.length > 2 || parts.some((part) => part.length === 0)) return undefined;
  const sanitizedParts = parts.map((part) => part.replace(/[^a-zA-Z0-9._-]/g, ""));
  if (sanitizedParts.some((part) => part.length === 0)) return undefined;
  return sanitizedParts.join("/").slice(0, 120) || undefined;
}

export async function normalizeProjectContext(projectIdValue: unknown, repoSlugValue: unknown) {
  const explicitProjectId = normalizeProjectId(projectIdValue);
  const repoSlug = normalizeRepoSlug(repoSlugValue);
  if (explicitProjectId || !repoSlug) return { projectId: explicitProjectId, repoSlug };
  return { projectId: await deriveRepoProjectId(repoSlug), repoSlug };
}

export function redactScopeForDiagnostics(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let end = 0;
  let codePoints = 0;
  while (end < value.length && codePoints < 512) {
    end += (value.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
    codePoints++;
  }
  const diagnosticValue = value.slice(0, end);
  if (!/[\\/]/.test(diagnosticValue)) return redactSecrets(diagnosticValue);
  return redactSecrets(diagnosticValue.replace(/([A-Za-z0-9_-]+:)?[^\s:]*[\\/]/g, (_match, prefix = "") => `${prefix}.../`));
}

/** Additive recall message controls; duration is milliseconds, never epoch time. */
export function normalizeRecallMessageFields(body: any) {
  const numeric = (value: unknown, fallback: number) => {
    if (typeof value !== "number" && typeof value !== "string") return fallback;
    if (typeof value === "string" && !value.trim()) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const rawLimit = numeric(body?.messageLimit, 3);
  const duration = numeric(body?.excludeRecentMessagesMs, 0);
  return {
    // A negative value is invalid, like NaN or a non-number: it falls back to the default, never to "no messages".
    messageLimit: Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.min(10, Math.trunc(rawLimit)) : 3,
    turnId: normalizeChannel(body?.turnId),
    excludeRecentMessagesMs: Number.isFinite(duration) ? Math.min(86_400_000, Math.max(0, Math.trunc(duration))) : 0,
  };
}
