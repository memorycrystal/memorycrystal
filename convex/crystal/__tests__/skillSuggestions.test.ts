import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import {
  clusterFailedQueries,
  classifyRecallOutcomes,
  findMatchingSuggestionByEmbedding,
} from "../organic/skillSuggestions";

const modules = {
  "_generated/api": () => import("../../_generated/api.js"),
  "_generated/server": () => import("../../_generated/server.js"),
  "crystal/auth": () => import("../auth"),
  "crystal/organic/skillSuggestions": () => import("../organic/skillSuggestions"),
  "crystal/memories": () => import("../memories"),
  "crystal/dashboardTotals": () => import("../dashboardTotals"),
  "crystal/contentScanner": () => import("../contentScanner"),
  "crystal/organic/activityLog": () => import("../organic/activityLog"),
};

const user = { subject: "skill_suggestions_user", tokenIdentifier: "token_skill_suggestions", issuer: "test" };

describe("organic skill suggestions", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("clusters 3 or more similar failed queries into a significant topic", () => {
    const clusters = clusterFailedQueries([
      { query: "how do i debug railway deploy failures", embedding: [1, 0, 0] },
      { query: "debugging railway deployment failure logs", embedding: [0.96, 0.04, 0] },
      { query: "railway deploy rollback troubleshooting", embedding: [0.95, 0.05, 0] },
      { query: "kitchen shopping list", embedding: [0, 1, 0] },
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.queries).toEqual([
      "how do i debug railway deploy failures",
      "debugging railway deployment failure logs",
      "railway deploy rollback troubleshooting",
    ]);
  });

  it("detects when a cluster is already covered by an existing suggestion embedding", () => {
    const match = findMatchingSuggestionByEmbedding([1, 0, 0], [
      {
        _id: "existing" as never,
        skillName: "railway-deploy-debugging",
        description: "Handle repeated deploy failures on Railway",
        content: "# railway deploy debugging",
        evidence: [],
        confidence: 0.8,
        status: "pending",
        generation: 1,
        createdAt: 1,
      },
    ], [[0.98, 0.02, 0]]);

    expect(match?.skillName).toBe("railway-deploy-debugging");
  });

  it("treats queries with results but no follow-up as ambiguous instead of failures", () => {
    const createdAt = 1_700_000_000_000;
    const outcomes = classifyRecallOutcomes(
      [
        {
          _id: "log-1" as never,
          _creationTime: createdAt,
          userId: user.subject,
          query: "find the deploy checklist",
          resultCount: 2,
          topResultIds: ["memory-1" as never, "memory-2" as never],
          source: "test",
          createdAt,
        } as any,
        {
          _id: "log-2" as never,
          _creationTime: createdAt + 1,
          userId: user.subject,
          query: "find a missing memory",
          resultCount: 0,
          topResultIds: [],
          source: "test",
          createdAt: createdAt + 1,
        } as any,
      ],
      []
    );

    expect(outcomes.failed.map((log) => log.query)).toEqual(["find a missing memory"]);
    expect(outcomes.successful.map((log) => log.query)).toEqual(["find the deploy checklist"]);
  });

  it("creates a linked skill suggestion and idea record", async () => {
    const result: any = await (t as any).mutation("crystal/organic/skillSuggestions:createSkillSuggestionRecord", {
      userId: user.subject,
      tickId: "tick_1",
      skillName: "deploy-troubleshooting",
      description: "Handle recurring deploy failures.",
      content: "# deploy-troubleshooting\n\nUse this when deploys fail repeatedly.",
      evidence: [
        {
          type: "recall_failure",
          query: "how do i fix a failed deploy",
          detail: "No successful recall result was later used.",
        },
      ],
      confidence: 0.78,
      generation: 1,
    });

    const suggestion = await t.run(async (ctx) => ctx.db.get(result.suggestionId));
    const idea = await t.run(async (ctx) => ctx.db.get(result.ideaId));

    expect(suggestion?.ideaId).toBe(result.ideaId);
    expect(suggestion?.status).toBe("pending");
    expect(idea?.ideaType).toBe("skill_suggestion");
    expect(idea?.title).toBe("Skill suggestion: deploy-troubleshooting");
  });

  it("updates suggestion status, normalizes SKILL.md content, and activates a skill memory", async () => {
    const { suggestionId, ideaId } = await (t as any).mutation("crystal/organic/skillSuggestions:createSkillSuggestionRecord", {
      userId: user.subject,
      tickId: "tick_2",
      skillName: "deploy-troubleshooting",
      description: "Handle recurring deploy failures.",
      content: "# deploy-troubleshooting\n\nUse this when deploys fail repeatedly.",
      evidence: [
        {
          type: "pattern_cluster",
          detail: "Three similar failed deploy queries were observed.",
        },
      ],
      confidence: 0.78,
      generation: 1,
    });

    await (t as any).withIdentity(user).mutation("crystal/organic/skillSuggestions:updateSkillSuggestionStatus", {
      suggestionId,
      status: "modified",
      modifiedContent: "# deploy-troubleshooting\n\n1. Inspect logs\n2. Roll back safely",
    });

    const suggestion = await t.run(async (ctx) => ctx.db.get(suggestionId));
    const idea = await t.run(async (ctx) => ctx.db.get(ideaId));
    const activatedMemory = suggestion?.activatedMemoryId
      ? await t.run(async (ctx) => ctx.db.get(suggestion.activatedMemoryId!))
      : null;

    expect(suggestion?.status).toBe("modified");
    expect(suggestion?.acceptedAt).toEqual(expect.any(Number));
    expect(suggestion?.content).toContain("# Deploy Troubleshooting");
    expect(suggestion?.content).toContain("## Trigger Conditions");
    expect(suggestion?.content).toContain("Inspect logs");
    expect(suggestion?.activatedMemoryId).toBeTruthy();
    expect(idea?.status).toBe("read");
    expect(activatedMemory?.category).toBe("skill");
    expect(activatedMemory?.store).toBe("procedural");
    expect(activatedMemory?.title).toBe("Deploy Troubleshooting");
    expect(activatedMemory?.metadata).toContain("\"suggestionId\"");
  });

  it("lists the authenticated user's suggestions in reverse chronological order", async () => {
    await (t as any).mutation("crystal/organic/skillSuggestions:createSkillSuggestionRecord", {
      userId: user.subject,
      tickId: "tick_3",
      skillName: "first-skill",
      description: "First",
      content: "# first-skill",
      evidence: [{ type: "pattern_cluster", detail: "Cluster one" }],
      confidence: 0.6,
      generation: 1,
    });

    await (t as any).mutation("crystal/organic/skillSuggestions:createSkillSuggestionRecord", {
      userId: user.subject,
      tickId: "tick_4",
      skillName: "second-skill",
      description: "Second",
      content: "# second-skill",
      evidence: [{ type: "pattern_cluster", detail: "Cluster two" }],
      confidence: 0.7,
      generation: 2,
    });

    const suggestions: any[] = await (t as any).withIdentity(user).query("crystal/organic/skillSuggestions:getMySkillSuggestions", {});

    expect(suggestions.map((suggestion: any) => suggestion.skillName)).toEqual([
      "second-skill",
      "first-skill",
    ]);
  });
});
