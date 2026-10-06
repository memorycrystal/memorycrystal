import { normalizeProjectId } from "./sourceRole";
import { classifyRecallIntent } from "../recallRanking";
import { resolveKnowledgeBaseAgentId } from "../knowledgeBases";
import { clampActionRecallLimit, clampHttpRecallLimit, normalizeTagList, resolveDefaultLimit } from "./limits";
import { presetForMode } from "./presets";
import {
  normalizeChannel,
  normalizeRecallMessageFields,
  normalizeProjectContext,
  optionalStringList,
  parseFlexibleTimeMs,
} from "./httpFields";
import type { McpNormalizeResult, NormalizedRecallRequest } from "./types";

export async function normalizeMcpRecallBody(body: any): Promise<McpNormalizeResult> {
  const query = String(body?.query ?? "").trim();
  const limit = clampHttpRecallLimit(body?.limit);
  const channel = normalizeChannel(body?.channel);
  const sessionKey = normalizeChannel(body?.sessionKey);
  const scopeToSession = body?.scopeToSession === true && Boolean(sessionKey);
  const recallSinceMs = parseFlexibleTimeMs(
    body?.fromMs ?? body?.sinceMs ?? body?.from ?? body?.after ?? body?.since ?? body?.startDate,
  );
  const recallBeforeMs = parseFlexibleTimeMs(
    body?.toMs ?? body?.beforeMs ?? body?.to ?? body?.before ?? body?.until ?? body?.endDate,
  );
  const mode = typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "";
  const requestedStores = Array.isArray(body?.stores) ? body.stores.map(String) : undefined;
  const requestedCategories = Array.isArray(body?.categories) ? body.categories.map(String) : undefined;
  const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
  const { projectId, repoSlug } = await normalizeProjectContext(body?.projectId, body?.repoSlug);
  if (!query) return { ok: false, status: 400, error: "query is required" };
  return {
    ok: true,
    request: httpRecallRequest({
      body,
      query,
      limit,
      channel,
      sessionKey,
      scopeToSession,
      recallSinceMs,
      recallBeforeMs,
      mode,
      requestedStores,
      requestedCategories,
      agentId,
      projectId,
      repoSlug,
    }),
  };
}

function httpRecallRequest(input: {
  body: any;
  query: string;
  limit: number;
  channel?: string;
  sessionKey?: string;
  scopeToSession: boolean;
  recallSinceMs?: number;
  recallBeforeMs?: number;
  mode: string;
  requestedStores?: string[];
  requestedCategories?: string[];
  agentId: string;
  projectId?: string;
  repoSlug?: string;
}): NormalizedRecallRequest {
  const requestedKnowledgeBaseIds = optionalStringList(input.body?.knowledgeBaseIds, input.body?.knowledgeBaseId);
  return {
    ...normalizeRecallMessageFields(input.body),
    messageProject: { projectId: normalizeProjectId(input.body?.projectId), repoSlug: input.repoSlug },
    query: input.query,
    limit: input.limit,
    channel: input.channel,
    sessionKey: input.sessionKey,
    scopeToSession: input.scopeToSession,
    recallSinceMs: input.recallSinceMs,
    recallBeforeMs: input.recallBeforeMs,
    mode: input.mode,
    resolvedStores: input.requestedStores?.length ? input.requestedStores : undefined,
    resolvedCategories: input.requestedCategories?.length ? input.requestedCategories : undefined,
    requestedTags:
      Array.isArray(input.body?.tags) && input.body.tags.length > 0
        ? normalizeTagList(input.body.tags.map(String))
        : undefined,
    agentId: input.agentId,
    effectiveAgentId: resolveKnowledgeBaseAgentId(input.agentId, input.channel) || "main",
    projectId: input.projectId,
    repoSlug: input.repoSlug,
    recallIntent: classifyRecallIntent(input.query, { channel: input.channel, projectId: input.projectId }),
    requestedKnowledgeBaseIds,
    hasKnowledgeBaseScope: (requestedKnowledgeBaseIds?.length ?? 0) > 0,
    peerScope: input.body?.peerScope ? String(input.body.peerScope) : undefined,
    includeAssets: input.body?.includeAssets === true,
    collapseNearDuplicates: input.body?.collapseNearDuplicates !== false,
    includeEmbeddingsFlag: input.body?.includeEmbeddings,
    recordAccess: true,
    includeArchived: false,
    awaitBookkeeping: false,
    excludeProspectiveFromBookkeeping: false,
  };
}

export type ActionRecallArgs = {
  embedding: number[];
  query?: string;
  stores?: string[];
  categories?: string[];
  tags?: string[];
  limit?: number;
  includeArchived?: boolean;
  recentMemoryIds?: string[];
  channel?: string;
  sessionKey?: string;
  scopeToSession?: boolean;
  agentId?: string;
  recordAccess?: boolean;
  mode?: string;
};

/** recallMemories' pre-engine vector take: clamp(4 * limit, 20, 100). */
export function actionFilteredVectorDepth(limit: number): number {
  return Math.min(Math.max(limit * 4, 20), 100);
}

export function normalizeActionRecallArgs(args: ActionRecallArgs): NormalizedRecallRequest {
  const mode = args.mode ?? "general";
  const preset = presetForMode(mode);
  const query = typeof args.query === "string" ? args.query : "";
  const channel = typeof args.channel === "string" ? args.channel : undefined;
  const sessionKey = normalizeChannel(args.sessionKey);
  const agentId = typeof args.agentId === "string" && args.agentId.trim().length > 0 ? args.agentId.trim() : "";
  const limit = clampActionRecallLimit(Math.floor(args.limit ?? preset.limit ?? resolveDefaultLimit()));
  const resolvedStores = args.stores?.length ? args.stores : undefined;
  const resolvedCategories = args.categories?.length ? args.categories : undefined;
  const requestedTags = args.tags?.length ? normalizeTagList(args.tags) : undefined;
  const filtered = Boolean(resolvedStores?.length || resolvedCategories?.length || requestedTags?.length);
  return {
    query,
    limit,
    channel,
    sessionKey,
    scopeToSession: args.scopeToSession === true && Boolean(sessionKey),
    mode,
    resolvedStores,
    resolvedCategories,
    requestedTags,
    agentId,
    effectiveAgentId: resolveKnowledgeBaseAgentId(agentId, channel) || "main",
    recallIntent: classifyRecallIntent(query, { channel }),
    hasKnowledgeBaseScope: false,
    includeAssets: false,
    collapseNearDuplicates: true,
    includeEmbeddingsFlag: false,
    precomputedEmbedding: args.embedding,
    recordAccess: args.recordAccess !== false,
    includeArchived: args.includeArchived ?? false,
    recentMemoryIds: args.recentMemoryIds,
    awaitBookkeeping: true,
    excludeProspectiveFromBookkeeping: true,
    bookkeepingIdCap: 50,
    ...actionAdapterOverrides(args, limit, filtered),
  };
}

/** recallMemories keeps its pre-engine side effects and filters (ILL-305 pre-gate Group A). */
function actionAdapterOverrides(
  args: ActionRecallArgs,
  limit: number,
  filtered: boolean,
): Partial<NormalizedRecallRequest> {
  return {
    includeMessages: false,
    resolveIdentity: false,
    recallDebits: {
      vectorReason: "recall.recallMemories.vector",
      textReason: "recall.recallMemories.text",
      textRequiresQuery: true,
    },
    carryStoredStrength: true,
    ...(filtered ? { filteredVectorDepth: actionFilteredVectorDepth(limit) } : {}),
  };
}
