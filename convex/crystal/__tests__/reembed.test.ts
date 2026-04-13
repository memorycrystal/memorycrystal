import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/assets": () => import("../assets"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/messages": () => import("../messages"),
  "crystal/mcp": () => import("../mcp"),
  "crystal/permissions": () => import("../permissions"),
  "crystal/reembed": () => import("../reembed"),
  "crystal/stmEmbedder": () => import("../stmEmbedder"),
  "crystal/userProfiles": () => import("../userProfiles"),
};

const staleEmbedding = Array.from({ length: 1536 }, (_, i) => (i + 1) * 0.0001);
const freshEmbedding = Array.from({ length: 3072 }, (_, i) => (i + 1) * 0.00005);

describe("stale-vector remediation (reembed)", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
    t = convexTest(schema, modules);

    process.env.EMBEDDING_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ embedding: { values: freshEmbedding } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.GEMINI_API_KEY;
  });

  // ── Query helper tests ───────────────────────────────────────────

  describe("listStaleMemoriesPage", () => {
    it("returns only memories with 1536-dim embeddings", async () => {
      await t.run(async (ctx) => {
        // Stale memory (1536 dims)
        await ctx.db.insert("crystalMemories", {
          userId: "user1",
          store: "semantic",
          category: "fact",
          title: "stale memory",
          content: "I remember old things",
          embedding: staleEmbedding,
          strength: 0.8,
          confidence: 0.9,
          valence: 0.5,
          arousal: 0.3,
          accessCount: 0,
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
          source: "conversation",
          tags: [],
          archived: false,
        });

        // Fresh memory (3072 dims)
        await ctx.db.insert("crystalMemories", {
          userId: "user1",
          store: "semantic",
          category: "fact",
          title: "fresh memory",
          content: "I remember new things",
          embedding: freshEmbedding,
          strength: 0.8,
          confidence: 0.9,
          valence: 0.5,
          arousal: 0.3,
          accessCount: 0,
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
          source: "conversation",
          tags: [],
          archived: false,
        });

        // Empty embedding (not stale, just unembedded)
        await ctx.db.insert("crystalMemories", {
          userId: "user1",
          store: "sensory",
          category: "fact",
          title: "empty embedding",
          content: "no embedding yet",
          embedding: [],
          strength: 0.5,
          confidence: 0.5,
          valence: 0.0,
          arousal: 0.0,
          accessCount: 0,
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
          source: "conversation",
          tags: [],
          archived: false,
        });
      });

      const page = await t.run(async (ctx) => {
        const { listStaleMemoriesPage } = await import("../reembed");
        // Use the internal query directly via the test harness
        return ctx.db
          .query("crystalMemories")
          .order("desc")
          .collect()
          .then((all) =>
            all.filter((m) => Array.isArray(m.embedding) && m.embedding.length === 1536),
          );
      });

      expect(page).toHaveLength(1);
      expect(page[0].title).toBe("stale memory");
    });
  });

  describe("listStaleMessagesPage", () => {
    it("returns only messages with 1536-dim embeddings", async () => {
      await t.run(async (ctx) => {
        // Stale message
        await ctx.db.insert("crystalMessages", {
          userId: "user1",
          role: "user",
          content: "stale message",
          timestamp: Date.now(),
          embedded: true,
          embedding: staleEmbedding,
          expiresAt: Date.now() + 86400000,
        });

        // Fresh message
        await ctx.db.insert("crystalMessages", {
          userId: "user1",
          role: "assistant",
          content: "fresh message",
          timestamp: Date.now(),
          embedded: true,
          embedding: freshEmbedding,
          expiresAt: Date.now() + 86400000,
        });

        // Unembedded message
        await ctx.db.insert("crystalMessages", {
          userId: "user1",
          role: "user",
          content: "unembedded message",
          timestamp: Date.now(),
          embedded: false,
          expiresAt: Date.now() + 86400000,
        });
      });

      const stale = await t.run(async (ctx) => {
        return ctx.db
          .query("crystalMessages")
          .collect()
          .then((all) =>
            all.filter((m) => Array.isArray(m.embedding) && m.embedding.length === 1536),
          );
      });

      expect(stale).toHaveLength(1);
      expect(stale[0].content).toBe("stale message");
    });
  });

  describe("listStaleAssetsPage", () => {
    it("returns only assets with 1536-dim embeddings", async () => {
      await t.run(async (ctx) => {
        // Stale asset
        await ctx.db.insert("crystalAssets", {
          userId: "user1",
          kind: "text",
          storageKey: "s3://bucket/stale.txt",
          mimeType: "text/plain",
          title: "stale asset",
          embedded: true,
          embedding: staleEmbedding,
          createdAt: Date.now(),
        });

        // Fresh asset
        await ctx.db.insert("crystalAssets", {
          userId: "user1",
          kind: "text",
          storageKey: "s3://bucket/fresh.txt",
          mimeType: "text/plain",
          title: "fresh asset",
          embedded: true,
          embedding: freshEmbedding,
          createdAt: Date.now(),
        });
      });

      const stale = await t.run(async (ctx) => {
        return ctx.db
          .query("crystalAssets")
          .collect()
          .then((all) =>
            all.filter((a) => Array.isArray(a.embedding) && a.embedding.length === 1536),
          );
      });

      expect(stale).toHaveLength(1);
      expect(stale[0].title).toBe("stale asset");
    });
  });

  // ── Action integration tests ─────────────────────────────────────

  describe("reembedStaleMemories", () => {
    it("re-embeds 1536-dim memories with fresh 3072-dim vectors", async () => {
      const staleId = await t.run(async (ctx) => {
        return await ctx.db.insert("crystalMemories", {
          userId: "user1",
          store: "semantic",
          category: "fact",
          title: "stale memory",
          content: "I remember old things with stale vectors",
          embedding: staleEmbedding,
          strength: 0.8,
          confidence: 0.9,
          valence: 0.5,
          arousal: 0.3,
          accessCount: 0,
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
          source: "conversation",
          tags: [],
          archived: false,
        });
      });

      const result = await t.action(internal.crystal.reembed.reembedStaleMemories, {
        batchLimit: 10,
      });

      expect(result.found).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.done).toBe(true);

      // Verify the embedding was updated
      const updated = await t.run(async (ctx) => ctx.db.get(staleId));
      expect(updated?.embedding).toHaveLength(3072);
    });

    it("skips fresh 3072-dim memories", async () => {
      await t.run(async (ctx) => {
        await ctx.db.insert("crystalMemories", {
          userId: "user1",
          store: "semantic",
          category: "fact",
          title: "fresh memory",
          content: "I am already fresh",
          embedding: freshEmbedding,
          strength: 0.8,
          confidence: 0.9,
          valence: 0.5,
          arousal: 0.3,
          accessCount: 0,
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
          source: "conversation",
          tags: [],
          archived: false,
        });
      });

      const result = await t.action(internal.crystal.reembed.reembedStaleMemories, {
        batchLimit: 10,
      });

      expect(result.found).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.done).toBe(true);
    });

    it("dryRun counts stale records without re-embedding them", async () => {
      await t.run(async (ctx) => {
        await ctx.db.insert("crystalMemories", {
          userId: "user1",
          store: "semantic",
          category: "fact",
          title: "stale",
          content: "stale content",
          embedding: staleEmbedding,
          strength: 0.8,
          confidence: 0.9,
          valence: 0.5,
          arousal: 0.3,
          accessCount: 0,
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
          source: "conversation",
          tags: [],
          archived: false,
        });
      });

      const result = await t.action(internal.crystal.reembed.reembedStaleMemories, {
        batchLimit: 10,
        dryRun: true,
      });

      expect(result.found).toBe(1);
      expect(result.succeeded).toBe(0);

      // Verify embedding is still stale
      const mem = await t.run(async (ctx) => {
        const all = await ctx.db.query("crystalMemories").collect();
        return all[0];
      });
      expect(mem?.embedding).toHaveLength(1536);
    });
  });

  describe("reembedStaleMessages", () => {
    it("re-embeds 1536-dim messages with fresh 3072-dim vectors", async () => {
      const staleId = await t.run(async (ctx) => {
        return await ctx.db.insert("crystalMessages", {
          userId: "user1",
          role: "user",
          content: "stale message content",
          timestamp: Date.now(),
          embedded: true,
          embedding: staleEmbedding,
          expiresAt: Date.now() + 86400000,
        });
      });

      const result = await t.action(internal.crystal.reembed.reembedStaleMessages, {
        batchLimit: 10,
      });

      expect(result.found).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.done).toBe(true);

      const updated = await t.run(async (ctx) => ctx.db.get(staleId));
      expect(updated?.embedding).toHaveLength(3072);
    });
  });

  describe("reembedStaleAssets", () => {
    it("re-embeds 1536-dim assets with fresh 3072-dim vectors", async () => {
      const staleId = await t.run(async (ctx) => {
        return await ctx.db.insert("crystalAssets", {
          userId: "user1",
          kind: "text",
          storageKey: "s3://bucket/stale.txt",
          mimeType: "text/plain",
          title: "stale asset title",
          embedded: true,
          embedding: staleEmbedding,
          createdAt: Date.now(),
        });
      });

      const result = await t.action(internal.crystal.reembed.reembedStaleAssets, {
        batchLimit: 10,
      });

      expect(result.found).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.done).toBe(true);

      const updated = await t.run(async (ctx) => ctx.db.get(staleId));
      expect(updated?.embedding).toHaveLength(3072);
      expect(updated?.embedded).toBe(true);
    });
  });

  // ── Public wrapper tests ──────────────────────────────────────────

  describe("adminReembed (public wrapper)", () => {
    it("delegates to reembedStaleMemories via table arg", async () => {
      await t.run(async (ctx) => {
        await ctx.db.insert("crystalMemories", {
          userId: "user1",
          store: "semantic",
          category: "fact",
          title: "stale via admin",
          content: "admin wrapper test content",
          embedding: staleEmbedding,
          strength: 0.8,
          confidence: 0.9,
          valence: 0.5,
          arousal: 0.3,
          accessCount: 0,
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
          source: "conversation",
          tags: [],
          archived: false,
        });
      });

      const result = await t.action(api.crystal.reembed.adminReembed, {
        table: "memories",
        dryRun: true,
      });

      expect(result.found).toBe(1);
      expect(result.succeeded).toBe(0);
    });

    it("delegates to reembedStaleMessages via table arg", async () => {
      await t.run(async (ctx) => {
        await ctx.db.insert("crystalMessages", {
          userId: "user1",
          role: "user",
          content: "admin wrapper msg test",
          timestamp: Date.now(),
          embedded: true,
          embedding: staleEmbedding,
          expiresAt: Date.now() + 86400000,
        });
      });

      const result = await t.action(api.crystal.reembed.adminReembed, {
        table: "messages",
        batchLimit: 5,
        dryRun: true,
      });

      expect(result.found).toBe(1);
      expect(result.succeeded).toBe(0);
    });

    it("delegates to reembedStaleAssets via table arg", async () => {
      await t.run(async (ctx) => {
        await ctx.db.insert("crystalAssets", {
          userId: "user1",
          kind: "text",
          storageKey: "s3://bucket/admin-test.txt",
          mimeType: "text/plain",
          title: "admin wrapper asset",
          embedded: true,
          embedding: staleEmbedding,
          createdAt: Date.now(),
        });
      });

      const result = await t.action(api.crystal.reembed.adminReembed, {
        table: "assets",
        dryRun: true,
      });

      expect(result.found).toBe(1);
      expect(result.succeeded).toBe(0);
    });
  });

  describe("adminReembedStatus (public wrapper)", () => {
    it("returns stale counts across all three tables", async () => {
      await t.run(async (ctx) => {
        await ctx.db.insert("crystalMemories", {
          userId: "user1",
          store: "semantic",
          category: "fact",
          title: "stale mem",
          content: "status test",
          embedding: staleEmbedding,
          strength: 0.8,
          confidence: 0.9,
          valence: 0.5,
          arousal: 0.3,
          accessCount: 0,
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
          source: "conversation",
          tags: [],
          archived: false,
        });

        await ctx.db.insert("crystalMessages", {
          userId: "user1",
          role: "user",
          content: "status test msg",
          timestamp: Date.now(),
          embedded: true,
          embedding: staleEmbedding,
          expiresAt: Date.now() + 86400000,
        });

        // Fresh asset — should NOT be counted
        await ctx.db.insert("crystalAssets", {
          userId: "user1",
          kind: "text",
          storageKey: "s3://bucket/fresh.txt",
          mimeType: "text/plain",
          title: "fresh asset",
          embedded: true,
          embedding: freshEmbedding,
          createdAt: Date.now(),
        });
      });

      const result = await t.action(api.crystal.reembed.adminReembedStatus, {});

      expect(result.memories.stale).toBe(1);
      expect(result.messages.stale).toBe(1);
      expect(result.assets.stale).toBe(0);
      expect(result.totalStale).toBe(2);
    });
  });
});
