import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { isCostBreakerEnabled, mergeCostBudgetResults } from "../recallBudgetPolicy";
import { OPENROUTER_CHAT_COMPLETIONS_ENDPOINT, recordMissingOpenRouterKey, requestOpenRouter } from "../providerGateway";
import type { RecallPorts, RerankReply } from "./types";

/** The model request is aborted after RECALL_RERANK_TIMEOUT_MS milliseconds, this default when unset or invalid. */
export const RECALL_RERANK_DEFAULT_TIMEOUT_MS = 1_500;

/** The rerank timeout: RECALL_RERANK_TIMEOUT_MS when it is an integer from 100 to 5,000, otherwise the default. */
export function recallRerankTimeoutMs(): number {
  const value = Number(process.env.RECALL_RERANK_TIMEOUT_MS?.trim());
  return Number.isInteger(value) && value >= 100 && value <= 5_000 ? value : RECALL_RERANK_DEFAULT_TIMEOUT_MS;
}
const SOURCE = "mcp.recallRerank";

/** The OpenRouter model id in RECALL_RERANK_MODEL, or null when unset or blank: the stage is off. */
export function recallRerankModel(): string | null {
  return process.env.RECALL_RERANK_MODEL?.trim() || null;
}

/**
 * One rerank call on the account's own OpenRouter key. The call is counted on the recall cost-breaker ledger (except
 * for benchmark keys, which recall never debits) and skipped while the breaker is in emergency; the gateway records the
 * provider outcome. Only a failure reason comes back on failure, never prompt or reply text.
 */
async function requestRerank(
  ctx: ActionCtx,
  args: { userId: string; benchmarkRecall: boolean; model: string; prompt: string },
): Promise<RerankReply> {
  const [credential, budget] = await Promise.all([
    ctx.runQuery(internal.crystal.providerSettings.resolveOpenRouterKeyForUser, {
      userId: args.userId,
      includeShared: false,
    }) as Promise<{ apiKey: string | null; keyLast4: string | null }>,
    args.benchmarkRecall || !isCostBreakerEnabled()
      ? null
      : ctx.runMutation(internal.crystal.costBreaker.debitUserAndGlobal, {
          userId: args.userId,
          surface: "recall",
          estimatedExternalCalls: 1,
          reason: SOURCE,
        }).catch(() => "unavailable" as const),
  ]);
  // A debit that failed leaves the call unaccounted, so the paid request is not made.
  if (budget === "unavailable") return { ok: false, reason: "cost_budget_unavailable" };
  if (!credential.apiKey) {
    await recordMissingOpenRouterKey(ctx, {
      userId: args.userId,
      keyLast4: credential.keyLast4,
      source: SOURCE,
      endpointKind: "chat_completions",
      model: args.model,
    }).catch(() => {});
    return { ok: false, reason: "missing_key" };
  }
  if (budget && mergeCostBudgetResults(budget.user, budget.global).emergency) {
    return { ok: false, reason: "cost_budget_exceeded" };
  }
  const result = await requestOpenRouter(ctx, {
    userId: args.userId,
    apiKey: credential.apiKey,
    keyLast4: credential.keyLast4,
    endpoint: OPENROUTER_CHAT_COMPLETIONS_ENDPOINT,
    source: SOURCE,
    timeoutMs: recallRerankTimeoutMs(),
    body: {
      model: args.model,
      temperature: 0,
      max_tokens: 64,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: args.prompt }],
    },
    headers: { "HTTP-Referer": "https://memorycrystal.ai", "X-Title": "Memory Crystal" },
  });
  // The gateway reports an aborted or unreachable request as a timeout.
  if (!result.ok) return { ok: false, reason: result.failureClass === "timeout" ? "timeout" : "provider_error" };
  const content = (result.payload as any)?.choices?.[0]?.message?.content;
  return { ok: true, content: typeof content === "string" ? content : "" };
}

/** The rerank port when RECALL_RERANK_MODEL names a model, otherwise undefined and the stage is off. */
export function createRerankPort(ctx: ActionCtx, userId: string, benchmarkRecall: boolean): RecallPorts["rerank"] {
  const model = recallRerankModel();
  if (!model) return undefined;
  return { model, complete: (prompt) => requestRerank(ctx, { userId, benchmarkRecall, model, prompt }) };
}
