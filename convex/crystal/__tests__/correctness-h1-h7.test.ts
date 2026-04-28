import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { readFileSync } from "fs";
import { join } from "path";
import schema from "../../schema";
import { internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/organic/ideaDigest": () => import("../organic/ideaDigest"),
};

describe("H-1: digest lease isolation", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("acquires a digest lease even when no organic tick state rows exist", async () => {
    const firstLease = await t.mutation(
      internal.crystal.organic.ideaDigest.acquireDigestLease,
      {}
    );

    expect(firstLease.acquired).toBe(true);

    const secondLease = await t.mutation(
      internal.crystal.organic.ideaDigest.acquireDigestLease,
      {}
    );

    expect(secondLease.acquired).toBe(false);

    await t.mutation(internal.crystal.organic.ideaDigest.releaseDigestLease, {});

    const thirdLease = await t.mutation(
      internal.crystal.organic.ideaDigest.acquireDigestLease,
      {}
    );

    expect(thirdLease.acquired).toBe(true);
  });

  it("uses a dedicated digestLease table instead of anchoring on organicTickState", () => {
    const schemaSrc = readFileSync(join(__dirname, "..", "..", "schema.ts"), "utf-8");
    const digestSrc = readFileSync(join(__dirname, "..", "organic", "ideaDigest.ts"), "utf-8");

    expect(schemaSrc).toMatch(/digestLease:\s*defineTable\(/);
    expect(digestSrc).toMatch(/query\("digestLease"\)/);

    const acquireLeaseSource = digestSrc.match(
      /export const acquireDigestLease[\s\S]*?export const releaseDigestLease/
    )?.[0] ?? "";

    expect(acquireLeaseSource).not.toContain('query("organicTickState")');
  });
});

describe("H-7: MCP recall payload deduplication", () => {
  it("returns structured memories without duplicating injectionBlock in the JSON payload", () => {
    const recallSrc = readFileSync(
      join(__dirname, "..", "..", "..", "mcp-server", "src", "tools", "recall.ts"),
      "utf-8"
    );

    expect(recallSrc).toContain("text: injectionBlock");
    expect(recallSrc).toContain("JSON.stringify({ memories }, null, 2)");
    expect(recallSrc).not.toContain("JSON.stringify({ memories, injectionBlock }, null, 2)");
  });
});
