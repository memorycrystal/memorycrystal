import { describe, expect, it } from "vitest";

// Unit tests for the chunk-scope filter logic introduced in Phase 2.2
// (knowledgeBases.ts:1572-1577 replacement).
//
// The filter is: keep chunk if m.scope === peerIdFromChannel OR m.scope === args.channel.
// peerIdFromChannel = channel.includes(":") ? channel.split(":").pop() : undefined
//
// We test the predicate directly to avoid needing a full Convex context.
// Integration coverage (actual DB round-trip) is in knowledge-bases.test.ts.

const peerIdFromChannel = (channel: string | undefined): string | undefined => {
  if (!channel?.includes(":")) return undefined;
  return channel.split(":").pop();
};

const chunkPassesFilter = (
  chunkScope: string | undefined,
  channel: string | undefined
): boolean => {
  const peerId = peerIdFromChannel(channel);
  if (!peerId) {
    // No peer dimension — no filter applied, all chunks pass.
    return true;
  }
  return chunkScope === peerId || chunkScope === channel;
};

describe("KB chunk-scope filter (Phase 2.2 predicate)", () => {
  describe("peer channel with numeric suffix", () => {
    it("admits chunk whose scope matches the peerId suffix", () => {
      expect(chunkPassesFilter("511172388", "morrow-coach:511172388")).toBe(true);
    });

    it("admits chunk whose scope matches the full channel string", () => {
      expect(chunkPassesFilter("morrow-coach:511172388", "morrow-coach:511172388")).toBe(true);
    });

    it("blocks chunk with undefined scope (old !m.scope admission bug)", () => {
      // Before the fix: `!m.scope` was truthy → cross-peer leak.
      // After the fix: only exact scope match is admitted.
      expect(chunkPassesFilter(undefined, "morrow-coach:511172388")).toBe(false);
    });

    it("blocks chunk scoped to a different peer ID", () => {
      expect(chunkPassesFilter("999999999", "morrow-coach:511172388")).toBe(false);
    });

    it("blocks chunk scoped to a different full channel", () => {
      expect(chunkPassesFilter("morrow-coach:999999999", "morrow-coach:511172388")).toBe(false);
    });

    it("blocks chunk scoped to the bare prefix (cross-peer leak vector)", () => {
      expect(chunkPassesFilter("morrow-coach", "morrow-coach:511172388")).toBe(false);
    });

    it("blocks chunk with empty string scope", () => {
      expect(chunkPassesFilter("", "morrow-coach:511172388")).toBe(false);
    });
  });

  describe("non-peer channel (no colon)", () => {
    it("passes all chunks when no peer dimension exists", () => {
      expect(chunkPassesFilter(undefined, "general")).toBe(true);
      expect(chunkPassesFilter("some-scope", "general")).toBe(true);
      expect(chunkPassesFilter("morrow-coach", "general")).toBe(true);
    });
  });

  describe("non-peer channel (colon but non-numeric suffix)", () => {
    it("passes all chunks for non-numeric suffix channels", () => {
      // peerIdFromChannel returns the suffix, but it is not numeric.
      // The filter still applies — chunks must match scope or full channel.
      // "coder:general" → peerId="general"; only chunks with scope="general" or "coder:general" pass.
      expect(chunkPassesFilter("general", "coder:general")).toBe(true);
      expect(chunkPassesFilter("coder:general", "coder:general")).toBe(true);
      expect(chunkPassesFilter(undefined, "coder:general")).toBe(false);
      expect(chunkPassesFilter("other", "coder:general")).toBe(false);
    });
  });

  describe("undefined channel", () => {
    it("passes all chunks when channel is undefined", () => {
      expect(chunkPassesFilter(undefined, undefined)).toBe(true);
      expect(chunkPassesFilter("any-scope", undefined)).toBe(true);
    });
  });

  describe("regression: the !m.scope admission bug", () => {
    // Before fix: candidateDocs.filter((m) => !m.scope || m.scope === peerIdFromChannel)
    // A chunk with scope=undefined passed `!m.scope` → leaked cross-peer.
    it("chunk with undefined scope does NOT pass for peer channel (regression guard)", () => {
      const channel = "morrow-coach:511172388";
      const peerId = peerIdFromChannel(channel)!;
      // Old predicate: !m.scope || m.scope === peerId
      const oldPredicate = (scope: string | undefined) => !scope || scope === peerId;
      // New predicate: m.scope === peerId || m.scope === channel
      const newPredicate = (scope: string | undefined) => scope === peerId || scope === channel;

      expect(oldPredicate(undefined)).toBe(true); // old: wrongly admitted
      expect(newPredicate(undefined)).toBe(false); // new: correctly blocked
    });
  });
});
