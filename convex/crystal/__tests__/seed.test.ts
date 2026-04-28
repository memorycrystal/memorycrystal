import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "../../schema";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/seed": () => import("../seed"),
  "crystal/stmEmbedder": () => import("../stmEmbedder"),
};

const insertFixtureRef = makeFunctionReference<"mutation">("crystal/seed:insertFixture");
const seedStatusRef = makeFunctionReference<"query">("crystal/seed:seedStatus");

const embedding = (offset = 0) => Array.from({ length: 3072 }, (_, index) => Number(((index + offset) / 1_000_000).toFixed(6)));

const fixture = {
  fixtureVersion: "test-seed-v1",
  userId: "local-convex-seed-test-user",
  channel: "local-convex-seed-test",
  session: {
    key: "test-session",
    summary: "Local seed test session",
    participants: ["tester", "assistant"],
  },
  memories: [
    {
      key: "memory-crystal-onboarding",
      store: "semantic" as const,
      category: "fact" as const,
      title: "Memory Crystal onboarding",
      content: "Memory Crystal local Convex onboarding should be vector searchable.",
      embedding: embedding(1),
      tags: ["onboarding"],
    },
    {
      key: "local-doctor",
      store: "procedural" as const,
      category: "workflow" as const,
      title: "Run local doctor",
      content: "The local doctor validates seed status before integration tests.",
      embedding: embedding(2),
      tags: ["doctor"],
    },
  ],
  messages: [
    {
      key: "message-1",
      role: "user" as const,
      content: "How do I test local Convex seeding?",
    },
  ],
  checkpoint: {
    label: "Seed test checkpoint",
    memoryKeys: ["memory-crystal-onboarding", "local-doctor"],
    semanticSummary: "Seed test checkpoint summary",
    tags: ["test"],
  },
  nodes: [
    {
      key: "node-local-convex",
      label: "Local Convex",
      nodeType: "resource" as const,
      canonicalKey: "environment:local-convex-test",
      description: "Local Convex seed test node",
      sourceMemoryKeys: ["memory-crystal-onboarding"],
    },
  ],
  memoryNodeLinks: [
    {
      memoryKey: "memory-crystal-onboarding",
      nodeKey: "node-local-convex",
      role: "topic" as const,
    },
  ],
};

describe("local Convex seed fixture mutation", () => {
  let t: ReturnType<typeof convexTest>;
  const originalBackend = process.env.CRYSTAL_BACKEND;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.CRYSTAL_BACKEND;
    else process.env.CRYSTAL_BACKEND = originalBackend;
  });

  it("refuses to seed deployments that are not explicitly marked local", async () => {
    delete process.env.CRYSTAL_BACKEND;

    await expect(
      t.mutation(insertFixtureRef, { fixture, replaceExisting: true })
    ).rejects.toThrow(/CRYSTAL_BACKEND=local/);
  });

  it("inserts fixture memories, messages, checkpoint, and graph links idempotently", async () => {
    process.env.CRYSTAL_BACKEND = "local";

    const first = await t.mutation(insertFixtureRef, { fixture, replaceExisting: true });
    expect(first.counts).toMatchObject({
      memories: 2,
      messages: 1,
      checkpoints: 1,
      nodes: 1,
      memoryNodeLinks: 1,
    });

    const second = await t.mutation(insertFixtureRef, { fixture, replaceExisting: true });
    expect(second.counts.memories).toBe(2);

    const status = await t.query(seedStatusRef, {
      userId: fixture.userId,
      channel: fixture.channel,
    });
    expect(status).toMatchObject({
      backendMode: "local",
      memories: 2,
      embeddedMemories: 2,
    });
  });

  it("rejects malformed fixture embeddings before writing partial data", async () => {
    process.env.CRYSTAL_BACKEND = "local";
    const badFixture = {
      ...fixture,
      memories: [
        {
          ...fixture.memories[0],
          embedding: [0.1, 0.2],
        },
      ],
    };

    await expect(
      t.mutation(insertFixtureRef, { fixture: badFixture, replaceExisting: true })
    ).rejects.toThrow(/expected 3072/);
  });
});
