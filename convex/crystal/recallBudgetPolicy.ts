import type { UserTier } from "../../shared/tierLimits";

export const COST_UNIT_BYTES = {
  vectorQuery: 820 * 1024 * 1024,
  textIndexQuery: 60 * 1024 * 1024,
};

export const RECALL_TEXT_INDEX_COUNT = 3;

export const FULL_RECALL_CHARGE = {
  vectorBytes: COST_UNIT_BYTES.vectorQuery,
  textBytes: COST_UNIT_BYTES.textIndexQuery * RECALL_TEXT_INDEX_COUNT,
};

export type CostBudgetResult = {
  status: "ok" | "warn" | "emergency";
  emergency: boolean;
  vectorEmergency?: boolean;
  textEmergency?: boolean;
  degradation?: {
    reason: string;
    surface: string;
    scope: string;
    scopeId: string;
    resetsAt?: number;
  };
};

export type TieredVectorReachPolicy = {
  tier: UserTier;
  vectorDepth: number;
  vectorAllowed: boolean;
  textAllowed: boolean;
  indexedFallbackAllowed: boolean;
  degraded: boolean;
  budgetLevel: "normal" | "limited" | "blocked";
  reasons: string[];
};

/**
 * The cost breaker is a cost/load guard on any backend, not specific to
 * Convex Cloud. Disable it by setting `MC_COST_BREAKER_ENABLED=0` in a
 * self-hosted deployment.
 */
export function isCostBreakerEnabled(): boolean {
  return process.env.MC_COST_BREAKER_ENABLED !== "0";
}

const DEGRADED_VECTOR_DEPTH_BY_TIER: Partial<Record<UserTier, number>> = {
  starter: 5,
  pro: 25,
};

function hasExplicitDimensionFlags(budget?: CostBudgetResult | null): boolean {
  return (
    typeof budget?.vectorEmergency === "boolean" ||
    typeof budget?.textEmergency === "boolean"
  );
}

function isVectorBudgetLimited(budget?: CostBudgetResult | null): boolean {
  if (!budget?.emergency) return false;
  if (budget.vectorEmergency === true) return true;
  return !hasExplicitDimensionFlags(budget);
}

function isTextBudgetLimited(budget?: CostBudgetResult | null): boolean {
  if (!budget?.emergency) return false;
  if (budget.textEmergency === true) return true;
  return !hasExplicitDimensionFlags(budget);
}

export function mergeCostBudgetResults(
  userBudget: CostBudgetResult,
  globalBudget: CostBudgetResult,
): CostBudgetResult {
  const mergeDimensionFlag = (
    left?: boolean,
    right?: boolean,
  ): boolean | undefined => {
    if (left === true || right === true) return true;
    if (left === false && right === false) return false;
    if (typeof left === "boolean" && right === undefined) return left;
    if (typeof right === "boolean" && left === undefined) return right;
    return undefined;
  };

  return {
    status: globalBudget.emergency ? globalBudget.status : userBudget.status,
    emergency: userBudget.emergency || globalBudget.emergency,
    vectorEmergency: mergeDimensionFlag(
      userBudget.vectorEmergency,
      globalBudget.vectorEmergency,
    ),
    textEmergency: mergeDimensionFlag(
      userBudget.textEmergency,
      globalBudget.textEmergency,
    ),
    degradation: globalBudget.degradation ?? userBudget.degradation,
  };
}

export function resolveTieredVectorReachPolicy(args: {
  tier: UserTier;
  normalVectorDepth: number;
  vectorBudget?: CostBudgetResult | null;
  textBudget?: CostBudgetResult | null;
  indexedFallbackAllowedOnDegradation?: boolean;
}): TieredVectorReachPolicy {
  const normalVectorDepth = Math.max(0, Math.floor(args.normalVectorDepth));
  const vectorBudgetLimited = isVectorBudgetLimited(args.vectorBudget);
  const textBudgetLimited = isTextBudgetLimited(args.textBudget);

  if (args.tier === "ultra" || args.tier === "unlimited") {
    return {
      tier: args.tier,
      vectorDepth: normalVectorDepth,
      vectorAllowed: normalVectorDepth > 0,
      textAllowed: true,
      indexedFallbackAllowed: false,
      degraded: false,
      budgetLevel: "normal",
      reasons: [],
    };
  }

  const reasons: string[] = [];
  let vectorDepth = normalVectorDepth;

  if (vectorBudgetLimited) {
    if (args.tier === "free") {
      vectorDepth = 0;
      reasons.push("vector_budget_exceeded");
    } else {
      const tierDepth = DEGRADED_VECTOR_DEPTH_BY_TIER[args.tier] ?? 0;
      vectorDepth = Math.min(tierDepth, normalVectorDepth);
      reasons.push("vector_budget_limited", `${args.tier}_vector_depth_applied`);
    }
  }

  if (textBudgetLimited) {
    reasons.push("text_budget_exceeded");
  }

  const degraded = reasons.length > 0;

  return {
    tier: args.tier,
    vectorDepth,
    vectorAllowed: vectorDepth > 0,
    textAllowed: !textBudgetLimited,
    indexedFallbackAllowed:
      degraded && !!args.indexedFallbackAllowedOnDegradation,
    degraded,
    budgetLevel:
      degraded && vectorDepth === 0 && vectorBudgetLimited ? "blocked" : degraded ? "limited" : "normal",
    reasons,
  };
}
