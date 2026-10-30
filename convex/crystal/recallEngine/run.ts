import { loadAgentLayer } from "./agentLayer";
import { logError } from "../crypto";
import type { UserTier } from "../../../shared/tierLimits";
import { createRecallStageTimer } from "../recallTimings";
import { loadRecallBudgets } from "./budgets";
import { createRecallDiagnostics } from "./diagnostics";
import { createDegradationTracker } from "./degradation";
import { finalizeRecall } from "./finalize";
import { tryIdentifierEarlyReturn } from "./earlyReturn";
import { getAnalyzedQuery, hasDecisiveIdentifier } from "./identifiers";
import { runKnowledgeAndAssets } from "./lanesKnowledge";
import { mergeLexicalLane, startLexicalHydration } from "./lanesLexical";
import { COST_UNIT_BYTES } from "../recallBudgetPolicy";
import { startParallelRecall } from "./lanesParallel";
import { runSemanticLane, startQueryEmbedding } from "./lanesSemantic";
import { normalRecallVectorDepth } from "./constants";
import type { NormalizedRecallRequest, RecallEngineSuccess, RecallPorts, RecallRuntime, RecallStageTimer } from "./types";
import { firstNameTokensFromPersonTitles } from "../recallCoverage";
import { classifyRecallIntent } from "../recallRanking";

let recallEngineEntries = 0;

export function recallEngineEntryCount(): number {
  return recallEngineEntries;
}

export function resetRecallEngineEntryCount(): void {
  recallEngineEntries = 0;
}

/** Handler-side timing an HTTP caller measured before the engine started. */
export type RecallRequestClock = { startedAt: number; timer: RecallStageTimer };

export function createRecallRuntime(
  request: NormalizedRecallRequest,
  ports: RecallPorts,
  clock?: RecallRequestClock,
): RecallRuntime {
  const startedAt = Date.now();
  return {
    request,
    ports,
    timer: clock?.timer ?? createRecallStageTimer(),
    startedAt,
    requestStartedAt: clock?.startedAt ?? startedAt,
    diagnostics: createRecallDiagnostics(request, ports.userId),
    degradation: createDegradationTracker(),
    memories: [],
    queryEmbedding: null,
    knownPersonNames: [],
    personMemoryCandidates: [],
    userTier: "free" as UserTier,
    recallBudget: null,
    textBudget: null,
    messageBudget: null,
    messageLaneOutcome: { bm25SkippedForBudget: false },
    reach: {
      tier: "free",
      vectorDepth: normalRecallVectorDepth(request.limit),
      vectorAllowed: true,
      textAllowed: true,
      indexedFallbackAllowed: true,
      degraded: false,
      budgetLevel: "normal",
      reasons: [],
    },
    assetContexts: [],
    pendingCredits: [],
  };
}

export async function runRecallEngine(
  request: NormalizedRecallRequest,
  ports: RecallPorts,
  clock?: RecallRequestClock,
): Promise<RecallEngineSuccess> {
  recallEngineEntries += 1;
  const state = createRecallRuntime(request, ports, clock);
  startQueryEmbedding(state);
  const agentLayerLoaded = loadAgentLayer(state).catch(async (err: unknown) => {
    console.error("[recall] agent_layer_unavailable:", await logError(err, state.ports.userId, [state.request.agentId]));
    state.degradation.mark({
      code: "agent_layer_unavailable",
      message: "Agent recall policy unavailable; using the account pool.",
      recoverable: true,
      affectedStage: "agent_layer",
    });
  });
  const budgetsLoaded = loadRecallBudgets(state, agentLayerLoaded);
  const hasPersonalAttributeCue = /\b(height|weight|age|old|birthday|birth ?date|bmr|basal metabolic rate)\b|\bon file\b/i.test(request.query);
  const hasTechnicalAttributeCue = /\b(css|style|refactor|mountain|limit|luggage|code|repository|deploy|deployment|service|app|system|database|software|server|model)\b/i.test(request.query);
  // ILL-495: an identifier query's attribute words (an issue key next to "age" or a name) do not ask about a person.
  const hasIdentifier = hasDecisiveIdentifier(getAnalyzedQuery(request));
  const needsPeopleContext = request.mode === "people" ||
    (request.resolveIdentity !== false && (request.recallIntent === "personal_attribute" ||
      (hasPersonalAttributeCue && !hasTechnicalAttributeCue && !hasIdentifier)));
  const peopleContext = needsPeopleContext
    ? Promise.all([
        request.resolveIdentity === false && request.mode !== "people"
          ? Promise.resolve({ userId: ports.userId, email: null, name: null })
          : ports.getIdentity(),
        ports.getPersonMemoryCandidates?.({ userId: ports.userId, limit: 50 }) ??
          Promise.resolve({ titles: [], candidates: [] }),
      ]).then(([identity, people]) => {
        state.accountHolderName = identity.name ?? undefined;
        state.knownPersonNames = firstNameTokensFromPersonTitles(people.titles, identity.name ?? "");
        if (request.mode === "people" && !request.hasKnowledgeBaseScope) {
          state.personMemoryCandidates = people.candidates;
        }
      }).catch(() => {
        state.accountHolderName = undefined;
        state.knownPersonNames = [];
        state.personMemoryCandidates = [];
      })
    : Promise.resolve();
  await Promise.all([budgetsLoaded, peopleContext]);
  state.request.recallIntent = classifyRecallIntent(request.query, {
    channel: request.channel,
    projectId: request.projectId,
    knownPersonNames: state.knownPersonNames,
  });
  state.diagnostics.recallIntent = state.request.recallIntent;
  const parallel = startParallelRecall(state);
  const earlyReturn = await tryIdentifierEarlyReturn(state, parallel);
  // Started after the probe, so documents the probe hydrated come from its memo, and before the semantic lane, so
  // the rest of lexical hydration overlaps it.
  const lexical = startLexicalHydration(state, parallel);
  if (earlyReturn) {
    state.earlyReturn = true;
    state.pendingCredits.push({
      surface: "recall",
      lane: "recall.vector",
      vectorBytes: COST_UNIT_BYTES.vectorQuery,
      textBytes: 0,
    });
  } else {
    await runSemanticLane(state, parallel);
  }
  await mergeLexicalLane(state, lexical);
  await runKnowledgeAndAssets(state, parallel.kbList);
  return finalizeRecall(state, parallel);
}
