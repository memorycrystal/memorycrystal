export type ContentSectionKind = "body" | "recalled_context" | "user" | "assistant" | "system";

export type ContentSection = {
  kind: ContentSectionKind;
  label: string;
  text: string;
};

const KNOWN_TAGS = ["recalled_context", "user", "assistant", "system"] as const;
const KNOWN_TAG_PATTERN = /<\/?(recalled_context|user|assistant|system)>/gi;
const WHITESPACE_PATTERN = /\s+/g;

const LABELS: Record<ContentSectionKind, string> = {
  body: "Content",
  recalled_context: "Recalled Context",
  user: "User",
  assistant: "AI",
  system: "System",
};

const normalizeKnownTag = (value: string): ContentSectionKind => {
  const normalized = value.toLowerCase();
  return KNOWN_TAGS.includes(normalized as (typeof KNOWN_TAGS)[number])
    ? (normalized as ContentSectionKind)
    : "body";
};

export const collapseWhitespace = (value: string | null | undefined) =>
  String(value ?? "").replace(WHITESPACE_PATTERN, " ").trim();

export const summarizeText = (content: string | null | undefined, maxChars = 220) => {
  const withoutKnownTags = String(content ?? "").replace(KNOWN_TAG_PATTERN, " ");
  const summary = collapseWhitespace(withoutKnownTags);

  if (summary.length <= maxChars) return summary;
  return `${summary.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

const pushSection = (sections: ContentSection[], kind: ContentSectionKind, rawText: string) => {
  const text = collapseWhitespace(rawText);
  if (!text) return;

  const previous = sections[sections.length - 1];
  if (previous?.kind === kind) {
    previous.text = `${previous.text}\n\n${text}`;
    return;
  }

  sections.push({ kind, label: LABELS[kind], text });
};

export const splitStructuredContent = (content: string | null | undefined): ContentSection[] => {
  const source = String(content ?? "");
  if (!source.trim()) return [];

  const sections: ContentSection[] = [];
  const stack: ContentSectionKind[] = [];
  let cursor = 0;

  for (const match of source.matchAll(KNOWN_TAG_PATTERN)) {
    const token = match[0];
    const tagName = match[1];
    const index = match.index ?? 0;
    const currentKind = stack[stack.length - 1] ?? "body";

    pushSection(sections, currentKind, source.slice(cursor, index));

    const kind = normalizeKnownTag(tagName);
    if (token.startsWith("</")) {
      const matchingIndex = stack.lastIndexOf(kind);
      if (matchingIndex >= 0) {
        stack.splice(matchingIndex, stack.length - matchingIndex);
      }
    } else {
      stack.push(kind);
    }

    cursor = index + token.length;
  }

  pushSection(sections, stack[stack.length - 1] ?? "body", source.slice(cursor));

  return sections.length > 0
    ? sections
    : [{ kind: "body", label: LABELS.body, text: collapseWhitespace(source) }];
};
