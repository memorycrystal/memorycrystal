import { describe, expect, it } from "vitest";
import { isNonKnowledgeBaseMemoryVisibleInChannel } from "../knowledgeBases";

describe("isNonKnowledgeBaseMemoryVisibleInChannel", () => {
  it("returns true when no channel filter is applied", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("general", undefined)).toBe(true);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel(undefined, undefined)).toBe(true);
  });

  it("returns true for global memories in unscoped channels, false in scoped", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel(undefined, "general")).toBe(true);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel(undefined, "coder:general")).toBe(false);
  });

  it("exact match on bare channels", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("general", "general")).toBe(true);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("general", "random")).toBe(false);
  });

  it("hides agent-scoped memories from bare channel requests", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("coder:general", "general")).toBe(false);
  });

  it("exact match on agent-scoped channels", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("coder:general", "coder:general")).toBe(true);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("coder:general", "writer:general")).toBe(false);
  });

  it("shows unscoped memories matching the base channel of an agent-scoped request", () => {
    // This is the key fix: memoryChannel="general" should be visible
    // when the request channel is "coder:general" (base channel = "general")
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("general", "coder:general")).toBe(true);
  });

  it("hides unscoped memories that don't match the base channel", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("random", "coder:general")).toBe(false);
  });

  // Peer-scoped coach channels: morrow-coach:511172388
  // When the suffix is a numeric peer ID, bare-prefix memories are blocked
  // because they contain a mix of all peers' data (cross-client leakage).
  it("blocks bare-prefix memories in peer-scoped (numeric suffix) channels", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach", "morrow-coach:511172388")).toBe(false);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach", "morrow-coach:8787596995")).toBe(false);
  });

  // Agent-scoped channels (non-numeric suffix) still allow prefix+suffix matches
  it("still allows prefix matches for agent-scoped (named suffix) channels", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("coder", "coder:general")).toBe(true);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("general", "coder:general")).toBe(true);
  });

  it("blocks cross-peer memories in peer-scoped channels", () => {
    // Memories from peer 999 must NOT surface in peer 511's channel
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach:999999", "morrow-coach:511172388")).toBe(false);
  });

  it("blocks global memories in peer-scoped channels", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel(undefined, "morrow-coach:511172388")).toBe(false);
  });

  it("blocks unrelated channel memories in peer-scoped channels", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("random", "morrow-coach:511172388")).toBe(false);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("general", "morrow-coach:511172388")).toBe(false);
  });

  it("exact match still works for peer-scoped channels", () => {
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach:511172388", "morrow-coach:511172388")).toBe(true);
  });

  // Regression: live smoke 2026-04-04 — querying "Andy Doucet client profile"
  // in morrow-coach:511172388 returned Kristen Knight / Cory G / Paul Treacy
  // memories stored under bare "morrow-coach". Same for BJ Moffatt in
  // morrow-coach:8787596995 returning Andy/Travis/Paul/Kristen notes.
  it("regression: bare-prefix memories do not leak across peer channels", () => {
    // Legacy memories stored under bare "morrow-coach" (no peer suffix)
    // must NOT appear in any peer-scoped channel
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach", "morrow-coach:511172388")).toBe(false);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach", "morrow-coach:8787596995")).toBe(false);

    // Other peer's scoped memories must not leak
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach:8787596995", "morrow-coach:511172388")).toBe(false);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach:511172388", "morrow-coach:8787596995")).toBe(false);

    // Own peer-scoped memories are still visible
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach:511172388", "morrow-coach:511172388")).toBe(true);
    expect(isNonKnowledgeBaseMemoryVisibleInChannel("morrow-coach:8787596995", "morrow-coach:8787596995")).toBe(true);
  });
});
