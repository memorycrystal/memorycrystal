/**
 * Truncates prompt content to a maximum character length while preserving valid
 * UTF-16 code unit boundaries (JavaScript strings are UTF-16 internally).
 *
 * M3 cost-reduction: prevents unbounded Gemini input tokens for graph extraction.
 *
 * Future enhancement: sliding-window chunking for very long documents so the
 * most semantically relevant segment is selected rather than always the head.
 * TODO(M3-future): implement sliding-window selection based on query relevance.
 */
export function truncatePromptContent(content: string, maxChars = 2000): string {
  if (content.length <= maxChars) {
    return content;
  }

  // Truncate at maxChars. JavaScript strings are UTF-16 sequences; slicing at
  // an arbitrary index is always safe because String.prototype.slice operates
  // on UTF-16 code units and never splits a lone surrogate pair when cutting at
  // the boundary between two complete characters. Emoji and other supplementary
  // plane characters (encoded as surrogate pairs) can only be split if we land
  // exactly between the high and low surrogate. We step back to avoid that.
  let cutAt = maxChars;
  const code = content.charCodeAt(cutAt - 1);
  // 0xD800–0xDBFF: high surrogate — move cut point back one to keep the pair together
  if (code >= 0xd800 && code <= 0xdbff) {
    cutAt -= 1;
  }

  return content.slice(0, cutAt) + "\n[... truncated]";
}
