import { keepAgentLayer, widenAgentText } from "./agentLayer";
import { isCompactRecallEnabled, resolveRecallContent } from "../memoryText";
import { isNonKnowledgeBaseMemoryVisibleInChannel } from "../knowledgeBases";
import { hasPastReferenceIntent, hasRecencyIntent, type RecallRankingCandidate } from "../recallRanking";
import { markRecallCostDegradation } from "./degradation";
import { COST_UNIT_BYTES, RECALL_TEXT_INDEX_COUNT } from "../recallBudgetPolicy";
import { candidateHasConflict, getAnalyzedQuery, identifierCandidates } from "./identifiers";
import { analyzeQuery, scoreQueryMatch, scoringText } from "./queryAnalysis";
import { passesStoreCategoryTagFilters } from "./scope";
import { getMemoryProjectId } from "./sourceRole";
import {
  type MemoryTextHits,
  decideMemoryProject,
  isRecallMemoryVisible,
  memoryProjectIdentity,
  recallRequestAllowlist,
  requestProjectIdentity,
} from "./memoryPolicy";
import { shapeLexicalCandidates } from "./lexicalShape";
import { blockForeignSessions, hydrateTextDocs, textHitIds } from "./lexicalIo";
import type { ParallelRecall, RecallRuntime } from "./types";
import { logError } from "../crypto";

function skipTextSearch(state: RecallRuntime): boolean {
  return state.request.hasKnowledgeBaseScope || !state.reach.textAllowed || state.request.query.trim().length === 0;
}

/** Use an extracted identifier to broaden candidate discovery; scoring still uses the original query. */
export function lexicalCandidateSearchQuery(
  query: string,
  options: { mode?: string; knownPersonNames?: readonly string[] } = {},
): string {
  // Person names are ranking preferences, not conjunctive text-index terms.
  // Appending all known names can suppress an otherwise matching fact row.
  void options;
  const analyzed = analyzeQuery(query);
  if (analyzed.prNumbers.size) {
    return [...analyzed.prNumbers].join(" ");
  }
  if (analyzed.ticketIds.size) {
    return [...analyzed.ticketIds].flatMap(([prefix, ids]) => [...ids].map((id) => `${prefix}-${id}`)).join(" ");
  }
  if (analyzed.shas.length) return analyzed.shas.join(" ");
  if (analyzed.urls.length) return query;
  if (analyzed.semvers.length) return analyzed.semvers.join(" ");
  const recencyIntent = /\b(latest|most recent|newest|current(?:ly)?|right now|as of now|at the moment|nowadays|up to date)\b/i.test(query);
  const pastReference = /\b(last time|originally|initially|previous(?:ly)?|used to|at first|first time)\b/i.test(query);
  const intentOnlyTerms = new Set<string>();
  if (recencyIntent) {
    for (const term of ["latest", "recent", "newest", "current", "currently", "now", "nowadays", "status"]) {
      intentOnlyTerms.add(term);
    }
  }
  if (pastReference) {
    for (const term of ["last", "originally", "initially", "previous", "previously", "used", "first"]) {
      intentOnlyTerms.add(term);
    }
  }
  const candidateTerms = analyzed.informativeTerms.filter((term) => !intentOnlyTerms.has(term));
  return candidateTerms.join(" ") || query;
}

function startTextSearch(state: RecallRuntime): Promise<MemoryTextHits> {
  if (skipTextSearch(state)) return Promise.resolve([]);
  const actionAdapter = state.request.includeMessages === false;
  const recencyIntent = hasRecencyIntent(state.request.query);
  const recencySensitive = hasRecencyIntent(state.request.query) || hasPastReferenceIntent(state.request.query);
  const preserveActionDefaults = actionAdapter && !recencyIntent;
  const searchWindow = preserveActionDefaults ? 50 : recencySensitive ? 200 : 150;
  const oversample = preserveActionDefaults ? 4 : recencySensitive ? 20 : 15;
  return state.ports
    .textSearch({
      userId: state.ports.userId,
      query: preserveActionDefaults
        ? state.request.query
        : lexicalCandidateSearchQuery(state.request.query, {
            mode: state.request.mode,
            knownPersonNames: state.knownPersonNames,
          }),
      // Over-fetch indexed IDs so repeated exact-text/inference rows cannot
      // crowd their substantive source out before the shared compositor sees it.
      limit: widenAgentText(Math.min(Math.max(state.request.limit * oversample, 20), searchWindow), searchWindow, state.agentLayer),
      ...(state.agentLayer ? { agentLayer: state.agentLayer } : {}),
      recallFilters: true,
    })
    .catch(async (err: unknown) => {
      console.error("[recall] text search fallback failed:", await logError(err, state.ports.userId));
      state.degradation.mark({
        code: "text_search_failed",
        message: "Text recall fallback failed; remaining retrieval sources were used.",
        recoverable: true,
        affectedStage: "text",
      });
      return [];
    });
}

function startRecent(state: RecallRuntime): Promise<any[]> {
  if (state.request.hasKnowledgeBaseScope) return Promise.resolve([]);
  return state.ports
    .recent({
      userId: state.ports.userId,
      limit: 100,
      channel: state.request.channel,
      sessionKey: state.request.sessionKey,
      scopeToSession: state.request.scopeToSession,
      ...(state.agentLayer ? { agentLayer: state.agentLayer } : {}),
      ...(state.request.messageProject?.projectId ? { requestProjectId: state.request.messageProject.projectId } : {}),
      ...(state.request.messageProject?.repoSlug ? { repoSlug: state.request.messageProject.repoSlug } : {}),
      ...(hasRecencyIntent(state.request.query) ? { recencyIntent: true } : {}),
    })
    .catch(async (err: unknown) => {
      console.error("[recall] recent fallback failed:", await logError(err, state.ports.userId));
      state.degradation.mark({
        code: "partial_backend_failure",
        message: "Recent-memory recall fallback failed; remaining retrieval sources were used.",
        recoverable: true,
        affectedStage: "hydration",
      });
      return [];
    });
}

export function startLexicalIo(state: RecallRuntime): Promise<[MemoryTextHits, any[]]> {
  return state.timer.measure("lexical", () => Promise.all([startTextSearch(state), startRecent(state)]));
}

function noteTextSkipped(state: RecallRuntime): void {
  if (state.request.hasKnowledgeBaseScope || state.reach.textAllowed) return;
  markRecallCostDegradation(state.degradation, {
    message:
      "Text recall temporarily skipped because a recall cost budget was exceeded; recent-memory fallback was used.",
    affectedStage: "text",
    policy: state.reach,
    budget: state.textBudget,
  });
  // R14: credit text when text was disallowed
  state.pendingCredits.push({
    surface: state.textBudget?.degradation?.surface as "recall" | "kb" | "messages" || "recall",
    lane: "recall.text",
    vectorBytes: 0,
    textBytes: COST_UNIT_BYTES.textIndexQuery * RECALL_TEXT_INDEX_COUNT,
  });
}

async function lexicalCandidate(
  state: RecallRuntime,
  source: any,
  blockedIds: Set<string> | null,
  compact: boolean,
  allowlist: readonly string[] | undefined,
): Promise<(RecallRankingCandidate & { _id: string; metadata?: string }) | null> {
  const id = String(source?._id ?? "");
  if (!id || source.userId !== state.ports.userId || (source.archived && !state.request.includeArchived)) return null;
  if (blockedIds?.has(id)) return null;
  const visibleIfMatched = source.knowledgeBaseId
    ? isNonKnowledgeBaseMemoryVisibleInChannel(source.channel, state.request.channel)
    : isRecallMemoryVisible(source.channel, state.request.channel, { sameProject: true, allowlist });
  if (!source.knowledgeBaseId && !visibleIfMatched) return null;
  const candidateProjectId = getMemoryProjectId(source);
  const decision = await decideMemoryProject(requestProjectIdentity(state.request), memoryProjectIdentity(source));
  if (!decision.include) {
    if (visibleIfMatched) state.diagnostics.suppressions.crossProject += 1;
    return null;
  }
  const visible = source.knowledgeBaseId
    ? isNonKnowledgeBaseMemoryVisibleInChannel(source.channel, state.request.channel)
    : isRecallMemoryVisible(source.channel, state.request.channel, { sameProject: decision.sameProject, allowlist });
  if (!visible) return null;
  if (!keepAgentLayer(state, source)) return null;
  const scoredText = scoringText(source);
  const analyzed = getAnalyzedQuery(state.request);
  if (candidateHasConflict(analyzed, scoredText.title, scoredText.fullText, scoredText.tags)) return null;
  const queryMatch = scoreQueryMatch(analyzed, scoredText.title, scoredText.fullText, scoredText.tags);
  const content = resolveRecallContent(source, compact);
  if (!content) return null;
  if (!passesStoreCategoryTagFilters(source, state.request)) return null;
  return {
    _id: id,
    memoryId: id,
    title: source.title,
    content,
    topicText: scoredText.fullText,
    dedupeText: typeof source.dedupeText === "string" ? source.dedupeText : source.content,
    metadata: source.metadata,
    store: source.store,
    category: source.category,
    tags: source.tags ?? [],
    strength: source.strength ?? 0,
    confidence: source.confidence ?? 0.7,
    accessCount: source.accessCount ?? 0,
    lastAccessedAt: source.lastAccessedAt,
    createdAt: source.createdAt,
    source: source.source,
    supersededByMemoryId: source.supersededByMemoryId,
    knowledgeBaseId: source.knowledgeBaseId ? String(source.knowledgeBaseId) : undefined,
    knowledgeBaseName: source.knowledgeBaseName,
    kbAgentPriority: source.kbAgentPriority,
    salienceScore: source.salienceScore,
    channel: source.channel,
    projectId: candidateProjectId,
    sameProject: decision.sameProject,
    vectorScore: 0,
    // The index supplies candidate IDs only. The signal comes from the full
    // surviving source text, never a BM25 constant or compact display string.
    textMatchScore: queryMatch.lexicalScore,
    identifierMatchScore: queryMatch.identifierScore,
    identifierMatch: queryMatch.identifierMatch,
    requestedPrTicketMatch: queryMatch.requestedPrTicketMatch,
    decisiveIdentifierMatch: queryMatch.decisiveIdentifierMatch,
    exactPhraseMatch: queryMatch.exactPhraseMatch,
  };
}

export async function collectLexicalCandidates(
  state: RecallRuntime,
  textDocs: any[],
  recent: any[],
  blockedIds: Set<string> | null,
  allowlist: readonly string[] | undefined,
  includePersonCandidates = true,
): Promise<Array<RecallRankingCandidate & { _id: string; metadata?: string }>> {
  const compact = isCompactRecallEnabled();
  const byId = new Map<string, RecallRankingCandidate & { _id: string; metadata?: string }>();
  for (const source of [...textDocs, ...recent, ...(includePersonCandidates ? state.personMemoryCandidates : [])]) {
    const candidate = await lexicalCandidate(state, source, blockedIds, compact, allowlist);
    if (candidate) byId.set(candidate._id, candidate);
  }
  return Array.from(byId.values());
}

type LexicalCandidate = RecallRankingCandidate & { _id: string; metadata?: string };

/** One deepening of the full, unfinished text indexes to 256 hits: only the new ids are hydrated and checked. */
async function deepenLexicalText(
  state: RecallRuntime,
  textResults: MemoryTextHits,
  firstIds: string[],
  textDocs: any[],
  firstCandidates: LexicalCandidate[],
  sessions: { seen: Set<string>; blocked: Set<string>; blockedIds: Set<string> | null },
  allowlist: readonly string[] | undefined,
): Promise<LexicalCandidate[]> {
  const expanded = await textResults.deepen!();
  const seen = new Set(firstIds);
  const newIds = textHitIds(expanded).filter((id) => !seen.has(id));
  const newDocs = await hydrateTextDocs(state, newIds);
  await blockForeignSessions(state, newDocs, sessions.seen, sessions.blocked);
  const newCandidates = await collectLexicalCandidates(state, newDocs, [], sessions.blockedIds, allowlist, false);
  const candidatesById = new Map([...firstCandidates, ...newCandidates].map((candidate) => [candidate._id, candidate]));
  return textHitIds(expanded).flatMap((id) => candidatesById.has(id) ? [candidatesById.get(id)!] : []);
}

async function rankHydratedLexical(state: RecallRuntime, textResults: MemoryTextHits, recent: any[]): Promise<any[]> {
  const firstIds = textHitIds(textResults);
  const seenSessions = new Set<string>();
  const blocked = new Set<string>();
  const allowlist = recallRequestAllowlist();
  const textDocs = await hydrateTextDocs(state, firstIds);
  await blockForeignSessions(state, [...textDocs, ...recent, ...state.personMemoryCandidates], seenSessions, blocked);
  const blockedIds = state.request.scopeToSession ? blocked : null;
  const firstCandidates = await collectLexicalCandidates(state, textDocs, [], blockedIds, allowlist, false);
  let textCandidates = firstCandidates;
  // The checks applied to the first window before ranking (visibility, project, store, category and tag filters, the
  // cross-session filter, the identifier-conflict exclusion, rows without usable content) left fewer than half of its
  // unique ids. Only then deepen the full, unfinished indexes once, to 256, and only when RECALL_FILTER_REFILL is on
  // (otherwise the hits carry no continuation). The deepening is an optional refill: if it fails, the first window
  // stands and the recall reports a recoverable degradation.
  if (firstCandidates.length < firstIds.length / 2 && textResults.deepen) {
    try {
      textCandidates = await deepenLexicalText(state, textResults, firstIds, textDocs, firstCandidates,
        { seen: seenSessions, blocked, blockedIds }, allowlist);
    } catch (err) {
      console.error("[recall] text deepening failed, keeping the first window:", await logError(err, state.ports.userId));
      state.degradation.mark({
        code: "text_search_failed",
        reason: "text_deepening_failed",
        message: "Text recall deepening failed; the first window was used.",
        recoverable: true,
        affectedStage: "text",
      });
    }
  }
  const otherCandidates = await collectLexicalCandidates(state, [], recent, blockedIds, allowlist);
  const lexicalCandidates = [...new Map([...textCandidates, ...otherCandidates].map((candidate) => [candidate._id, candidate])).values()];
  if (hasRecencyIntent(state.request.query) && state.queryEmbedding && state.ports.scoreRecallCandidates) {
    const vectorHitIds = new Set(state.memories.map((memory: any) => String(memory?._id ?? "")));
    const scoreCandidates = lexicalCandidates
      .filter((candidate) => !vectorHitIds.has(candidate._id) && (candidate.textMatchScore ?? 0) > 0)
      .sort((left, right) =>
        (right.textMatchScore ?? 0) - (left.textMatchScore ?? 0) ||
        Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0),
      )
      .slice(0, 100);
    if (scoreCandidates.length > 0) {
      try {
        const scored = await state.ports.scoreRecallCandidates({
          userId: state.ports.userId,
          memoryIds: scoreCandidates.map((candidate) => candidate._id),
          queryEmbedding: state.queryEmbedding,
        });
        const scoresById = new Map<string, number>();
        for (const row of scored) {
          if (Number.isFinite(row.score)) scoresById.set(String(row.memoryId), row.score);
        }
        for (const candidate of scoreCandidates) {
          const score = scoresById.get(candidate._id);
          if (score !== undefined) candidate.vectorScore = score;
        }
      } catch (err) {
        console.error("[recall] recency candidate vector scoring failed:", await logError(err, state.ports.userId));
        state.degradation.mark({
          code: "vector_search_failed",
          message: "Recency candidate vector scoring failed; lexical and recent candidates were used.",
          recoverable: true,
          affectedStage: "vector",
        });
      }
    }
  }
  return shapeLexicalCandidates(lexicalCandidates);
}

export function mergeRecallCandidates(semantic: any[], lexical: any[], collapseNearDuplicates: boolean, requestQuery: RecallRuntime): any[] {
  void collapseNearDuplicates;
  const identified: any[] = [];
  for (const id of identifierCandidates(requestQuery.request)) identified.push({ _id: id });
  const byId = new Map<string, any>();
  for (const memory of [...semantic, ...lexical, ...identified]) {
    const id = String(memory?._id ?? "");
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, memory);
      continue;
    }
    byId.set(id, {
      ...existing,
      ...memory,
      vectorScore: Math.max(Number(existing.vectorScore ?? existing.rankingSignals?.vectorScore ?? 0), Number(memory.vectorScore ?? memory.rankingSignals?.vectorScore ?? 0)),
      textMatchScore: Math.max(Number(existing.textMatchScore ?? existing.rankingSignals?.textMatchScore ?? 0), Number(memory.textMatchScore ?? memory.rankingSignals?.textMatchScore ?? 0)),
      identifierMatchScore: Math.max(Number(existing.identifierMatchScore ?? 0), Number(memory.identifierMatchScore ?? 0)),
      identifierMatch: Boolean(existing.identifierMatch || memory.identifierMatch),
      requestedPrTicketMatch: Boolean(existing.requestedPrTicketMatch || memory.requestedPrTicketMatch),
      decisiveIdentifierMatch: Boolean(existing.decisiveIdentifierMatch || memory.decisiveIdentifierMatch),
      exactPhraseMatch: Boolean(existing.exactPhraseMatch || memory.exactPhraseMatch),
      sameProject: Boolean(existing.sameProject || memory.sameProject),
    });
  }
  return Array.from(byId.values());
}

export async function mergeLexicalLane(state: RecallRuntime, parallel: ParallelRecall): Promise<void> {
  const [textResults, recent] = await parallel.lexical;
  noteTextSkipped(state);
  const lexicalHydrateStarted = Date.now();
  const lexicalMemories = await rankHydratedLexical(state, textResults, recent);
  state.diagnostics.candidateCounts.lexicalRanked = lexicalMemories.length;
  state.memories = mergeRecallCandidates(state.memories, lexicalMemories, state.request.collapseNearDuplicates, state);
  state.diagnostics.candidateCounts.ltmAfterInitialCap = state.memories.length;
  state.timer.add("lexical", Date.now() - lexicalHydrateStarted);
}
