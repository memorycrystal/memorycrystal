import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/associations": () => import("../associations"),
  "crystal/auth": () => import("../auth"),
  "crystal/knowledgeBases": () => import("../knowledgeBases"),
  "crystal/mcp": () => import("../mcp"),
  "crystal/memories": () => import("../memories"),
  "crystal/recall": () => import("../recall"),
  "crystal/messages": () => import("../messages"),
  "crystal/sessions": () => import("../sessions"),
  "crystal/wake": () => import("../wake"),
  "crystal/graphEnrich": () => import("../graphEnrich"),
  "crystal/geminiGuardrail": () => import("../geminiGuardrail"),
  "crystal/salience": () => import("../salience"),
  "crystal/userProfiles": () => import("./stubs/userProfiles"),
  "crystal/cleanup": () => import("../cleanup"),
  "crystal/decay": () => import("../decay"),
  "crystal/organic/policyTuner": () => import("../organic/policyTuner"),
  "crystal/emailEngine": () => import("./stubs/emailEngine"),
};

const user = {
  subject: "recall-smoke-user",
  tokenIdentifier: "token-recall-smoke-user",
  issuer: "test",
};

const otherUser = {
  subject: "recall-smoke-other-user",
  tokenIdentifier: "token-recall-smoke-other-user",
  issuer: "test",
};

const embeddingForText = (text: string) => {
  let seed = 0;
  for (const char of text) {
    seed = (seed + char.charCodeAt(0)) % 997;
  }
  const base = seed / 1000;
  return Array.from({ length: 3072 }, (_, index) => Number((base + index * 0.000001).toFixed(6)));
};

describe("recall smoke tests", () => {
  let t: ReturnType<typeof convexTest>;

  const insertMemory = async (
    owner: typeof user,
    overrides: Record<string, unknown>,
  ) => {
    const now = Date.now();
    return await t.run(async (ctx) => {
      return await ctx.db.insert("crystalMemories", {
        userId: owner.subject,
        store: "semantic",
        category: "fact",
        title: "Seed memory",
        content: "Seed memory content",
        embedding: embeddingForText(String(overrides.content ?? "Seed memory content")),
        strength: 1,
        confidence: 1,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: "conversation",
        tags: [],
        archived: false,
        ...overrides,
      });
    });
  };

  beforeEach(async () => {
    t = convexTest(schema, modules);
    await t.mutation(internal.crystal.userProfiles.upsertSubscriptionByUserInternal, {
      userId: user.subject,
      subscriptionStatus: "active",
      plan: "starter",
    });
    await t.mutation(internal.crystal.userProfiles.upsertSubscriptionByUserInternal, {
      userId: otherUser.subject,
      subscriptionStatus: "active",
      plan: "starter",
    });
  });

  afterEach(() => {
    // convex-test cleans its own state between tests; no globals/envs to reset here.
  });

  it("semanticSearch still returns visible non-archived hits after batched hydration", async () => {
    const matchingId = await insertMemory(user, {
      title: "Deploy checklist",
      content: "Ship project atlas after QA signoff",
      channel: "discord:memorycrystal",
    });
    await insertMemory(user, {
      title: "Archived deploy checklist",
      content: "Ship project atlas after QA signoff",
      channel: "discord:memorycrystal",
      archived: true,
    });
    await insertMemory(user, {
      title: "Other channel deploy checklist",
      content: "Ship project atlas after QA signoff",
      channel: "discord:other",
    });
    await insertMemory(otherUser, {
      title: "Other user deploy checklist",
      content: "Ship project atlas after QA signoff",
      channel: "discord:memorycrystal",
    });

    const results = await t.action(internal.crystal.mcp.semanticSearch, {
      userId: user.subject,
      queryEmbedding: embeddingForText("ship project atlas after qa signoff"),
      query: "ship project atlas after qa signoff",
      limit: 10,
      channel: "discord:memorycrystal",
    });

    const ids = results.map((memory: { _id: string }) => memory._id);
    expect(ids).toContain(matchingId);
    expect(ids).toHaveLength(1);
  });

  it("recallMemories still expands associated memories when includeAssociations is enabled", async () => {
    const baseMemoryId = await insertMemory(user, {
      title: "Atlas launch plan",
      content: "Ship atlas release tonight after QA passes",
      channel: "discord:memorycrystal",
    });
    const linkedMemoryId = await insertMemory(user, {
      title: "Atlas rollback note",
      content: "Grocery list apples oranges pears",
      channel: "discord:memorycrystal",
    });

    await t.withIdentity(user).mutation(api.crystal.associations.upsertAssociation, {
      fromMemoryId: baseMemoryId,
      toMemoryId: linkedMemoryId,
      relationshipType: "supports",
      weight: 0.9,
    });

    const withoutAssociations = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("ship atlas release tonight after qa passes"),
      limit: 1,
      channel: "discord:memorycrystal",
      includeAssociations: false,
    });
    expect(withoutAssociations.memories.map((memory: { memoryId: string }) => memory.memoryId)).not.toContain(linkedMemoryId);

    const withAssociations = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("ship atlas release tonight after qa passes"),
      limit: 2,
      channel: "discord:memorycrystal",
      includeAssociations: true,
    });
    expect(withAssociations.memories.map((memory: { memoryId: string }) => memory.memoryId)).toContain(baseMemoryId);
    expect(withAssociations.memories.map((memory: { memoryId: string }) => memory.memoryId)).toContain(linkedMemoryId);
  });

  it("recallMemories still honors includeArchived after batched candidate hydration", async () => {
    const archivedMemoryId = await insertMemory(user, {
      title: "Archived Atlas note",
      content: "Old atlas migration checklist",
      channel: "discord:memorycrystal",
      archived: true,
    });

    const hidden = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("old atlas migration checklist"),
      limit: 10,
      channel: "discord:memorycrystal",
      includeArchived: false,
      includeAssociations: false,
    });
    expect(hidden.memories.map((memory: { memoryId: string }) => memory.memoryId)).not.toContain(archivedMemoryId);

    const visible = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("old atlas migration checklist"),
      limit: 10,
      channel: "discord:memorycrystal",
      includeArchived: true,
      includeAssociations: false,
    });
    expect(visible.memories.map((memory: { memoryId: string }) => memory.memoryId)).toContain(archivedMemoryId);
  });
});
