/**
 * ILL-272 — additive recall stage timings for `/api/mcp/recall`.
 *
 * Pure helpers so convex-test can assert the diagnostics.timings shape without
 * hitting Railway. Values are milliseconds. The object must never carry memory
 * bodies, transcripts, or secrets — only numeric stage durations plus an
 * optional parallel flag when stages overlap.
 */

export const RECALL_TIMING_STAGE_KEYS = [
  "embed",
  "vectorSearch",
  "lexical",
  "kb",
  "messages",
  "graph",
  "compose",
  "total",
] as const;

export type RecallTimingStage = (typeof RECALL_TIMING_STAGE_KEYS)[number];

export type RecallTimings = {
  embed: number;
  vectorSearch: number;
  lexical: number;
  kb: number;
  messages: number;
  graph: number;
  compose: number;
  total: number;
  parallel?: boolean;
};

const MEMORY_BODY_KEYS = new Set([
  "content",
  "title",
  "memories",
  "messageMatches",
  "text",
  "body",
  "transcript",
  "extractedText",
  "summary",
]);

function asNonNegativeMs(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.round(numeric);
}

export function createRecallStageTimer() {
  const ms: Record<string, number> = {};
  return {
    async measure<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        ms[name] = (ms[name] ?? 0) + Math.max(0, Date.now() - start);
      }
    },
    add(name: string, durationMs: number) {
      ms[name] = (ms[name] ?? 0) + asNonNegativeMs(durationMs);
    },
    get(name: string): number {
      return asNonNegativeMs(ms[name] ?? 0);
    },
    snapshot(): Record<string, number> {
      return { ...ms };
    },
  };
}

export function finalizeRecallTimings(args: {
  stages: Partial<Omit<RecallTimings, "total" | "parallel">>;
  totalMs: number;
  parallel?: boolean;
}): RecallTimings {
  const timings: RecallTimings = {
    embed: asNonNegativeMs(args.stages.embed),
    vectorSearch: asNonNegativeMs(args.stages.vectorSearch),
    lexical: asNonNegativeMs(args.stages.lexical),
    kb: asNonNegativeMs(args.stages.kb),
    messages: asNonNegativeMs(args.stages.messages),
    graph: asNonNegativeMs(args.stages.graph),
    compose: asNonNegativeMs(args.stages.compose),
    total: asNonNegativeMs(args.totalMs),
  };
  if (args.parallel) timings.parallel = true;
  return timings;
}

export function isNumericRecallTimings(value: unknown): value is RecallTimings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of RECALL_TIMING_STAGE_KEYS) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) {
      return false;
    }
  }
  if (record.parallel !== undefined && typeof record.parallel !== "boolean") {
    return false;
  }
  return true;
}

/** True when a timings object contains fields that look like memory bodies. */
export function recallTimingsContainMemoryBodies(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return true;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (MEMORY_BODY_KEYS.has(key)) return true;
    if (key === "parallel") {
      if (typeof entry !== "boolean") return true;
      continue;
    }
    if (typeof entry === "string") return true;
    if (Array.isArray(entry)) return true;
    if (entry !== null && typeof entry === "object") return true;
    if (typeof entry !== "number" || !Number.isFinite(entry)) return true;
  }
  return false;
}
