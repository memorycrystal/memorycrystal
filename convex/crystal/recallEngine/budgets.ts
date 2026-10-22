import { widenAgentVector } from "./agentLayer";
import type { UserTier } from "../../../shared/tierLimits";
import type { CostBudgetResult } from "../recallBudgetPolicy";
import { RECALL_TEXT_INDEX_COUNT } from "../recallBudgetPolicy";
import { ESTIMATED_RECALL_VECTOR_BYTES, ESTIMATED_TEXT_INDEX_BYTES, normalRecallVectorDepth } from "./constants";
import type { RecallCostDebit, RecallRuntime } from "./types";
import { logError } from "../crypto";

export async function dispatchCreditMutation(
  ctx: any,
  mutation: any,
  args: Record<string, unknown>,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const charges = args as {
    user?: { vectorBytes?: number; textBytes?: number };
    global?: { vectorBytes?: number; textBytes?: number };
  };
  const total = (charges.user?.vectorBytes ?? 0) + (charges.user?.textBytes ?? 0) +
    (charges.global?.vectorBytes ?? 0) + (charges.global?.textBytes ?? 0);
  if (total <= 0) return;
  try {
    if (process.env.VITEST) await ctx.runMutation(mutation, args);
    else await ctx.scheduler.runAfter(0, mutation, args);
  } catch (_) {
    // Credit failures never change a response.
  }
}

function debitRecall(state: RecallRuntime, args: RecallCostDebit): Promise<CostBudgetResult | null> {
  if (state.ports.benchmarkRecall) return Promise.resolve(null);
  return state.ports.debit(args);
}

function loadIdentity(state: RecallRuntime): Promise<{ email: string | null; name: string | null }> {
  if (state.request.resolveIdentity === false) return Promise.resolve({ email: null, name: null });
  return state.ports.getIdentity().catch(async (err: unknown) => {
    console.error("[recall] account identity fallback:", await logError(err, state.ports.userId));
    return { userId: state.ports.userId, email: null, name: null };
  });
}

export async function loadRecallBudgets(state: RecallRuntime): Promise<void> {
  const debits = state.request.recallDebits;
  // recallMemories never debited text for an empty query (no text lane runs).
  const textRequiresQuery = debits?.textRequiresQuery && state.request.query.trim().length === 0;

  const [userTier, identity, recallBudget] = await Promise.all([
    state.ports.getTier().catch(async (err: unknown) => {
      console.error("[recall] tier lookup fallback:", await logError(err, state.ports.userId));
      return "free" as UserTier;
    }),
    loadIdentity(state),
    // KB-scoped requests do not debit the recall surface (R12).
    state.request.hasKnowledgeBaseScope
      ? Promise.resolve(null)
      : debitRecall(state, {
          surface: "recall",
          estimatedVectorQueryBytes: ESTIMATED_RECALL_VECTOR_BYTES,
          ...(textRequiresQuery ? {} : { estimatedTextQueryBytes: ESTIMATED_TEXT_INDEX_BYTES * RECALL_TEXT_INDEX_COUNT }),
          estimatedEmbeddingCalls: 1,
          reason: debits?.vectorReason ?? "mcp.recall.semantic",
        }),
  ]);
  state.diagnostics.account.email = identity.email;
  state.diagnostics.account.name = identity.name;
  state.userTier = userTier;
  // One combined debit serves as both vector and text budget (R13).
  state.recallBudget = recallBudget;
  state.textBudget = recallBudget;
  state.reach = state.ports.resolveReach({
    tier: userTier,
    normalVectorDepth: widenAgentVector(state.request.filteredVectorDepth ?? normalRecallVectorDepth(state.request.limit), state.agentLayer),
    vectorBudget: recallBudget,
    textBudget: recallBudget,
    indexedFallbackAllowedOnDegradation: true,
  });
}
