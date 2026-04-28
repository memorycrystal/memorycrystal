import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

// Integration: two peers hitting the same Morrow userId — peer B must be blocked
// from seeing peer A's KB chunks and vice versa.
//
// Seeds:
//   KB-shared  — scope=undefined, agentIds=["morrow-coach"], peerScopePolicy=undefined (strict)
//   KB-andy    — scope="511172388", agentIds=["morrow-coach"]
//
// Assertions:
//   channel="morrow-coach:511172388" → sees KB-andy + KB-shared (if shared allows)
//   channel="morrow-coach:999"       → sees 0 hits (regression: pre-fix would return Andy's chunks)

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
  subject: "peer-isolation-user",
  tokenIdentifier: "token-peer-isolation-user",
  issuer: "test",
};

const embeddingForText = (text: string) => {
  let seed = 0;
  for (const char of text) seed = (seed + char.charCodeAt(0)) % 997;
  const base = seed / 1000;
  return Array.from({ length: 3072 }, (_, i) => Number((base + i * 0.000001).toFixed(6)));
};

describe("KB peer isolation — two peers, same Morrow userId", () => {
  let t: ReturnType<typeof convexTest>;

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
            candidates: [{
              content: { parts: [{ text: JSON.stringify({ entities: [], relations: [], associationHint: null }) }] },
            }],
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

  it("peer B (999) is blocked from peer A (511172388) KB chunks; peer A sees own KB", async () => {
    // KB-shared: scope=undefined, strict (default) — no peer gets this under strict-by-default
    const kbSharedId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Morrow Shared Methodology",
      agentIds: ["morrow-coach"],
      // peerScopePolicy: undefined → strict; shared KB needs permissive to be visible to peers
    });

    // KB-andy: scope="morrow-coach:511172388" — Andy's personal KB
    const kbAndyId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Andy Morrow KB",
      agentIds: ["morrow-coach"],
      scope: "morrow-coach:511172388",
    });

    // Insert Andy's PII chunk via bulkInsertChunksInternal with explicit scope.
    // batchImportChunks → insertKnowledgeBaseChunkInternal has no scope field and
    // throws on strict peer-capable KBs; use bulkInsert for scoped inserts.
    const andyImport = await t.mutation(internal.crystal.knowledgeBases.bulkInsertChunksInternal, {
      knowledgeBaseId: kbAndyId,
      userId: user.subject,
      chunks: [
        {
          content: "Andy Doucet coaching notes: daughters Natasha and Autumn, goals for 2026.",
          title: "Andy personal profile",
          scope: "511172388",
        },
      ],
    });

    const andyMemoryId = andyImport.memoryIds[0];
    expect(andyMemoryId).toBeTruthy();

    // Verify KB visibility directly via listKnowledgeBases — this exercises
    // isKnowledgeBaseVisibleToAgent without going through vector recall.
    // Peer A (Andy, 511172388) should see his own KB.
    const andyVisibleKbs = await t.withIdentity(user).query(api.crystal.knowledgeBases.listKnowledgeBases, {
      channel: "morrow-coach:511172388",
      includeInactive: false,
    });
    const andyKbIds = andyVisibleKbs.map((kb: { _id: string }) => kb._id);
    expect(andyKbIds).toContain(kbAndyId);
    // Shared strict KB is not visible to any peer (strict-by-default with no scope)
    expect(andyKbIds).not.toContain(kbSharedId);

    // Peer B (cold peer, 999) must NOT see Andy's KB.
    // Pre-fix: isKnowledgeBaseVisibleToAgent had no peer dimension → would include kbAndyId.
    const coldPeerVisibleKbs = await t.withIdentity(user).query(api.crystal.knowledgeBases.listKnowledgeBases, {
      channel: "morrow-coach:999",
      includeInactive: false,
    });
    const coldPeerKbIds = coldPeerVisibleKbs.map((kb: { _id: string }) => kb._id);
    expect(coldPeerKbIds).not.toContain(kbAndyId);
    expect(coldPeerKbIds).not.toContain(kbSharedId);
    // Cold peer sees 0 KBs (regression: pre-fix returned Andy's KB for any peer)
    expect(coldPeerKbIds).toHaveLength(0);
  });

  it("shared permissive KB is visible to both peers; strict KB is visible to neither without scope", async () => {
    // KB-shared-permissive: opt-in shared across all peers
    const kbPermissiveId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Permissive Shared Methodology",
      agentIds: ["morrow-coach"],
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(kbPermissiveId, { peerScopePolicy: "permissive" });
    });

    // KB-strict: no scope, strict — invisible to any peer channel
    const kbStrictId = await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Strict Unscoped KB",
      agentIds: ["morrow-coach"],
      // peerScopePolicy: undefined = strict
    });

    // Permissive KB accepts unscoped inserts via batchImportChunks.
    const permissiveImport = await t.withIdentity(user).action((api as any).crystal.knowledgeBases.batchImportChunks, {
      knowledgeBaseId: kbPermissiveId,
      chunks: [{ content: "Shared methodology content visible to all peers." }],
    });
    // Strict KB rejects unscoped inserts — insert directly via t.run to bypass admission
    // and seed the chunk to test that the read-side also blocks it.
    const strictMemoryId = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("crystalMemories", {
        userId: user.subject,
        store: "semantic" as const,
        category: "fact" as const,
        title: "Strict unscoped chunk",
        content: "Strict unscoped content must not appear in any peer channel.",
        embedding: [],
        strength: 1,
        confidence: 1,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: "external" as const,
        tags: [],
        archived: false,
        graphEnriched: false,
        knowledgeBaseId: kbStrictId,
      });
    });

    const permissiveMemoryId = permissiveImport.memoryIds[0];

    // Both peers should see permissive KB
    for (const channel of ["morrow-coach:511172388", "morrow-coach:999"]) {
      const recall = await t.withIdentity(user).action(api.crystal.recall.recallMemories, {
        embedding: embeddingForText("shared methodology content"),
        query: "shared methodology content",
        channel,
        limit: 10,
        includeAssociations: false,
      });
      const ids = recall.memories.map((m: any) => m.memoryId);
      expect(ids).toContain(permissiveMemoryId);
      // Strict unscoped KB must NOT appear for any peer
      expect(ids).not.toContain(strictMemoryId);
    }
  });

  it("listKnowledgeBases for peer B does not expose peer A's scoped KB", async () => {
    await t.withIdentity(user).mutation(api.crystal.knowledgeBases.createKnowledgeBase, {
      name: "Andy Scoped KB for Listing",
      agentIds: ["morrow-coach"],
      scope: "morrow-coach:511172388",
    });

    // Peer B listing should not include Andy's KB
    const peerBListing = await t.withIdentity(user).query(api.crystal.knowledgeBases.listKnowledgeBases, {
      channel: "morrow-coach:999",
      includeInactive: false,
    });

    const listingNames = peerBListing.map((kb: { name: string }) => kb.name);
    expect(listingNames).not.toContain("Andy Scoped KB for Listing");
  });
});
