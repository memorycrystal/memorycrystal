import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/organic/ideas": () => import("../organic/ideas"),
};

async function insertMemory(ctx: any, userId: string, now: number) {
  return ctx.db.insert("crystalMemories", {
    userId,
    store: "semantic",
    category: "fact",
    title: `${userId} memory`,
    content: "Owned source memory",
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

async function insertEnsemble(ctx: any, userId: string, memoryId: any, now: number) {
  return ctx.db.insert("organicEnsembles", {
    userId,
    ensembleType: "cluster",
    label: `${userId} ensemble`,
    summary: "Owned source ensemble",
    memberMemoryIds: [memoryId],
    centroidEmbedding: Array.from({ length: 3072 }, () => 0),
    strength: 0.8,
    confidence: 0.9,
    metadata: "{}",
    createdAt: now,
    updatedAt: now,
    archived: false,
  });
}

describe("organic idea ownership", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("rejects source memory ids that do not belong to the idea owner", async () => {
    const now = Date.now();
    const foreignMemoryId = await t.run((ctx) => insertMemory(ctx, "other-user", now));

    await expect(
      t.mutation(internal.crystal.organic.ideas.createIdea, {
        userId: "idea-owner",
        title: "Cross-tenant memory source",
        summary: "Should not be accepted.",
        ideaType: "insight",
        sourceMemoryIds: [foreignMemoryId],
        confidence: 0.8,
        pulseId: "security-test",
      }),
    ).rejects.toThrow(/sourceMemoryIds/);
  });

  it("rejects source ensemble ids that do not belong to the idea owner", async () => {
    const now = Date.now();
    const { ownedMemoryId, foreignEnsembleId } = await t.run(async (ctx) => {
      const ownedMemoryId = await insertMemory(ctx, "idea-owner", now);
      const foreignMemoryId = await insertMemory(ctx, "other-user", now + 1);
      const foreignEnsembleId = await insertEnsemble(ctx, "other-user", foreignMemoryId, now + 2);
      return { ownedMemoryId, foreignEnsembleId };
    });

    await expect(
      t.mutation(internal.crystal.organic.ideas.createIdea, {
        userId: "idea-owner",
        title: "Cross-tenant ensemble source",
        summary: "Should not be accepted.",
        ideaType: "insight",
        sourceMemoryIds: [ownedMemoryId],
        sourceEnsembleIds: [foreignEnsembleId],
        confidence: 0.8,
        pulseId: "security-test",
      }),
    ).rejects.toThrow(/sourceEnsembleIds/);
  });
});
