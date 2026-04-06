import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
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
  subject: "kb-user",
  tokenIdentifier: "token-kb-user",
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

describe("knowledge bases", () => {
  let t: ReturnType<typeof convexTest>;

  const insertMemory = async (overrides: Record<string, any>) => {
    const now = Date.now();
    return t.run(async (ctx) => {
      return await ctx.db.insert("crystalMemories", {
        userId: user.subject,
        store: "semantic",
        category: "fact",
        title: "Test memory",
        content: "Test memory content",
        embedding: embeddingForText(String(overrides.content ?? "Test memory content")),
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
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    vi.stubEnv("EMBEDDING_PROVIDER", "gemini");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes(":embedContent")) {
        const text = String(body?.content?.parts?.[0]?.text ?? "");
        return new Response(
          JSON.stringify({ embedding: { values: embeddingForText(text) } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes(":generateContent")) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        entities: [
                          {
                            label: "Disrupting Divorce",
                            type: "concept",
                            description: "Knowledge base concept",
                          },
                        ],
                        relations: [],
                        associationHint: null,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("not found", { status: 404 });
    }));

    await t.mutation(internal.crystal.userProfiles.upsertSubscriptionByUserInternal, {
      userId: user.subject,
      subscriptionStatus: "active",
      plan: "starter",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("imports chunks with embeddings and graph enrichment, then recalls them", async () => {
    const knowledgeBaseId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Disrupting Divorce Methodology",
      description: "Reference corpus for the coaching agent",
      sourceType: "course",
      agentIds: ["coach"],
    });

    const importResult = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.batchImportChunks, {
      knowledgeBaseId,
      chunks: [
        {
          content: "Disrupting Divorce methodology stresses calm conflict mapping and structured de-escalation.",
          metadata: { title: "Core lesson", chunkIndex: 0, totalChunks: 1, sourceType: "course" },
        },
      ],
    });

    expect(importResult.importedCount).toBe(1);

    const detail = await t.withIdentity(user).query(api.crystal.knowledgeBases.getKnowledgeBase, {
      knowledgeBaseId,
      limit: 10,
    });

    expect(detail?.memoryCount).toBe(1);
    expect(detail?.totalChars).toBeGreaterThan(20);
    expect(detail?.memories).toHaveLength(1);

    const memoryId = detail?.memories?.[0]?._id;
    expect(memoryId).toBeTruthy();

    const importedMemory = await t.query(internal.crystal.mcp.getMemoryById, {
      memoryId: memoryId!,
    });

    expect(importedMemory?.knowledgeBaseId).toBe(knowledgeBaseId);
    expect(importedMemory?.embedding).toHaveLength(3072);
    expect(importedMemory?.graphEnriched).toBe(true);

    const recall = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("calm conflict mapping"),
      query: "calm conflict mapping",
      channel: "coach:session-1",
      limit: 10,
    });

    expect(recall.memories.some((memory: any) => memory.memoryId === memoryId)).toBe(true);
  });

  it("respects agent scoping during normal recall", async () => {
    const coachKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Coach KB",
      agentIds: ["coach"],
    });
    const cassKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Cass KB",
      agentIds: ["ask-cass"],
    });

    await t.withIdentity(user).action((api as any).crystal.knowledgeBases.batchImportChunks, {
      knowledgeBaseId: coachKb,
      chunks: [{ content: "Coach-only material about mediation scripts." }],
    });
    const cassImport = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.batchImportChunks, {
      knowledgeBaseId: cassKb,
      chunks: [{ content: "Cass-only material about client intake calibration." }],
    });

    const cassMemoryId = cassImport.memoryIds[0];

    const coachRecall = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("client intake calibration"),
      query: "client intake calibration",
      channel: "coach:session-2",
      limit: 10,
    });
    expect(coachRecall.memories.some((memory: any) => memory.memoryId === cassMemoryId)).toBe(false);

    const cassRecall = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("client intake calibration"),
      query: "client intake calibration",
      channel: "ask-cass:session-2",
      limit: 10,
    });
    expect(cassRecall.memories.some((memory: any) => memory.memoryId === cassMemoryId)).toBe(true);
  });

  it("enforces scope walls for recall, direct KB queries, and channel-aware listings", async () => {
    const sharedKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Shared KB",
      agentIds: ["morrow-coach"],
    });
    const danKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Dan KB",
      agentIds: ["morrow-coach"],
      scope: "morrow-coach:12345",
    });
    const jakoKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Jako KB",
      agentIds: ["morrow-coach"],
      scope: "morrow-coach:99999",
    });

    const sharedImport = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.batchImportChunks, {
      knowledgeBaseId: sharedKb,
      chunks: [{ content: "Shared playbook: always start with mirror summary." }],
    });
    const danImport = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.batchImportChunks, {
      knowledgeBaseId: danKb,
      chunks: [{ content: "Dan playbook: always start with mirror summary before action planning." }],
    });
    const jakoImport = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.batchImportChunks, {
      knowledgeBaseId: jakoKb,
      chunks: [{ content: "Jako playbook: always start with mirror summary before action planning." }],
    });

    const sharedMemoryId = sharedImport.memoryIds[0];
    const danMemoryId = danImport.memoryIds[0];
    const jakoMemoryId = jakoImport.memoryIds[0];

    const danRecall = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("mirror summary before action planning"),
      query: "mirror summary before action planning",
      channel: "morrow-coach:12345",
      limit: 10,
    });

    expect(danRecall.memories.some((memory: any) => memory.memoryId === sharedMemoryId)).toBe(true);
    expect(danRecall.memories.some((memory: any) => memory.memoryId === danMemoryId)).toBe(true);
    expect(danRecall.memories.some((memory: any) => memory.memoryId === jakoMemoryId)).toBe(false);

    const danVisibleKnowledgeBases = await t.withIdentity(user).query(api.crystal.knowledgeBases.listKnowledgeBases, {
      channel: "morrow-coach:12345",
      includeInactive: true,
    });

    expect(danVisibleKnowledgeBases.map((knowledgeBase: { _id: string }) => knowledgeBase._id).sort()).toEqual(
      [sharedKb, danKb].sort()
    );

    const ownerKnowledgeBases = await t.withIdentity(user).query(api.crystal.knowledgeBases.listKnowledgeBases, {
      includeInactive: true,
    });

    expect(ownerKnowledgeBases.map((knowledgeBase: { _id: string }) => knowledgeBase._id).sort()).toEqual(
      [sharedKb, danKb, jakoKb].sort()
    );

    const blockedQuery = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.queryKnowledgeBase, {
      knowledgeBaseId: jakoKb,
      query: "mirror summary before action planning",
      channel: "morrow-coach:12345",
      limit: 10,
    });

    expect(blockedQuery.memories).toEqual([]);

    const allowedQuery = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.queryKnowledgeBase, {
      knowledgeBaseId: danKb,
      query: "mirror summary before action planning",
      channel: "morrow-coach:12345",
      limit: 10,
    });

    expect(allowedQuery.memories.some((memory: { memoryId: string }) => memory.memoryId === danMemoryId)).toBe(true);
  });

  it("hard-filters peer-scoped non-KB memories during recall while preserving visible KB memories", async () => {
    const sharedKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Shared Recall KB",
      agentIds: ["morrow-coach"],
    });
    const danKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Dan Recall KB",
      agentIds: ["morrow-coach"],
      scope: "morrow-coach:12345",
    });
    const jakoKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Jako Recall KB",
      agentIds: ["morrow-coach"],
      scope: "morrow-coach:99999",
    });

    const danPrivateMemoryId = await insertMemory({
      title: "Dan private recall",
      content: "Boundary recall phrase for Dan only.",
      channel: "morrow-coach:12345",
    });
    const genericCoachMemoryId = await insertMemory({
      title: "Generic coach recall",
      content: "Boundary recall phrase from the generic coach lane.",
      channel: "morrow-coach",
    });
    const unscopedMemoryId = await insertMemory({
      title: "Unscoped recall",
      content: "Boundary recall phrase from an unscoped note.",
    });
    const jakoPrivateMemoryId = await insertMemory({
      title: "Jako private recall",
      content: "Boundary recall phrase for Jako only.",
      channel: "morrow-coach:99999",
    });
    const sharedKbMemoryId = await insertMemory({
      title: "Shared KB recall",
      content: "Boundary recall phrase from the shared KB.",
      knowledgeBaseId: sharedKb,
      source: "external",
    });
    const danKbMemoryId = await insertMemory({
      title: "Dan KB recall",
      content: "Boundary recall phrase from Dan's KB.",
      knowledgeBaseId: danKb,
      source: "external",
    });
    const jakoKbMemoryId = await insertMemory({
      title: "Jako KB recall",
      content: "Boundary recall phrase from Jako's KB.",
      knowledgeBaseId: jakoKb,
      source: "external",
    });

    const recall = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
      embedding: embeddingForText("Boundary recall phrase"),
      query: "Boundary recall phrase",
      channel: "morrow-coach:12345",
      limit: 10,
      includeAssociations: false,
    });

    const recallIds = recall.memories.map((memory: any) => memory.memoryId);
    expect(recallIds).toContain(danPrivateMemoryId);
    expect(recallIds).toContain(sharedKbMemoryId);
    expect(recallIds).toContain(danKbMemoryId);
    expect(recallIds).not.toContain(genericCoachMemoryId); // bare-prefix memories blocked from peer-scoped (numeric suffix) channels
    expect(recallIds).not.toContain(unscopedMemoryId);
    expect(recallIds).not.toContain(jakoPrivateMemoryId);
    expect(recallIds).not.toContain(jakoKbMemoryId);
  });

  it("hard-filters wake and guardrail retrieval for peer-scoped sessions without hiding visible KB memories", async () => {
    const sharedKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Shared Wake KB",
      agentIds: ["morrow-coach"],
    });
    const danKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Dan Wake KB",
      agentIds: ["morrow-coach"],
      scope: "morrow-coach:12345",
    });
    const jakoKb = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Jako Wake KB",
      agentIds: ["morrow-coach"],
      scope: "morrow-coach:99999",
    });

    const danGoalId = await insertMemory({
      store: "prospective",
      category: "goal",
      title: "Dan wake goal",
      content: "Prepare Dan's next step.",
      channel: "morrow-coach:12345",
      strength: 0.95,
    });
    const genericGoalId = await insertMemory({
      store: "prospective",
      category: "goal",
      title: "Generic wake goal",
      content: "Prepare the generic coach next step.",
      channel: "morrow-coach",
      strength: 0.9,
    });
    const jakoGoalId = await insertMemory({
      store: "prospective",
      category: "goal",
      title: "Jako wake goal",
      content: "Prepare Jako's next step.",
      channel: "morrow-coach:99999",
      strength: 0.92,
    });
    const sharedKbGoalId = await insertMemory({
      store: "prospective",
      category: "goal",
      title: "Shared KB wake goal",
      content: "Shared KB next-step guardrail.",
      knowledgeBaseId: sharedKb,
      source: "external",
      strength: 0.99,
    });
    const danRuleId = await insertMemory({
      category: "rule",
      title: "Dan wake rule",
      content: "Use Dan's exact channel context before proposing action.",
      channel: "morrow-coach:12345",
      strength: 0.91,
    });
    const genericRuleId = await insertMemory({
      category: "rule",
      title: "Generic wake rule",
      content: "Generic coach rule that should not bleed into peer wake.",
      strength: 0.97,
    });
    const sharedKbRuleId = await insertMemory({
      category: "rule",
      title: "Shared KB wake rule",
      content: "Shared KB rule visible to every Morrow peer session.",
      knowledgeBaseId: sharedKb,
      source: "external",
      strength: 0.96,
    });
    const danKbRuleId = await insertMemory({
      category: "rule",
      title: "Dan KB wake rule",
      content: "Dan KB rule visible only inside Dan's peer scope.",
      knowledgeBaseId: danKb,
      source: "external",
      strength: 0.98,
    });
    const jakoKbRuleId = await insertMemory({
      category: "rule",
      title: "Jako KB wake rule",
      content: "Jako KB rule hidden from Dan's peer scope.",
      knowledgeBaseId: jakoKb,
      source: "external",
      strength: 0.99,
    });

    const recentMemories = await t.query(internal.crystal.mcp.listRecentMemories, {
      userId: user.subject,
      limit: 20,
      channel: "morrow-coach:12345",
    });
    const recentMemoryIds = recentMemories.map((memory: any) => String(memory._id));

    expect(recentMemoryIds).toContain(danGoalId);
    expect(recentMemoryIds).toContain(sharedKbGoalId);
    expect(recentMemoryIds).not.toContain(genericGoalId); // bare-prefix memories blocked from peer-scoped (numeric suffix) channels
    expect(recentMemoryIds).not.toContain(jakoGoalId);

    const guardrails = await t.query(internal.crystal.mcp.getGuardrailMemories, {
      userId: user.subject,
      limit: 10,
      channel: "morrow-coach:12345",
    });
    const guardrailIds = guardrails.map((memory: any) => String(memory._id));

    expect(guardrailIds).toContain(danRuleId);
    expect(guardrailIds).toContain(sharedKbRuleId);
    expect(guardrailIds).toContain(danKbRuleId);
    expect(guardrailIds).not.toContain(genericRuleId);
    expect(guardrailIds).not.toContain(jakoKbRuleId);

    const wake = await t.withIdentity(user).action((api as any).crystal.wake.getWakePrompt, {
      channel: "morrow-coach:12345",
      limit: 5,
    });
    const wakeGoalIds = wake.openGoals.map((memory: { memoryId: string }) => memory.memoryId);
    const wakeGuardrailIds = wake.guardrailMemories.map((memory: { memoryId: string }) => memory.memoryId);

    expect(wakeGoalIds).toContain(danGoalId);
    expect(wakeGoalIds).toContain(sharedKbGoalId);
    expect(wakeGoalIds).not.toContain(genericGoalId); // bare-prefix memories blocked from peer-scoped (numeric suffix) channels
    expect(wakeGoalIds).not.toContain(jakoGoalId);
    expect(wakeGuardrailIds).toContain(danRuleId);
    expect(wakeGuardrailIds).toContain(sharedKbRuleId);
    expect(wakeGuardrailIds).toContain(danKbRuleId);
    expect(wakeGuardrailIds).not.toContain(genericRuleId);
    expect(wakeGuardrailIds).not.toContain(jakoKbRuleId);
  });

  it("skips knowledge-base memories during cleanup and keeps consolidation guards in source", async () => {
    const knowledgeBaseId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Cleanup Guard KB",
      agentIds: ["coach"],
    });

    const importResult = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.batchImportChunks, {
      knowledgeBaseId,
      chunks: [{ content: "Permanent reference material that must not decay or archive." }],
    });

    const memoryId = importResult.memoryIds[0];

    await t.mutation(internal.crystal.decay.applyDecayPatch, {
      memoryId,
      strength: 0.01,
      archived: false,
    });

    await t.action(internal.crystal.cleanup.runCleanup, {
      strengthFloor: 0.5,
      sensoryTtlHours: 1,
    });

    const memoryAfterCleanup = await t.query(internal.crystal.mcp.getMemoryById, { memoryId });
    expect(memoryAfterCleanup?.archived).toBe(false);

    const consolidateSource = readFileSync(join(__dirname, "..", "consolidate.ts"), "utf8");
    expect(consolidateSource).toContain("knowledgeBaseId");
  });
});
