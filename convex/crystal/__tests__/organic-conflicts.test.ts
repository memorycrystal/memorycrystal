import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { runOrganicCoreProcessorsInTickOrder } from "../organic/tick";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/contentScanner": () => import("../contentScanner"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/organic/contradictions": () => import("../organic/contradictions"),
  "crystal/organic/conflicts": () => import("../organic/conflicts"),
};

const user = { subject: "conflict_user", tokenIdentifier: "token_conflict", issuer: "test" };

async function insertMemory(ctx: any, title: string, content: string, now: number) {
  return ctx.db.insert("crystalMemories", {
    userId: user.subject,
    store: "semantic",
    category: "fact",
    title,
    content,
    embedding: Array.from({ length: 3072 }, () => 0),
    strength: 0.8,
    confidence: 0.9,
    valence: 0,
    arousal: 0.2,
    accessCount: 0,
    lastAccessedAt: now,
    createdAt: now,
    source: "conversation",
    tags: [],
    archived: false,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("organic conflict inbox", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("lists only unresolved conflict groups by default and records status changes", async () => {
    const now = Date.now();
    const { ensembleId, pairKey, unrelatedPairKey } = await t.run(async (ctx) => {
      const firstId = await insertMemory(ctx, "Old budget", "Budget is $50K.", now);
      const secondId = await insertMemory(ctx, "New budget", "Budget is $75K.", now + 1);
      const thirdId = await insertMemory(ctx, "Different budget", "Budget is $90K.", now + 2);
      const pairKey = `${firstId}::${secondId}`;
      const unrelatedPairKey = `${firstId}::${thirdId}`;
      await ctx.db.insert("organicProspectiveTraces", {
        userId: user.subject,
        createdAt: now,
        tickId: "write-contradiction-test",
        predictedQuery: "Budget contradiction",
        predictedContext: "Budget memories disagree.",
        traceType: "contradiction",
        confidence: 0.91,
        expiresAt: now + 60_000,
        validated: null,
        sourceMemoryIds: [firstId, secondId],
        sourcePattern: `pair:${pairKey} Detected factual contradiction during memory write`,
        accessCount: 0,
        usefulness: 0,
      });
      await ctx.db.insert("organicProspectiveTraces", {
        userId: user.subject,
        createdAt: now,
        tickId: "write-contradiction-other-test",
        predictedQuery: "Different budget contradiction",
        predictedContext: "Another budget memory disagrees.",
        traceType: "contradiction",
        confidence: 0.89,
        expiresAt: now + 60_000,
        validated: null,
        sourceMemoryIds: [firstId, thirdId],
        sourcePattern: `pair:${unrelatedPairKey} Detected factual contradiction during memory write`,
        accessCount: 0,
        usefulness: 0,
      });
      const ensembleId = await ctx.db.insert("organicEnsembles", {
        userId: user.subject,
        ensembleType: "conflict_group",
        label: "Conflict: Old budget vs New budget",
        summary: "Budget memories disagree.",
        memberMemoryIds: [firstId, secondId],
        centroidEmbedding: Array.from({ length: 3072 }, () => 0),
        strength: 0.9,
        confidence: 0.92,
        metadata: JSON.stringify({
          version: 1,
          kind: "contradiction",
          pairKey,
          status: "unresolved",
          explanation: "Budget memories disagree.",
          detectedBy: "write",
          detectedAt: now,
        }),
        createdAt: now,
        updatedAt: now,
        archived: false,
      });
      return { ensembleId, pairKey, unrelatedPairKey };
    });

    const initial = await t.withIdentity(user).query(api.crystal.organic.conflicts.listMyConflictGroups, {});
    expect(initial).toHaveLength(1);
    expect(initial[0].metadata.status).toBe("unresolved");
    expect(initial[0].memberMemories).toHaveLength(2);

    await t.withIdentity(user).mutation(api.crystal.organic.conflicts.updateConflictStatus, {
      ensembleId,
      action: "dismissed",
      note: "Old project budget is no longer relevant.",
    });

    const defaultList = await t.withIdentity(user).query(api.crystal.organic.conflicts.listMyConflictGroups, {});
    expect(defaultList).toHaveLength(0);

    const fullList = await t.withIdentity(user).query(api.crystal.organic.conflicts.listMyConflictGroups, {
      includeResolved: true,
    });
    expect(fullList).toHaveLength(1);
    expect(fullList[0].metadata).toMatchObject({
      status: "dismissed",
      resolvedByAction: "dismissed",
      resolutionNote: "Old project budget is no longer relevant.",
    });

    const traces = await t.run(async (ctx) => {
      return (ctx.db as any)
        .query("organicProspectiveTraces")
        .withIndex("by_user_type", (q: any) => q.eq("userId", user.subject).eq("traceType", "contradiction"))
        .collect();
    });
    expect(traces).toHaveLength(2);
    const invalidatedTrace = traces.find((trace: any) => trace.sourcePattern.includes(pairKey));
    const stillActiveTrace = traces.find((trace: any) => trace.sourcePattern.includes(unrelatedPairKey));
    expect(invalidatedTrace?.validated).toBe(false);
    expect(invalidatedTrace?.sourcePattern).toContain(pairKey);
    expect(invalidatedTrace?.validatedAt).toEqual(expect.any(Number));
    expect(stillActiveTrace?.validated).toBeNull();
    expect(stillActiveTrace?.sourcePattern).toContain(unrelatedPairKey);
  });

  it("filters member memories that do not belong to the conflict owner", async () => {
    const now = Date.now();
    const ensembleId = await t.run(async (ctx) => {
      const ownedId = await insertMemory(ctx, "Owned", "Owned memory", now);
      const foreignId = await ctx.db.insert("crystalMemories", {
        userId: "other_user",
        store: "semantic",
        category: "fact",
        title: "Foreign",
        content: "Foreign memory",
        embedding: Array.from({ length: 3072 }, () => 0),
        strength: 0.8,
        confidence: 0.9,
        valence: 0,
        arousal: 0.2,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: "conversation",
        tags: [],
        archived: false,
      });
      return ctx.db.insert("organicEnsembles", {
        userId: user.subject,
        ensembleType: "conflict_group",
        label: "Mixed owner conflict",
        summary: "Mixed owner conflict",
        memberMemoryIds: [ownedId, foreignId],
        centroidEmbedding: Array.from({ length: 3072 }, () => 0),
        strength: 0.9,
        confidence: 0.92,
        metadata: JSON.stringify({ version: 1, kind: "contradiction", pairKey: "owned::foreign", status: "unresolved" }),
        createdAt: now,
        updatedAt: now,
        archived: false,
      });
    });

    const detail = await t.withIdentity(user).query(api.crystal.organic.conflicts.getMyConflictGroupDetail, {
      ensembleId,
    });
    expect(detail?.memberMemories).toHaveLength(1);
    expect(detail?.memberMemories[0].title).toBe("Owned");
  });

  it("treats recently resolved conflict pairs as active cooldown gates", async () => {
    const now = Date.now();
    const { pairKey } = await t.run(async (ctx) => {
      const firstId = await insertMemory(ctx, "Old budget", "Budget is $50K.", now);
      const secondId = await insertMemory(ctx, "New budget", "Budget is $75K.", now + 1);
      const pairKey = `${firstId}::${secondId}`;
      await ctx.db.insert("organicEnsembles", {
        userId: user.subject,
        ensembleType: "conflict_group",
        label: "Conflict: Old budget vs New budget",
        summary: "Budget memories disagree.",
        memberMemoryIds: [firstId, secondId],
        centroidEmbedding: Array.from({ length: 3072 }, () => 0),
        strength: 0.9,
        confidence: 0.92,
        metadata: JSON.stringify({
          version: 1,
          kind: "contradiction",
          pairKey,
          status: "dismissed",
          explanation: "Budget memories disagree.",
          detectedBy: "write",
          detectedAt: now,
          resolvedAt: now,
        }),
        createdAt: now,
        updatedAt: now,
        archived: false,
      });
      return { pairKey };
    });

    const existing = await t.query(internal.crystal.organic.contradictions.getActiveConflictForPair, {
      userId: user.subject,
      pairKey,
    });

    expect(existing?.label).toBe("Conflict: Old budget vs New budget");
  });

  it("starts contradiction scanning only after ensemble processing settles", async () => {
    const ensembleDone = deferred<string>();
    const events: string[] = [];

    const run = runOrganicCoreProcessorsInTickOrder({
      ensemble: async () => {
        events.push("ensemble:start");
        const result = await ensembleDone.promise;
        events.push("ensemble:end");
        return result;
      },
      contradiction: async () => {
        events.push("contradiction:start");
        return events.includes("ensemble:end") ? "saw-ensemble" : "missed-ensemble";
      },
      resonance: async () => {
        events.push("resonance:start");
        return "resonance";
      },
      procedural: async () => {
        events.push("procedural:start");
        return "procedural";
      },
    });

    await Promise.resolve();
    expect(events).toEqual(["ensemble:start", "resonance:start", "procedural:start"]);

    ensembleDone.resolve("ensemble");
    const [ensembleResult, contradictionResult, resonanceResult, proceduralResult] = await run;

    expect(ensembleResult).toMatchObject({ status: "fulfilled", value: "ensemble" });
    expect(contradictionResult).toMatchObject({ status: "fulfilled", value: "saw-ensemble" });
    expect(resonanceResult).toMatchObject({ status: "fulfilled", value: "resonance" });
    expect(proceduralResult).toMatchObject({ status: "fulfilled", value: "procedural" });
    expect(events).toEqual([
      "ensemble:start",
      "resonance:start",
      "procedural:start",
      "ensemble:end",
      "contradiction:start",
    ]);
  });
});
