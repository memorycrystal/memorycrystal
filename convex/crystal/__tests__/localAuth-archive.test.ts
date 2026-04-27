import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

type ApiKeyRow = {
  keyHash: string;
  active: boolean;
  label?: string;
};

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/localAuth": () => import("../localAuth"),
};

describe("upsertLocalInstallerApiKey archives stale rows on rerun (US-10)", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    process.env.CRYSTAL_BACKEND = "local";
    t = convexTest(schema, modules);
  });

  it("flips active=false on prior local installer rows for the same user", async () => {
    const userId = "user-rerun";

    // First installer run: creates row #1.
    await t.mutation(api.crystal.localAuth.upsertLocalInstallerApiKey, {
      userId,
      keyHash: "hash-1",
      now: 1000,
    });
    // Second installer run with a fresh keyHash: archive row #1 + create row #2.
    await t.mutation(api.crystal.localAuth.upsertLocalInstallerApiKey, {
      userId,
      keyHash: "hash-2",
      now: 2000,
    });
    // Third installer run, again with fresh keyHash.
    await t.mutation(api.crystal.localAuth.upsertLocalInstallerApiKey, {
      userId,
      keyHash: "hash-3",
      now: 3000,
    });

    const rows = await t.run(async (ctx) => {
      return await (ctx as any).db
        .query("crystalApiKeys")
        .withIndex("by_user", (q: any) => q.eq("userId", userId))
        .collect();
    }) as ApiKeyRow[];
    const byHash = Object.fromEntries(rows.map((r: ApiKeyRow) => [r.keyHash, r]));

    expect(rows).toHaveLength(3);
    expect(byHash["hash-1"]?.active).toBe(false);
    expect(byHash["hash-2"]?.active).toBe(false);
    expect(byHash["hash-3"]?.active).toBe(true);
    // Sanity: only the latest row should be active for "local installer".
    const activeInstallerRows = rows.filter(
      (r: ApiKeyRow) => r.active && (r.label ?? "") === "local installer",
    );
    expect(activeInstallerRows).toHaveLength(1);
    expect(activeInstallerRows[0].keyHash).toBe("hash-3");
  });

  it("does not archive rows with a different label", async () => {
    const userId = "user-mixed-labels";

    // A non-installer key (e.g. dashboard-issued) for the same user.
    await t.run(async (ctx) => {
      await ctx.db.insert("crystalApiKeys", {
        userId,
        keyHash: "dashboard-hash",
        label: "dashboard-issued",
        createdAt: 500,
        active: true,
      });
    });

    await t.mutation(api.crystal.localAuth.upsertLocalInstallerApiKey, {
      userId,
      keyHash: "installer-1",
      now: 1000,
    });
    await t.mutation(api.crystal.localAuth.upsertLocalInstallerApiKey, {
      userId,
      keyHash: "installer-2",
      now: 2000,
    });

    const rows = await t.run(async (ctx) => {
      return await (ctx as any).db
        .query("crystalApiKeys")
        .withIndex("by_user", (q: any) => q.eq("userId", userId))
        .collect();
    }) as ApiKeyRow[];
    const byHash = Object.fromEntries(rows.map((r: ApiKeyRow) => [r.keyHash, r]));

    expect(byHash["dashboard-hash"].active).toBe(true);
    expect(byHash["installer-1"].active).toBe(false);
    expect(byHash["installer-2"].active).toBe(true);
  });

  it("re-running with the same keyHash patches the existing row, no duplicate", async () => {
    const userId = "user-same-hash";

    await t.mutation(api.crystal.localAuth.upsertLocalInstallerApiKey, {
      userId,
      keyHash: "stable-hash",
      now: 1000,
    });
    await t.mutation(api.crystal.localAuth.upsertLocalInstallerApiKey, {
      userId,
      keyHash: "stable-hash",
      now: 2000,
    });

    const rows = await t.run(async (ctx) => {
      return await (ctx as any).db
        .query("crystalApiKeys")
        .withIndex("by_user", (q: any) => q.eq("userId", userId))
        .collect();
    }) as ApiKeyRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
    expect(rows[0].keyHash).toBe("stable-hash");
  });
});
