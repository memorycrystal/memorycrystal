import { describe, expect, it } from "vitest";
import {
  diversityFilter,
  rankRecallCandidates,
  scoreRecallCandidate,
  textSimilarity,
} from "../recallRanking";
import { isNonKnowledgeBaseMemoryVisibleInChannel } from "../knowledgeBases";

const now = Date.parse("2026-03-15T20:24:00.000Z");
const dayMs = 24 * 60 * 60 * 1000;

const candidate = (overrides: Partial<Parameters<typeof scoreRecallCandidate>[0]>) => ({
  memoryId: "memory-1",
  title: "Untitled",
  content: "Generic memory",
  store: "episodic",
  category: "conversation",
  tags: [],
  strength: 0.6,
  confidence: 0.7,
  accessCount: 0,
  createdAt: now - 30 * dayMs,
  lastAccessedAt: now - 30 * dayMs,
  vectorScore: 0.5,
  ...overrides,
});

describe("recall ranking", () => {
  it("prefers fresher same-channel memories over stale off-channel vector hits", () => {
    const ranked = rankRecallCandidates(
      [
        candidate({
          memoryId: "stale-strong-vector",
          title: "Old deployment note",
          content: "Deployment note for project Atlas",
          store: "sensory",
          category: "conversation",
          createdAt: now - 180 * dayMs,
          lastAccessedAt: now - 180 * dayMs,
          vectorScore: 0.92,
          channel: "discord:other",
          salienceScore: 0.18,
        }),
        candidate({
          memoryId: "fresh-same-channel",
          title: "Atlas rollout decision",
          content: "We decided to ship the Atlas rollout tonight.",
          store: "semantic",
          category: "decision",
          createdAt: now - 1 * dayMs,
          lastAccessedAt: now - 1 * dayMs,
          vectorScore: 0.8,
          channel: "discord:memorycrystal",
          salienceScore: 0.92,
        }),
      ],
      {
        now,
        query: "atlas rollout tonight",
        channel: "discord:memorycrystal",
      }
    );

    expect(ranked.map((item) => item.memoryId)).toEqual([
      "fresh-same-channel",
      "stale-strong-vector",
    ]);
  });

  it("uses salience to break near-ties in favor of durable memories", () => {
    const bland = scoreRecallCandidate(
      candidate({
        memoryId: "bland",
        title: "chat note",
        content: "talked about things",
        store: "sensory",
        category: "conversation",
        vectorScore: 0.68,
        salienceScore: 0.1,
        createdAt: now - 7 * dayMs,
        lastAccessedAt: now - 7 * dayMs,
      }),
      { now, query: "what did we decide", channel: "discord:memorycrystal" }
    );

    const important = scoreRecallCandidate(
      candidate({
        memoryId: "important",
        title: "pricing decision",
        content: "We decided to keep the starter plan and confirmed the rollout.",
        store: "semantic",
        category: "decision",
        vectorScore: 0.64,
        salienceScore: 0.96,
        createdAt: now - 7 * dayMs,
        lastAccessedAt: now - 7 * dayMs,
      }),
      { now, query: "what did we decide", channel: "discord:memorycrystal" }
    );

    expect(important.scoreValue).toBeGreaterThan(bland.scoreValue);
  });

  it("applies a slight boost to knowledge-base memories", () => {
    const regular = scoreRecallCandidate(
      candidate({
        memoryId: "regular",
        title: "Mediation notes",
        content: "A note about mediation scripts.",
        vectorScore: 0.7,
        salienceScore: 0.5,
      }),
      { now, query: "mediation scripts" }
    );

    const knowledgeBase = scoreRecallCandidate(
      candidate({
        memoryId: "kb",
        title: "Mediation notes",
        content: "A note about mediation scripts.",
        vectorScore: 0.7,
        salienceScore: 0.5,
        knowledgeBaseId: "kb-1",
      }),
      { now, query: "mediation scripts" }
    );

    expect(knowledgeBase.scoreValue).toBeGreaterThan(regular.scoreValue);
    expect(knowledgeBase.rankingSignals.knowledgeBaseScore).toBe(1);
  });

  it("ranks a KB definition above a hot auto-extracted note with the same vector similarity", () => {
    const hotNote = scoreRecallCandidate(
      candidate({
        memoryId: "client-note",
        title: "Client said half rap felt unfamiliar",
        content: "Auto-extracted conversation detail mentioning half rap in passing.",
        vectorScore: 0.72,
        salienceScore: 0.6,
        strength: 0.7,
        accessCount: 8,
        createdAt: now - 10 * dayMs,
        lastAccessedAt: now - 3 * dayMs,
      }),
      { now, query: "what is a half rap" }
    );

    const kbDefinition = scoreRecallCandidate(
      candidate({
        memoryId: "kb-half-rap",
        title: "Half Rap",
        content:
          "A Half Rap is the first 'T' in STAT on steroids. You listen, ask questions, summarize, and validate.",
        vectorScore: 0.72,
        salienceScore: 0.55,
        strength: 0.5,
        accessCount: 0,
        createdAt: now - 180 * dayMs,
        lastAccessedAt: now - 180 * dayMs,
        knowledgeBaseId: "kb-disrupting-divorce",
      }),
      { now, query: "what is a half rap" }
    );

    expect(kbDefinition.scoreValue).toBeGreaterThan(hotNote.scoreValue);
  });

  it("dedupes exact duplicate memories and keeps the best-scoring copy", () => {
    const ranked = rankRecallCandidates(
      [
        candidate({
          memoryId: "lower-copy",
          title: "Sprint plan",
          content: "Ship the ranking fix this week",
          vectorScore: 0.55,
          salienceScore: 0.4,
          createdAt: now - 20 * dayMs,
          lastAccessedAt: now - 20 * dayMs,
        }),
        candidate({
          memoryId: "better-copy",
          title: "Sprint plan",
          content: "Ship the ranking fix this week",
          vectorScore: 0.74,
          salienceScore: 0.85,
          channel: "discord:memorycrystal",
          createdAt: now - 2 * dayMs,
          lastAccessedAt: now - 1 * dayMs,
        }),
      ],
      {
        now,
        query: "ranking fix",
        channel: "discord:memorycrystal",
      }
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.memoryId).toBe("better-copy");
  });

  it("measures bigram overlap for similar and dissimilar text", () => {
    const similar = textSimilarity(
      candidate({
        title: "Atlas deploy plan",
        content: "Ship project Atlas deploy tonight after QA signoff",
      }),
      candidate({
        title: "Atlas deployment plan",
        content: "Ship project Atlas deploy tonight after QA approval",
      })
    );

    const dissimilar = textSimilarity(
      candidate({
        title: "Atlas deploy plan",
        content: "Ship project Atlas deploy tonight after QA signoff",
      }),
      candidate({
        title: "Vacation ideas",
        content: "Book flights and compare hotels for the summer trip",
      })
    );

    expect(similar).toBeGreaterThan(0.4);
    expect(dissimilar).toBeLessThan(0.2);
  });

  it("keeps one near-duplicate cluster member and backfills with diverse results", () => {
    const rankedCandidates = [
      candidate({
        memoryId: "dup-1",
        title: "Atlas launch checklist",
        content: "Project Atlas launch checklist with QA signoff, staging verification, and rollout tonight",
        vectorScore: 0.98,
        salienceScore: 0.8,
      }),
      candidate({
        memoryId: "dup-2",
        title: "Atlas launch checklist",
        content: "Project Atlas launch checklist with QA signoff, staging verification, and rollout tonight please",
        vectorScore: 0.95,
        salienceScore: 0.79,
      }),
      candidate({
        memoryId: "dup-3",
        title: "Atlas launch checklist",
        content: "Project Atlas launch checklist with QA signoff, staging verification, and rollout tonight now",
        vectorScore: 0.93,
        salienceScore: 0.78,
      }),
      candidate({
        memoryId: "dup-4",
        title: "Atlas launch checklist",
        content: "Project Atlas launch checklist with QA signoff, staging verification, and rollout tonight asap",
        vectorScore: 0.9,
        salienceScore: 0.77,
      }),
      candidate({
        memoryId: "diverse-1",
        title: "Billing follow-up",
        content: "Confirm Polar billing webhook retry behavior",
        vectorScore: 0.88,
        salienceScore: 0.72,
      }),
      candidate({
        memoryId: "diverse-2",
        title: "Docs update",
        content: "Document the MCP server environment variables",
        vectorScore: 0.84,
        salienceScore: 0.7,
      }),
      candidate({
        memoryId: "diverse-3",
        title: "Customer note",
        content: "A user asked for March 14 conversation recall",
        vectorScore: 0.82,
        salienceScore: 0.68,
      }),
      candidate({
        memoryId: "diverse-4",
        title: "Infra issue",
        content: "Railway deploy failed due to a missing secret",
        vectorScore: 0.8,
        salienceScore: 0.66,
      }),
    ].map((entry) =>
      scoreRecallCandidate(entry, {
        now,
        query: "atlas launch checklist",
        channel: "discord:memorycrystal",
      })
    );

    const filtered = diversityFilter(rankedCandidates, 5, { similarityThreshold: 0.85, minDiversity: 3 });

    expect(filtered).toHaveLength(5);
    expect(filtered.filter((item) => item.memoryId.startsWith("dup-"))).toHaveLength(1);
    expect(filtered[0]?.memoryId).toBe("dup-1");
  });

  it("still returns the requested limit when every candidate is similar", () => {
    const rankedCandidates = Array.from({ length: 5 }, (_, index) =>
      scoreRecallCandidate(
        candidate({
          memoryId: `similar-${index + 1}`,
          title: "Atlas summary",
          content: `Atlas summary for tonight release candidate ${index + 1}`,
          vectorScore: 0.95 - index * 0.05,
        }),
        { now, query: "atlas summary" }
      )
    );

    const filtered = diversityFilter(rankedCandidates, 4, { similarityThreshold: 0.5 });

    expect(filtered).toHaveLength(4);
    expect(filtered.map((item) => item.memoryId)).toEqual([
      "similar-1",
      "similar-2",
      "similar-3",
      "similar-4",
    ]);
  });

  it("leaves already diverse candidates in score order", () => {
    const rankedCandidates = [
      candidate({
        memoryId: "top",
        title: "Deployment notes",
        content: "Deploy Atlas from Railway after secrets are rotated",
        vectorScore: 0.95,
      }),
      candidate({
        memoryId: "middle",
        title: "Hiring update",
        content: "Schedule interviews for the backend engineer role",
        vectorScore: 0.84,
      }),
      candidate({
        memoryId: "low",
        title: "Family trip",
        content: "Book Jasper hotel before the summer weekend",
        vectorScore: 0.73,
      }),
    ].map((entry) => scoreRecallCandidate(entry, { now, query: "general update" }));

    const filtered = diversityFilter(rankedCandidates, 3);

    expect(filtered.map((item) => item.memoryId)).toEqual(["top", "middle", "low"]);
  });

  describe("peer-scoped recall isolation", () => {
    // Simulates the semanticSearch filter: only include memories that pass
    // isNonKnowledgeBaseMemoryVisibleInChannel, then rank.
    const filterAndRank = (
      candidates: ReturnType<typeof candidate>[],
      channel: string,
      query: string
    ) => {
      const visible = candidates.filter((c) =>
        isNonKnowledgeBaseMemoryVisibleInChannel(c.channel, channel)
      );
      return rankRecallCandidates(visible, { now, query, channel });
    };

    it("excludes memories from unrelated bare channels in peer-scoped recall", () => {
      const results = filterAndRank(
        [
          candidate({
            memoryId: "same-peer",
            title: "Peer note",
            content: "Note from the coder agent in general",
            channel: "coder:general",
            vectorScore: 0.85,
          }),
          candidate({
            memoryId: "unrelated-bare",
            title: "Random channel note",
            content: "Note from random channel",
            channel: "random",
            vectorScore: 0.90,
          }),
          candidate({
            memoryId: "base-channel",
            title: "General channel note",
            content: "Note from general channel (base match)",
            channel: "general",
            vectorScore: 0.80,
          }),
        ],
        "coder:general",
        "some query"
      );

      const ids = results.map((r) => r.memoryId);
      expect(ids).toContain("same-peer");
      expect(ids).toContain("base-channel");
      expect(ids).not.toContain("unrelated-bare");
    });

    it("excludes memories from other peer-scoped channels", () => {
      const results = filterAndRank(
        [
          candidate({
            memoryId: "my-peer",
            title: "My peer memory",
            content: "From coder:general",
            channel: "coder:general",
            vectorScore: 0.9,
          }),
          candidate({
            memoryId: "other-peer",
            title: "Other peer memory",
            content: "From writer:general",
            channel: "writer:general",
            vectorScore: 0.95,
          }),
        ],
        "coder:general",
        "some query"
      );

      const ids = results.map((r) => r.memoryId);
      expect(ids).toContain("my-peer");
      expect(ids).not.toContain("other-peer");
    });

    it("excludes global memories (no channel) from scoped recall", () => {
      const results = filterAndRank(
        [
          candidate({
            memoryId: "global",
            title: "Global memory",
            content: "No channel set",
            channel: undefined,
            vectorScore: 0.85,
          }),
          candidate({
            memoryId: "same-peer",
            title: "Peer note",
            content: "Note from this peer channel",
            channel: "coder:general",
            vectorScore: 0.80,
          }),
        ],
        "coder:general",
        "some query"
      );

      const ids = results.map((r) => r.memoryId);
      expect(ids).not.toContain("global");
      expect(ids).toContain("same-peer");
    });

    it("still includes global memories in unscoped recall", () => {
      const results = filterAndRank(
        [
          candidate({
            memoryId: "global",
            title: "Global memory",
            content: "No channel set",
            channel: undefined,
            vectorScore: 0.85,
          }),
        ],
        "general",
        "some query"
      );

      expect(results.map((r) => r.memoryId)).toContain("global");
    });

    it("excludes global memories from peer-scoped coaching channels", () => {
      // Regression: personal memories like "daily voice notes to kids" were
      // leaking into peer-scoped coaching channels because global memories
      // (no channel) were treated as visible everywhere.
      const results = filterAndRank(
        [
          candidate({
            memoryId: "personal-global",
            title: "Daily voice notes",
            content: "Decision: Decided to send daily voice notes to the kids to maintain connection.",
            channel: undefined,
            vectorScore: 0.75,
            salienceScore: 0.6,
          }),
          candidate({
            memoryId: "peer-memory",
            title: "Coaching session note",
            content: "Discussed morning routine optimization with peer.",
            channel: "morrow-coach:8787596995",
            vectorScore: 0.70,
            salienceScore: 0.5,
          }),
        ],
        "morrow-coach:8787596995",
        "morning routine"
      );

      const ids = results.map((r) => r.memoryId);
      expect(ids).not.toContain("personal-global");
      expect(ids).toContain("peer-memory");
    });

    // Regression: live smoke 2026-04-04 — peer-scoped recall returned other
    // clients' memories stored under bare "morrow-coach".
    it("regression: bare-prefix coaching memories do not leak across peer channels", () => {
      const results = filterAndRank(
        [
          candidate({
            memoryId: "andy-peer",
            title: "Andy Doucet client profile",
            content: "Andy Doucet coaching session notes and goals.",
            channel: "morrow-coach:511172388",
            vectorScore: 0.90,
          }),
          candidate({
            memoryId: "kristen-legacy",
            title: "Kristen Knight coaching notes",
            content: "Kristen Knight session summary from legacy capture.",
            channel: "morrow-coach",
            vectorScore: 0.85,
          }),
          candidate({
            memoryId: "cory-legacy",
            title: "Cory G accountability plan",
            content: "Cory G weekly accountability check-in.",
            channel: "morrow-coach",
            vectorScore: 0.82,
          }),
          candidate({
            memoryId: "paul-legacy",
            title: "Paul Treacy goal setting",
            content: "Paul Treacy Q2 goal review.",
            channel: "morrow-coach",
            vectorScore: 0.80,
          }),
          candidate({
            memoryId: "bj-peer",
            title: "BJ Moffatt coaching notes",
            content: "BJ Moffatt session from peer channel.",
            channel: "morrow-coach:8787596995",
            vectorScore: 0.75,
          }),
        ],
        "morrow-coach:511172388",
        "Andy Doucet client profile"
      );

      const ids = results.map((r) => r.memoryId);
      // Only Andy's own peer-scoped memory should appear
      expect(ids).toContain("andy-peer");
      // Legacy bare-prefix memories must NOT leak
      expect(ids).not.toContain("kristen-legacy");
      expect(ids).not.toContain("cory-legacy");
      expect(ids).not.toContain("paul-legacy");
      // Other peer's scoped memories must NOT leak
      expect(ids).not.toContain("bj-peer");
    });

    it("gives continuityScore 0 to non-matching channel memories that pass visibility", () => {
      // A base-channel memory ("general") is visible in "coder:general" but
      // should have continuityScore=0 because the channels don't match exactly.
      // This is expected — visibility and continuity are separate concerns.
      const scored = scoreRecallCandidate(
        candidate({
          memoryId: "base-match",
          channel: "general",
          vectorScore: 0.8,
        }),
        { now, query: "test", channel: "coder:general" }
      );
      expect(scored.rankingSignals.continuityScore).toBe(0);

      // Exact peer match should get continuityScore=1
      const exactMatch = scoreRecallCandidate(
        candidate({
          memoryId: "exact-match",
          channel: "coder:general",
          vectorScore: 0.8,
        }),
        { now, query: "test", channel: "coder:general" }
      );
      expect(exactMatch.rankingSignals.continuityScore).toBe(1);
    });
  });
});
