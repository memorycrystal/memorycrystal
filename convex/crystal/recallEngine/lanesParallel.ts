import { collectRecallMessages } from "./lanesMessages";
import { COST_UNIT_BYTES } from "../recallBudgetPolicy";
import { ESTIMATED_TEXT_INDEX_BYTES } from "./constants";
import { startLexicalIo } from "./lanesLexical";
import type { ParallelRecall, RecallRuntime } from "./types";
import { logError } from "../crypto";

type MessageLane = { promise: Promise<any[]> | null; matches: any[]; resolved: boolean };

function startMessageSearch(state: RecallRuntime, lane: MessageLane): void {
  if (lane.promise) return;
  lane.promise = state.timer.measure("messages", () => runMessageSearch(state));
}

async function resolveMessageSearch(state: RecallRuntime, lane: MessageLane): Promise<any[]> {
  if (lane.resolved) return lane.matches;
  lane.matches = await (lane.promise ?? Promise.resolve([]));
  state.diagnostics.candidateCounts.messageMatches = lane.matches.length;
  lane.resolved = true;
  return lane.matches;
}

async function runMessageSearch(state: RecallRuntime): Promise<any[]> {
  // includeMessages:false (recallMemories) skips the lane before any debit or query.
  if (state.request.hasKnowledgeBaseScope || state.request.includeMessages === false || state.request.messageLimit === 0) return [];
  const messageBudget = state.ports.benchmarkRecall
    ? null
    : await state.ports.debit({
        surface: "messages",
        estimatedTextQueryBytes: ESTIMATED_TEXT_INDEX_BYTES,
        reason: "mcp.recall.messages",
      });
  state.messageBudget = messageBudget;
  const textAllowed = !messageBudget?.emergency;
  const matches = await collectRecallMessages(state, textAllowed);
  // R14: only credit when searchMessageMatches confirms BM25 was skipped.
  if (state.messageLaneOutcome.bm25SkippedForBudget && messageBudget) {
    state.pendingCredits.push({
      surface: "messages",
      lane: "messages.text",
      vectorBytes: 0,
      textBytes: COST_UNIT_BYTES.textIndexQuery,
    });
  }
  return matches;
}

export function startKbList(state: RecallRuntime): Promise<any[]> {
  if (!state.request.hasKnowledgeBaseScope) return Promise.resolve([]);
  const requested = state.request.requestedKnowledgeBaseIds;
  return state.timer.measure("kb", () =>
    state.ports
      .listKnowledgeBases({
        userId: state.ports.userId,
        knowledgeBaseIds: requested,
        agentId: state.request.effectiveAgentId,
        channel: state.request.channel,
      })
      .then((allKBs) =>
        allKBs.filter((kb: any) => {
          if (!kb?.isActive) return false;
          if (requested?.length && !requested.includes(String(kb._id))) return false;
          return true;
        }),
      )
      .catch(async (err: unknown) => {
        console.error("[recall] KB visibility fallback:", await logError(err, state.ports.userId));
        state.degradation.mark({
          code: "kb_visibility_failed",
          message: "Knowledge base visibility lookup failed; KB-scoped asset recall was skipped.",
          recoverable: true,
          affectedStage: "knowledge_bases",
        });
        return [];
      }),
  );
}

export function startParallelRecall(state: RecallRuntime): ParallelRecall {
  const lane: MessageLane = { promise: null, matches: [], resolved: false };
  const parallel: ParallelRecall = {
    lexical: startLexicalIo(state),
    kbList: startKbList(state),
    startMessages: () => startMessageSearch(state, lane),
    resolveMessages: () => resolveMessageSearch(state, lane),
  };
  parallel.startMessages();
  return parallel;
}
