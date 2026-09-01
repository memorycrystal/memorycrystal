import { afterEach, describe, expect, it } from "vitest";
import {
  organicPolicyTunerEnabled,
  organicTracesEnabled,
} from "../flags";

const TRACE_KEYS = ["CRYSTAL_TRACES_ENABLED", "CRYSTAL_TRACES_DISABLED"] as const;
const TUNER_KEY = "CRYSTAL_POLICY_TUNER_ENABLED";

afterEach(() => {
  for (const key of TRACE_KEYS) delete process.env[key];
  delete process.env[TUNER_KEY];
});

describe("organicTracesEnabled", () => {
  it("is off by default", () => {
    expect(organicTracesEnabled()).toBe(false);
  });

  it("turns on only when CRYSTAL_TRACES_ENABLED=1", () => {
    process.env.CRYSTAL_TRACES_ENABLED = "1";
    expect(organicTracesEnabled()).toBe(true);
  });

  it("stays off when DISABLED=1 even if ENABLED=1", () => {
    process.env.CRYSTAL_TRACES_ENABLED = "1";
    process.env.CRYSTAL_TRACES_DISABLED = "1";
    expect(organicTracesEnabled()).toBe(false);
  });
});

describe("organicPolicyTunerEnabled", () => {
  it("is off by default", () => {
    expect(organicPolicyTunerEnabled()).toBe(false);
  });

  it("turns on only when CRYSTAL_POLICY_TUNER_ENABLED=1", () => {
    process.env.CRYSTAL_POLICY_TUNER_ENABLED = "1";
    expect(organicPolicyTunerEnabled()).toBe(true);
  });
});
