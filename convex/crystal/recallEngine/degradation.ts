import type { CostBudgetResult, TieredVectorReachPolicy } from "../recallBudgetPolicy";
import type { DegradationTracker, RecallDegradation, UpgradePrompt } from "./types";

function selectUpgradePrompt(
  current?: UpgradePrompt,
  next?: UpgradePrompt,
): UpgradePrompt | undefined {
  if (!current) return next;
  if (!next) return current;
  if (current.targetTier !== "ultra" && next.targetTier === "ultra") return next;
  return current;
}

function degradationSnapshot(entry: RecallDegradation): Record<string, unknown> {
  return {
    code: entry.code,
    message: entry.message,
    recoverable: entry.recoverable,
    affectedStage: entry.affectedStage,
    reason: entry.reason,
    surface: entry.surface,
    scope: entry.scope,
    resetsAt: entry.resetsAt,
    tier: entry.tier,
    vectorDepth: entry.vectorDepth,
    budgetLevel: entry.budgetLevel,
    upgradePrompt: entry.upgradePrompt,
  };
}

export function createDegradationTracker(): DegradationTracker {
  let degradation: RecallDegradation | undefined;
  return {
    current: () => degradation,
    mark(next: RecallDegradation) {
      if (!degradation) {
        degradation = next;
        return;
      }
      const reasons = Array.from(
        new Set(
          [degradation.reason, next.reason]
            .flatMap((reason) => (typeof reason === "string" ? reason.split(",") : []))
            .map((reason) => reason.trim())
            .filter((reason) => reason.length > 0),
        ),
      );
      degradation = {
        ...degradation,
        reason: reasons.length > 0 ? reasons.join(",") : degradation.reason,
        surface: degradation.surface ?? next.surface,
        scope: degradation.scope ?? next.scope,
        resetsAt: degradation.resetsAt ?? next.resetsAt,
        upgradePrompt: selectUpgradePrompt(degradation.upgradePrompt, next.upgradePrompt),
        relatedDegradations: [
          ...(degradation.relatedDegradations ?? [degradationSnapshot(degradation)]),
          degradationSnapshot(next),
        ],
      };
    },
  };
}

export function markRecallCostDegradation(
  tracker: DegradationTracker,
  input: {
    message: string;
    affectedStage: string;
    policy: TieredVectorReachPolicy;
    budget: CostBudgetResult | null;
  },
): void {
  tracker.mark({
    code: "cost_budget_exceeded",
    message: input.message,
    recoverable: true,
    affectedStage: input.affectedStage,
    reason: input.policy.reasons.join(","),
    surface: input.budget?.degradation?.surface,
    scope: input.budget?.degradation?.scope,
    resetsAt: input.budget?.degradation?.resetsAt,
    tier: input.policy.tier,
    vectorDepth: input.policy.vectorDepth,
    budgetLevel: input.policy.budgetLevel,
  });
}
