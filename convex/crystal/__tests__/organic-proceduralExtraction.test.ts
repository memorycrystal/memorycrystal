import { describe, expect, it } from "vitest";
import {
  MAX_PROCEDURALS_PER_TICK,
  MIN_OBSERVATIONS_TO_CREATE,
  buildHumanReadableContent,
  mergeProceduralMetadata,
  parseProceduralMetadata,
} from "../organic/proceduralExtraction";

describe("organic procedural metadata helpers", () => {
  it("tightens procedural extraction gates", () => {
    expect(MAX_PROCEDURALS_PER_TICK).toBe(1);
    expect(MIN_OBSERVATIONS_TO_CREATE).toBe(2);
  });

  it("merges trigger conditions, pitfalls, and steps while increasing observation count", () => {
    const existing = parseProceduralMetadata(
      JSON.stringify({
        skillFormat: true,
        triggerConditions: ["when a deploy fails"],
        steps: [{ order: 1, action: "Check logs" }],
        pitfalls: ["Do not redeploy blind"],
        verification: "The deployment succeeds",
        patternType: "workflow",
        observationCount: 2,
        lastObserved: 100,
      })
    );

    const merged = mergeProceduralMetadata(existing, {
      title: "How to recover a failed deploy",
      content: "Recover a failed deployment safely.",
      sourceMemoryIndices: [0, 1],
      patternType: "workflow",
      observationCount: 3,
      triggerConditions: ["when a deploy fails", "when rollout errors appear"],
      steps: [
        { order: 1, action: "Check logs" },
        { order: 2, action: "Rollback to last good build", command: "pnpm release:rollback" },
      ],
      pitfalls: ["Do not redeploy blind", "Confirm the rollback target first"],
      verification: "Traffic stabilizes and the health checks pass",
    });

    expect(merged.triggerConditions).toEqual([
      "when a deploy fails",
      "when rollout errors appear",
    ]);
    expect(merged.steps).toEqual([
      { order: 1, action: "Check logs" },
      { order: 2, action: "Rollback to last good build", command: "pnpm release:rollback" },
    ]);
    expect(merged.pitfalls).toEqual([
      "Do not redeploy blind",
      "Confirm the rollback target first",
    ]);
    expect(merged.verification).toBe("Traffic stabilizes and the health checks pass");
    expect(merged.observationCount).toBe(5);
  });

  it("builds readable content sections from structured metadata", () => {
    const metadata = parseProceduralMetadata(
      JSON.stringify({
        skillFormat: true,
        triggerConditions: ["when the API key fails"],
        steps: [{ order: 1, action: "Rotate the key" }],
        pitfalls: ["Do not forget dependent services"],
        verification: "The API responds with 200s again",
        patternType: "workflow",
        observationCount: 1,
        lastObserved: 100,
      })
    );

    const content = buildHumanReadableContent(
      { content: "Recover an expired API key." },
      metadata!
    );

    expect(content).toContain("Trigger conditions:");
    expect(content).toContain("1. Rotate the key");
    expect(content).toContain("Verification:");
  });
});
