import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression for the channel-filter outage caught in the 15h review (US-8).
// crystalMessages.by_embedding MUST keep `channel` in filterFields, otherwise
// vector recall stops applying the channel filter and bleeds across peers.
describe("crystalMessages.by_embedding filterFields", () => {
  const schemaPath = path.resolve(__dirname, "..", "..", "schema.ts");
  const schemaText = fs.readFileSync(schemaPath, "utf8");

  it("contains channel in filterFields so peer recall can scope by channel", () => {
    // Locate the crystalMessages defineTable block.
    const tableStart = schemaText.indexOf("crystalMessages: defineTable(");
    expect(tableStart, "crystalMessages defineTable block must exist").toBeGreaterThan(-1);

    // Slice from crystalMessages until the next top-level table definition (heuristic:
    // a line ending with ': defineTable(' OR end-of-file). The vectorIndex we care about
    // is the only by_embedding inside this slice.
    const tail = schemaText.slice(tableStart);
    const nextTableMatch = tail.slice(1).search(/\n\s{2}[a-zA-Z_]\w*:\s*defineTable\(/);
    const block = nextTableMatch === -1 ? tail : tail.slice(0, nextTableMatch + 1);

    const vectorIndexMatch = block.match(
      /\.vectorIndex\(\s*"by_embedding"\s*,\s*\{([\s\S]*?)\}\s*\)/,
    );
    expect(
      vectorIndexMatch,
      "crystalMessages must declare a by_embedding vectorIndex",
    ).not.toBeNull();

    const body = vectorIndexMatch![1];
    const filterFieldsMatch = body.match(/filterFields\s*:\s*\[([\s\S]*?)\]/);
    expect(
      filterFieldsMatch,
      "by_embedding must declare filterFields",
    ).not.toBeNull();

    const filterFieldsRaw = filterFieldsMatch![1];
    const filterFields = filterFieldsRaw
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

    expect(filterFields).toContain("channel");
    // Also confirm userId stays in place so no test passes after a regression that
    // accidentally drops both fields.
    expect(filterFields).toContain("userId");
  });
});
