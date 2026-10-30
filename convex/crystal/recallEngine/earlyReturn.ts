import { hasDecisiveIdentifier, getAnalyzedQuery } from "./identifiers";
import { stripDecisiveIdentifiers } from "./topicalQuery";
import { composeFinalRecallMemories, finalCompositionOptions } from "./ranking";
import { collectLexicalCandidates } from "./lanesLexical";
import { blockForeignSessions, hydrateTextDocs, textHitIds } from "./lexicalIo";
import { recallRequestAllowlist } from "./memoryPolicy";
import { shapeLexicalCandidates } from "./lexicalShape";
import { dropRecentMemoryIds } from "./scope";
import type { IdentifierEarlyReturnDiagnostics, ParallelRecall, RecallRuntime } from "./types";

const DISABLED = new Set(["0", "false", "off", "no"]);

/** On by default. 0, false, off or no (any case, trimmed) turns the identifier early return off, per request. */
export function identifierEarlyReturnEnabled(): boolean {
  const raw = process.env.RECALL_IDENTIFIER_EARLY_RETURN?.trim().toLowerCase();
  return raw === undefined || !DISABLED.has(raw);
}

const DEFAULT_MAX_DECISIVE_MATCHES = 3;
const MAX_DECISIVE_MATCHES_CEILING = 20;

/**
 * The most decisive-identifier lexical matches a query may have and still early-return (ILL-495). A trimmed decimal
 * positive integer, clamped to 1..20; unset or anything else means the default of 3. An identifier shared by more
 * memories goes through the full hybrid path so semantic similarity ranks among its matches.
 */
export function identifierEarlyReturnMaxMatches(): number {
  const raw = process.env.RECALL_IDENTIFIER_EARLY_RETURN_MAX_MATCHES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_DECISIVE_MATCHES;
  const value = Number(raw);
  if (value < 1) return DEFAULT_MAX_DECISIVE_MATCHES;
  return Math.min(value, MAX_DECISIVE_MATCHES_CEILING);
}

const isDecisive = (memory: any): boolean =>
  Boolean(memory.decisiveIdentifierMatch || memory.rankingSignals?.decisiveIdentifierMatch);

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
  const decide = (outcome: IdentifierEarlyReturnDiagnostics): boolean => {
    state.diagnostics.identifierEarlyReturn = outcome;
    return outcome.taken;
  };
  try {
    if (!identifierEarlyReturnEnabled()) return decide({ taken: false, reason: "disabled" });
    if (!hasDecisiveIdentifier(getAnalyzedQuery(state.request))) return decide({ taken: false, reason: "no_identifier" });
    if (state.request.hasKnowledgeBaseScope) return decide({ taken: false, reason: "kb_scope" });
    if (!state.reach.textAllowed) return decide({ taken: false, reason: "text_disallowed" });

    const [textResults, recent] = await parallel.lexical;
    const firstIds = textHitIds(textResults);
    if (firstIds.length === 0) return decide({ taken: false, reason: "no_lexical_hits" });

    const textDocs = await hydrateTextDocs(state, firstIds);
    const blocked = new Set<string>();
    // The same sources, in the same order, as hydrateLexical, so its later pass finds every answer memoized.
    await blockForeignSessions(state, [...textDocs, ...recent, ...state.personMemoryCandidates], new Set<string>(), blocked);
    const blockedIds = state.request.scopeToSession ? blocked : null;
    const candidates = await collectLexicalCandidates(
      probeView(state), textDocs, [], blockedIds, recallRequestAllowlist(), false,
    );
    if (candidates.length === 0) return decide({ taken: false, reason: "no_lexical_hits" });
    // Counted before final composition trims to the request limit, which would cap the count at the limit.
    const decisiveMatches = candidates.filter(isDecisive).length;

    const composed = dropRecentMemoryIds(
      composeFinalRecallMemories(shapeLexicalCandidates(candidates), finalCompositionOptions(state)),
      state.request.recentMemoryIds,
    );
    if (!composed.some(isDecisive)) return decide({ taken: false, decisiveMatches, reason: "no_survivor" });
    if (decisiveMatches > identifierEarlyReturnMaxMatches()) {
      state.topicalQuery = stripDecisiveIdentifiers(state.request.query) ?? undefined;
      return decide({ taken: false, decisiveMatches, reason: "not_selective" });
    }
    return decide({ taken: true, decisiveMatches, reason: "taken" });
  } catch {
    return decide({ taken: false, reason: "error" });
  }
}
