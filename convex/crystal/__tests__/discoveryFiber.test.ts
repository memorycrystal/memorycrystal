import { describe, expect, it } from "vitest";
import { areIdeaTitlesSimilar, filterIdeaCandidates } from "../organic/discoveryFiber";

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
      5
    );

    expect(accepted).toHaveLength(4);
    expect(accepted.map((idea) => idea.title)).toEqual([
      "Connect project pressure to sleep quality",
      "Track recurring context switching costs",
      "Convert unresolved notes into explicit next actions",
      "Link repeated tool churn to missing process decisions",
    ]);
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
