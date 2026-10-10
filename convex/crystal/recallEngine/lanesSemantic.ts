import { ConvexError } from "convex/values";
import { markRecallCostDegradation } from "./degradation";
import { passesStoreCategoryTagFilters } from "./scope";
import { COST_UNIT_BYTES } from "../recallBudgetPolicy";
import { logError } from "../crypto";
import type { ParallelRecall, RecallRuntime } from "./types";

function markVectorSkipped(state: RecallRuntime): void {
  markRecallCostDegradation(state.degradation, {
    message:
      "Semantic recall temporarily skipped because a recall cost budget was exceeded; fallback retrieval was used.",
    affectedStage: "vector",
    policy: state.reach,
    budget: state.recallBudget,
  });
  // R14: credit vector charge when no vector search ran
  state.pendingCredits.push({
    surface: "recall",
    lane: "recall.vector",
    vectorBytes: COST_UNIT_BYTES.vectorQuery,
    textBytes: 0,
  });
}

function markVectorReduced(state: RecallRuntime): void {
  const reasons = state.reach.reasons;
  if (!reasons.includes("vector_budget_exceeded") && !reasons.includes("vector_budget_limited")) return;
  markRecallCostDegradation(state.degradation, {
    message: "Semantic recall used reduced vector reach because a recall cost budget was exceeded.",
    affectedStage: "vector",
    policy: state.reach,
    budget: state.recallBudget,
  });
}

async function resolveQueryEmbedding(state: RecallRuntime): Promise<number[] | null> {
  if (Array.isArray(state.request.precomputedEmbedding)) return state.request.precomputedEmbedding;
  return state.timer.measure("embed", () => state.ports.embed(state.request.query));
}

export async function markSemanticFailure(state: RecallRuntime, err: unknown): Promise<void> {
  const hadEmbedding = Array.isArray(state.queryEmbedding);
  console.error("[recall] semantic recall failed:", await logError(err, state.ports.userId));
  if (!hadEmbedding) {
    // Embedding failures happen before vector search, so the estimated vector
    // charge is unexecuted just as it is when embedding returns no vector.
    state.pendingCredits.push({
      surface: "recall",
      lane: "recall.vector",
      vectorBytes: COST_UNIT_BYTES.vectorQuery,
      textBytes: 0,
    });
  }
  const capExceeded =
    !hadEmbedding &&
    err instanceof ConvexError &&
    (err.data as { code?: string } | undefined)?.code === "embedding_cap_exceeded";
  state.degradation.mark({
    code: hadEmbedding ? "vector_search_failed" : "embedding_unavailable",
    ...(capExceeded ? { reason: "embedding_cap_exceeded" } : {}),
    message: hadEmbedding
      ? "Semantic vector recall failed; fallback retrieval was used."
      : "Embedding generation failed; fallback retrieval was used.",
    recoverable: true,
    affectedStage: hadEmbedding ? "vector" : "embedding",
  });
}

export async function embedAndSearch(state: RecallRuntime, parallel: ParallelRecall): Promise<void> {
  if (state.reach.degraded) markVectorReduced(state);
  const queryEmbedding = await resolveQueryEmbedding(state);
  state.queryEmbedding = queryEmbedding;
  parallel.startMessages();
  if (!Array.isArray(queryEmbedding) || state.request.hasKnowledgeBaseScope) {
    if (!state.request.hasKnowledgeBaseScope) {
      // R14: credit vector when embedding failed and no search ran
      state.pendingCredits.push({
        surface: "recall",
        lane: "recall.vector",
        vectorBytes: COST_UNIT_BYTES.vectorQuery,
        textBytes: 0,
      });
    }
    return;
  }
  // Filtered recallMemories calls ask for every hit up to the reach depth.
  const filteredDepth = state.request.filteredVectorDepth !== undefined;
  const requestProjectId = state.request.messageProject?.projectId;
  const repoSlug = state.request.messageProject?.repoSlug;
  const raw = await state.timer.measure("vectorSearch", () =>
    state.ports.vectorSearch({
      userId: state.ports.userId,
      queryEmbedding,
      query: state.request.query,
      limit: state.request.limit,
      channel: state.request.channel,
      sessionKey: state.request.sessionKey,
      scopeToSession: state.request.scopeToSession,
      vectorDepth: state.reach.vectorDepth,
      ...(state.agentLayer && state.reach.degraded ? { allowFilterRefill: false } : {}),
      includeArchived: state.request.includeArchived,
      ...(state.agentLayer ? { agentLayer: state.agentLayer } : {}),
      ...(filteredDepth ? { candidateDepth: state.reach.vectorDepth } : {}),
      ...(requestProjectId ? { requestProjectId } : {}),
      ...(repoSlug ? { repoSlug } : {}),
    }),
  );
  let crossProjectDrops = 0;
  let refillFailed = false;
  const memories: any[] = [];
  for (const row of raw) {
    if (row && typeof row.crossProjectDrops === "number") crossProjectDrops = row.crossProjectDrops;
    if (row?.refillFailed === true) refillFailed = true;
    if (state.agentLayer && typeof row?.agentLayerDrops === "number") state.diagnostics.suppressions.agentLayer! += row.agentLayerDrops;
    if (row?._filterDropReport) continue;
    if (row && (Object.prototype.hasOwnProperty.call(row, "crossProjectDrops") || Object.prototype.hasOwnProperty.call(row, "refillFailed") || Object.prototype.hasOwnProperty.call(row, "agentLayerDrops"))) {
      const { crossProjectDrops: _drops, refillFailed: _refill, agentLayerDrops: _agentDrops, ...rest } = row;
      memories.push(rest);
    } else {
      memories.push(row);
    }
  }
  if (crossProjectDrops > 0) state.diagnostics.suppressions.crossProject += crossProjectDrops;
  if (refillFailed) {
    state.degradation.mark({
      code: "vector_search_failed",
      reason: "vector_refill_failed",
      message: "The deeper semantic window failed; the first window was used.",
      recoverable: true,
      affectedStage: "vector",
    });
  }
  state.memories = memories;
  state.diagnostics.candidateCounts.semanticInitial = state.memories.length;
  // Filters run after the port's bounded vector window. recallMemories sets
  // candidateDepth for filtered calls; mcpRecall returns its full normal depth.
  // Both then compose the available candidates in one bounded ranking pass.
  state.memories = state.memories.filter((memory) => passesStoreCategoryTagFilters(memory, state.request));
}

export async function runSemanticLane(state: RecallRuntime, parallel: ParallelRecall): Promise<void> {
  try {
    if (!state.reach.vectorAllowed) markVectorSkipped(state);
    else await embedAndSearch(state, parallel);
  } catch (err) {
    await markSemanticFailure(state, err);
  }
  parallel.startMessages();
}
