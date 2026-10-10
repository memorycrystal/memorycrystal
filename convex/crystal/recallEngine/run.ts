import { loadAgentLayer } from "./agentLayer";
import { logError } from "../crypto";
import type { UserTier } from "../../../shared/tierLimits";
import { createRecallStageTimer } from "../recallTimings";
import { loadRecallBudgets } from "./budgets";
import { createRecallDiagnostics } from "./diagnostics";
import { createDegradationTracker } from "./degradation";
import { finalizeRecall } from "./finalize";
import { tryIdentifierEarlyReturn } from "./earlyReturn";
import { runKnowledgeAndAssets } from "./lanesKnowledge";
import { mergeLexicalLane } from "./lanesLexical";
import { COST_UNIT_BYTES } from "../recallBudgetPolicy";
import { startParallelRecall } from "./lanesParallel";
import { runSemanticLane } from "./lanesSemantic";
import { normalRecallVectorDepth } from "./constants";
import type { NormalizedRecallRequest, RecallEngineSuccess, RecallPorts, RecallRuntime } from "./types";
import { firstNameTokensFromPersonTitles } from "../recallCoverage";
import { classifyRecallIntent } from "../recallRanking";

let recallEngineEntries = 0;

export function recallEngineEntryCount(): number {
  return recallEngineEntries;
}

export function resetRecallEngineEntryCount(): void {
  recallEngineEntries = 0;
}

export function createRecallRuntime(request: NormalizedRecallRequest, ports: RecallPorts): RecallRuntime {
  return {
    request,
    ports,
    timer: createRecallStageTimer(),
    startedAt: Date.now(),
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
): Promise<RecallEngineSuccess> {
  recallEngineEntries += 1;
  const state = createRecallRuntime(request, ports);
  try {
    await loadAgentLayer(state);
  } catch (err) {
    console.error("[recall] agent_layer_unavailable:", await logError(err, state.ports.userId, [state.request.agentId]));
    state.degradation.mark({
      code: "agent_layer_unavailable",
      message: "Agent recall policy unavailable; using the account pool.",
      recoverable: true,
      affectedStage: "agent_layer",
    });
  }
  const hasPersonalAttributeCue = /\b(height|weight|age|old|birthday|birth ?date|bmr|basal metabolic rate)\b|\bon file\b/i.test(request.query);
  const hasTechnicalAttributeCue = /\b(css|style|refactor|mountain|limit|luggage|code|repository|deploy|deployment|service|app|system|database|software|server|model)\b/i.test(request.query);
  const needsPeopleContext = request.mode === "people" ||
    (request.resolveIdentity !== false && (request.recallIntent === "personal_attribute" ||
      (hasPersonalAttributeCue && !hasTechnicalAttributeCue)));
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
  await Promise.all([loadRecallBudgets(state), peopleContext]);
  state.request.recallIntent = classifyRecallIntent(request.query, {
    channel: request.channel,
    projectId: request.projectId,
    knownPersonNames: state.knownPersonNames,
  });
  state.diagnostics.recallIntent = state.request.recallIntent;
  const parallel = startParallelRecall(state);
  if (await tryIdentifierEarlyReturn(state, parallel)) {
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
  await mergeLexicalLane(state, parallel);
  await runKnowledgeAndAssets(state, parallel.kbList);
  return finalizeRecall(state, parallel);
}
