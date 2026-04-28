const XML_LIKE_MARKERS = [
  /<\/?system>/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
];

const WRAPPED_INJECTION_PATTERNS = [
  /<system>[\s\S]*?<\/system>/gi,
  /\[INST\][\s\S]*?\[\/INST\]/gi,
  /<\|im_start\|>\s*[^\s]+\s*/gi,
  /<\|im_end\|>/gi,
];

const INJECTION_LINE_PATTERNS = [
  /^system:\s*/i,
  /^#{3}\s*system\b/i,
  /^you are now\b/i,
  /^ignore previous\b/i,
];

const MAX_MEMORY_CONTENT_LENGTH = 2000;

export function sanitizeMemoryContent(text: string): string {
  const normalizedText = typeof text === "string" ? text : "";

  const safeLines = normalizedText
    .split("\n")
    .map((line) =>
      WRAPPED_INJECTION_PATTERNS.reduce((current, pattern) => current.replace(pattern, ""), line)
    )
    .map((line) => XML_LIKE_MARKERS.reduce((current, pattern) => current.replace(pattern, ""), line).trimEnd())
    .filter((line) => !INJECTION_LINE_PATTERNS.some((pattern) => pattern.test(line.trimStart())))
    .filter((line) => line.trim().length > 0);

  return safeLines.join("\n").slice(0, MAX_MEMORY_CONTENT_LENGTH).trim();
}
