import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/evalStats": () => import("../evalStats"),
  "crystal/auth": () => import("../auth"),
};

describe("eval stats recall telemetry", () => {
  it("excludes zero-access memories from top recalled while preserving never-recalled", async () => {
    const t = convexTest(schema, modules);
    const user = { subject: "telemetry-user|session", tokenIdentifier: "token", issuer: "test" } as any;

    await t.run(async (ctx) => {
      const now = Date.now();
      for (const memory of [
        { title: "Never recalled", accessCount: 0, createdAt: now - 10 },
        { title: "Recalled once", accessCount: 1, createdAt: now - 20 },
        { title: "Recalled often", accessCount: 4, createdAt: now - 30 },
      ]) {
        await ctx.db.insert("crystalMemories", {
          userId: "telemetry-user",
          title: memory.title,
          content: memory.title,
          store: "semantic",
          category: "fact",
          tags: [],
          source: "conversation",
          strength: 0.8,
          confidence: 0.9,
          valence: 0,
          arousal: 0,
          accessCount: memory.accessCount,
          lastAccessedAt: memory.createdAt,
          createdAt: memory.createdAt,
          archived: false,
          embedding: [],
        });
      }
    });

    const top = await t.withIdentity(user).query(api.crystal.evalStats.getTopRecalledMemories, { limit: 10 }) as Array<{ title: string }>;
    const never = await t.withIdentity(user).query(api.crystal.evalStats.getNeverRecalledMemories, { limit: 10 }) as Array<{ title: string }>;

    expect(top.map((row) => row.title)).toEqual(["Recalled often", "Recalled once"]);
    expect(never.map((row) => row.title)).toEqual(["Never recalled"]);
  });

  it("summarizes LTM extraction telemetry for attempts, inserts, skips, and caps", async () => {
    const t = convexTest(schema, modules);
    const user = { subject: "telemetry-user|session", tokenIdentifier: "token", issuer: "test" } as any;
    const now = Date.now();

    await t.run(async (ctx) => {
      for (let index = 0; index < 600; index += 1) {
        await ctx.db.insert("crystalTelemetry", {
          userId: "telemetry-user",
          kind: "ltm_extraction",
          payload: JSON.stringify({ status: "inserted", inserted: 99 }),
          createdAt: now - 3 * 60 * 60 * 1000 - index,
        });
      }
      for (const payload of [
        { status: "attempted", scanned: 4 },
        { status: "inserted", inserted: 2, scanned: 4 },
        { status: "skipped_low_signal", skipped: 1, scanned: 2 },
        { status: "skipped_cap", skipped: 1 },
        { status: "error", errors: 2, scanned: 1 },
      ]) {
        await ctx.db.insert("crystalTelemetry", {
          userId: "telemetry-user",
          kind: "ltm_extraction",
          payload: JSON.stringify(payload),
          createdAt: now,
        });
      }
    });

    const stats = await t.withIdentity(user).query(api.crystal.evalStats.getLtmExtractionStats, { hours: 2 }) as {
      attempts: number;
      memoriesInserted: number;
      messagesScanned: number;
      skippedLowSignal: number;
      skippedCap: number;
      errors: number;
    };

    expect(stats.attempts).toBe(1);
    expect(stats.memoriesInserted).toBe(2);
    expect(stats.messagesScanned).toBe(11);
    expect(stats.skippedLowSignal).toBe(1);
    expect(stats.skippedCap).toBe(1);
    expect(stats.errors).toBe(2);
  });
});
