import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { requestEmbedding } from "./stmEmbedder";

const LOCAL_BACKEND_FLAG = "local";
const FIXTURE_EMBEDDING_DIMENSIONS = 3072;
const DEFAULT_SEED_USER_ID = "local-convex-seed-user";
const DEFAULT_SEED_CHANNEL = "local-convex-seed";
const SEED_TAG = "local-seed";

export const logDryRunEmail = internalMutation({
  args: {
    to: v.string(),
    subject: v.string(),
    body: v.string(),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("crystalDryRunEmails", {
      to: args.to,
      subject: args.subject,
      body: args.body,
      createdAt: args.createdAt ?? Date.now(),
    });
  },
});

const hydrateSeedCanaryResultsRef = makeFunctionReference<"query">("crystal/seed:hydrateSeedCanaryResults");

const memoryStore = v.union(
  v.literal("sensory"),
  v.literal("episodic"),
  v.literal("semantic"),
  v.literal("procedural"),
  v.literal("prospective")
);

const memoryCategory = v.union(
  v.literal("decision"),
  v.literal("lesson"),
  v.literal("person"),
  v.literal("rule"),
  v.literal("event"),
  v.literal("fact"),
  v.literal("goal"),
  v.literal("skill"),
  v.literal("workflow"),
  v.literal("conversation")
);

const memorySource = v.union(
  v.literal("conversation"),
  v.literal("cron"),
  v.literal("observation"),
  v.literal("inference"),
  v.literal("external")
);

const graphNodeType = v.union(
  v.literal("person"),
  v.literal("project"),
  v.literal("goal"),
  v.literal("decision"),
  v.literal("concept"),
  v.literal("tool"),
  v.literal("event"),
  v.literal("resource"),
  v.literal("channel")
);

const graphRelationType = v.union(
  v.literal("mentions"),
  v.literal("decided_in"),
  v.literal("leads_to"),
  v.literal("depends_on"),
  v.literal("owns"),
  v.literal("uses"),
  v.literal("conflicts_with"),
  v.literal("supports"),
  v.literal("occurs_with"),
  v.literal("assigned_to")
);

const graphLinkRole = v.union(v.literal("subject"), v.literal("object"), v.literal("topic"));

const seededMemoryInput = v.object({
  key: v.string(),
  store: memoryStore,
  category: memoryCategory,
  title: v.string(),
  content: v.string(),
  metadata: v.optional(v.string()),
  embedding: v.union(v.array(v.float64()), v.literal("REGENERATE")),
  strength: v.optional(v.float64()),
  confidence: v.optional(v.float64()),
  valence: v.optional(v.float64()),
  arousal: v.optional(v.float64()),
  source: v.optional(memorySource),
  tags: v.optional(v.array(v.string())),
});

const seededMessageInput = v.object({
  key: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
  content: v.string(),
  metadata: v.optional(v.string()),
  embedding: v.optional(v.array(v.float64())),
});

const seededNodeInput = v.object({
  key: v.string(),
  label: v.string(),
  nodeType: graphNodeType,
  alias: v.optional(v.array(v.string())),
  canonicalKey: v.string(),
  description: v.string(),
  strength: v.optional(v.float64()),
  confidence: v.optional(v.float64()),
  tags: v.optional(v.array(v.string())),
  metadata: v.optional(v.string()),
  sourceMemoryKeys: v.optional(v.array(v.string())),
});

const seededRelationInput = v.object({
  key: v.string(),
  fromNodeKey: v.string(),
  toNodeKey: v.string(),
  relationType: graphRelationType,
  weight: v.optional(v.float64()),
  evidenceMemoryKeys: v.optional(v.array(v.string())),
  channels: v.optional(v.array(v.string())),
  proofNote: v.optional(v.string()),
  confidence: v.optional(v.float64()),
  confidenceReason: v.optional(v.string()),
});

const seededMemoryNodeLinkInput = v.object({
  memoryKey: v.string(),
  nodeKey: v.string(),
  role: graphLinkRole,
  linkConfidence: v.optional(v.float64()),
});

const fixtureInput = v.object({
  fixtureVersion: v.string(),
  userId: v.optional(v.string()),
  channel: v.optional(v.string()),
  session: v.optional(v.object({
    key: v.string(),
    summary: v.optional(v.string()),
    participants: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
  })),
  memories: v.array(seededMemoryInput),
  messages: v.optional(v.array(seededMessageInput)),
  checkpoint: v.optional(v.object({
    label: v.string(),
    description: v.optional(v.string()),
    createdBy: v.optional(v.string()),
    memoryKeys: v.array(v.string()),
    semanticSummary: v.string(),
    tags: v.optional(v.array(v.string())),
  })),
  nodes: v.optional(v.array(seededNodeInput)),
  relations: v.optional(v.array(seededRelationInput)),
  memoryNodeLinks: v.optional(v.array(seededMemoryNodeLinkInput)),
});

function assertLocalDeployment(operation: string) {
  if (process.env.CRYSTAL_BACKEND !== LOCAL_BACKEND_FLAG) {
    throw new Error(`${operation} refused: deployment is not marked CRYSTAL_BACKEND=local`);
  }
}

function assertEmbedding(embedding: number[] | "REGENERATE", key: string): number[] {
  if (embedding === "REGENERATE") {
    throw new Error(`Fixture memory ${key} still has embedding=REGENERATE; run scripts/convex-local-seed.ts so it can generate the embedding first`);
  }
  if (embedding.length !== FIXTURE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Fixture memory ${key} embedding has ${embedding.length} dimensions; expected ${FIXTURE_EMBEDDING_DIMENSIONS}`
    );
  }
  return embedding;
}

function requireMappedId<T>(map: Map<string, T>, key: string, kind: string): T {
  const value = map.get(key);
  if (!value) throw new Error(`Unknown ${kind} fixture key: ${key}`);
  return value;
}

async function deleteAllForSeedUser(ctx: any, userId: string) {
  const [links, relations, associations, nodes, checkpoints, messages, sessions, memories] = await Promise.all([
    ctx.db.query("crystalMemoryNodeLinks").withIndex("by_user", (q: any) => q.eq("userId", userId)).collect(),
    ctx.db.query("crystalRelations").withIndex("by_user", (q: any) => q.eq("userId", userId)).collect(),
    ctx.db.query("crystalAssociations").withIndex("by_user", (q: any) => q.eq("userId", userId)).collect(),
    ctx.db.query("crystalNodes").withIndex("by_user", (q: any) => q.eq("userId", userId)).collect(),
    ctx.db.query("crystalCheckpoints").withIndex("by_user", (q: any) => q.eq("userId", userId)).collect(),
    ctx.db.query("crystalMessages").withIndex("by_user_time", (q: any) => q.eq("userId", userId)).collect(),
    ctx.db.query("crystalSessions").withIndex("by_user", (q: any) => q.eq("userId", userId)).collect(),
    ctx.db.query("crystalMemories").withIndex("by_user", (q: any) => q.eq("userId", userId).eq("archived", false)).collect(),
  ]);

  for (const row of [...links, ...relations, ...associations, ...nodes, ...checkpoints, ...messages, ...sessions, ...memories]) {
    await ctx.db.delete(row._id);
  }
}

export const embedFixtureContent = action({
  args: { content: v.string() },
  handler: async (_ctx, args): Promise<number[]> => {
    assertLocalDeployment("embedFixtureContent");
    const embedding = await requestEmbedding(args.content);
    if (!embedding) throw new Error("Gemini embedding response did not include a vector");
    return embedding;
  },
});

export const insertFixture = mutation({
  args: { fixture: fixtureInput, replaceExisting: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    assertLocalDeployment("insertFixture");

    const userId = args.fixture.userId ?? DEFAULT_SEED_USER_ID;
    const channel = args.fixture.channel ?? DEFAULT_SEED_CHANNEL;
    const now = Date.now();

    if (args.replaceExisting ?? true) {
      await deleteAllForSeedUser(ctx, userId);
    }

    const sessionId = args.fixture.session
      ? await ctx.db.insert("crystalSessions", {
          userId,
          channel,
          channelId: args.fixture.session.key,
          startedAt: now,
          lastActiveAt: now,
          messageCount: args.fixture.messages?.length ?? 0,
          memoryCount: args.fixture.memories.length,
          summary: args.fixture.session.summary,
          participants: args.fixture.session.participants ?? ["local-seed", "assistant"],
          model: args.fixture.session.model ?? "local-fixture",
        })
      : undefined;

    const memoryIds = new Map<string, any>();
    for (const memory of args.fixture.memories) {
      const tags = Array.from(new Set([...(memory.tags ?? []), SEED_TAG]));
      const memoryId = await ctx.db.insert("crystalMemories", {
        userId,
        store: memory.store,
        category: memory.category,
        title: memory.title,
        content: memory.content,
        metadata: memory.metadata,
        embedding: assertEmbedding(memory.embedding, memory.key),
        strength: memory.strength ?? 0.85,
        confidence: memory.confidence ?? 0.9,
        valence: memory.valence ?? 0,
        arousal: memory.arousal ?? 0.25,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: memory.source ?? "external",
        sessionId,
        channel,
        tags,
        archived: false,
        graphEnriched: false,
      });
      memoryIds.set(memory.key, memoryId);
    }

    for (const message of args.fixture.messages ?? []) {
      if (message.embedding && message.embedding.length !== FIXTURE_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Fixture message ${message.key} embedding has ${message.embedding.length} dimensions; expected ${FIXTURE_EMBEDDING_DIMENSIONS}`
        );
      }
      await ctx.db.insert("crystalMessages", {
        userId,
        role: message.role,
        content: message.content,
        channel,
        sessionKey: args.fixture.session?.key,
        turnId: message.key,
        timestamp: now,
        embedding: message.embedding,
        embedded: Boolean(message.embedding),
        expiresAt: now + 1000 * 60 * 60 * 24 * 30,
        metadata: message.metadata,
      });
    }

    let checkpointId: any = undefined;
    if (args.fixture.checkpoint) {
      checkpointId = await ctx.db.insert("crystalCheckpoints", {
        userId,
        label: args.fixture.checkpoint.label,
        description: args.fixture.checkpoint.description,
        createdAt: now,
        createdBy: args.fixture.checkpoint.createdBy ?? "local-seed",
        sessionId,
        memorySnapshot: args.fixture.checkpoint.memoryKeys.map((key) => {
          const memoryId = requireMappedId(memoryIds, key, "memory");
          const memory = args.fixture.memories.find((entry) => entry.key === key);
          if (!memory) throw new Error(`Unknown checkpoint memory key: ${key}`);
          return {
            memoryId,
            strength: memory.strength ?? 0.85,
            content: memory.content,
            store: memory.store,
          };
        }),
        semanticSummary: args.fixture.checkpoint.semanticSummary,
        tags: Array.from(new Set([...(args.fixture.checkpoint.tags ?? []), SEED_TAG])),
      });
      for (const memoryId of memoryIds.values()) {
        await ctx.db.patch(memoryId, { checkpointId });
      }
      if (sessionId) await ctx.db.patch(sessionId, { checkpointId });
    }

    const nodeIds = new Map<string, any>();
    for (const node of args.fixture.nodes ?? []) {
      const nodeId = await ctx.db.insert("crystalNodes", {
        userId,
        label: node.label,
        nodeType: node.nodeType,
        alias: node.alias ?? [],
        canonicalKey: node.canonicalKey,
        description: node.description,
        strength: node.strength ?? 0.8,
        confidence: node.confidence ?? 0.85,
        tags: Array.from(new Set([...(node.tags ?? []), SEED_TAG])),
        metadata: node.metadata,
        createdAt: now,
        updatedAt: now,
        sourceMemoryIds: (node.sourceMemoryKeys ?? []).map((key) => requireMappedId(memoryIds, key, "memory")),
        status: "active",
      });
      nodeIds.set(node.key, nodeId);
    }

    for (const relation of args.fixture.relations ?? []) {
      await ctx.db.insert("crystalRelations", {
        userId,
        fromNodeId: requireMappedId(nodeIds, relation.fromNodeKey, "node"),
        toNodeId: requireMappedId(nodeIds, relation.toNodeKey, "node"),
        relationType: relation.relationType,
        weight: relation.weight ?? 0.75,
        evidenceMemoryIds: (relation.evidenceMemoryKeys ?? []).map((key) => requireMappedId(memoryIds, key, "memory")),
        channels: relation.channels ?? [channel],
        proofNote: relation.proofNote,
        confidence: relation.confidence ?? 0.8,
        confidenceReason: relation.confidenceReason,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const link of args.fixture.memoryNodeLinks ?? []) {
      await ctx.db.insert("crystalMemoryNodeLinks", {
        userId,
        memoryId: requireMappedId(memoryIds, link.memoryKey, "memory"),
        nodeId: requireMappedId(nodeIds, link.nodeKey, "node"),
        role: link.role,
        linkConfidence: link.linkConfidence ?? 0.8,
        createdAt: now,
      });
    }

    return {
      userId,
      channel,
      sessionId,
      checkpointId,
      memoryIds: Object.fromEntries(memoryIds),
      counts: {
        memories: memoryIds.size,
        messages: args.fixture.messages?.length ?? 0,
        checkpoints: checkpointId ? 1 : 0,
        nodes: nodeIds.size,
        relations: args.fixture.relations?.length ?? 0,
        memoryNodeLinks: args.fixture.memoryNodeLinks?.length ?? 0,
      },
    };
  },
});

export const seedStatus = query({
  args: {
    userId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.userId ?? DEFAULT_SEED_USER_ID;
    const channel = args.channel ?? DEFAULT_SEED_CHANNEL;
    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", false))
      .collect();
    const channelMemories = memories.filter((memory) => memory.channel === channel);
    return {
      backendMode: process.env.CRYSTAL_BACKEND === LOCAL_BACKEND_FLAG ? "local" : "cloud",
      userId,
      channel,
      memories: channelMemories.length,
      embeddedMemories: channelMemories.filter((memory) => memory.embedding.length === FIXTURE_EMBEDDING_DIMENSIONS).length,
    };
  },
});


export const hydrateSeedCanaryResults = internalQuery({
  args: {
    ids: v.array(v.string()),
    scores: v.array(v.float64()),
    channel: v.string(),
    query: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = [];
    for (let index = 0; index < args.ids.length; index += 1) {
      const memory = await ctx.db.get(args.ids[index] as any);
      if (memory && (memory as any).channel === args.channel) {
        rows.push({
          memoryId: String(memory._id),
          title: (memory as any).title,
          score: args.scores[index] ?? 0,
          query: args.query,
        });
      }
    }
    return rows;
  },
});

export const vectorDivergenceCanary = action({
  args: {
    embedding: v.array(v.float64()),
    query: v.optional(v.string()),
    userId: v.optional(v.string()),
    channel: v.optional(v.string()),
    minScore: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    assertLocalDeployment("vectorDivergenceCanary");
    if (args.embedding.length !== FIXTURE_EMBEDDING_DIMENSIONS) {
      throw new Error(`Canary embedding has ${args.embedding.length} dimensions; expected ${FIXTURE_EMBEDDING_DIMENSIONS}`);
    }
    const userId = args.userId ?? DEFAULT_SEED_USER_ID;
    const channel = args.channel ?? DEFAULT_SEED_CHANNEL;
    const minScore = args.minScore ?? 0.6;
    const vectorResults = await ctx.vectorSearch("crystalMemories", "by_embedding", {
      vector: args.embedding,
      limit: 5,
      filter: (q: any) => q.eq("userId", userId).eq("archived", false),
    }) as Array<{ _id: string; _score: number }>;

    const hydrated = await ctx.runQuery(hydrateSeedCanaryResultsRef, {
      ids: vectorResults.map((result) => String(result._id)),
      scores: vectorResults.map((result) => result._score),
      channel,
      query: args.query,
    });

    return {
      ok: hydrated.some((result: { score: number }) => result.score >= minScore),
      minScore,
      results: hydrated,
    };
  },
});
