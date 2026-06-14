export type ContentSectionKind = "body" | "recalled_context" | "user" | "assistant" | "system";

export type ContentSection = {
  kind: ContentSectionKind;
  label: string;
  text: string;
};

const KNOWN_TAGS = ["recalled_context", "user", "assistant", "system"] as const;
const KNOWN_TAG_PATTERN = /<\/?(recalled_context|user|assistant|system)>/gi;
const WHITESPACE_PATTERN = /\s+/g;
const ROLE_PREFIX_PATTERN = /(?:^|\n+)(User|Assistant|AI|System):\s*/gi;

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

const preserveDisplayWhitespace = (value: string | null | undefined) =>
  String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const summarizeText = (content: string | null | undefined, maxChars = 220) => {
  const withoutKnownTags = String(content ?? "").replace(KNOWN_TAG_PATTERN, " ");
  const summary = collapseWhitespace(withoutKnownTags);

  if (summary.length <= maxChars) return summary;
  return `${summary.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

const pushSection = (sections: ContentSection[], kind: ContentSectionKind, rawText: string) => {
  const text = preserveDisplayWhitespace(rawText);
  if (!text) return;

  const previous = sections[sections.length - 1];
  if (previous?.kind === kind) {
    previous.text = `${previous.text}\n\n${text}`;
    return;
  }

  sections.push({ kind, label: LABELS[kind], text });
};

const kindFromRolePrefix = (role: string): ContentSectionKind => {
  const normalized = role.toLowerCase();
  if (normalized === "assistant" || normalized === "ai") return "assistant";
  if (normalized === "system") return "system";
  return "user";
};

const splitRolePrefixedContent = (source: string): ContentSection[] | null => {
  const matches = [...source.matchAll(ROLE_PREFIX_PATTERN)];
  if (matches.length === 0) return null;

  const firstIndex = matches[0].index ?? 0;
  if (source.slice(0, firstIndex).trim()) return null;

  const sections: ContentSection[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const next = matches[i + 1];
    const kind = kindFromRolePrefix(match[1]);
    const start = (match.index ?? 0) + match[0].length;
    const end = next?.index ?? source.length;
    pushSection(sections, kind, source.slice(start, end));
  }

  return sections.length > 0 ? sections : null;
};

export const splitStructuredContent = (content: string | null | undefined): ContentSection[] => {
  const source = String(content ?? "");
  if (!source.trim()) return [];

  const rolePrefixed = splitRolePrefixedContent(source);
  if (rolePrefixed) return rolePrefixed;

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
