import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { buildRecallQueryEmbeddingInput } from "../embeddingInput";
import { embedText } from "../embeddings";
import { isCostBreakerEnabled } from "../recallBudgetPolicy";
import { settleBeforeReturn } from "../requestEnqueues";
import type { RecallPorts } from "./types";

/** Counts a hedge's second request on the recall cost-breaker ledger. It is already sent, so a failure is only logged. */
async function debitHedge(ctx: ActionCtx, userId: string): Promise<void> {
  if (!isCostBreakerEnabled()) return;
  await ctx.runMutation(internal.crystal.costBreaker.debitUserAndGlobal, {
    userId,
    surface: "recall",
    estimatedEmbeddingCalls: 1,
    reason: "mcp.recall.embed_hedge",
  }).catch(() => {
    console.warn("[costBreaker] embed_hedge_debit_failures=1");
  });
}

/**
 * The query embedding port. It hedges a slow provider with a second request, which is debited on the recall surface
 * when the engine debits the embedding there.
 */
export function createEmbedPort(ctx: ActionCtx, userId: string): RecallPorts["embed"] {
  return (text, accounting) => settleBeforeReturn(ctx, embedText(buildRecallQueryEmbeddingInput(text), ctx, { userId, source: "mcp.recall" }, {
    hedge: true,
    onHedgeSent: accounting?.debitsRecall
      ? () => {
        void settleBeforeReturn(ctx, debitHedge(ctx, userId));
      }
      : undefined,
  }));
}
