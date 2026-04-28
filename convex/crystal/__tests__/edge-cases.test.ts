import { describe, expect, it } from "vitest";
import { parseTemporalReference } from "../temporalParser";
import { diversityFilter, textSimilarity, scoreRecallCandidate } from "../recallRanking";

const now = Date.parse("2026-04-01T18:30:00.000Z");

const candidate = (overrides: Record<string, any> = {}) => ({
  memoryId: overrides.memoryId || "test",
  title: overrides.title || "Test",
  content: overrides.content || "test content",
  vectorScore: overrides.vectorScore || 0.5,
  salienceScore: overrides.salienceScore || 0.5,
  store: "semantic",
  category: overrides.category || "fact",
  tags: overrides.tags || [],
  confidence: overrides.confidence ?? 0.8,
  archived: false,
  createdAt: overrides.createdAt || now - 86400000,
  lastAccessedAt: overrides.lastAccessedAt || now - 86400000,
  accessCount: overrides.accessCount || 1,
  strength: overrides.strength || 0.5,
  graphNodeCount: 0,
  graphRelationCount: 0,
});

describe("temporal parser edge cases", () => {
  it("parses date embedded in longer text", () => {
    const result = parseTemporalReference("tell me what happened on March 14 with the deploy", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.startMs).getUTCDate()).toBe(14);
    expect(new Date(result!.startMs).getUTCMonth()).toBe(2); // March = 2
  });

  it("parses abbreviated month", () => {
    const result = parseTemporalReference("what about Sep 3", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.startMs).getUTCMonth()).toBe(8); // September = 8
    expect(new Date(result!.startMs).getUTCDate()).toBe(3);
  });

  it("parses European format (day before month)", () => {
    const result = parseTemporalReference("what happened 14 March", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.startMs).getUTCDate()).toBe(14);
    expect(new Date(result!.startMs).getUTCMonth()).toBe(2);
  });

  it("parses numeric days ago", () => {
    const result = parseTemporalReference("3 days ago something happened", now);
    expect(result).not.toBeNull();
    const expected = new Date(now - 3 * 86400000);
    expect(new Date(result!.startMs).getUTCDate()).toBe(expected.getUTCDate());
  });

  it("parses 'today'", () => {
    const result = parseTemporalReference("what happened today", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.startMs).getUTCDate()).toBe(new Date(now).getUTCDate());
  });

  it("resolves future month to last year", () => {
    // "in December" when now is April 2026 → December 2025
    const result = parseTemporalReference("in December", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.startMs).getUTCFullYear()).toBe(2025);
    expect(new Date(result!.startMs).getUTCMonth()).toBe(11);
  });

  it("resolves 'last March' to previous year", () => {
    // "last March" in April 2026 → March 2025
    const result = parseTemporalReference("last March", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.startMs).getUTCFullYear()).toBe(2025);
    expect(new Date(result!.startMs).getUTCMonth()).toBe(2);
  });

  it("returns null for non-temporal query", () => {
    expect(parseTemporalReference("how do I configure the MCP server", now)).toBeNull();
  });

  it("parses bare ISO date", () => {
    const result = parseTemporalReference("2026-03-14", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.startMs).getUTCFullYear()).toBe(2026);
    expect(new Date(result!.startMs).getUTCMonth()).toBe(2);
    expect(new Date(result!.startMs).getUTCDate()).toBe(14);
  });

  it("parses 'last Tuesday' correctly", () => {
    // April 1, 2026 is Wednesday. Last Tuesday = March 31.
    const result = parseTemporalReference("last Tuesday", now);
    expect(result).not.toBeNull();
    expect(new Date(result!.startMs).getUTCDate()).toBe(31);
    expect(new Date(result!.startMs).getUTCMonth()).toBe(2);
  });

  it("handles empty string", () => {
    expect(parseTemporalReference("", now)).toBeNull();
  });

  it("handles whitespace-only string", () => {
    expect(parseTemporalReference("   ", now)).toBeNull();
  });

  it("handles 'ten days ago'", () => {
    const result = parseTemporalReference("ten days ago", now);
    expect(result).not.toBeNull();
  });
});

describe("diversity filter edge cases", () => {
  it("handles empty candidates", () => {
    expect(diversityFilter([], 5)).toHaveLength(0);
  });

  it("handles limit 0", () => {
    const scored = [scoreRecallCandidate(candidate(), { now, query: "test" })];
    expect(diversityFilter(scored, 0)).toHaveLength(0);
  });

  it("handles single candidate", () => {
    const scored = [scoreRecallCandidate(candidate(), { now, query: "test" })];
    expect(diversityFilter(scored, 5)).toHaveLength(1);
  });

  it("handles limit larger than candidates", () => {
    const scored = [
      scoreRecallCandidate(candidate({ memoryId: "a" }), { now, query: "test" }),
      scoreRecallCandidate(candidate({ memoryId: "b", title: "Different" }), { now, query: "test" }),
    ];
    expect(diversityFilter(scored, 10)).toHaveLength(2);
  });
});

describe("text similarity edge cases", () => {
  it("returns 1 for two empty strings", () => {
    expect(textSimilarity({ title: "", content: "" }, { title: "", content: "" })).toBe(1);
  });

  it("returns 1 for identical single-word strings", () => {
    // Single words produce unigram tokens (< 2 tokens = no bigrams, fallback to tokens)
    const sim = textSimilarity({ title: "hello", content: "" }, { title: "hello", content: "" });
    expect(sim).toBe(1);
  });

  it("returns 0 for completely different text", () => {
    const sim = textSimilarity(
      { title: "apples oranges bananas grapes", content: "" },
      { title: "terraform kubernetes docker ansible", content: "" }
    );
    expect(sim).toBe(0);
  });
});
