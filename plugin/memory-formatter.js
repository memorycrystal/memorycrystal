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

const KB_MAX_CHARS = 1200;
const NON_KB_MAX_CHARS = 600;

/**
 * Cap memory content at the appropriate tier and prefer sentence-boundary cuts.
 *
 * @param {string} content - The raw memory content.
 * @param {boolean} isKnowledgeBase - True when the memory came from a knowledge base.
 * @returns {string} - The capped, sentence-aligned content.
 */
function truncateMemoryContent(content, isKnowledgeBase) {
  const text = String(content == null ? "" : content);
  const cap = isKnowledgeBase ? KB_MAX_CHARS : NON_KB_MAX_CHARS;
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

module.exports = {
  KB_MAX_CHARS,
  NON_KB_MAX_CHARS,
  truncateMemoryContent,
};
