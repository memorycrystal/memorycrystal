import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { requestHedged, type HedgeAdmission } from "../hedgedRequest";
import { isCostBreakerEnabled, mergeCostBudgetResults } from "../recallBudgetPolicy";
import {
  OPENROUTER_CHAT_COMPLETIONS_ENDPOINT,
  recordMissingOpenRouterKey,
  requestOpenRouter,
  type OpenRouterGatewayResult,
} from "../providerGateway";
import { awaitEnqueue } from "../requestEnqueues";
import type { RecallPorts, RerankReply, RerankTrace } from "./types";

/** The model request is aborted after RECALL_RERANK_TIMEOUT_MS milliseconds, this default when unset or invalid. */
export const RECALL_RERANK_DEFAULT_TIMEOUT_MS = 1_500;

/** The rerank timeout: RECALL_RERANK_TIMEOUT_MS when it is an integer from 100 to 5,000, otherwise the default. */
export function recallRerankTimeoutMs(): number {
  const value = Number(process.env.RECALL_RERANK_TIMEOUT_MS?.trim());
  return Number.isInteger(value) && value >= 100 && value <= 5_000 ? value : RECALL_RERANK_DEFAULT_TIMEOUT_MS;
}

/**
 * One identical rerank request is sent when the first has not answered in RECALL_RERANK_HEDGE_DELAY_MS milliseconds,
 * this default when unset or invalid. google/gemini-3.5-flash-lite answers in about 710 ms at p50 but its tail passes
 * the 1,500 ms timeout inside Convex (Oct 2026); a hedged call answers in about 700 + 710 ms instead.
 */
export const RECALL_RERANK_DEFAULT_HEDGE_DELAY_MS = 700;

/** The hedge delay: RECALL_RERANK_HEDGE_DELAY_MS when it is an integer from 100 to 5,000, otherwise the default. */
export function recallRerankHedgeDelayMs(): number {
  const value = Number(process.env.RECALL_RERANK_HEDGE_DELAY_MS?.trim());
  return Number.isInteger(value) && value >= 100 && value <= 5_000 ? value : RECALL_RERANK_DEFAULT_HEDGE_DELAY_MS;
}
const SOURCE = "mcp.recallRerank";

/**
 * The OpenRouter `reasoning` field for the answer check: RECALL_RERANK_REASONING=off asks the model not to reason, so a
 * reasoning model cannot spend the whole token budget before answering. Unset or any other value sends no field, since
 * some models refuse a request that disables reasoning.
 */
export function recallRerankReasoning(): { reasoning: { effort: "none"; exclude: true } } | null {
  return process.env.RECALL_RERANK_REASONING?.trim().toLowerCase() === "off"
    ? { reasoning: { effort: "none", exclude: true } }
    : null;
}

/** The OpenRouter model id in RECALL_RERANK_MODEL, or null when unset or blank: the stage is off. */
export function recallRerankModel(): string | null {
  return process.env.RECALL_RERANK_MODEL?.trim() || null;
}

/** Counts one rerank request as an external call on the recall cost-breaker ledger. */
function debitRerankRequest(ctx: ActionCtx, userId: string, reason: string) {
  return ctx.runMutation(internal.crystal.costBreaker.debitUserAndGlobal, {
    userId,
    surface: "recall",
    estimatedExternalCalls: 1,
    reason,
  });
}

/**
 * Debits the hedge's second request before it is sent, as the first was: benchmark keys are not debited. A failed
 * debit, a breaker in emergency or a passed deadline sends no hedge and the first request still answers; a debit for a
 * request that is not sent is credited back.
 */
async function admitRerankHedge(
  ctx: ActionCtx,
  args: { userId: string; benchmarkRecall: boolean; deadline: number; source: string },
): Promise<HedgeAdmission | null> {
  const { userId, deadline } = args;
  // The first request can still be recording its timeout at the deadline; a hedge sent then could not answer.
  if (Date.now() >= deadline) return null;
  if (args.benchmarkRecall || !isCostBreakerEnabled()) return { release: async () => {} };
  const budget = await debitRerankRequest(ctx, userId, `${args.source}.hedge`).catch(() => {
    console.warn("[costBreaker] rerank_hedge_debit_failures=1");
    return null;
  });
  if (!budget) return null;
  const admission: HedgeAdmission = {
    release: async () => {
      await ctx.runMutation(internal.crystal.costBreaker.creditUnsentExternalCalls, {
        userId,
        surface: "recall",
        dayKey: budget.dayKey,
        externalCalls: 1,
      }).catch(() => {
        console.warn("[costBreaker] rerank_hedge_credit_failures=1");
      });
    },
  };
  if (!mergeCostBudgetResults(budget.user, budget.global).emergency && Date.now() < deadline) return admission;
  await awaitEnqueue(ctx, admission.release());
  return null;
}

/**
 * One rerank call on the account's own OpenRouter key. The call is counted on the recall cost-breaker ledger (except
 * for benchmark keys, which recall never debits) and skipped while the breaker is in emergency; the gateway records the
 * provider outcome. With `hedge` (recall), a slow call is hedged with one identical request, counted the same way, and
 * both share the RECALL_RERANK_TIMEOUT_MS deadline; without it (the deep health probe, which measures one request)
 * exactly one request is sent and the caller's signal aborts it. Only a failure reason comes back on failure, never
 * prompt or reply text.
 */
export async function requestRerank(
  ctx: ActionCtx,
  args: { userId: string; benchmarkRecall: boolean; model: string; prompt: string; source?: string } & (
    // `signal?: never`: a hedged call takes no caller signal (neither request would honour it). Excess-property checks
    // reject one only in an inline object literal; this rejects it in an object built beforehand too.
    | { hedge: true; signal?: never }
    | { hedge?: false; signal?: AbortSignal }
  ),
): Promise<RerankReply> {
  // The gateway and the cost ledger attribute the call to its caller: recall, or the deep health probe.
  const source = args.source ?? SOURCE;
  const [credential, budget] = await Promise.all([
    ctx.runQuery(internal.crystal.providerSettings.resolveOpenRouterKeyForUser, {
      userId: args.userId,
      includeShared: false,
    }) as Promise<{ apiKey: string | null; keyLast4: string | null }>,
    args.benchmarkRecall || !isCostBreakerEnabled()
      ? null
      : debitRerankRequest(ctx, args.userId, source).catch(() => "unavailable" as const),
  ]);
  // A debit that failed leaves the call unaccounted, so the paid request is not made.
  if (budget === "unavailable") return { ok: false, reason: "cost_budget_unavailable" };
  const apiKey = credential.apiKey;
  if (!apiKey) {
    await recordMissingOpenRouterKey(ctx, {
      userId: args.userId,
      keyLast4: credential.keyLast4,
      source,
      endpointKind: "chat_completions",
      model: args.model,
    }).catch(() => {});
    return { ok: false, reason: "missing_key" };
  }
  if (budget && mergeCostBudgetResults(budget.user, budget.global).emergency) {
    return { ok: false, reason: "cost_budget_exceeded" };
  }
  const emptyLegs: Array<"first" | "hedge"> = [];
  const send = async (signal: AbortSignal | undefined, timeoutMs: number, leg: "first" | "hedge"): Promise<RerankAttempt> => {
    const gateway = await requestOpenRouter(ctx, {
      userId: args.userId,
      apiKey,
      keyLast4: credential.keyLast4,
      endpoint: OPENROUTER_CHAT_COMPLETIONS_ENDPOINT,
      source,
      timeoutMs,
      ...(signal ? { signal } : {}),
      body: rerankRequestBody(args.model, args.prompt),
      headers: { "HTTP-Referer": "https://memorycrystal.ai", "X-Title": "Memory Crystal" },
    });
    const content = gateway.ok ? replyText(gateway.payload) : "";
    // A success with no reply text (an empty, blank or unreadable body) does not end a hedged race: the status is not
    // a 4xx, so the other request, when one is in flight, can still answer. The trace records it either way.
    const blank = gateway.ok && content.trim().length === 0;
    if (blank) emptyLegs.push(leg);
    return { ok: gateway.ok && !blank, status: gateway.status, gateway, content, leg };
  };
  const deadline = Date.now() + recallRerankTimeoutMs();
  let sent = 0;
  // Unhedged callers (the deep health probe) send exactly one request, aborted by their own signal.
  // Hedged: a reply, a thrown error or a permanent 4xx from either request ends the race; a 429 is not hedged.
  const result = !args.hedge
    ? await send(args.signal, recallRerankTimeoutMs(), "first")
    : await requestHedged(ctx, {
        delayMs: recallRerankHedgeDelayMs(),
        // With a deadline, requestHedged always passes the time left at dispatch.
        send: (signal, remainingMs) => send(signal, remainingMs!, sent++ === 0 ? "first" : "hedge"),
        admit: () => admitRerankHedge(ctx, { userId: args.userId, benchmarkRecall: args.benchmarkRecall, deadline, source }),
        // Admission is asynchronous, so the time left is read again at dispatch; none left sends nothing.
        deadline: { at: deadline, expired: () => DEADLINE_PASSED },
      });
  const { gateway, content } = result;
  const trace = { ...rerankTrace(result), ...(emptyLegs.length > 0 ? { emptyLegs: [...emptyLegs] } : {}) };
  // The gateway reports an unreachable request, or one past its deadline, as a timeout.
  if (!gateway.ok) return { ok: false, reason: gateway.failureClass === "timeout" ? "timeout" : "provider_error", trace };
  return { ok: true, content, trace };
}

/** The answer-check chat request: deterministic, JSON only, 64 tokens, with the reasoning switch when set. */
function rerankRequestBody(model: string, prompt: string) {
  return {
    model,
    temperature: 0,
    max_tokens: 64,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
    ...recallRerankReasoning(),
  };
}

/** One rerank request's outcome; `ok` only when the provider answered with reply text. */
type RerankAttempt = { ok: boolean; status: number; gateway: OpenRouterGatewayResult; content: string; leg: RerankTrace["leg"] };

/**
 * The reply text: a string `content`, or the string `text` of every part of a `content` array joined, except reasoning
 * parts (a `type` containing "reasoning"); otherwise empty.
 */
function replyText(payload: unknown): string {
  const content = (payload as any)?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const isReasoning = (part: any) => typeof part.type === "string" && part.type.includes("reasoning");
  return content.map((part) => (part && typeof part.text === "string" && !isReasoning(part) ? part.text : "")).join("");
}

/** finish_reason values the operator log names; any other value, or none, is logged as "other". */
const FINISH_REASONS = new Set(["stop", "length", "content_filter", "tool_calls", "error"]);
/** Upstream providers OpenRouter routes the answer-check models to; any other name, or none, is logged as "other". */
const PROVIDERS = new Set(["Google", "Google AI Studio", "Google Vertex", "Anthropic", "OpenAI", "Amazon Bedrock", "Azure"]);

/** `value` when it is on the allow-list, otherwise "other": the log never carries upstream free text. */
function allowListed(value: unknown, allowed: Set<string>): string {
  return typeof value === "string" && allowed.has(value) ? value : "other";
}

/** HTTP statuses the operator log names; the gateway can report an upstream payload error code as the status. */
const STATUSES = new Set([0, 200, 400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504]);

function statusClass(status: number): RerankTrace["statusClass"] {
  if (!Number.isInteger(status)) return "none";
  if (status >= 200 && status <= 299) return "2xx";
  if (status >= 400 && status <= 499) return "4xx";
  if (status >= 500 && status <= 599) return "5xx";
  return "none";
}

function rerankTrace(attempt: RerankAttempt): RerankTrace {
  const payload = attempt.gateway.ok ? (attempt.gateway.payload as any) : null;
  return {
    leg: attempt.leg,
    status: STATUSES.has(attempt.status) ? attempt.status : "other",
    statusClass: statusClass(attempt.status),
    contentLength: attempt.content.length,
    finishReason: allowListed(payload?.choices?.[0]?.finish_reason, FINISH_REASONS),
    provider: allowListed(payload?.provider, PROVIDERS),
  };
}

/** The answer for a request that would be dispatched at or past its deadline: a timeout, without a provider call. */
const DEADLINE_PASSED: RerankAttempt = {
  ok: false,
  status: 0,
  gateway: { ok: false, status: 0, failureClass: "timeout", category: "transient", errorMessage: null },
  content: "",
  leg: "none",
};

/** The rerank port when RECALL_RERANK_MODEL names a model, otherwise undefined and the stage is off. */
export function createRerankPort(ctx: ActionCtx, userId: string, benchmarkRecall: boolean): RecallPorts["rerank"] {
  const model = recallRerankModel();
  if (!model) return undefined;
  return { model, complete: (prompt) => requestRerank(ctx, { userId, benchmarkRecall, model, prompt, hedge: true }) };
}
