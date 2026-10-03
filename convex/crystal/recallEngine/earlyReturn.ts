import { hasDecisiveIdentifier, getAnalyzedQuery } from "./identifiers";
import { composeFinalRecallMemories, finalCompositionOptions } from "./ranking";
import { collectLexicalCandidates } from "./lanesLexical";
import { blockForeignSessions, hydrateTextDocs, textHitIds } from "./lexicalIo";
import { recallRequestAllowlist } from "./memoryPolicy";
import { shapeLexicalCandidates } from "./lexicalShape";
import { dropRecentMemoryIds } from "./scope";
import type { ParallelRecall, RecallRuntime } from "./types";

const DISABLED = new Set(["0", "false", "off", "no"]);

/** On by default. 0, false, off or no (any case, trimmed) turns the identifier early return off, per request. */
export function identifierEarlyReturnEnabled(): boolean {
  const raw = process.env.RECALL_IDENTIFIER_EARLY_RETURN?.trim().toLowerCase();
  return raw === undefined || !DISABLED.has(raw);
}

/** A copy whose diagnostics can be counted into without touching the request's own. */
function probeView(state: RecallRuntime): RecallRuntime {
  return {
    ...state,
    diagnostics: { ...state.diagnostics, suppressions: { ...state.diagnostics.suppressions } },
  };
}

/**
 * Probe the lexical lane for a decisive-identifier memory that survives final composition (including the
 * recent-memory drop). True when the trigger conditions hold and such a memory exists.
 *
 * The probe leaves the request state alone: candidates are counted into a copy of the diagnostics, the degradation
 * tracker and state.memories are never touched, and hydration and cross-session answers go through the request-scoped
 * memos so the later lexical merge reads nothing twice. Any failure means "no early return" and marks nothing.
 */
export async function tryIdentifierEarlyReturn(
  state: RecallRuntime,
  parallel: ParallelRecall,
): Promise<boolean> {
  try {
    if (!identifierEarlyReturnEnabled()) return false;
    if (!hasDecisiveIdentifier(getAnalyzedQuery(state.request))) return false;
    if (state.request.hasKnowledgeBaseScope || !state.reach.textAllowed) return false;

    const [textResults, recent] = await parallel.lexical;
    const firstIds = textHitIds(textResults);
    if (firstIds.length === 0) return false;

    const textDocs = await hydrateTextDocs(state, firstIds);
    const blocked = new Set<string>();
    // The same sources, in the same order, as rankHydratedLexical, so its later pass finds every answer memoized.
    await blockForeignSessions(state, [...textDocs, ...recent, ...state.personMemoryCandidates], new Set<string>(), blocked);
    const blockedIds = state.request.scopeToSession ? blocked : null;
    const candidates = await collectLexicalCandidates(
      probeView(state), textDocs, [], blockedIds, recallRequestAllowlist(), false,
    );
    if (candidates.length === 0) return false;

    const composed = dropRecentMemoryIds(
      composeFinalRecallMemories(shapeLexicalCandidates(candidates), finalCompositionOptions(state)),
      state.request.recentMemoryIds,
    );
    return composed.some((memory: any) => memory.decisiveIdentifierMatch || memory.rankingSignals?.decisiveIdentifierMatch);
  } catch {
    return false;
  }
}
