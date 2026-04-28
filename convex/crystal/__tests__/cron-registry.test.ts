import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("cron registry memory creation policy", () => {
  it("does not register scheduled global LTM extraction in normal config", () => {
    const crons = read("convex/crons.ts");

    expect(crons).not.toContain('crons.interval("crystal-ltm-extract"');
    expect(crons).toContain('crons.interval("stmEmbedder"');
    expect(crons).toContain("api.crystal.stmEmbedder.embedUnprocessedMessages");
  });
});

