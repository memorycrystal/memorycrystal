import { applyAgentLayer } from "./agentLayer";
import {
  normalizeSourceRole,
  type SourceRole,
  type SourceRoleSource,
} from "../recallRanking";
import { COST_UNIT_BYTES, RECALL_TEXT_INDEX_COUNT } from "../recallBudgetPolicy";
import { ESTIMATED_KB_VECTOR_BYTES, ESTIMATED_TEXT_INDEX_BYTES, normalRecallVectorDepth } from "./constants";
import { markRecallCostDegradation } from "./degradation";
import { recallDedupeKey } from "./dedupe";
import { composeFinalRecallMemories, finalCompositionOptions, kbSearchPriority } from "./ranking";
import { applyProjectFilter, applyRequestedKnowledgeBaseFilter, dropRecentMemoryIds } from "./scope";
import { resolveKnowledgeBaseSourceRole, sourceRoleCounts } from "./sourceRole";
import type { RecallRuntime } from "./types";
import { logError } from "../crypto";

function assetKnowledgeBaseIds(state: RecallRuntime, activeKBs: any[]): string[] | undefined {
  const visible = activeKBs.map((kb) => String(kb._id));
  if (visible.length > 0) return visible;
  return state.request.requestedKnowledgeBaseIds?.length ? [] : undefined;
}

export function startAssetSearch(state: RecallRuntime, activeKBs: any[]): Promise<any[]> {
  if (!state.request.includeAssets) return Promise.resolve([]);
  return state.ports
    .searchAssets({
      userId: state.ports.userId,
      query: state.request.query,
      channel: state.request.channel,
      knowledgeBaseIds: assetKnowledgeBaseIds(state, activeKBs),
      peerScope: state.request.peerScope,
      limit: Math.min(state.request.limit, 5),
    })
    .catch(async (err: unknown) => {
      if (!(err instanceof Error) || err.message !== "asset_search_failed") {
        console.error("[recall] asset context search failed:", await logError(err, state.ports.userId));
      }
      state.degradation.mark({
        code: "asset_search_failed",
        message: "Asset recall fallback failed; text memory recall continued.",
        recoverable: true,
        affectedStage: "assets",
      });
      return [];
    });
}

function kbSlice(state: RecallRuntime, activeKBs: any[]): { kbs: any[]; limit: number } {
  const maxKbs = state.request.hasKnowledgeBaseScope ? 12 : state.request.recallIntent === "factual_framework" ? 6 : 4;
  const limit = state.request.recallIntent === "factual_framework" ? Math.min(Math.max(state.request.limit, 6), 8) : 3;
  const kbs = [...activeKBs]
    .sort((a, b) => kbSearchPriority(b, state.request.query, state.request.recallIntent) - kbSearchPriority(a, state.request.query, state.request.recallIntent))
    .slice(0, maxKbs);
  return { kbs, limit };
}

async function debitKnowledgeBases(state: RecallRuntime, count: number) {
  if (state.ports.benchmarkRecall) return null;
  return state.ports.debit({
    surface: "kb",
    estimatedVectorQueryBytes: ESTIMATED_KB_VECTOR_BYTES * count,
    estimatedTextQueryBytes: ESTIMATED_TEXT_INDEX_BYTES * RECALL_TEXT_INDEX_COUNT * count,
    reason: "mcp.recall.knowledge_bases",
  });
}

function pushKnowledgeBaseHit(
  state: RecallRuntime,
  km: any,
  knowledgeBase: any,
  kbSummary: any,
  sourceRole: { sourceRole: SourceRole; sourceRoleSource: SourceRoleSource },
  existingIds: Set<string>,
  existingContentKeys: Set<string>,
): boolean {
  const id = String(km.memoryId ?? km._id ?? "");
  if (!id) return false;
  const knowledgeBaseId = String(km.knowledgeBaseId ?? kbSummary._id);
  const explicitRole = normalizeSourceRole(knowledgeBase?.sourceRole);
  if (existingIds.has(id)) {
    // The recent/text lanes can discover the same KB row before the KB lane.
    // Preserve its resolved per-agent priority and KB role when that happens.
    const existing = state.memories.find((memory: any) => String(memory._id) === id);
    if (existing) {
      existing.knowledgeBaseId = knowledgeBaseId;
      existing.knowledgeBaseName = knowledgeBase?.name ?? kbSummary.name ?? "unknown";
      existing.kbAgentPriority = km.kbAgentPriority ?? existing.kbAgentPriority;
      existing.sourceRole = explicitRole ?? sourceRole.sourceRole;
      existing.sourceRoleSource = explicitRole ? "metadata" : sourceRole.sourceRoleSource;
    }
    return false;
  }
  if (state.request.resolvedCategories?.length && km.category && !state.request.resolvedCategories.includes(km.category)) {
    state.diagnostics.suppressions.categoryFilter += 1;
    return false;
  }
  const contentKey = recallDedupeKey(km, state.request.collapseNearDuplicates);
  const hasContentKey = !contentKey.startsWith(" id:");
  if (hasContentKey && existingContentKeys.has(contentKey)) {
    state.diagnostics.suppressions.duplicateOrExisting += 1;
    return false;
  }
  existingIds.add(id);
  if (hasContentKey) existingContentKeys.add(contentKey);
  state.diagnostics.candidateCounts.kbAppended += 1;
  state.memories.push({
    _id: id,
    title: km.title,
    content: km.content,
    store: km.store,
    category: km.category,
    tags: km.tags ?? [],
    createdAt: km.createdAt ?? Date.now(),
    source: km.source,
    supersededByMemoryId: km.supersededByMemoryId,
    score: km.scoreValue ?? km.score ?? 0,
    confidence: km.confidence ?? 0.7,
    rankingSignals: km.rankingSignals,
    knowledgeBaseId,
    knowledgeBaseName: knowledgeBase?.name ?? kbSummary.name ?? "unknown",
    sourceRole: explicitRole ?? sourceRole.sourceRole,
    sourceRoleSource: explicitRole ? "metadata" : sourceRole.sourceRoleSource,
  });
  return true;
}

function absorbKnowledgeBase(
  state: RecallRuntime,
  result: PromiseSettledResult<any>,
  kbSummary: any,
  existingIds: Set<string>,
  existingContentKeys: Set<string>,
): void {
  const sourceRole = resolveKnowledgeBaseSourceRole(kbSummary);
  const searched = {
    id: String(kbSummary?._id ?? ""),
    name: String(kbSummary?.name ?? "unknown"),
    sourceRole: sourceRole.sourceRole,
    sourceRoleSource: sourceRole.sourceRoleSource,
    returned: 0,
  };
  if (result.status !== "fulfilled" || !result.value) {
    state.diagnostics.knowledgeBasesSearched.push(searched);
    return;
  }
  const value = result.value as any;
  if (value.degradation) markKnowledgeBaseDegradation(state, value.degradation);
  if (!Array.isArray(value.memories)) {
    state.diagnostics.knowledgeBasesSearched.push(searched);
    return;
  }
  for (const km of value.memories) {
    if (pushKnowledgeBaseHit(state, km, value.knowledgeBase, kbSummary, sourceRole, existingIds, existingContentKeys)) {
      searched.returned += 1;
    }
  }
  state.diagnostics.knowledgeBasesSearched.push(searched);
}

function markKnowledgeBaseDegradation(state: RecallRuntime, kbDegradation: any): void {
  state.degradation.mark({
    code: String(kbDegradation.code ?? "kb_retrieval_degraded"),
    message: "Knowledge-base recall used a degraded retrieval path.",
    recoverable: kbDegradation.recoverable !== false,
    affectedStage: "knowledge_bases",
    reason: Array.isArray(kbDegradation.reasons) ? kbDegradation.reasons.join(",") : undefined,
    surface: "kb",
    tier: kbDegradation.tier,
    vectorDepth: kbDegradation.vectorDepth,
    budgetLevel: kbDegradation.budgetLevel,
    upgradePrompt: kbDegradation.upgradePrompt,
  });
}

async function searchSelectedKnowledgeBases(state: RecallRuntime, activeKBs: any[]): Promise<void> {
  const { kbs, limit } = kbSlice(state, activeKBs);
  state.diagnostics.candidateCounts.knowledgeBasesSearched = kbs.length;
  const kbBudget = await debitKnowledgeBases(state, kbs.length);
  const reach = state.ports.resolveReach({
    tier: state.userTier,
    normalVectorDepth: normalRecallVectorDepth(limit),
    vectorBudget: kbBudget,
    textBudget: kbBudget,
    indexedFallbackAllowedOnDegradation: true,
  });
  if (reach.degraded) {
    markRecallCostDegradation(state.degradation, {
      message:
        "Knowledge-base recall semantic search was degraded because a KB cost budget was exceeded; bounded KB fallback was attempted.",
      affectedStage: "knowledge_bases",
      policy: reach,
      budget: kbBudget,
    });
  }
  const results = await Promise.allSettled(kbs.map((kb) => queryOneKnowledgeBase(state, kb, limit, kbBudget, reach.vectorDepth)));
  if (kbBudget && !state.ports.benchmarkRecall) {
    let vectorBytes = 0;
    let textBytes = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        vectorBytes += COST_UNIT_BYTES.vectorQuery;
        textBytes += COST_UNIT_BYTES.textIndexQuery * RECALL_TEXT_INDEX_COUNT;
        continue;
      }
      const retrieval = result.value?.retrieval;
      if (retrieval?.vectorAttempted !== true) vectorBytes += COST_UNIT_BYTES.vectorQuery;
      if (retrieval?.lexicalAttempted !== true) textBytes += COST_UNIT_BYTES.textIndexQuery * RECALL_TEXT_INDEX_COUNT;
    }
    if (vectorBytes + textBytes > 0) {
      state.pendingCredits.push({
        surface: "kb",
        lane: "kb.retrieval",
        vectorBytes,
        textBytes,
      });
    }
  }
  const existingIds = new Set(state.memories.map((memory: any) => String(memory._id)));
  const existingContentKeys = new Set(
    state.memories.map((memory: any) => recallDedupeKey(memory, state.request.collapseNearDuplicates)).filter((key: string) => !key.startsWith(" id:")),
  );
  for (let i = 0; i < results.length; i += 1) absorbKnowledgeBase(state, results[i], kbs[i], existingIds, existingContentKeys);
}

function queryOneKnowledgeBase(state: RecallRuntime, kb: any, limit: number, kbBudget: any, vectorDepth: number): Promise<any> {
  return state.ports.queryKnowledgeBase({
    userId: state.ports.userId,
    knowledgeBaseId: kb._id,
    query: state.request.query,
    limit,
    agentId: state.request.effectiveAgentId,
    queryEmbedding: Array.isArray(state.queryEmbedding) ? state.queryEmbedding : undefined,
    skipCostBreaker: true,
    precomputedCostBudget: kbBudget ?? undefined,
    vectorDepth,
    channel: state.request.channel,
    includeGraphContext: false,
    allowIndexedFill: state.request.hasKnowledgeBaseScope,
    skipAccessBookkeeping: true,
  });
}

async function searchActiveKnowledgeBases(state: RecallRuntime, activeKBs: any[]): Promise<void> {
  try {
    if (Array.isArray(activeKBs) && activeKBs.length > 0) await searchSelectedKnowledgeBases(state, activeKBs);
  } catch (err) {
    console.error("[recall] KB search failed:", await logError(err, state.ports.userId));
  }
}

async function composeMemories(state: RecallRuntime): Promise<void> {
  state.diagnostics.candidateCounts.preFinalComposition = state.memories.length;
  state.diagnostics.trim.beforeFinalComposition = state.memories.length;
  const composed = await state.timer.measure("compose", () =>
    composeFinalRecallMemories(state.memories, finalCompositionOptions(state)),
  );
  state.memories = dropRecentMemoryIds(composed, state.request.recentMemoryIds);
  state.diagnostics.candidateCounts.final = state.memories.length;
  state.diagnostics.trim.afterFinalComposition = state.memories.length;
  state.diagnostics.trim.trimmed = Math.max(0, state.diagnostics.trim.beforeFinalComposition - state.memories.length);
  state.diagnostics.sourceRoles = sourceRoleCounts(state.memories);
}

export async function runKnowledgeAndAssets(state: RecallRuntime, activeKBsPromise: Promise<any[]>): Promise<void> {
  const activeKBs = await activeKBsPromise;
  state.diagnostics.candidateCounts.activeKnowledgeBases = activeKBs.length;
  const assetPromise = startAssetSearch(state, activeKBs);
  const kbPromise = state.timer.measure("kb", () => searchActiveKnowledgeBases(state, activeKBs));
  const [assets] = await Promise.all([assetPromise, kbPromise]);
  state.assetContexts = assets;
  state.diagnostics.candidateCounts.assetContexts = assets.length;
  applyRequestedKnowledgeBaseFilter(state);
  await applyProjectFilter(state);
  applyAgentLayer(state);
  await composeMemories(state);
}
