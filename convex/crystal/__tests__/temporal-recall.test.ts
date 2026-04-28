import { describe, expect, it } from "vitest";
import { parseTemporalReference } from "../temporalParser";

const now = Date.parse("2026-04-01T18:30:00.000Z");

const rangeForDay = (year: number, monthIndex: number, day: number) => ({
  startMs: Date.UTC(year, monthIndex, day, 0, 0, 0, 0),
  endMs: Date.UTC(year, monthIndex, day, 23, 59, 59, 999),
});

describe("parseTemporalReference", () => {
  it("parses written dates without an explicit year", () => {
    expect(parseTemporalReference("what happened March 14", now)).toEqual(rangeForDay(2026, 2, 14));
  });

  it("parses yesterday relative to now", () => {
    expect(parseTemporalReference("yesterday", now)).toEqual(rangeForDay(2026, 2, 31));
  });

  it("parses last week as a monday through sunday range", () => {
    expect(parseTemporalReference("what happened last week", now)).toEqual({
      startMs: Date.UTC(2026, 2, 23, 0, 0, 0, 0),
      endMs: Date.UTC(2026, 2, 29, 23, 59, 59, 999),
    });
  });

  it("parses two weeks ago as the full prior week window", () => {
    expect(parseTemporalReference("two weeks ago", now)).toEqual({
      startMs: Date.UTC(2026, 2, 16, 0, 0, 0, 0),
      endMs: Date.UTC(2026, 2, 22, 23, 59, 59, 999),
    });
  });

  it("parses month references", () => {
    expect(parseTemporalReference("in March", now)).toEqual({
      startMs: Date.UTC(2026, 2, 1, 0, 0, 0, 0),
      endMs: Date.UTC(2026, 2, 31, 23, 59, 59, 999),
    });
  });

  it("parses day-name references as the most recent matching day", () => {
    expect(parseTemporalReference("on Tuesday", now)).toEqual(rangeForDay(2026, 2, 31));
  });

  it("returns null for non-temporal queries", () => {
    expect(parseTemporalReference("how do I deploy", now)).toBeNull();
  });

  it("parses iso dates", () => {
    expect(parseTemporalReference("2026-03-14", now)).toEqual(rangeForDay(2026, 2, 14));
  });
});
