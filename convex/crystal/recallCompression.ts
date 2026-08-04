// Recall compression — "telegraphic / caveman" compaction for memory recall.
//
// Contract (shared across surfaces):
//   crystalMemories.recallText  — compact telegraphic form of `content`.
//   crystalMemories.chunkKind   — "content" | "config"; absent == "content".
//   MEMORY_CRYSTAL_COMPACT_RECALL (read side, default TRUE) picks recallText
//   over content at injection.
//
// Writers ALWAYS populate recallText. This module is deterministic (no LLM /
// network), so the capture path and the lazy backfill pulse can both call it
// cheaply and produce identical, idempotent output. The full `content` field is
// never dropped or mutated — recallText is a faithful, reversible-by-fallback
// derivative.

// Articles / fillers / politeness stripped from the telegraphic form. Kept
// conservative so nouns, verbs, entities, numbers and symbols survive intact.
const STOP_WORDS = new Set<string>([
  // articles
  "a", "an", "the",
  // common fillers / auxiliaries that carry little recall signal
  "is", "are", "was", "were", "be", "been", "being", "am",
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "onto",
  "that", "this", "these", "those", "there", "here",
  "and", "or", "but", "so", "then", "than", "as",
  "do", "does", "did", "has", "have", "had",
  "it", "its", "we", "our", "us", "you", "your", "i",
  "just", "really", "very", "quite", "actually", "basically", "simply",
  // politeness
  "please", "thanks", "thank", "kindly", "sorry", "hi", "hello", "hey",
]);

const WORD_RE = /[A-Za-z][A-Za-z'-]*/;

// Preserve tokens that look like identifiers, numbers, code, URLs, env vars,
// paths, or contain digits/symbols — these are high-signal entities we never
// want to fold into stopword filtering or lowercasing.
function isHighSignalToken(token: string): boolean {
  if (!WORD_RE.test(token)) return true; // punctuation / symbol run
  if (/[0-9]/.test(token)) return true; // has a digit
  if (/[_/@:.]/.test(token)) return true; // path/env/url-ish
  // Internal capital => camelCase / PascalWord entity (OpenRouter, gpt4o). A
  // leading capital alone (sentence-initial "Please", "The") is NOT high-signal
  // — only a capital after the first character counts.
  if (/[a-z].*[A-Z]|[A-Z].*[A-Z]/.test(token)) return true;
  if (token.length > 1 && token === token.toUpperCase() && /[A-Z]/.test(token)) {
    return true; // ACRONYM / CONSTANT
  }
  return false;
}

/**
 * Compress content into a compact telegraphic recall string.
 *
 * Deterministic and idempotent: compressRecallText(compressRecallText(x)) is
 * stable. Strips articles/fillers/politeness while keeping nouns, verbs,
 * entities, identifiers, and numbers. Returns a trimmed, capped string. Falls
 * back to a trimmed copy of the input when nothing survives filtering (so we
 * never emit an empty recallText for non-empty content).
 */
export function compressRecallText(content: string, maxChars = 600): string {
  const source = (content ?? "").trim();
  if (!source) return "";

  // Tokenize on whitespace, preserving each token's original text so
  // high-signal tokens keep their casing/symbols.
  const rawTokens = source.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const token of rawTokens) {
    if (isHighSignalToken(token)) {
      kept.push(token);
      continue;
    }
    // Plain word: strip surrounding punctuation for the stopword test.
    const core = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!core) {
      // pure punctuation that WORD_RE didn't already catch — drop it
      continue;
    }
    if (STOP_WORDS.has(core.toLowerCase())) continue;
    kept.push(core);
  }

  let out = kept.join(" ").replace(/\s+/g, " ").trim();
  if (!out) out = source; // nothing survived — keep faithful fallback
  if (out.length > maxChars) {
    out = out.slice(0, maxChars).trimEnd();
  }
  return out;
}

/**
 * Classify a chunk as real content vs. config/source-mirror.
 *
 * Heuristic (intentionally simple + additive): import chunks that are pure
 * front-matter / config headers or verbatim source mirrors are tagged "config"
 * so recall can drop them; everything else is "content". Absent chunkKind is
 * treated as "content" downstream, so being conservative here is safe.
 */
export function classifyChunkKind(args: {
  content: string;
  title?: string;
  tags?: string[];
  source?: string;
}): "content" | "config" {
  const tags = (args.tags ?? []).map((t) => t.toLowerCase());
  if (tags.some((t) => t === "config" || t === "config-header" || t === "source-mirror")) {
    return "config";
  }

  const title = (args.title ?? "").toLowerCase().trim();
  if (
    title === "config" ||
    title === "configuration" ||
    title.endsWith(" config") ||
    title.startsWith("config:") ||
    title.startsWith("source:") ||
    title.startsWith("front matter") ||
    title.startsWith("frontmatter")
  ) {
    return "config";
  }

  const content = (args.content ?? "").trim();
  // YAML/TOML front-matter block or a fenced config header at the very top.
  if (/^---\s*[\r\n][\s\S]*?[\r\n]---\s*$/.test(content)) return "config";
  if (/^\+\+\+\s*[\r\n][\s\S]*?[\r\n]\+\+\+\s*$/.test(content)) return "config";

  // Mostly key: value or key = value lines (config/env dump) with no prose.
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const kvLines = lines.filter((l) => /^[A-Za-z0-9_.-]+\s*[:=]\s*\S/.test(l));
    if (kvLines.length / lines.length >= 0.8) return "config";
  }

  return "content";
}
