import {
  defaultRecallRankingWeights,
  deriveTextMatchScore,
  rankRecallV2Candidates,
  type RecallIntent,
  type RecallRankingCandidate,
} from "../recallRanking";
import { getMemoryProjectId, getMemorySourceRole, resolveKnowledgeBaseSourceRole } from "./sourceRole";
import { analyzeQuery, hasConflictingIdentifier, scoringText } from "./queryAnalysis";
import { recallDedupeKey } from "./dedupe";
import { recallRequestAllowlist, withRecallScopeAdjustment } from "./memoryPolicy";
import type { RecallRuntime } from "./types";

export function recallCompositionCandidate(memory: any): RecallRankingCandidate & Record<string, any> {
  const id = String(memory?._id ?? memory?.memoryId ?? "");
  const { sourceRole, sourceRoleSource } = getMemorySourceRole(memory);
  const projectId = getMemoryProjectId(memory);
  return {
    ...memory,
    _id: id,
    memoryId: id,
    title: String(memory?.title ?? ""),
    content: String(memory?.content ?? ""),
    topicText: String(memory?.topicText ?? memory?.content ?? ""),
    store: String(memory?.store ?? "episodic"),
    category: String(memory?.category ?? "conversation"),
    tags: Array.isArray(memory?.tags) ? memory.tags.map(String) : [],
    strength: Number.isFinite(Number(memory?.strength ?? memory?.memoryStrength))
      ? Number(memory?.strength ?? memory?.memoryStrength)
      : 0.5,
    confidence: Number.isFinite(Number(memory?.confidence)) ? Number(memory.confidence) : 0.7,
    accessCount: Number.isFinite(Number(memory?.accessCount)) ? Number(memory.accessCount) : 0,
    lastAccessedAt: memory?.lastAccessedAt,
    createdAt: memory?.createdAt,
    salienceScore: memory?.salienceScore ?? memory?.rankingSignals?.salienceScore,
    channel: memory?.channel,
    vectorScore: memory?.vectorScore ?? memory?.rankingSignals?.vectorScore ?? memory?.score,
    textMatchScore: memory?.textMatchScore ?? memory?.rankingSignals?.textMatchScore,
    identifierMatchScore: memory?.identifierMatchScore ?? memory?.rankingSignals?.identifierMatchScore,
    identifierMatch: memory?.identifierMatch ?? memory?.rankingSignals?.identifierMatch,
    requestedPrTicketMatch: memory?.requestedPrTicketMatch ?? memory?.rankingSignals?.requestedPrTicketMatch,
    decisiveIdentifierMatch: memory?.decisiveIdentifierMatch ?? memory?.rankingSignals?.decisiveIdentifierMatch,
    exactPhraseMatch: memory?.exactPhraseMatch ?? memory?.rankingSignals?.exactPhraseMatch,
    knowledgeBaseId: memory?.knowledgeBaseId,
    knowledgeBaseName: memory?.knowledgeBaseName,
    kbAgentPriority: memory?.kbAgentPriority ?? memory?.rankingSignals?.kbAgentPriority,
    sourceRole,
    sourceRoleSource,
    projectId,
  };
}

/** The one option set the final composition uses; the identifier early-return probe composes with the same options. */
export function finalCompositionOptions(state: RecallRuntime) {
  return {
    query: state.request.query,
    channel: state.request.channel,
    projectId: state.request.projectId,
    recallIntent: state.request.recallIntent,
    mode: state.request.mode,
    knownPersonNames: state.knownPersonNames,
    collapseNearDuplicates: state.request.collapseNearDuplicates,
    limit: state.request.limit,
    weights: defaultRecallRankingWeights,
  };
}

export function composeFinalRecallMemories(
  memories: any[],
  options: {
    query: string;
    channel?: string;
    projectId?: string;
    recallIntent: RecallIntent;
    mode?: string;
    knownPersonNames?: readonly string[];
    collapseNearDuplicates?: boolean;
    limit: number;
    weights: Partial<typeof defaultRecallRankingWeights> | null | undefined;
  },
): any[] {
  const analyzed = analyzeQuery(options.query);
  const allowlist = recallRequestAllowlist();
  const ranked = rankRecallV2Candidates(
    memories
      .map((memory) => ({ memory, candidate: recallCompositionCandidate(memory) }))
      .filter(({ memory, candidate }) => {
        if (!candidate.memoryId || !candidate.content) return false;
        const scoredText = scoringText(memory);
        return !hasConflictingIdentifier(
          analyzed,
          `${scoredText.title} ${scoredText.fullText} ${scoredText.tags.join(" ")}`,
        );
      })
      .map(({ candidate }) => withRecallScopeAdjustment(candidate, { ...options, allowlist })),
    {
      now: Date.now(),
      query: options.query,
      limit: options.limit,
      channel: options.channel,
      projectId: options.projectId,
      recallIntent: options.recallIntent,
      mode: options.mode,
      knownPersonNames: options.knownPersonNames,
    },
  );
  const deduped: typeof ranked = [];
  const seen = new Set<string>();
  for (const candidate of ranked) {
    const key = recallDedupeKey(candidate, options.collapseNearDuplicates ?? false);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
    if (deduped.length >= options.limit) break;
  }
  return deduped.map((candidate) => {
    const {
      scoreValue, memoryId, rankingSignals, topicText, rankScore, adjustment, relevance,
      sameProject: _sameProject, scopeAdjustmentOverride: _scopeAdjustmentOverride,
      projectMatch: _projectMatch, crossProjectDrops: _crossProjectDrops,
      ...rest
    } = candidate as any;
    return {
      ...rest,
      _id: rest._id ?? memoryId,
      score: scoreValue,
      relevance,
      rankScore,
      adjustment,
      rankingSignals,
    };
  });
}

export function kbSearchPriority(kb: any, query: string, intent: RecallIntent): number {
  const { sourceRole } = resolveKnowledgeBaseSourceRole(kb);
  const rolePriority: Record<string, number> =
    intent === "factual_framework"
      ? {
          canonical_reference: 100,
          unknown: 35,
          client_context: 20,
          project_context: 18,
          user_preference: 12,
          message_history: 8,
          persona_guardrail: 2,
          voice_style: 30,
        }
      : {
          client_context: 60,
          canonical_reference: 55,
          project_context: 45,
          user_preference: 35,
          message_history: 30,
          unknown: 25,
          persona_guardrail: 15,
          voice_style: 15,
        };
  const textScore = deriveTextMatchScore(
    query,
    String(kb?.name ?? ""),
    String(kb?.description ?? ""),
    Array.isArray(kb?.tags) ? kb.tags.map(String) : [],
  );
  return rolePriority[sourceRole] + textScore * 20 + Math.min(Number(kb?.updatedAt ?? 0) / 10_000_000_000_000, 1);
}
