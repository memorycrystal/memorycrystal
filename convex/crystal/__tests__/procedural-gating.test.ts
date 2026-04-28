import { describe, expect, it } from "vitest";
import { getWeakProceduralArchiveEligibility } from "../cleanup";
import { getProceduralRecallPenaltyMultiplier } from "../recall";

describe("procedural gating", () => {
  it("penalizes low-observation procedural memories during recall", () => {
    const lowConfidenceMultiplier = getProceduralRecallPenaltyMultiplier({
      store: "procedural",
      category: "workflow",
      metadata: JSON.stringify({ observationCount: 2 }),
    });
    const trustedMultiplier = getProceduralRecallPenaltyMultiplier({
      store: "procedural",
      category: "workflow",
      metadata: JSON.stringify({ observationCount: 3 }),
    });
    const approvedSkillMultiplier = getProceduralRecallPenaltyMultiplier({
      store: "procedural",
      category: "skill",
      metadata: JSON.stringify({ observationCount: 1 }),
    });

    expect(lowConfidenceMultiplier).toBe(0.5);
    expect(trustedMultiplier).toBe(1);
    expect(approvedSkillMultiplier).toBe(1);
  });

  it("archives weak procedural memories that go stale for 30 days", () => {
    const now = Date.now();
    const staleWeakWorkflow = getWeakProceduralArchiveEligibility(
      {
        store: "procedural",
        category: "workflow",
        metadata: JSON.stringify({
          observationCount: 2,
          lastObserved: now - 31 * 24 * 60 * 60 * 1000,
        }),
      },
      now
    );
    const reinforcedWorkflow = getWeakProceduralArchiveEligibility(
      {
        store: "procedural",
        category: "workflow",
        metadata: JSON.stringify({
          observationCount: 3,
          lastObserved: now - 45 * 24 * 60 * 60 * 1000,
        }),
      },
      now
    );

    expect(staleWeakWorkflow).toBe(true);
    expect(reinforcedWorkflow).toBe(false);
  });
});
