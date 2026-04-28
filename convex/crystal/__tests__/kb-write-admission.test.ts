import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

// Write-side admission control tests (Phase 2.4)
// Tests that insertKnowledgeBaseChunkInternal and bulkInsertChunksInternal
// enforce the structural invariant: strict peer-capable KB rejects unscoped inserts.

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
  subject: "write-admission-user",
  tokenIdentifier: "token-write-admission-user",
  issuer: "test",
};

describe("KB write-admission control (Phase 2.4)", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    vi.stubEnv("EMBEDDING_PROVIDER", "gemini");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes(":embedContent")) {
        const text = String(body?.content?.parts?.[0]?.text ?? "test");
        let seed = 0;
        for (const char of text) seed = (seed + char.charCodeAt(0)) % 997;
        const base = seed / 1000;
        return new Response(
          JSON.stringify({ embedding: { values: Array.from({ length: 3072 }, (_, i) => base + i * 0.000001) } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes(":generateContent")) {
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ entities: [], relations: [], associationHint: null }) }] } }] }),
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

  describe("insertKnowledgeBaseChunkInternal", () => {
    it("throws when inserting unscoped chunk into strict peer-capable KB", async () => {
      const kbId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
        name: "Strict Peer KB",
        agentIds: ["morrow-coach"],
        // peerScopePolicy defaults to strict (undefined = strict)
      });

      await expect(
        t.mutation(internal.crystal.knowledgeBases.insertKnowledgeBaseChunkInternal, {
          knowledgeBaseId: kbId,
          userId: user.subject,
          content: "Unscoped chunk — should be rejected",
          metadata: { title: "Unscoped", chunkIndex: 0, totalChunks: 1, sourceType: "notes" },
        })
      ).rejects.toThrow(/kb-write-admission/);
    });

    it("succeeds when inserting scoped chunk via bulkInsertChunksInternal into strict peer-capable KB", async () => {
      // insertKnowledgeBaseChunkInternal has no scope field — scoped inserts use bulkInsertChunksInternal.
      const kbId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
        name: "Strict Peer KB with scope",
        agentIds: ["morrow-coach"],
      });

      await expect(
        t.mutation(internal.crystal.knowledgeBases.bulkInsertChunksInternal, {
          knowledgeBaseId: kbId,
          userId: user.subject,
          chunks: [{ content: "Scoped chunk for peer 511172388", title: "Scoped", scope: "511172388" }],
        })
      ).resolves.toBeDefined();
    });

    it("succeeds when inserting unscoped chunk into permissive peer-capable KB", async () => {
      const kbId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
        name: "Permissive Peer KB",
        agentIds: ["morrow-coach"],
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(kbId, { peerScopePolicy: "permissive" });
      });

      await expect(
        t.mutation(internal.crystal.knowledgeBases.insertKnowledgeBaseChunkInternal, {
          knowledgeBaseId: kbId,
          userId: user.subject,
          content: "Unscoped chunk — allowed on permissive KB",
          metadata: { title: "Unscoped permissive", chunkIndex: 0, totalChunks: 1, sourceType: "notes" },
        })
      ).resolves.toBeDefined();
    });

    it("succeeds when inserting unscoped chunk into non-peer-capable KB", async () => {
      const kbId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
        name: "Non-Peer KB",
        agentIds: ["coach"],
      });

      await expect(
        t.mutation(internal.crystal.knowledgeBases.insertKnowledgeBaseChunkInternal, {
          knowledgeBaseId: kbId,
          userId: user.subject,
          content: "Unscoped chunk — allowed on non-peer KB",
          metadata: { title: "OK", chunkIndex: 0, totalChunks: 1, sourceType: "notes" },
        })
      ).resolves.toBeDefined();
    });
  });

  describe("bulkInsertChunksInternal", () => {
    it("throws when bulk-inserting any unscoped chunk into strict peer-capable KB", async () => {
      const kbId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
        name: "Strict Peer KB Bulk",
        agentIds: ["morrow-coach"],
      });

      await expect(
        t.mutation(internal.crystal.knowledgeBases.bulkInsertChunksInternal, {
          knowledgeBaseId: kbId,
          userId: user.subject,
          chunks: [
            { content: "Unscoped bulk chunk", title: "Unscoped" },
          ],
        })
      ).rejects.toThrow(/kb-write-admission/);
    });

    it("succeeds when bulk-inserting scoped chunks into strict peer-capable KB", async () => {
      const kbId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
        name: "Strict Peer KB Bulk Scoped",
        agentIds: ["morrow-coach"],
      });

      const result = await t.mutation(internal.crystal.knowledgeBases.bulkInsertChunksInternal, {
        knowledgeBaseId: kbId,
        userId: user.subject,
        chunks: [
          { content: "Scoped bulk chunk peer 123", title: "Scoped", scope: "123" },
          { content: "Another scoped bulk chunk peer 123", title: "Scoped 2", scope: "123" },
        ],
      });

      expect(result.importedCount).toBe(2);
    });

    it("succeeds when bulk-inserting unscoped chunks into permissive peer-capable KB", async () => {
      const kbId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
        name: "Permissive Peer KB Bulk",
        agentIds: ["morrow-coach"],
      });
      // Set peerScopePolicy=permissive directly since createKnowledgeBase validator
      // does not yet expose peerScopePolicy (pending worker-3 schema update).
      await t.run(async (ctx) => {
        await ctx.db.patch(kbId, { peerScopePolicy: "permissive" });
      });

      const result = await t.mutation(internal.crystal.knowledgeBases.bulkInsertChunksInternal, {
        knowledgeBaseId: kbId,
        userId: user.subject,
        chunks: [
          { content: "Unscoped permissive bulk chunk", title: "OK" },
        ],
      });

      expect(result.importedCount).toBe(1);
    });
  });
});
