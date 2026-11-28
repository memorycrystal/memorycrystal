// memory-formatter.js — tier-aware truncation for recall memory content.
//
// Knowledge-base chunks (book/course/podcast excerpts) tend to be 800–2000+ chars
// of multi-sentence prose where the actionable claim often lives in the closing
// sentence. Auto-extracted memories are typically 200–400 chars of single facts
// or decisions. A flat 350-char slice was truncating KB definitions mid-sentence
// and hiding the punchline.
//
// This module gives each tier its own cap and slices on sentence boundaries so
// the truncated text always ends at . ! ? or a paragraph break.

const KB_MAX_CHARS = 1600;
const NON_KB_MAX_CHARS = 800;

// ILL-1241: injected recall previews default to 500 chars. On 66 ground-truth
// queries a 500-char excerpt kept every hit full content found (the key fact
// sat at most 499 chars in), while 800 only added context. Hooks send the cap
// as `maxContentChars` so the backend cuts on a sentence boundary, and apply
// it locally too for backends that ignore the field.
const DEFAULT_PREVIEW_CHARS = 500;
const PREVIEW_CHARS_CEILING = 2000;
// The backend accepts maxContentChars from 120 to 4,000.
const MIN_BACKEND_CONTENT_CHARS = 120;

/**
 * The injected preview cap: MEMORY_CRYSTAL_PREVIEW_CHARS (highest), then the
 * plugin-config value, then the default. Values are positive integers capped
 * at 2000; anything else falls through to the next source.
 */
function resolvePreviewChars(env = process.env, configValue) {
  for (const raw of [env?.MEMORY_CRYSTAL_PREVIEW_CHARS, configValue]) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.min(parsed, PREVIEW_CHARS_CEILING);
  }
  return DEFAULT_PREVIEW_CHARS;
}

/** The `maxContentChars` to send for a preview cap: the backend's 120-char floor still leaves the local cut. */
function backendContentChars(previewChars) {
  return Math.max(MIN_BACKEND_CONTENT_CHARS, previewChars);
}

/**
 * Cap memory content at the appropriate tier and prefer sentence-boundary cuts.
 *
 * @param {string} content - The raw memory content.
 * @param {boolean} isKnowledgeBase - True when the memory came from a knowledge base.
 * @param {number} [maxChars] - A cap that replaces the tier cap when it is a positive number.
 * @returns {string} - The capped, sentence-aligned content.
 */
function truncateMemoryContent(content, isKnowledgeBase, maxChars) {
  const text = String(content == null ? "" : content);
  const cap = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : isKnowledgeBase ? KB_MAX_CHARS : NON_KB_MAX_CHARS;
  if (text.length <= cap) return text;
  // Scan one char beyond cap so a terminator at position cap-1 whose trailing
  // whitespace lives at position cap can still satisfy the lookahead. The
  // returned slice is still bounded by lastBoundary <= cap.
  const scanWindow = text.slice(0, cap + 1);
  let lastBoundary = -1;
  let match;
  const sentenceBoundaryRe = /[.!?](?=\s|$)|\n\n/g;
  while ((match = sentenceBoundaryRe.exec(scanWindow)) !== null) {
    // For . ! ? matches, end-of-sentence is the terminator itself (index + 1).
    // For "\n\n" matches, the cut belongs at the start of the blank line (index).
    const end = match[0] === "\n\n" ? match.index : match.index + 1;
    if (end > lastBoundary && end <= cap) lastBoundary = end;
  }
  if (lastBoundary > 0) return text.slice(0, lastBoundary);
  // No sentence boundary inside the window: hard slice rather than over-trim.
  return text.slice(0, cap);
}

// ILL-1241 B1: fail-closed injection-wrapper guard for recalled text, run before
// any other sanitizing. Recalled text is cut at the FIRST wrapper marker of any
// family (any case) and everything from it on is dropped: <system>, <assistant>,
// <user> openers or closers (with optional spaces, attributes or "/"),
// <|im_start|>, <|im_end|>, [INST] and [/INST]. There is no tag parsing,
// balancing or quote handling to get wrong; a memory that merely mentions
// "<system>" loses the text after the mention, which is rare and safe.
//
// ILL-1263 adds chat-template role and turn markers: <|system|>, <|assistant|>,
// <|user|>, <|start_header_id|>, <|end_header_id|>, <|eot_id|>, <|end|>,
// <|endoftext|>, <<SYS>> and <</SYS>>, Gemma's <start_of_turn> and <end_of_turn>
// (only with the closing ">", inner spaces allowed), [SYSTEM_PROMPT] and
// [/SYSTEM_PROMPT], and [INST] or [/INST] with inner spaces. Markers are matched on a normalized copy (NFKC, then every
// Default_Ignorable_Code_Point removed), so fullwidth forms
// (＜system＞) and names split by zero-width characters are caught; the match is
// mapped back to its index in the ORIGINAL text before cutting.
//
// `<\s*(?:\/\s*)?` matches the same strings as `<\s*\/?\s*` without the
// adjacent \s* runs that would backtrack quadratically on "<" plus whitespace.
const WRAPPER_MARKER = new RegExp([
  String.raw`<\s*(?:\/\s*)?(?:system|assistant|user)\b`,
  String.raw`<\s*(?:start|end)_of_turn\s*>`,
  String.raw`<\|(?:im_start|im_end|system|assistant|user|start_header_id|end_header_id|eot_id|end|endoftext)\|>`,
  String.raw`<<\/?SYS>>`,
  String.raw`\[\s*(?:\/\s*)?INST\s*\]`,
  String.raw`\[\/?SYSTEM_PROMPT\]`,
].join("|"), "i");
// Every Default_Ignorable_Code_Point (zero-width spaces and joiners, soft hyphen, invisible operators, variation
// selectors, ...) is dropped from the normalized copy (IGNORABLE_ALL below).
// eslint-disable-next-line no-control-regex
const NEEDS_NORMALIZING = /[^\x00-\x7f]/;
// Fail-closed safety bound: longer input is cut to its first MAX_GUARD_INPUT code units BEFORE matching. Every caller
// trims far below this (recall injection to 2,000 chars, triggers to 200); the bound only caps the work.
const MAX_GUARD_INPUT = 200_000;

// NFKC runs per extended grapheme cluster (Intl.Segmenter; per code point where it is unavailable) over the whole
// input, so combining sequences such as "e\u0301" normalize together. Every character of a cluster's normalized form
// maps back to the cluster's START in the original text.
const GRAPHEMES = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("en", { granularity: "grapheme" })
  : null;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const IGNORABLE_ALL = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * The NFKC-normalized copy of `value` with every default-ignorable code point removed, plus, per grapheme cluster,
 * where its normalized form starts (`starts`) and where the cluster starts in `value` (`origins`). `originOf(i)` is the
 * index in `value` of the cluster that produced normalized character `i`. Identical clusters are normalized once.
 *
 * A cluster start is at or before every character in the cluster, and cutAtWrapperMarker always applies the
 * original-text match as well. So any imperfection in this mapping can only make the cut EARLIER, never later.
 */
function normalizeWithIndexMap(value) {
  const parts = [];
  const starts = [];
  const origins = [];
  const memo = new Map();
  let length = 0;
  const add = (segment, index) => {
    let normalized = segment;
    if (segment.length !== 1 || segment.charCodeAt(0) >= 0x80) {
      normalized = memo.get(segment);
      if (normalized === undefined) {
        normalized = segment.normalize("NFKC").replace(IGNORABLE_ALL, "");
        if (memo.size < 4096) memo.set(segment, normalized);
      }
    }
    if (!normalized) return;
    parts.push(normalized);
    starts.push(length);
    origins.push(index);
    length += normalized.length;
  };
  if (GRAPHEMES) {
    for (const { segment, index } of GRAPHEMES.segment(value)) add(segment, index);
  } else {
    for (let i = 0; i < value.length; ) {
      const width = value.codePointAt(i) > 0xffff ? 2 : 1;
      add(value.slice(i, i + width), i);
      i += width;
    }
  }
  const originOf = (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return origins[low];
  };
  return { text: parts.join(""), originOf };
}

/**
 * `text` up to (not including) its first wrapper marker; unchanged when it has none. The marker regex runs on the
 * ORIGINAL text and on the normalized copy of the whole text, and the text is cut at the EARLIER of the two matches:
 * normalizing can hide a marker the original shows (`<system\u200bnote>` loses its word boundary once the zero-width
 * space is dropped), so the normalized pass only ever adds an earlier cut to what the original pass finds. Input over
 * MAX_GUARD_INPUT code units is first cut to that length (fail-closed).
 */
function cutAtWrapperMarker(text) {
  let value = String(text == null ? "" : text);
  if (value.length > MAX_GUARD_INPUT) {
    value = value.slice(0, MAX_GUARD_INPUT);
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1); // never split a surrogate pair
  }
  const direct = WRAPPER_MARKER.exec(value);
  let cut = direct ? direct.index : value.length;
  // Text that NFKC leaves unchanged and that holds no ignorable code point needs no second pass.
  if (NEEDS_NORMALIZING.test(value) && (IGNORABLE.test(value) || value.normalize("NFKC") !== value)) {
    const normalized = normalizeWithIndexMap(value);
    const match = WRAPPER_MARKER.exec(normalized.text);
    if (match) cut = Math.min(cut, normalized.originOf(match.index));
  }
  return cut < value.length ? value.slice(0, cut) : value;
}

module.exports = {
  KB_MAX_CHARS,
  NON_KB_MAX_CHARS,
  DEFAULT_PREVIEW_CHARS,
  PREVIEW_CHARS_CEILING,
  backendContentChars,
  cutAtWrapperMarker,
  resolvePreviewChars,
  truncateMemoryContent,
};
