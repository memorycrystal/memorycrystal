import { isSecretKeyName, REDACTED_VALUE, redactSecrets } from "../redactSecrets";
import { buildCoverageDiagnostics, buildPromotionCandidates } from "../recallCoverage";
import { finalizeRecallTimings } from "../recallTimings";
import type { RecallRuntime } from "./types";

function redactStringFields<T extends Record<string, any>>(row: T, fields: string[]): T {
  const shaped: Record<string, any> = { ...row };
  for (const field of fields) {
    if (typeof shaped[field] === "string") shaped[field] = redactSecrets(shaped[field]);
  }
  return shaped as T;
}

// Redact every string in a parsed JSON value. A value under a secret-shaped key
// (`password`, `apiKey`, ...) is replaced whole, which is what the key-name
// rules do to `"password": "..."` in flat text. The flag propagates into
// nested objects and arrays, so every leaf under a secret-shaped key is
// redacted (ILL-328 review: `{"apiKey":{"key":"..."}}` must not leak).
function redactJsonValue(value: unknown, underSecretKey = false): unknown {
  if (typeof value === "string") return underSecretKey ? REDACTED_VALUE : redactSecrets(value);
  if (typeof value === "number") return underSecretKey ? REDACTED_VALUE : value;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, underSecretKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactSecrets(key),
        redactJsonValue(item, underSecretKey || isSecretKeyName(key)),
      ]),
    );
  }
  return value;
}

// Metadata is stored as a JSON string. Redact its values and re-serialize so it
// still parses; fall back to flat-string redaction only when it does not parse.
// Unchanged metadata is returned byte-for-byte, not re-serialized.
function redactMetadata(metadata: unknown): unknown {
  if (typeof metadata !== "string") {
    if (!metadata || typeof metadata !== "object") return metadata;
    const redacted = redactJsonValue(metadata);
    return JSON.stringify(redacted) === JSON.stringify(metadata) ? metadata : redacted;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return redactSecrets(metadata);
  }
  const reserialized = JSON.stringify(redactJsonValue(parsed));
  return reserialized === JSON.stringify(parsed) ? metadata : reserialized;
}

const AGENT_READ_TEXT_FIELDS = ["title", "content", "summary"] as const;
// String arrays an agent can write back through update, edit and supersede.
// Each element is redacted like flat text (ILL-360).
const AGENT_READ_ARRAY_FIELDS = ["tags", "actionTriggers"] as const;

/**
 * The one response shaper for memory objects returned to agent-authenticated
 * HTTP reads (ILL-328): recall, get, triggers, trace, wake and the KB reads.
 * Redacts secret-shaped text in title, content, summary and metadata (JSON-aware),
 * and in every element of tags and actionTriggers (ILL-360),
 * drops the internal `dedupeText` dedupe key, and flags the object with
 * `redacted: true` and `redactedFields` when any field changed, so a client
 * knows the text is not the stored text. Call it after ranking and dedupe.
 */
export function shapeMemoryForAgentRead<T extends Record<string, any>>(
  memory: T,
): Omit<T, "dedupeText"> & { redacted?: true; redactedFields?: string[] } {
  const { dedupeText: _dedupeText, ...shaped } = memory as T & { dedupeText?: unknown };
  const redactedFields: string[] = [];
  for (const field of AGENT_READ_TEXT_FIELDS) {
    const value = (shaped as Record<string, any>)[field];
    if (typeof value !== "string") continue;
    const redacted = redactSecrets(value);
    if (redacted !== value) {
      (shaped as Record<string, any>)[field] = redacted;
      redactedFields.push(field);
    }
  }
  if ("metadata" in shaped) {
    const redacted = redactMetadata((shaped as Record<string, any>).metadata);
    if (redacted !== (shaped as Record<string, any>).metadata) {
      (shaped as Record<string, any>).metadata = redacted;
      redactedFields.push("metadata");
    }
  }
  for (const field of AGENT_READ_ARRAY_FIELDS) {
    const value = (shaped as Record<string, any>)[field];
    if (!Array.isArray(value)) continue;
    let changed = false;
    const redacted = value.map((item) => {
      if (typeof item !== "string") return item;
      const next = redactSecrets(item);
      if (next !== item) changed = true;
      return next;
    });
    if (changed) {
      (shaped as Record<string, any>)[field] = redacted;
      redactedFields.push(field);
    }
  }
  if (redactedFields.length === 0) return shaped as Omit<T, "dedupeText">;
  return { ...shaped, redacted: true, redactedFields } as Omit<T, "dedupeText"> & {
    redacted: true;
    redactedFields: string[];
  };
}

export function shapeRecallMemoryForHttp<T extends Record<string, any>>(memory: T) {
  return shapeMemoryForAgentRead(memory);
}

export function shapeAssetContextForHttp<T extends Record<string, any>>(asset: T): T {
  return redactStringFields(asset, ["title", "summary", "extractedText", "transcript"]);
}

export function recallFiltersApplied(state: RecallRuntime): string[] {
  const request = state.request;
  return [
    ...(request.channel ? ["channel"] : []),
    ...(request.sessionKey ? ["sessionKey"] : []),
    ...(request.resolvedStores?.length ? ["stores"] : []),
    ...(request.resolvedCategories?.length ? ["categories"] : []),
    ...(request.requestedTags?.length ? ["tags"] : []),
    ...(request.hasKnowledgeBaseScope ? ["knowledgeBaseIds"] : []),
  ];
}

export function buildRecallHttpBody(
  state: RecallRuntime,
  memories: any[],
  assetContexts: any[],
  filteredMessageMatches: any[],
  shapedCount: number,
): Record<string, unknown> {
  const coverage = buildCoverageDiagnostics(memories, filteredMessageMatches, {
    recallIntent: state.request.recallIntent,
    requestedLimit: state.request.limit,
    query: state.request.query,
  });
  const promotionCandidates = buildPromotionCandidates(memories, filteredMessageMatches, {
    recallIntent: state.request.recallIntent,
    query: state.request.query,
  });
  const degradation = state.degradation.current();
  return {
    memories,
    assetContexts,
    messageMatches: state.ports.shapeMessages(filteredMessageMatches, state.ports.includeEmbeddings()),
    ...(promotionCandidates.length > 0 ? { promotionCandidates } : {}),
    degraded: degradation !== undefined,
    ...(degradation ? { degradation } : {}),
    retrieval: {
      requestedLimit: state.request.limit,
      finalHits: shapedCount,
      assetContexts: assetContexts.length,
      messageMatches: filteredMessageMatches.length,
      messageMatchesAvailable: state.messageMatchesAvailable ?? 0,
      ...(state.messageScan ? { messageScan: state.messageScan } : {}),
      starved: false,
      filtersApplied: recallFiltersApplied(state),
      ...(state.earlyReturn ? { earlyReturn: true as const } : {}),
    },
    diagnostics: {
      ...state.diagnostics,
      coverage,
      timings: finalizeRecallTimings({
        stages: {
          embed: state.timer.get("embed"),
          vectorSearch: state.timer.get("vectorSearch"),
          lexical: state.timer.get("lexical"),
          kb: state.timer.get("kb"),
          messages: state.timer.get("messages"),
          compose: state.timer.get("compose"),
        },
        totalMs: Date.now() - state.startedAt,
        parallel: true,
      }),
    },
  };
}
