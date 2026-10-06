import { v } from "convex/values";
import { FULL_RECALL_CHARGE } from "./recallBudgetPolicy";
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
// Default recall envelope in full recalls per UTC day (D1).
// On kb, thresholds are multiplied by 4 (D9):
//   500 scoped recalls over 4 KBs, 166 over 12, or 2,000 standalone queries.
// Broad recall is uncharged on kb (AC39).
// Messages: 1,500 searches per user per day.
export const DEFAULT_RECALL_ENVELOPE = {
  user: { warn: 250, emergency: 500 },
  global: { warn: 50000, emergency: 100000 },
};

type Thresholds = {
  warnVectorBytes: number;
  emergencyVectorBytes: number;
  warnTextBytes: number;
  emergencyTextBytes: number;
};

const DEFAULT_THRESHOLDS: Record<Scope, Thresholds> = {
  global: {
    warnVectorBytes: DEFAULT_RECALL_ENVELOPE.global.warn * FULL_RECALL_CHARGE.vectorBytes,
    emergencyVectorBytes: DEFAULT_RECALL_ENVELOPE.global.emergency * FULL_RECALL_CHARGE.vectorBytes,
    warnTextBytes: DEFAULT_RECALL_ENVELOPE.global.warn * FULL_RECALL_CHARGE.textBytes,
    emergencyTextBytes: DEFAULT_RECALL_ENVELOPE.global.emergency * FULL_RECALL_CHARGE.textBytes,
  },
  user: {
    warnVectorBytes: DEFAULT_RECALL_ENVELOPE.user.warn * FULL_RECALL_CHARGE.vectorBytes,
    emergencyVectorBytes: DEFAULT_RECALL_ENVELOPE.user.emergency * FULL_RECALL_CHARGE.vectorBytes,
    warnTextBytes: DEFAULT_RECALL_ENVELOPE.user.warn * FULL_RECALL_CHARGE.textBytes,
    emergencyTextBytes: DEFAULT_RECALL_ENVELOPE.user.emergency * FULL_RECALL_CHARGE.textBytes,
  },
};

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcDay(now: number): number {
  const currentDay = new Date(dayKey(now)).getTime();
  return currentDay + DAY_MS;
}

function readEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function envNumber(name: string, fallback: number): number {
  return readEnvNumber(name) ?? fallback;
}

function envIsSet(name: string): boolean {
  return readEnvNumber(name) !== undefined;
}

function thresholdsFor(scope: Scope, surface?: Surface): Thresholds {
  const defaults = DEFAULT_THRESHOLDS[scope];
  const prefix =
    scope === "global" ? "MC_COST_BREAKER_GLOBAL" : "MC_COST_BREAKER_USER";
  // kb surface gets 4× the envelope (D9), per-threshold, only when the
  // environment variable is unset. An explicit override, even to the
  // default value, must apply unchanged.
  const rawWarnVector = envNumber(`${prefix}_WARN_VECTOR_BYTES`, defaults.warnVectorBytes);
  const rawEmVector = envNumber(`${prefix}_EMERGENCY_VECTOR_BYTES`, defaults.emergencyVectorBytes);
  const rawWarnText = envNumber(`${prefix}_WARN_TEXT_BYTES`, defaults.warnTextBytes);
  const rawEmText = envNumber(`${prefix}_EMERGENCY_TEXT_BYTES`, defaults.emergencyTextBytes);
  const kbMult = surface === "kb" ? 4 : 1;
  return {
    warnVectorBytes: envIsSet(`${prefix}_WARN_VECTOR_BYTES`) ? rawWarnVector : rawWarnVector * kbMult,
    emergencyVectorBytes: envIsSet(`${prefix}_EMERGENCY_VECTOR_BYTES`) ? rawEmVector : rawEmVector * kbMult,
    warnTextBytes: envIsSet(`${prefix}_WARN_TEXT_BYTES`) ? rawWarnText : rawWarnText * kbMult,
    emergencyTextBytes: envIsSet(`${prefix}_EMERGENCY_TEXT_BYTES`) ? rawEmText : rawEmText * kbMult,
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

/** Shared ledger write handler used by debitAndCheck and debitUserAndGlobal.
 *  Inserts or patches the row with the computed next totals and returns the
 *  standardized DebitResult. */
async function applyLedgerDebit(
  db: any,
  existing: any,
  next: Record<string, number>,
  thresholds: Thresholds,
  args: { scope: Scope; scopeId: string; surface: Surface; dayKey: string; reason?: string },
  now: number,
): Promise<DebitResult> {
  const totals = {
    estimatedVectorQueryBytes: next.estimatedVectorQueryBytes,
    estimatedTextQueryBytes: next.estimatedTextQueryBytes,
  };
  const status = breakerStatus(totals, thresholds);
  const dimensions = dimensionEmergency(totals, thresholds);
  const becameEmergency = status === "emergency" && existing?.status !== "emergency";
  const emergencyUntil = status === "emergency"
    ? (existing?.emergencyUntil ?? nextUtcDay(now))
    : undefined;

  if (existing) {
    await db.patch(existing._id, {
      ...next,
      status,
      emergencyStartedAt: becameEmergency ? now : existing.emergencyStartedAt,
      emergencyUntil,
      lastReason: args.reason ?? existing.lastReason,
      updatedAt: now,
    });
  } else {
    await db.insert("crystalCostBreakerLedger", {
      scope: args.scope,
      scopeId: args.scopeId,
      dayKey: args.dayKey,
      surface: args.surface,
      estimatedVectorQueryBytes: next.estimatedVectorQueryBytes,
      estimatedTextQueryBytes: next.estimatedTextQueryBytes,
      estimatedDbReadBytes: next.estimatedDbReadBytes,
      estimatedEmbeddingCalls: next.estimatedEmbeddingCalls,
      estimatedExternalCalls: next.estimatedExternalCalls,
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
    const thresholds = thresholdsFor(args.scope, args.surface);
    return applyLedgerDebit(ctx.db, existing, next, thresholds, {
      scope: args.scope,
      scopeId: args.scopeId,
      surface: args.surface,
      dayKey: today,
      reason: args.reason,
    }, now);
  },
});


type DebitResult = {
  status: "ok" | "warn" | "emergency";
  emergency: boolean;
  vectorEmergency: boolean;
  textEmergency: boolean;
  degradation?: ReturnType<typeof degradationPayload>;
};

type DebitReceipt = {
  dayKey: string;
  applied: { user: { vectorBytes: number; textBytes: number }; global: { vectorBytes: number; textBytes: number } };
  crossedEmergency: { user: { vector: boolean; text: boolean }; global: { vector: boolean; text: boolean } };
};

type CombinedDebitResult = {
  dayKey: string;
  user: DebitResult;
  global: DebitResult;
  applied: { user: { vectorBytes: number; textBytes: number }; global: { vectorBytes: number; textBytes: number } };
  crossedEmergency: { user: { vector: boolean; text: boolean }; global: { vector: boolean; text: boolean } };
};

/** Combined debit that atomically charges one user row and one global row.
 *  Limits one account's contribution to the global ledger to its own user
 *  emergency threshold (D3). */
export const debitUserAndGlobal = internalMutation({
  args: {
    userId: v.string(),
    surface: surfaceValidator,
    estimatedVectorQueryBytes: v.optional(v.number()),
    estimatedTextQueryBytes: v.optional(v.number()),
    estimatedDbReadBytes: v.optional(v.number()),
    estimatedEmbeddingCalls: v.optional(v.number()),
    estimatedExternalCalls: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CombinedDebitResult> => {
    const now = Date.now();
    const today = dayKey(now);
    const userThresholds = thresholdsFor("user", args.surface);
    const globalThresholds = thresholdsFor("global", args.surface);

    const [userExisting, globalExisting] = await Promise.all([
      ctx.db.query("crystalCostBreakerLedger")
        .withIndex("by_scope_day_surface", (q) =>
          q.eq("scope", "user").eq("scopeId", args.userId).eq("dayKey", today).eq("surface", args.surface))
        .first(),
      ctx.db.query("crystalCostBreakerLedger")
        .withIndex("by_scope_day_surface", (q) =>
          q.eq("scope", "global").eq("scopeId", "global").eq("dayKey", today).eq("surface", args.surface))
        .first(),
    ]);

    const vecInc = Math.max(0, args.estimatedVectorQueryBytes ?? 0);
    const textInc = Math.max(0, args.estimatedTextQueryBytes ?? 0);
    const dbInc = Math.max(0, args.estimatedDbReadBytes ?? 0);
    const embInc = Math.max(0, args.estimatedEmbeddingCalls ?? 0);
    const extInc = Math.max(0, args.estimatedExternalCalls ?? 0);

    // D3 cap: if the user row is already at/above its emergency threshold,
    // the global increment is 0 for that dimension.
    const userVecBefore = userExisting?.estimatedVectorQueryBytes ?? 0;
    const userTextBefore = userExisting?.estimatedTextQueryBytes ?? 0;
    const globalVecInc = userVecBefore >= userThresholds.emergencyVectorBytes ? 0 : vecInc;
    const globalTextInc = userTextBefore >= userThresholds.emergencyTextBytes ? 0 : textInc;

    const userNext = {
      estimatedVectorQueryBytes: userVecBefore + vecInc,
      estimatedTextQueryBytes: userTextBefore + textInc,
      estimatedDbReadBytes: (userExisting?.estimatedDbReadBytes ?? 0) + dbInc,
      estimatedEmbeddingCalls: (userExisting?.estimatedEmbeddingCalls ?? 0) + embInc,
      estimatedExternalCalls: (userExisting?.estimatedExternalCalls ?? 0) + extInc,
    };
    const globalNext = {
      estimatedVectorQueryBytes: (globalExisting?.estimatedVectorQueryBytes ?? 0) + globalVecInc,
      estimatedTextQueryBytes: (globalExisting?.estimatedTextQueryBytes ?? 0) + globalTextInc,
      estimatedDbReadBytes: (globalExisting?.estimatedDbReadBytes ?? 0) + dbInc,
      estimatedEmbeddingCalls: (globalExisting?.estimatedEmbeddingCalls ?? 0) + embInc,
      estimatedExternalCalls: (globalExisting?.estimatedExternalCalls ?? 0) + extInc,
    };

    const [userResult, globalResult] = await Promise.all([
      applyLedgerDebit(ctx.db, userExisting, userNext, userThresholds, { scope: "user", scopeId: args.userId, surface: args.surface, dayKey: today, reason: args.reason }, now),
      applyLedgerDebit(ctx.db, globalExisting, globalNext, globalThresholds, { scope: "global", scopeId: "global", surface: args.surface, dayKey: today, reason: args.reason }, now),
    ]);

    return {
      dayKey: today,
      user: userResult,
      global: globalResult,
      applied: {
        user: { vectorBytes: vecInc, textBytes: textInc },
        global: { vectorBytes: globalVecInc, textBytes: globalTextInc },
      },
      crossedEmergency: {
        user: {
          vector: userVecBefore < userThresholds.emergencyVectorBytes && userNext.estimatedVectorQueryBytes >= userThresholds.emergencyVectorBytes,
          text: userTextBefore < userThresholds.emergencyTextBytes && userNext.estimatedTextQueryBytes >= userThresholds.emergencyTextBytes,
        },
        global: {
          vector: (globalExisting?.estimatedVectorQueryBytes ?? 0) < globalThresholds.emergencyVectorBytes && globalNext.estimatedVectorQueryBytes >= globalThresholds.emergencyVectorBytes,
          text: (globalExisting?.estimatedTextQueryBytes ?? 0) < globalThresholds.emergencyTextBytes && globalNext.estimatedTextQueryBytes >= globalThresholds.emergencyTextBytes,
        },
      },
    };
  },
});

type CreditReceipt = {
  dayKey: string;
  applied: { user: { vectorBytes: number; textBytes: number }; global: { vectorBytes: number; textBytes: number } };
  crossedEmergency: { user: { vector: boolean; text: boolean }; global: { vector: boolean; text: boolean } };
};

/** Credits charges for lanes that did not execute, without lifting a row out
 *  of emergency (R4). Per-scope, per-dimension rules:
 *  1. Latch: 0 if the receipt crossedEmergency flag is set.
 *  2. Clamp: min(requested, receipt.applied).
 *  3. Floor: cap at total - threshold when total >= emergency threshold.
 *  A credit never inserts a row. */
export const creditUnexecuted = internalMutation({
  args: {
    userId: v.string(),
    surface: surfaceValidator,
    receipt: v.object({
      dayKey: v.string(),
      applied: v.object({
        user: v.object({ vectorBytes: v.number(), textBytes: v.number() }),
        global: v.object({ vectorBytes: v.number(), textBytes: v.number() }),
      }),
      crossedEmergency: v.object({
        user: v.object({ vector: v.boolean(), text: v.boolean() }),
        global: v.object({ vector: v.boolean(), text: v.boolean() }),
      }),
    }),
    user: v.object({ vectorBytes: v.number(), textBytes: v.number() }),
    global: v.object({ vectorBytes: v.number(), textBytes: v.number() }),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const userThresholds = thresholdsFor("user", args.surface);
    const globalThresholds = thresholdsFor("global", args.surface);

    const creditScope = async (
      scope: "user" | "global",
      scopeId: string,
      requestedVec: number,
      requestedText: number,
      crossed: { vector: boolean; text: boolean },
      applied: { vectorBytes: number; textBytes: number },
    ) => {
      const vecBeforeLatch = crossed.vector ? 0 : requestedVec;
      const textBeforeLatch = crossed.text ? 0 : requestedText;
      if (vecBeforeLatch === 0 && textBeforeLatch === 0) return;

      const vecClamped = Math.min(vecBeforeLatch, applied.vectorBytes);
      const textClamped = Math.min(textBeforeLatch, applied.textBytes);

      const row = await ctx.db.query("crystalCostBreakerLedger")
        .withIndex("by_scope_day_surface", (q) =>
          q.eq("scope", scope).eq("scopeId", scopeId).eq("dayKey", args.receipt.dayKey).eq("surface", args.surface))
        .first();
      if (!row) return;

      const thresholds = scope === "user" ? userThresholds : globalThresholds;
      const currentVec = row.estimatedVectorQueryBytes;
      const currentText = row.estimatedTextQueryBytes;

      let vecAmount = vecClamped;
      let textAmount = textClamped;

      if (currentVec >= thresholds.emergencyVectorBytes) {
        vecAmount = Math.min(vecAmount, currentVec - thresholds.emergencyVectorBytes);
      }
      if (currentText >= thresholds.emergencyTextBytes) {
        textAmount = Math.min(textAmount, currentText - thresholds.emergencyTextBytes);
      }

      vecAmount = Math.max(0, Math.min(vecAmount, currentVec));
      textAmount = Math.max(0, Math.min(textAmount, currentText));

      if (vecAmount === 0 && textAmount === 0) return;

      const next = {
        estimatedVectorQueryBytes: currentVec - vecAmount,
        estimatedTextQueryBytes: currentText - textAmount,
      };
      const status = breakerStatus(next, thresholds);
      const emergencyUntil = status === "emergency" ? row.emergencyUntil : undefined;

      await ctx.db.patch(row._id, {
        estimatedVectorQueryBytes: next.estimatedVectorQueryBytes,
        estimatedTextQueryBytes: next.estimatedTextQueryBytes,
        status,
        emergencyUntil,
        updatedAt: now,
      });
    };

    await Promise.all([
      creditScope("user", args.userId, args.user.vectorBytes, args.user.textBytes, args.receipt.crossedEmergency.user, args.receipt.applied.user),
      creditScope("global", "global", args.global.vectorBytes, args.global.textBytes, args.receipt.crossedEmergency.global, args.receipt.applied.global),
    ]);
  },
});


const LEDGER_SURFACES = [
  "recall",
  "kb",
  "messages",
  "organic",
  "cleanup",
  "embedding",
  "counter",
] as const;

/** Today's ledger status per surface. Missing rows are `ok`. Read-only. */
export const readTodayLedgerStatus = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const today = dayKey(Date.now());
    const readScope = async (scope: "global" | "user", scopeId: string) => {
      const surfaces: Record<(typeof LEDGER_SURFACES)[number], "ok" | "warn" | "emergency"> = {
        recall: "ok",
        kb: "ok",
        messages: "ok",
        organic: "ok",
        cleanup: "ok",
        embedding: "ok",
        counter: "ok",
      };
      for (const surface of LEDGER_SURFACES) {
        const row = await ctx.db
          .query("crystalCostBreakerLedger")
          .withIndex("by_scope_day_surface", (q) =>
            q.eq("scope", scope).eq("scopeId", scopeId).eq("dayKey", today).eq("surface", surface),
          )
          .first();
        surfaces[surface] = row?.status ?? "ok";
      }
      return surfaces;
    };
    return {
      dayKey: today,
      global: await readScope("global", "global"),
      user: await readScope("user", args.userId),
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
