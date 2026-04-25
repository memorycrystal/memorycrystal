import { describe, expect, it, vi } from "vitest";
import {
  extractGeminiResponseText,
  parseGeminiJson,
  vectorSearchUserFilter,
} from "../organic/utils";

describe("organic Gemini utilities", () => {
  it("extracts text across multipart Gemini candidates", () => {
    const text = extractGeminiResponseText({
      candidates: [
        {
          content: {
            parts: [
              { text: "```json\n[{\"predictedQuery\":\"alpha\"}]\n```" },
              { text: "\n" },
            ],
          },
        },
      ],
    });

    expect(text).toContain("\"predictedQuery\":\"alpha\"");
  });

  it("parses fenced JSON arrays", () => {
    const parsed = parseGeminiJson<Array<{ predictedQuery: string }>>(
      "```json\n[{\"predictedQuery\":\"alpha\"}]\n```"
    );

    expect(parsed).toEqual([{ predictedQuery: "alpha" }]);
  });

  it("parses JSON embedded inside surrounding prose", () => {
    const parsed = parseGeminiJson<{ label: string; summary: string }>(
      "Here is the result:\n{\"label\":\"Project habits\",\"summary\":\"Patterns around repeated shipping work.\"}\nThanks."
    );

    expect(parsed).toEqual({
      label: "Project habits",
      summary: "Patterns around repeated shipping work.",
    });
  });

  it("uses only the runtime-supported user eq filter for vector search", () => {
    const eq = vi.fn().mockReturnValue("filtered");

    const result = vectorSearchUserFilter("user_123")({ eq } as never);

    expect(eq).toHaveBeenCalledWith("userId", "user_123");
    expect(result).toBe("filtered");
  });
});
