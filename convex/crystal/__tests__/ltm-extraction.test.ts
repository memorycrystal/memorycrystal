import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import {
  groupMessagesForExtraction,
  parseExtractedMemories,
} from "../ltmExtraction";
import { buildMemoryHashInput, buildMessageDedupeScopeInput, buildMessageHashInput, normalizeMemoryContentForHash } from "../contentHash";
import { sha256Hex } from "../crypto";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/ltmExtraction": () => import("../ltmExtraction"),
  "crystal/messages": () => import("../messages"),
  "crystal/userProfiles": () => import("../userProfiles"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/contentScanner": () => import("../contentScanner"),
  "crystal/crypto": () => import("../crypto"),
  "crystal/contentHash": () => import("../contentHash"),
};

describe("LTM extraction helpers", () => {
  it("groups STM messages into ordered extraction windows", () => {
    const windows = groupMessagesForExtraction([
      {
        _id: "m1" as any,
        userId: "u1",
        role: "user",
        content: "Remember that my birthday is May 2.",
        channel: "coach:123",
        sessionKey: "s1",
        timestamp: 1_000,
      },
      {
        _id: "m2" as any,
        userId: "u1",
        role: "assistant",
        content: "Got it.",
        channel: "coach:123",
        sessionKey: "s1",
        timestamp: 2_000,
      },
      {
        _id: "m3" as any,
        userId: "u1",
        role: "user",
        content: "Different session.",
        channel: "coach:123",
        sessionKey: "s2",
        timestamp: 3_000,
      },
    ]);

    expect(windows).toHaveLength(2);
    expect(windows[0].messageIds.map(String)).toEqual(["m1", "m2"]);
    expect(windows[0].text).toContain("birthday is May 2");
  });

  it("parses and normalizes extracted memory JSON", () => {
    const raw = [
      "```json",
      '{"memories":[{"title":"Birthday preference","content":"The user birthday is May 2.","store":"semantic","category":"person","tags":["Birthday"," user "],"importance":0.9,"confidence":0.85},{"title":"Bad","content":"Nope","store":"sensory","category":"fact","tags":[]}]}',
      "```",
    ].join("\n");
    const memories = parseExtractedMemories(raw);


    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      title: "Birthday preference",
      store: "semantic",
      category: "person",
      tags: ["birthday", "user"],
    });
  });

  it("normalizes memory content for stable hashes", () => {
    expect(normalizeMemoryContentForHash("  Important\r\n\r\n fact  ")).toBe("important\n\nfact");
  });
});

describe("LTM extraction persistence", () => {
  let t: ReturnType<typeof convexTest>;
  const userId = "ltm-user";

  beforeEach(() => {
    process.env.MC_DISABLE_MESSAGE_EMBED_SCHEDULE = "1";
    t = convexTest(schema, modules);
  });

  it("dedupes extracted memories by content hash and merges source message ids", async () => {
    const firstMessageId = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "user",
      content: "Remember my birthday is May 2.",
      channel: "coach:123",
      sessionKey: "s1",
    });
    const secondMessageId = await t.mutation(internal.crystal.messages.logMessageInternal, {
      userId,
      role: "assistant",
      content: "Saved.",
      channel: "coach:123",
      sessionKey: "s1",
    });

    const memory = {
      store: "semantic" as const,
      category: "person" as const,
      title: "User birthday",
      content: "The user's birthday is May 2.",
      tags: ["birthday"],
      confidence: 0.9,
      strength: 0.85,
    };
    const contentHash = await sha256Hex(buildMemoryHashInput(memory));

    const first = await t.mutation(internal.crystal.ltmExtraction.insertExtractedMemory, {
      userId,
      ...memory,
      contentHash,
      sourceMessageIds: [firstMessageId],
      channel: "coach:123",
    });
    const second = await t.mutation(internal.crystal.ltmExtraction.insertExtractedMemory, {
      userId,
      ...memory,
      contentHash,
      sourceMessageIds: [secondMessageId],
      channel: "coach:123",
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const stored = await t.run((ctx) => ctx.db.get(first.id as any));
    expect(stored?.sourceMessageIds?.map(String).sort()).toEqual([String(firstMessageId), String(secondMessageId)].sort());
  });


  it("keeps identical extracted memories separate across peer channels", async () => {
    const memory = {
      store: "semantic" as const,
      category: "person" as const,
      title: "User birthday",
      content: "The user's birthday is May 2.",
      tags: ["birthday"],
      confidence: 0.9,
      strength: 0.85,
    };
    const contentHash = await sha256Hex(buildMemoryHashInput(memory));

    const coachA = await t.mutation(internal.crystal.ltmExtraction.insertExtractedMemory, {
      userId,
      ...memory,
      contentHash,
      sourceMessageIds: [],
      channel: "coach:111",
    });
    const coachB = await t.mutation(internal.crystal.ltmExtraction.insertExtractedMemory, {
      userId,
      ...memory,
      contentHash,
      sourceMessageIds: [],
      channel: "coach:222",
    });

    expect(coachA.inserted).toBe(true);
    expect(coachB.inserted).toBe(true);
    expect(coachB.id).not.toBe(coachA.id);
  });



  it("dedupes extracted memories by exact channel even after many same-hash other channels", async () => {
    const memory = {
      store: "semantic" as const,
      category: "person" as const,
      title: "Shared birthday",
      content: "The user's birthday is May 2.",
      tags: ["birthday"],
      confidence: 0.9,
      strength: 0.85,
    };
    const contentHash = await sha256Hex(buildMemoryHashInput(memory));

    for (let i = 0; i < 40; i += 1) {
      const result = await t.mutation(internal.crystal.ltmExtraction.insertExtractedMemory, {
        userId,
        ...memory,
        contentHash,
        sourceMessageIds: [],
        channel: `coach:${1000 + i}`,
      });
      expect(result.inserted).toBe(true);
    }

    const first = await t.mutation(internal.crystal.ltmExtraction.insertExtractedMemory, {
      userId,
      ...memory,
      contentHash,
      sourceMessageIds: [],
      channel: "coach:target",
    });
    const second = await t.mutation(internal.crystal.ltmExtraction.insertExtractedMemory, {
      userId,
      ...memory,
      contentHash,
      sourceMessageIds: [],
      channel: "coach:target",
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("revisits fully hashed unchecked rows during duplicate cleanup", async () => {
    const contentHash = await sha256Hex(buildMessageHashInput({ role: "assistant", content: "Previously patched duplicate" }));
    const dedupeScopeHash = await sha256Hex(buildMessageDedupeScopeInput({
      userId,
      role: "assistant",
      contentHash,
      channel: "coach:123",
      sessionKey: "patched",
    }));

    const canonical = await t.run((ctx) =>
      ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Previously patched duplicate",
        channel: "coach:123",
        sessionKey: "patched",
        timestamp: 5_000,
        embedded: false,
        expiresAt: 100_000,
        contentHash,
        dedupeScopeHash,
      })
    );
    const duplicate = await t.run((ctx) =>
      ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Previously patched duplicate",
        channel: "coach:123",
        sessionKey: "patched",
        timestamp: 5_001,
        embedded: false,
        expiresAt: 100_000,
        contentHash,
        dedupeScopeHash,
      })
    );

    const result = await t.action(internal.crystal.ltmExtraction.backfillMessageContentHashes, {
      userId,
      limit: 10,
    });

    expect(result.duplicatesDeleted).toBe(1);
    expect(await t.run((ctx) => ctx.db.get(canonical))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(duplicate))).toBeNull();
  });

  it("finds a canonical duplicate by dedupe scope even when many same-hash rows are in other scopes", async () => {
    const { sha256Hex } = await import("../crypto");
    const { buildMessageDedupeScopeInput, buildMessageHashInput } = await import("../contentHash");
    const contentHash = await sha256Hex(buildMessageHashInput({ role: "assistant", content: "Common response" }));

    for (let i = 0; i < 75; i += 1) {
      const sessionKey = `other-${i}`;
      const dedupeScopeHash = await sha256Hex(buildMessageDedupeScopeInput({
        userId,
        role: "assistant",
        contentHash,
        channel: "coach:999",
        sessionKey,
      }));
      await t.run((ctx) =>
        ctx.db.insert("crystalMessages", {
          userId,
          role: "assistant",
          content: "Common response",
          channel: "coach:999",
          sessionKey,
          timestamp: i,
          embedded: false,
          expiresAt: 100_000,
          contentHash,
          dedupeScopeHash,
        })
      );
    }

    const targetScopeHash = await sha256Hex(buildMessageDedupeScopeInput({
      userId,
      role: "assistant",
      contentHash,
      channel: "coach:123",
      sessionKey: "target",
    }));
    const canonical = await t.run((ctx) =>
      ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Common response",
        channel: "coach:123",
        sessionKey: "target",
        timestamp: 10_000,
        embedded: false,
        expiresAt: 100_000,
        contentHash,
        dedupeScopeHash: targetScopeHash,
      })
    );
    const duplicate = await t.run((ctx) =>
      ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Common response",
        channel: "coach:123",
        sessionKey: "target",
        timestamp: 10_001,
        embedded: false,
        expiresAt: 100_000,
        contentHash,
        dedupeScopeHash: targetScopeHash,
      })
    );

    const found = await t.query(internal.crystal.ltmExtraction.findCanonicalDuplicateMessage, {
      userId,
      messageId: duplicate,
      role: "assistant",
      contentHash,
      dedupeScopeHash: targetScopeHash,
      channel: "coach:123",
      sessionKey: "target",
      timestamp: 10_001,
    });

    expect(String(found?._id)).toBe(String(canonical));
  });

  it("backfills message hashes and deletes exact duplicate rows in the same scope", async () => {
    const first = await t.run((ctx) =>
      ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Duplicate assistant response",
        channel: "coach:123",
        sessionKey: "s1",
        timestamp: 1_000,
        embedded: false,
        expiresAt: 100_000,
      })
    );
    const duplicate = await t.run((ctx) =>
      ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Duplicate assistant response",
        channel: "coach:123",
        sessionKey: "s1",
        timestamp: 1_001,
        embedded: false,
        expiresAt: 100_000,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Duplicate assistant response",
        channel: "coach:123",
        sessionKey: "s2",
        timestamp: 1_002,
        embedded: false,
        expiresAt: 100_000,
      })
    );
    const repeatedLater = await t.run((ctx) =>
      ctx.db.insert("crystalMessages", {
        userId,
        role: "assistant",
        content: "Duplicate assistant response",
        channel: "coach:123",
        sessionKey: "s1",
        timestamp: 20_000,
        embedded: false,
        expiresAt: 100_000,
      })
    );

    const result = await t.action(internal.crystal.ltmExtraction.backfillMessageContentHashes, {
      userId,
      limit: 10,
    });

    expect(result.hashed).toBe(4);
    expect(result.duplicatesFound).toBe(1);
    expect(result.duplicatesDeleted).toBe(1);
    expect(await t.run((ctx) => ctx.db.get(first))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(duplicate))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(repeatedLater))).not.toBeNull();
  });
});
