import type { RecallDiagnostics, NormalizedRecallRequest } from "./types";
import { redactScopeForDiagnostics } from "./httpFields";

export function createRecallDiagnostics(
  request: NormalizedRecallRequest,
  userId: string,
): RecallDiagnostics {
  return {
    account: { userId, email: null, name: null },
    scope: {
      channel: redactScopeForDiagnostics(request.channel),
      sessionKey: redactScopeForDiagnostics(request.sessionKey),
      agentId: request.agentId || undefined,
      effectiveAgentId: request.effectiveAgentId,
      projectId: request.projectId,
      repoSlug: request.repoSlug,
    },
    recallIntent: request.recallIntent,
    knowledgeBasesSearched: [],
    candidateCounts: {
      semanticInitial: 0,
      lexicalRanked: 0,
      ltmAfterInitialCap: 0,
      activeKnowledgeBases: 0,
      knowledgeBasesSearched: 0,
      kbAppended: 0,
      assetContexts: 0,
      messageMatches: 0,
      preFinalComposition: 0,
      final: 0,
    },
    sourceRoles: {},
    suppressions: {
      crossProject: 0,
      duplicateOrExisting: 0,
      categoryFilter: 0,
      requestedKnowledgeBaseFilter: 0,
      crossPerson: 0,
    },
    trim: {
      requestedLimit: request.limit,
      beforeFinalComposition: 0,
      afterFinalComposition: 0,
      trimmed: 0,
    },
  };
}
