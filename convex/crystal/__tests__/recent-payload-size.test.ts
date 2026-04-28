import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { mcpRecentMessages, mcpSearchMessages } from "../mcp";

// Plan main-agent-shared-memory-fix-2026-04-26.md PR 2 — strip 3072-dim Gemini
// embedding arrays from /api/mcp/recent-messages and /api/mcp/search-messages
// HTTP responses unless explicitly opted in via body.includeEmbeddings or the
// CRYSTAL_HTTP_INCLUDE_EMBEDDINGS=true deployment env override. Payload size
// for limit:5 with embeddings present was previously ~750KB; bound to <20KB
// with default-strip.

const AUTH_TOKEN = "test-api-key";

function makeRequest(path: string, body: object) {
  return new Request(`https://example.test/api/mcp/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// 3072-dim Gemini embedding (matches the production model dimension).
function makeEmbedding(seed: number): number[] {
  return Array.from({ length: 3072 }, (_, i) => (seed * 0.001 + i * 0.0001));
}

function makeFakeMessageRows(count: number, channel: string) {
  return Array.from({ length: count }, (_, i) => ({
    _id: `msg-${i}`,
    messageId: `msg-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message content ${i}`,
    channel,
    sessionKey: "agent:cass-admin-bot:tg:1234:direct:5678",
    timestamp: 1000 + i,
    score: 0.9,
    embedding: makeEmbedding(i),
    embeddingModel: "gemini-embedding-2-preview",
  }));
}

function makeMockCtx(rows: ReturnType<typeof makeFakeMessageRows>) {
  const runQuery = vi.fn(async (ref: unknown) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/mcp:getApiKeyRecord") {
      return { _id: "key-id", active: true, userId: "test-user" };
    }
    if (name === "crystal/messages:getRecentMessagesForUser") return rows;
    if (name === "crystal/messages:searchMessagesByTextForUser") return rows;
    throw new Error(`Unexpected query ref: ${name}`);
  });
  const runMutation = vi.fn(async (ref: unknown) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
    if (name === "crystal/apiKeys:touchLastUsedAt") return null;
    if (name === "crystal/mcp:writeAuditLog") return null;
    throw new Error(`Unexpected mutation ref: ${name}`);
  });
  const runAction = vi.fn(async (ref: unknown) => {
    const name = getFunctionName(ref as any);
    if (name === "crystal/messages:searchMessagesForUser") return rows;
    throw new Error(`Unexpected action ref: ${name}`);
  });
  return { runQuery, runMutation, runAction };
}

describe("mcpRecentMessages embedding strip (PR 2)", () => {
  afterEach(() => {
    delete process.env.CRYSTAL_HTTP_INCLUDE_EMBEDDINGS;
    vi.restoreAllMocks();
  });

  it("strips embedding + embeddingModel from each row by default", async () => {
    const rows = makeFakeMessageRows(5, "cass:main-cass-admin-bot");
    const ctx = makeMockCtx(rows);

    const response = await (mcpRecentMessages as any)(
      ctx as any,
      makeRequest("recent-messages", { limit: 5, channel: "cass:main-cass-admin-bot" }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = JSON.parse(text);

    // Every row stripped.
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.messages.length).toBe(5);
    for (const msg of payload.messages) {
      expect(msg.embedding).toBeUndefined();
      expect(msg.embeddingModel).toBeUndefined();
    }

    // Turns also stripped.
    if (Array.isArray(payload.turns)) {
      for (const turn of payload.turns) {
        for (const m of turn.messages ?? []) {
          expect(m.embedding).toBeUndefined();
          expect(m.embeddingModel).toBeUndefined();
        }
      }
    }

    // Bound: <20KB regardless of how many embeddings would have been included.
    expect(text.length).toBeLessThan(20_000);
  });

  it("body.includeEmbeddings:true keeps embeddings", async () => {
    const rows = makeFakeMessageRows(2, "cass:main-cass-admin-bot");
    const ctx = makeMockCtx(rows);

    const response = await (mcpRecentMessages as any)(
      ctx as any,
      makeRequest("recent-messages", {
        limit: 2,
        channel: "cass:main-cass-admin-bot",
        includeEmbeddings: true,
      }),
    );

    const payload = await response.json();
    expect(payload.messages.length).toBe(2);
    for (const msg of payload.messages) {
      expect(Array.isArray(msg.embedding)).toBe(true);
      expect(msg.embedding.length).toBe(3072);
    }
  });

  it("CRYSTAL_HTTP_INCLUDE_EMBEDDINGS=true env override forces inclusion regardless of body", async () => {
    process.env.CRYSTAL_HTTP_INCLUDE_EMBEDDINGS = "true";
    const rows = makeFakeMessageRows(2, "cass:main-cass-admin-bot");
    const ctx = makeMockCtx(rows);

    // No includeEmbeddings in the body — env override should still pass them through.
    const response = await (mcpRecentMessages as any)(
      ctx as any,
      makeRequest("recent-messages", { limit: 2, channel: "cass:main-cass-admin-bot" }),
    );

    const payload = await response.json();
    expect(payload.messages.length).toBe(2);
    for (const msg of payload.messages) {
      expect(Array.isArray(msg.embedding)).toBe(true);
      expect(msg.embedding.length).toBe(3072);
    }
  });
});

describe("mcpWake embedding strip (PR 2 follow-up)", () => {
  afterEach(() => {
    delete process.env.CRYSTAL_HTTP_INCLUDE_EMBEDDINGS;
    vi.restoreAllMocks();
  });

  it("strips embedding from wake recentMessages + recentTurns by default", async () => {
    const { mcpWakePost } = await import("../mcp");
    const rows = makeFakeMessageRows(5, "cass:main-cass-admin-bot");

    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:getApiKeyRecord") return { _id: "key-id", active: true, userId: "test-user" };
      if (name === "crystal/messages:getRecentMessagesForUser") return rows;
      if (name === "crystal/mcp:listRecentMemories") return [];
      if (name === "crystal/mcp:listRecentCheckpoints") return [];
      if (name === "crystal/mcp:getMemoryStoreStats") return { total: 0, sensory: 0, episodic: 0, semantic: 0, procedural: 0, prospective: 0 };
      if (name === "crystal/mcp:getLastSessionByUser") return null;
      if (name === "crystal/mcp:getGuardrailMemories") return [];
      throw new Error(`Unexpected query ref: ${name}`);
    });
    const runMutation = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as any);
      if (name === "crystal/mcp:checkAndIncrementRateLimit") return { allowed: true, remaining: 59 };
      if (name === "crystal/apiKeys:touchLastUsedAt") return null;
      if (name === "crystal/mcp:writeAuditLog") return null;
      if (name === "crystal/sessions:createSessionInternal") return null;
      throw new Error(`Unexpected mutation ref: ${name}`);
    });

    const response = await (mcpWakePost as any)(
      { runQuery, runMutation } as any,
      makeRequest("wake", { channel: "cass:main-cass-admin-bot" }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = JSON.parse(text);

    expect(Array.isArray(payload.recentMessages)).toBe(true);
    for (const msg of payload.recentMessages) {
      expect(msg.embedding).toBeUndefined();
      expect(msg.embeddingModel).toBeUndefined();
    }
    if (Array.isArray(payload.recentTurns)) {
      for (const turn of payload.recentTurns) {
        for (const m of turn.messages ?? []) {
          expect(m.embedding).toBeUndefined();
        }
      }
    }
    // Bound: <30KB even with briefing + memories + 5 messages.
    expect(text.length).toBeLessThan(30_000);
  });
});

describe("mcpSearchMessages embedding strip (PR 2)", () => {
  afterEach(() => {
    delete process.env.CRYSTAL_HTTP_INCLUDE_EMBEDDINGS;
    vi.restoreAllMocks();
  });

  it("strips embedding from each row by default", async () => {
    const rows = makeFakeMessageRows(3, "cass:main-cass-admin-bot");
    const ctx = makeMockCtx(rows);

    const response = await (mcpSearchMessages as any)(
      ctx as any,
      makeRequest("search-messages", {
        query: "anything",
        limit: 3,
        channel: "cass:main-cass-admin-bot",
      }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = JSON.parse(text);

    expect(Array.isArray(payload.messages)).toBe(true);
    for (const msg of payload.messages) {
      expect(msg.embedding).toBeUndefined();
      expect(msg.embeddingModel).toBeUndefined();
    }

    expect(text.length).toBeLessThan(20_000);
  });
});
