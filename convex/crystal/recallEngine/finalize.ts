import { applyProvenanceToMemory } from "../recallProvenance";
import { buildRecallHttpBody, shapeAssetContextForHttp, shapeRecallMemoryForHttp } from "./response";
import { selectBookkeepingIds } from "./scope";
import { sourceRoleCounts } from "./sourceRole";
import type { ParallelRecall, RecallEngineSuccess, RecallPendingCredit, RecallRuntime } from "./types";

function coalescePendingCredits(credits: RecallPendingCredit[]): Array<Omit<RecallPendingCredit, "lane">> {
  const byLane = new Map<string, RecallPendingCredit>();
  for (const credit of credits) {
    const key = `${credit.surface}:${credit.lane}`;
    const existing = byLane.get(key);
    if (existing) {
      existing.vectorBytes = Math.max(existing.vectorBytes, credit.vectorBytes);
      existing.textBytes = Math.max(existing.textBytes, credit.textBytes);
    } else {
      byLane.set(key, { ...credit });
    }
  }
  const bySurface = new Map<string, Omit<RecallPendingCredit, "lane">>();
  for (const credit of byLane.values()) {
    const existing = bySurface.get(credit.surface);
    if (existing) {
      existing.vectorBytes += credit.vectorBytes;
      existing.textBytes += credit.textBytes;
    } else {
      bySurface.set(credit.surface, {
        surface: credit.surface,
        vectorBytes: credit.vectorBytes,
        textBytes: credit.textBytes,
      });
    }
  }
  return Array.from(bySurface.values());
}

async function bookkeepAndProvenance(state: RecallRuntime, shapedMemories: any[]): Promise<any[]> {
  const recalledMemoryIds = selectBookkeepingIds(state.memories, state.request);
  const provenanceNow = Date.now();
  if (recalledMemoryIds.length > 0 && state.request.recordAccess && !state.ports.benchmarkRecall) {
    const pending = state.ports.bookkeep(recalledMemoryIds);
    if (state.request.awaitBookkeeping) await pending;
  }
  const contradictedIds = new Set<string>();
  return shapedMemories.map((memory) => applyProvenanceToMemory(memory, contradictedIds, provenanceNow));
}

export async function finalizeRecall(state: RecallRuntime, parallel: ParallelRecall): Promise<RecallEngineSuccess> {
  const shapedMemories = state.memories.map((memory: any) => shapeRecallMemoryForHttp(memory));
  const shapedAssetContexts = state.assetContexts.map((asset: any) => shapeAssetContextForHttp(asset));
  state.diagnostics.candidateCounts.final = shapedMemories.length;
  state.diagnostics.trim.afterFinalComposition = shapedMemories.length;
  state.diagnostics.sourceRoles = sourceRoleCounts(shapedMemories);
  const memoriesPromise = bookkeepAndProvenance(state, shapedMemories).then(
    (memories) => ({ memories }),
    (error: unknown) => ({ error }),
  );
  const filteredMessageMatches = await parallel.resolveMessages();

  // Include credits queued by the parallel message lane before dispatching.
  const credits = coalescePendingCredits(state.pendingCredits);
  state.pendingCredits = [];
  const creditDispatch = Promise.all(credits.map((credit) =>
    Promise.resolve(state.ports.creditLane?.(credit)).catch(() => undefined),
  ));
  const [memoryResult] = await Promise.all([memoriesPromise, creditDispatch]);
  if ("error" in memoryResult) throw memoryResult.error;
  const memories = memoryResult.memories;

  // R16: keep this mark at the fixed post-lane point, after vector/text marks.
  if (state.messageLaneOutcome.bm25SkippedForBudget) {
    const messageBudget = state.messageBudget;
    state.degradation.mark({
      code: "cost_budget_exceeded",
      message: "Keyword message search was skipped because a message cost budget was exceeded; recent messages were searched instead.",
      recoverable: true,
      affectedStage: "messages",
      reason: "text_budget_exceeded",
      surface: messageBudget?.degradation?.surface ?? "messages",
      scope: messageBudget?.degradation?.scope,
      resetsAt: messageBudget?.degradation?.resetsAt,
      ...(state.messageLaneOutcome.tier ? { tier: state.messageLaneOutcome.tier } : {}),
    });
  }

  return {
    status: 200,
    body: buildRecallHttpBody(state, memories, shapedAssetContexts, filteredMessageMatches, shapedMemories.length),
  };
}
