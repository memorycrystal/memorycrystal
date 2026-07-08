import { describe, expect, it } from "vitest";
import { shouldEnrich, MAX_ENRICHMENT_ATTEMPTS, STRENGTH_FLOOR } from "../enrichmentEligibility";

describe("shouldEnrich — M1 sensory-tier skip", () => {
  it("returns ok=false with reason=sensory_skip when store=sensory", () => {
    const result = shouldEnrich({ store: "sensory" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sensory_skip");
  });

  it("returns ok=false with reason=sensory_skip when tier=sensory (forward-compat)", () => {
    const result = shouldEnrich({ tier: "sensory" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sensory_skip");
  });

  it("returns ok=true for store=episodic", () => {
    const result = shouldEnrich({ store: "episodic" });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns ok=true for store=semantic", () => {
    const result = shouldEnrich({ store: "semantic" });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns ok=true when store is undefined", () => {
    const result = shouldEnrich({});
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe("shouldEnrich — M2 attempt cap", () => {
  it("returns ok=true when attempts=0", () => {
    const result = shouldEnrich({ store: "episodic", attempts: 0 });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns ok=true when attempts is below the cap", () => {
    const result = shouldEnrich({ store: "episodic", attempts: MAX_ENRICHMENT_ATTEMPTS - 1 });
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with reason=max_attempts_exceeded when attempts >= MAX_ENRICHMENT_ATTEMPTS", () => {
    const result = shouldEnrich({ store: "episodic", attempts: MAX_ENRICHMENT_ATTEMPTS });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_attempts_exceeded");
  });

  it("returns ok=false with reason=max_attempts_exceeded when attempts exceeds cap", () => {
    const result = shouldEnrich({ store: "episodic", attempts: MAX_ENRICHMENT_ATTEMPTS + 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_attempts_exceeded");
  });

  it("returns ok=false when enrichmentSkippedReason is set (permanent DB skip)", () => {
    const result = shouldEnrich({ store: "episodic", enrichmentSkippedReason: "max_attempts_exceeded" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_attempts_exceeded");
  });

  it("returns ok=false when enrichmentSkippedReason is a custom string", () => {
    const result = shouldEnrich({ enrichmentSkippedReason: "sensory_skip" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sensory_skip");
  });

  it("sensory skip wins over attempts > 0 (M1 checked first)", () => {
    // Combined: sensory store + non-zero attempts — sensory_skip should be returned first
    const result = shouldEnrich({ store: "sensory", attempts: 3 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sensory_skip");
  });

  it("returns ok=true when attempts is undefined (legacy rows without field)", () => {
    const result = shouldEnrich({ store: "episodic" });
    expect(result.ok).toBe(true);
  });
});

describe("shouldEnrich — M5 strength floor", () => {
  it("STRENGTH_FLOOR is 0.3", () => {
    expect(STRENGTH_FLOOR).toBe(0.3);
  });

  it("returns ok=false with reason=below_strength_floor when strength < floor and accessCount === 0", () => {
    const result = shouldEnrich({ store: "episodic", strength: 0.2, accessCount: 0 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("below_strength_floor");
  });

  it("returns ok=true when strength below floor but accessCount > 0 (already recalled)", () => {
    const result = shouldEnrich({ store: "episodic", strength: 0.2, accessCount: 1 });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns ok=true when strength is exactly at the floor", () => {
    const result = shouldEnrich({ store: "episodic", strength: STRENGTH_FLOOR, accessCount: 0 });
    expect(result.ok).toBe(true);
  });

  it("returns ok=true when strength is above the floor", () => {
    const result = shouldEnrich({ store: "episodic", strength: 0.9, accessCount: 0 });
    expect(result.ok).toBe(true);
  });

  it("returns ok=true for KB parents below floor (KB parents always enrich)", () => {
    const result = shouldEnrich({
      store: "semantic",
      strength: 0.1,
      accessCount: 0,
      isKbParent: true,
    });
    expect(result.ok).toBe(true);
  });

  it("treats accessCount=undefined as 0 (legacy rows)", () => {
    const result = shouldEnrich({ store: "episodic", strength: 0.2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("below_strength_floor");
  });

  it("does not skip when strength is undefined (no strength signal)", () => {
    const result = shouldEnrich({ store: "episodic", accessCount: 0 });
    expect(result.ok).toBe(true);
  });

  it("M1 sensory_skip wins over M5 floor", () => {
    const result = shouldEnrich({ store: "sensory", strength: 0.1, accessCount: 0 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sensory_skip");
  });

  it("M2 max_attempts wins over M5 floor", () => {
    const result = shouldEnrich({
      store: "episodic",
      strength: 0.1,
      accessCount: 0,
      attempts: MAX_ENRICHMENT_ATTEMPTS,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_attempts_exceeded");
  });

  it("M2 enrichmentSkippedReason wins over M5 floor", () => {
    const result = shouldEnrich({
      store: "episodic",
      strength: 0.1,
      accessCount: 0,
      enrichmentSkippedReason: "below_strength_floor",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("below_strength_floor");
  });
});
