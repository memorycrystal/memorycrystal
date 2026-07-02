import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const DAY_MS = 24 * 60 * 60 * 1000;

const surfaceValidator = v.union(
  v.literal("recall"),
  v.literal("kb"),
  v.literal("messages"),
  v.literal("organic"),
  v.literal("cleanup"),
  v.literal("embedding"),
  v.literal("counter"),
);

type Surface =
  | "recall"
  | "kb"
  | "messages"
  | "organic"
  | "cleanup"
  | "embedding"
  | "counter";
type Scope = "global" | "user";

type Thresholds = {
  warnVectorBytes: number;
  emergencyVectorBytes: number;
  warnTextBytes: number;
  emergencyTextBytes: number;
};

const DEFAULT_THRESHOLDS: Record<Scope, Thresholds> = {
  global: {
    warnVectorBytes: 10 * GB,
    emergencyVectorBytes: 25 * GB,
    warnTextBytes: 1 * GB,
    emergencyTextBytes: 5 * GB,
  },
  user: {
    warnVectorBytes: 1 * GB,
    emergencyVectorBytes: Math.floor(2.5 * GB),
    warnTextBytes: 250 * MB,
    emergencyTextBytes: 1 * GB,
  },
};

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcDay(now: number): number {
  const currentDay = new Date(dayKey(now)).getTime();
  return currentDay + DAY_MS;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function thresholdsFor(scope: Scope): Thresholds {
  const defaults = DEFAULT_THRESHOLDS[scope];
  const prefix =
    scope === "global" ? "MC_COST_BREAKER_GLOBAL" : "MC_COST_BREAKER_USER";
  return {
    warnVectorBytes: envNumber(
      `${prefix}_WARN_VECTOR_BYTES`,
      defaults.warnVectorBytes,
    ),
    emergencyVectorBytes: envNumber(
      `${prefix}_EMERGENCY_VECTOR_BYTES`,
      defaults.emergencyVectorBytes,
    ),
    warnTextBytes: envNumber(
      `${prefix}_WARN_TEXT_BYTES`,
      defaults.warnTextBytes,
    ),
    emergencyTextBytes: envNumber(
      `${prefix}_EMERGENCY_TEXT_BYTES`,
      defaults.emergencyTextBytes,
    ),
  };
}

function breakerStatus(
  totals: {
    estimatedVectorQueryBytes: number;
    estimatedTextQueryBytes: number;
  },
  thresholds: Thresholds,
): "ok" | "warn" | "emergency" {
  if (
    totals.estimatedVectorQueryBytes >= thresholds.emergencyVectorBytes ||
    totals.estimatedTextQueryBytes >= thresholds.emergencyTextBytes
  ) {
    return "emergency";
  }
  if (
    totals.estimatedVectorQueryBytes >= thresholds.warnVectorBytes ||
    totals.estimatedTextQueryBytes >= thresholds.warnTextBytes
  ) {
    return "warn";
  }
  return "ok";
}

function dimensionEmergency(
  totals: {
    estimatedVectorQueryBytes: number;
    estimatedTextQueryBytes: number;
  },
  thresholds: Thresholds,
) {
  return {
    vectorEmergency: totals.estimatedVectorQueryBytes >= thresholds.emergencyVectorBytes,
    textEmergency: totals.estimatedTextQueryBytes >= thresholds.emergencyTextBytes,
  };
}

function degradationPayload(args: {
  scope: Scope;
  scopeId: string;
  surface: Surface;
  resetsAt?: number;
}) {
  return {
    reason: "cost_budget_exceeded",
    surface: args.surface,
    scope: args.scope,
    scopeId: args.scopeId,
    resetsAt: args.resetsAt,
  };
}

export const debitAndCheck = internalMutation({
  args: {
    scope: v.union(v.literal("global"), v.literal("user")),
    scopeId: v.string(),
    surface: surfaceValidator,
    estimatedVectorQueryBytes: v.optional(v.number()),
    estimatedTextQueryBytes: v.optional(v.number()),
    estimatedDbReadBytes: v.optional(v.number()),
    estimatedEmbeddingCalls: v.optional(v.number()),
    estimatedExternalCalls: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "ok" | "warn" | "emergency";
    emergency: boolean;
    vectorEmergency: boolean;
    textEmergency: boolean;
    degradation?: ReturnType<typeof degradationPayload>;
  }> => {
    const now = Date.now();
    const today = dayKey(now);
    const existing = await ctx.db
      .query("crystalCostBreakerLedger")
      .withIndex("by_scope_day_surface", (q) =>
        q
          .eq("scope", args.scope)
          .eq("scopeId", args.scopeId)
          .eq("dayKey", today)
          .eq("surface", args.surface),
      )
      .first();

    const next = {
      estimatedVectorQueryBytes:
        (existing?.estimatedVectorQueryBytes ?? 0) +
        Math.max(0, args.estimatedVectorQueryBytes ?? 0),
      estimatedTextQueryBytes:
        (existing?.estimatedTextQueryBytes ?? 0) +
        Math.max(0, args.estimatedTextQueryBytes ?? 0),
      estimatedDbReadBytes:
        (existing?.estimatedDbReadBytes ?? 0) +
        Math.max(0, args.estimatedDbReadBytes ?? 0),
      estimatedEmbeddingCalls:
        (existing?.estimatedEmbeddingCalls ?? 0) +
        Math.max(0, args.estimatedEmbeddingCalls ?? 0),
      estimatedExternalCalls:
        (existing?.estimatedExternalCalls ?? 0) +
        Math.max(0, args.estimatedExternalCalls ?? 0),
    };
    const thresholds = thresholdsFor(args.scope);
    const status = breakerStatus(next, thresholds);
    const dimensions = dimensionEmergency(next, thresholds);
    const becameEmergency =
      status === "emergency" && existing?.status !== "emergency";
    const emergencyUntil =
      status === "emergency"
        ? (existing?.emergencyUntil ?? nextUtcDay(now))
        : undefined;

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...next,
        status,
        emergencyStartedAt: becameEmergency ? now : existing.emergencyStartedAt,
        emergencyUntil,
        lastReason: args.reason ?? existing.lastReason,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("crystalCostBreakerLedger", {
        scope: args.scope,
        scopeId: args.scopeId,
        dayKey: today,
        surface: args.surface,
        ...next,
        status,
        emergencyStartedAt: status === "emergency" ? now : undefined,
        emergencyUntil,
        lastReason: args.reason,
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      status,
      emergency: status === "emergency",
      ...dimensions,
      ...(status === "emergency"
        ? {
            degradation: degradationPayload({
              scope: args.scope,
              scopeId: args.scopeId,
              surface: args.surface,
              resetsAt: emergencyUntil,
            }),
          }
        : {}),
    };
  },
});

export const getState = internalQuery({
  args: {
    scope: v.union(v.literal("global"), v.literal("user")),
    scopeId: v.string(),
    surface: surfaceValidator,
    dayKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const today = args.dayKey ?? dayKey(Date.now());
    return await ctx.db
      .query("crystalCostBreakerLedger")
      .withIndex("by_scope_day_surface", (q) =>
        q
          .eq("scope", args.scope)
          .eq("scopeId", args.scopeId)
          .eq("dayKey", today)
          .eq("surface", args.surface),
      )
      .first();
  },
});
