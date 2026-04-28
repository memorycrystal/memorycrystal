import { describe, expect, it } from "vitest";
import {
  isNonKnowledgeBaseMemoryVisibleInChannel,
  isKnowledgeBaseVisibleToAgent,
  PEER_CAPABLE_SCOPES,
  MANAGEMENT_CHANNEL_SENTINEL,
} from "../knowledgeBases";

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

// §14 truth table — isKnowledgeBaseVisibleToAgent (post-fix)
// PEER_CAPABLE_SCOPES = { "morrow-coach", "cass-coach" }
// All rows assume agentId matches kb.agentIds allowlist (or allowlist empty).
describe("isKnowledgeBaseVisibleToAgent — §14 truth table", () => {
  const kb = (overrides: {
    agentIds?: string[];
    isActive?: boolean;
    scope?: string;
    peerScopePolicy?: "strict" | "permissive";
  }) => ({
    agentIds: ["coach"],
    isActive: true,
    scope: undefined as string | undefined,
    peerScopePolicy: undefined as "strict" | "permissive" | undefined,
    ...overrides,
  });

  // Row 1: undefined policy, undefined scope, numeric peer channel → DENY (strict-by-default)
  it("row 1: undefined peerScopePolicy + undefined scope + numeric peer channel → DENY", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ agentIds: ["coach"] }), "coach", "morrow-coach:123")
    ).toBe(false);
  });

  // Row 2: undefined policy, scope="123", channel="morrow-coach:123" → ALLOW (suffix match)
  it("row 2: undefined peerScopePolicy + scope='123' + matching numeric peer channel → ALLOW", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ scope: "123" }), "coach", "morrow-coach:123")
    ).toBe(true);
  });

  // Row 3: undefined policy, scope="morrow-coach:123", channel="morrow-coach:123" → ALLOW (full match)
  it("row 3: undefined peerScopePolicy + scope='morrow-coach:123' + matching full channel → ALLOW", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ scope: "morrow-coach:123" }), "coach", "morrow-coach:123")
    ).toBe(true);
  });

  // Row 4: permissive, undefined scope, numeric peer channel → ALLOW (opt-in)
  it("row 4: permissive peerScopePolicy + undefined scope + numeric peer channel → ALLOW", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ peerScopePolicy: "permissive" }), "coach", "morrow-coach:123")
    ).toBe(true);
  });

  // Row 5: strict, undefined scope, numeric peer channel → DENY
  it("row 5: strict peerScopePolicy + undefined scope + numeric peer channel → DENY", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ peerScopePolicy: "strict" }), "coach", "morrow-coach:123")
    ).toBe(false);
  });

  // Row 6: undefined policy, undefined scope, non-peer-capable prefix → ALLOW (legacy preserved)
  it("row 6: undefined peerScopePolicy + undefined scope + non-peer-capable prefix channel → ALLOW", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ agentIds: [] }), undefined, "coder:general")
    ).toBe(true);
  });

  // Row 7: undefined policy, undefined scope, bare peer-capable (no colon) → DENY (CRIT-1)
  it("row 7: undefined peerScopePolicy + bare peer-capable scope (no colon) → DENY (CRIT-1)", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({}), "coach", "morrow-coach")
    ).toBe(false);
  });

  // Row 8: permissive, undefined scope, bare peer-capable → ALLOW (explicit opt-in)
  it("row 8: permissive peerScopePolicy + bare peer-capable scope → ALLOW", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ peerScopePolicy: "permissive" }), "coach", "morrow-coach")
    ).toBe(true);
  });

  // Row 9: undefined policy, undefined scope, bare non-peer-capable → ALLOW (legacy preserved)
  it("row 9: undefined peerScopePolicy + undefined scope + bare non-peer-capable channel → ALLOW", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ agentIds: [] }), undefined, "general")
    ).toBe(true);
  });

  // Row 10: undefined policy, undefined scope, peer-capable with non-numeric suffix → DENY
  it("row 10: undefined peerScopePolicy + peer-capable prefix + non-numeric suffix → DENY", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({}), "coach", "morrow-coach:team")
    ).toBe(false);
  });

  // Row 11: permissive, undefined scope, peer-capable with non-numeric suffix → ALLOW
  it("row 11: permissive peerScopePolicy + peer-capable prefix + non-numeric suffix → ALLOW", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ peerScopePolicy: "permissive" }), "coach", "morrow-coach:team")
    ).toBe(true);
  });

  it("MANAGEMENT_CHANNEL_SENTINEL bypasses peer logic and uses agentIds-only check", () => {
    // Management path: no peer scope enforcement regardless of agentIds
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ agentIds: ["coach"] }), "coach", MANAGEMENT_CHANNEL_SENTINEL)
    ).toBe(true);
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ agentIds: ["coach"] }), "other", MANAGEMENT_CHANNEL_SENTINEL)
    ).toBe(false);
  });

  it("PEER_CAPABLE_SCOPES includes morrow-coach and cass-coach", () => {
    expect(PEER_CAPABLE_SCOPES.has("morrow-coach")).toBe(true);
    expect(PEER_CAPABLE_SCOPES.has("cass-coach")).toBe(true);
    expect(PEER_CAPABLE_SCOPES.has("coder")).toBe(false);
  });

  it("inactive KB is always denied regardless of channel or policy", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(
        kb({ isActive: false, peerScopePolicy: "permissive" }),
        "coach",
        "morrow-coach:123"
      )
    ).toBe(false);
  });

  it("cass-coach peer scope enforces same isolation as morrow-coach", () => {
    expect(
      isKnowledgeBaseVisibleToAgent(kb({}), "coach", "cass-coach:456")
    ).toBe(false);
    expect(
      isKnowledgeBaseVisibleToAgent(kb({ scope: "456" }), "coach", "cass-coach:456")
    ).toBe(true);
  });
});
