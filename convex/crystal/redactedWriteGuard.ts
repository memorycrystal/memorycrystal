import { getMemoryEffectiveText } from "./memoryText";
import { shapeMemoryForAgentRead } from "./recallEngine/response";
import { containsRedactionPlaceholder } from "./redactSecrets";

/**
 * The agent-writable text fields that agent reads redact (ILL-360). A write
 * to one of them is refused when the incoming value carries a redaction
 * placeholder AND the stored value is lossy on read, because that pairing is
 * the signature of a read-modify-write that would overwrite a stored secret
 * with its placeholder. Either condition alone is fine: placeholder text on a
 * clean memory is a deliberate write, and a lossy memory can be edited freely
 * with placeholder-free text.
 */
export const REDACTION_GUARDED_FIELDS = ["title", "content", "metadata", "tags", "actionTriggers"] as const;

export type RedactionGuardedField = (typeof REDACTION_GUARDED_FIELDS)[number];

export type RedactionGuardedWrite = Partial<Record<RedactionGuardedField, unknown>>;

export type RedactionGuardedStored = {
  title?: string | null;
  content?: string | null;
  summary?: string | null;
  recallText?: string | null;
  rawContentWipedAt?: number | null;
  metadata?: string | null;
  tags?: string[] | null;
  actionTriggers?: string[] | null;
};

// Element-wise for arrays; metadata is checked as the raw string.
export function incomingCarriesPlaceholder(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsRedactionPlaceholder(item));
  return containsRedactionPlaceholder(value);
}

/**
 * The stored fields shapeMemoryForAgentRead would change, i.e. the fields an
 * agent read returned with a placeholder in place of the stored text. Content
 * is lossy when the stored `content`, the stored `summary`, or the text agent
 * reads actually return for it (getMemoryEffectiveText: recallText, summary or
 * content) would change. The summary counts on its own because wake and recall
 * return it instead of recallText when compact recall is off.
 */
export function lossyStoredFields(stored: RedactionGuardedStored): Set<RedactionGuardedField> {
  const shaped = shapeMemoryForAgentRead({
    title: stored.title ?? undefined,
    content: stored.content ?? undefined,
    summary: getMemoryEffectiveText(stored),
    metadata: stored.metadata ?? undefined,
    tags: stored.tags ?? undefined,
    actionTriggers: stored.actionTriggers ?? undefined,
  });
  const lossy = new Set<RedactionGuardedField>();
  for (const field of shaped.redactedFields ?? []) {
    if (field === "summary") lossy.add("content");
    else if ((REDACTION_GUARDED_FIELDS as readonly string[]).includes(field)) lossy.add(field as RedactionGuardedField);
  }
  if (!lossy.has("content") && shapeMemoryForAgentRead({ summary: stored.summary ?? undefined }).redactedFields?.includes("summary")) {
    lossy.add("content");
  }
  return lossy;
}

/**
 * The fields of `incoming` that must not be written over `stored` without
 * `allowRedactedContent: true`: present in the write, carrying a placeholder,
 * and lossy on read in the stored memory. Empty when the write is safe.
 */
export function findRedactedWriteConflicts(
  incoming: RedactionGuardedWrite,
  stored: RedactionGuardedStored,
): RedactionGuardedField[] {
  const present = REDACTION_GUARDED_FIELDS.filter(
    (field) => incoming[field] !== undefined && incomingCarriesPlaceholder(incoming[field]),
  );
  if (present.length === 0) return [];
  const lossy = lossyStoredFields(stored);
  return present.filter((field) => lossy.has(field));
}

export function redactedWriteRefusal(fields: RedactionGuardedField[]) {
  const list = fields.join(", ");
  return {
    error: "redacted_content_write" as const,
    fields,
    message:
      `${list} ${fields.length === 1 ? "contains" : "contain"} a redaction placeholder such as [REDACTED], and the stored ` +
      `${list} ${fields.length === 1 ? "holds" : "hold"} secret-shaped text that agent reads redact; writing the placeholder ` +
      "back would replace the stored text. Send allowRedactedContent: true to write it anyway.",
  };
}
