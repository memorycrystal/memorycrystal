export type RecallMode =
  | "general"
  | "decision"
  | "project"
  | "people"
  | "preflight"
  | "workflow"
  | "conversation";

/**
 * Ranking preferences and default limits. Store/category lists are descriptive
 * mode preferences only; normalize.ts never turns them into hard filters.
 */
export const RECALL_MODE_PRESETS: Record<
  RecallMode,
  { stores?: string[]; categories?: string[]; limit?: number }
> = {
  general: {},
  decision: {
    stores: ["semantic", "episodic"],
    categories: ["decision", "lesson", "rule"],
    limit: 12,
  },
  project: {
    stores: ["semantic", "episodic", "procedural"],
    categories: ["goal", "workflow", "skill", "decision", "fact"],
    limit: 12,
  },
  people: {
    stores: ["semantic", "episodic"],
    categories: ["person", "decision", "event"],
    limit: 8,
  },
  preflight: {
    stores: ["procedural"],
    categories: ["rule", "lesson", "workflow", "skill", "decision"],
    limit: 10,
  },
  workflow: {
    stores: ["procedural", "semantic"],
    categories: ["workflow", "skill", "rule", "lesson"],
    limit: 10,
  },
  conversation: {
    stores: ["sensory", "episodic"],
    categories: ["conversation", "event"],
    limit: 6,
  },
};

export function presetForMode(mode: string): {
  stores?: string[];
  categories?: string[];
  limit?: number;
} {
  return RECALL_MODE_PRESETS[mode as RecallMode] ?? RECALL_MODE_PRESETS.general;
}
