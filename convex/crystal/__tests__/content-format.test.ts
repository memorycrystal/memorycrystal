import { describe, expect, it } from "vitest";

import {
  splitStructuredContent,
  summarizeText,
} from "../../../shared/contentFormat";

describe("dashboard content formatting helpers", () => {
  it("splits only allowlisted pseudo-tags into labeled sections", () => {
    const sections = splitStructuredContent(
      "<recalled_context><user>Hello there</user><assistant>Hi back</assistant></recalled_context>"
    );

    expect(sections).toEqual([
      { kind: "user", label: "User", text: "Hello there" },
      { kind: "assistant", label: "AI", text: "Hi back" },
    ]);
  });

  it("leaves unknown angle-bracket content as plain text", () => {
    const sections = splitStructuredContent("Before <client>Andy</client> after");

    expect(sections).toEqual([
      { kind: "body", label: "Content", text: "Before <client>Andy</client> after" },
    ]);
  });

  it("summarizes previews by removing known tags without mutating unknown text", () => {
    expect(summarizeText("<user>One\n two</user> <client>Andy</client>", 40)).toBe(
      "One two <client>Andy</client>"
    );
  });
});
