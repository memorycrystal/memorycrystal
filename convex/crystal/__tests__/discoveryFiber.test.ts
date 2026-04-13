import { describe, expect, it } from "vitest";
import { areIdeaTitlesSimilar, filterIdeaCandidates, normalizeIdeaFrequency } from "../organic/discoveryFiber";

describe("discovery fiber idea filtering", () => {
  it("filters weak, duplicate, and oversized idea sets", () => {
    const accepted = filterIdeaCandidates(
      [
        {
          title: "Improve weekly planning cadence",
          summary: "Recurring work fragments and deadline collisions suggest the user needs a tighter weekly planning ritual.",
          ideaType: "action_suggested",
          confidence: 0.76,
          sourceMemoryIds: ["mem1", "mem2"],
          sourceEnsembleIds: ["ens1"],
        },
        {
          title: "Short",
          summary: "This summary is long enough to pass but the title is not.",
          ideaType: "insight",
          confidence: 0.8,
          sourceMemoryIds: ["mem1"],
        },
        {
          title: "Improve weekly planning cadence!!!",
          summary: "A duplicate variant should be removed even if punctuation and casing differ from a recent idea title.",
          ideaType: "action_suggested",
          confidence: 0.82,
          sourceMemoryIds: ["mem2"],
        },
        {
          title: "Connect project pressure to sleep quality",
          summary: "Multiple clusters imply project stress is consistently bleeding into recovery habits and lowering sleep quality over time.",
          ideaType: "connection",
          confidence: 0.62,
          sourceMemoryIds: ["mem3", "mem4"],
        },
        {
          title: "Track recurring context switching costs",
          summary: "Recent contradictions and resonances both point to hidden switching costs that keep resurfacing during planning and execution.",
          ideaType: "pattern",
          confidence: 0.59,
          sourceMemoryIds: ["mem5"],
        },
        {
          title: "Convert unresolved notes into explicit next actions",
          summary: "The pulse keeps surfacing open loops without commitments, which suggests the user should turn vague notes into explicit next actions.",
          ideaType: "action_suggested",
          confidence: 0.67,
          sourceMemoryIds: ["mem6"],
        },
        {
          title: "Link repeated tool churn to missing process decisions",
          summary: "The latest pulse implies tooling churn is a symptom of unresolved process choices rather than a tooling problem by itself.",
          ideaType: "insight",
          confidence: 0.74,
          sourceMemoryIds: ["mem7"],
        },
        {
          title: "Low confidence but otherwise valid title",
          summary: "This summary would pass the length gate, but the idea should still be filtered out because the confidence is too low.",
          ideaType: "insight",
          confidence: 0.2,
          sourceMemoryIds: ["mem8"],
        },
      ],
      ["Improve weekly planning cadence"],
      { limit: 5 }
    );

    expect(accepted).toHaveLength(4);
    expect(accepted.map((idea) => idea.title)).toEqual([
      "Connect project pressure to sleep quality",
      "Track recurring context switching costs",
      "Convert unresolved notes into explicit next actions",
      "Link repeated tool churn to missing process decisions",
    ]);
  });


  it("adjusts idea acceptance thresholds by idea frequency", () => {
    const candidates: Array<{
      title: string;
      summary: string;
      ideaType: "insight" | "action_suggested" | "pattern" | "connection";
      confidence: number;
      sourceMemoryIds: string[];
    }> = [
      {
        title: "Surface lower-confidence recurring insight",
        summary: "This candidate should only pass when the engine is configured to be more aggressive about surfacing ideas from pulse findings.",
        ideaType: "insight",
        confidence: 0.25,
        sourceMemoryIds: ["mem1"],
      },
      {
        title: "Keep only strong recommendation",
        summary: "This candidate should survive even conservative mode because the confidence is comfortably above the stricter threshold.",
        ideaType: "action_suggested",
        confidence: 0.81,
        sourceMemoryIds: ["mem2"],
      },
      {
        title: "Third plausible idea in the batch",
        summary: "This candidate helps show that conservative mode trims the number of accepted ideas even when additional valid ideas are available.",
        ideaType: "pattern",
        confidence: 0.6,
        sourceMemoryIds: ["mem3"],
      },
      {
        title: "Fourth plausible idea in the batch",
        summary: "This one also qualifies so we can observe the max-ideas cap tightening as the frequency becomes more conservative.",
        ideaType: "connection",
        confidence: 0.58,
        sourceMemoryIds: ["mem4"],
      },
    ];

    expect(normalizeIdeaFrequency("weird-value")).toBe("balanced");

    const aggressive = filterIdeaCandidates(candidates, [], { ideaFrequency: "aggressive" });
    const conservative = filterIdeaCandidates(candidates, [], { ideaFrequency: "conservative" });

    expect(aggressive.map((idea) => idea.title)).toContain("Surface lower-confidence recurring insight");
    expect(conservative.map((idea) => idea.title)).not.toContain("Surface lower-confidence recurring insight");
    expect(conservative).toHaveLength(3);
  });

  it("treats normalized titles as similar when wording is nearly identical", () => {
    expect(
      areIdeaTitlesSimilar(
        "Improve weekly planning cadence",
        "improve the weekly planning cadence"
      )
    ).toBe(true);

    expect(
      areIdeaTitlesSimilar(
        "Connect project pressure to sleep quality",
        "Surface cross-domain sleep recovery insight"
      )
    ).toBe(false);
  });
});
