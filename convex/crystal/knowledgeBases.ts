import { v, ConvexError } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { stableUserId } from "./auth";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { UserTier } from "../../shared/tierLimits";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
  buildMemoryTransitionDelta,
} from "./dashboardTotals";
import { scanMemoryContent } from "./contentScanner";
import { cascadeDeleteMemory } from "./archivedPurge";
import {
  defaultRecallRankingWeights,
  deriveTextMatchScore,
  normalizeSourceRole,
  rankRecallCandidates,
  type SourceRole,
} from "./recallRanking";
import { metric } from "./metrics";
import { embedTextsWithUserOpenRouter, embedTextWithUserOpenRouter } from "./embeddings";
import { isCompactRecallEnabled } from "./memoryText";
import { shouldEnrich } from "./organic/enrichmentEligibility";
import {
  mergeCostBudgetResults,
  resolveTieredVectorReachPolicy,
  type CostBudgetResult,
} from "./recallBudgetPolicy";

type KnowledgeBaseDoc = Doc<"knowledgeBases">;
const ESTIMATED_KB_VECTOR_QUERY_BYTES = 820 * 1024 * 1024;
const ESTIMATED_KB_TEXT_QUERY_BYTES = 60 * 1024 * 1024;

// Registry of agent-prefix scopes that run in a multi-peer context (e.g.
// Telegram bots where {prefix}:{peerId} identifies the end-user). This is used
// for non-KB peer memory isolation and KB write admission; KB query visibility
// itself is global per agentId.
export const PEER_CAPABLE_SCOPES: ReadonlySet<string> = new Set([
  "peer-coach",
  "support-coach",
]);

// Sentinel used by management/admin surfaces (dashboard list, internal
// enumeration). Kept as a named channel value so older call sites remain
// explicit, even though KB visibility is now agent-only.
export const MANAGEMENT_CHANNEL_SENTINEL = "__management__" as const;
export type ManagementChannel = typeof MANAGEMENT_CHANNEL_SENTINEL;

const chunkMetadataValidator = v.optional(v.object({
  title: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  chunkIndex: v.optional(v.number()),
  totalChunks: v.optional(v.number()),
  sourceType: v.optional(v.string()),
}));

const batchImportChunkValidator = v.object({
  content: v.string(),
  metadata: chunkMetadataValidator,
});
const peerScopePolicyValidator = v.optional(
  v.union(v.literal("strict"), v.literal("permissive"))
);
const sourceRoleValidator = v.optional(v.string());
const normalizeKnowledgeBaseSourceRole = (value: unknown): SourceRole | undefined =>
  normalizeSourceRole(value);

const jsonMetadata = (value: Record<string, unknown>) => JSON.stringify(value);

type KbUpgradePrompt = {
  code: "kb_upgrade_to_pro" | "kb_upgrade_to_ultra";
  targetTier: "pro" | "ultra";
  message: string;
  reason: "budget_limited" | "embedding_cap_exceeded";
};

type KbRetrievalPolicy = {
  indexedFallbackAllowedOnDegradation: boolean;
  upgradeTargetTier?: "pro" | "ultra";
  upgradePromptCode?: "kb_upgrade_to_pro" | "kb_upgrade_to_ultra";
  upgradeMessage?: string;
};

async function debitKnowledgeBaseQueryCost(
  ctx: any,
  args: {
    userId: string;
    estimatedVectorQueryBytes?: number;
    estimatedTextQueryBytes?: number;
    estimatedEmbeddingCalls?: number;
    reason: string;
  },
): Promise<CostBudgetResult | null> {
  try {
    const [userBudget, globalBudget] = await Promise.all([
      ctx.runMutation((internal as any).crystal.costBreaker.debitAndCheck, {
        scope: "user",
        scopeId: args.userId,
        surface: "kb",
        estimatedVectorQueryBytes: args.estimatedVectorQueryBytes,
        estimatedTextQueryBytes: args.estimatedTextQueryBytes,
        estimatedEmbeddingCalls: args.estimatedEmbeddingCalls,
        reason: args.reason,
      }),
      ctx.runMutation((internal as any).crystal.costBreaker.debitAndCheck, {
        scope: "global",
        scopeId: "global",
        surface: "kb",
        estimatedVectorQueryBytes: args.estimatedVectorQueryBytes,
        estimatedTextQueryBytes: args.estimatedTextQueryBytes,
        estimatedEmbeddingCalls: args.estimatedEmbeddingCalls,
        reason: args.reason,
      }),
    ]);
    return mergeCostBudgetResults(userBudget, globalBudget);
  } catch (error) {
    console.warn("[costBreaker] knowledge-base query debit failed open", error);
    return null;
  }
}

function getKbRetrievalPolicyForTier(tier: UserTier): KbRetrievalPolicy {
  switch (tier) {
    case "free":
      return {
        indexedFallbackAllowedOnDegradation: false,
        upgradeTargetTier: "pro",
        upgradePromptCode: "kb_upgrade_to_pro",
        upgradeMessage: "Knowledge-base search is limited on your current plan. Upgrade to Pro to keep KB recall available when semantic search is capped.",
      };
    case "starter":
    case "pro":
      return {
        indexedFallbackAllowedOnDegradation: true,
        upgradeTargetTier: "ultra",
        upgradePromptCode: "kb_upgrade_to_ultra",
        upgradeMessage: "Knowledge-base search returned a degraded fallback because your current plan hit a recall budget. Upgrade to Ultra for higher recall limits.",
      };
    case "ultra":
    case "unlimited":
      return { indexedFallbackAllowedOnDegradation: true };
  }
}

async function getUserTierForKbFallback(ctx: Pick<any, "runQuery">, userId: string): Promise<UserTier> {
  return await ctx.runQuery((internal as any).crystal.userProfiles.getUserTier, { userId }) as UserTier;
}

function isEmbeddingCapExceeded(error: unknown): boolean {
  return error instanceof ConvexError && (error.data as any)?.code === "embedding_cap_exceeded";
}

type KbRetrievalMode = {
  vectorAllowed: boolean;
  vectorDepth: number;
  textAllowed: boolean;
  indexedFallbackAllowed: boolean;
  degraded: boolean;
  budgetLevel?: "normal" | "limited" | "blocked";
  reasons: string[];
  tier?: UserTier;
  vectorBudget?: CostBudgetResult | null;
  textBudget?: CostBudgetResult | null;
};

const precomputedCostBudgetValidator = v.object({
  status: v.union(v.literal("ok"), v.literal("warn"), v.literal("emergency")),
  emergency: v.boolean(),
  vectorEmergency: v.optional(v.boolean()),
  textEmergency: v.optional(v.boolean()),
  degradation: v.optional(v.object({
    reason: v.string(),
    surface: v.string(),
    scope: v.string(),
    scopeId: v.string(),
    resetsAt: v.optional(v.number()),
  })),
});

function isKbUpgradePromptReason(reason: string): boolean {
  return reason === "vector_budget_exceeded" ||
    reason === "vector_budget_limited" ||
    reason === "text_budget_exceeded" ||
    reason === "embedding_cap_exceeded";
}

function buildKbUpgradePrompt(tier: UserTier | undefined, reasons: string[]): KbUpgradePrompt | undefined {
  if (!tier || !reasons.some(isKbUpgradePromptReason)) {
    return undefined;
  }
  const policy = getKbRetrievalPolicyForTier(tier);
  if (!policy.upgradeTargetTier || !policy.upgradePromptCode || !policy.upgradeMessage) {
    return undefined;
  }
  return {
    code: policy.upgradePromptCode,
    targetTier: policy.upgradeTargetTier,
    message: policy.upgradeMessage,
    reason: reasons.includes("embedding_cap_exceeded") ? "embedding_cap_exceeded" : "budget_limited",
  };
}

async function applyKbEmbeddingDegradation(
  ctx: Pick<any, "runQuery">,
  args: { userId: string; retrievalMode: KbRetrievalMode; reason: "embedding_cap_exceeded" | "embedding_failed" },
) {
  args.retrievalMode.vectorAllowed = false;
  args.retrievalMode.vectorDepth = 0;
  args.retrievalMode.degraded = true;
  args.retrievalMode.reasons.push(args.reason);
  if (!args.retrievalMode.tier) {
    args.retrievalMode.tier = await getUserTierForKbFallback(ctx, args.userId);
  }
  args.retrievalMode.indexedFallbackAllowed =
    args.retrievalMode.indexedFallbackAllowed ||
    getKbRetrievalPolicyForTier(args.retrievalMode.tier).indexedFallbackAllowedOnDegradation;
}

async function resolveKbRetrievalMode(
  ctx: Pick<any, "runQuery" | "runMutation">,
  args: {
    userId: string;
    normalVectorDepth: number;
    skipCostBreaker?: boolean;
    precomputedCostBudget?: CostBudgetResult | null;
  },
): Promise<KbRetrievalMode> {
  if (args.precomputedCostBudget) {
    const budget = args.precomputedCostBudget;
    const tier = await getUserTierForKbFallback(ctx, args.userId);
    const policy = getKbRetrievalPolicyForTier(tier);
    const reachPolicy = resolveTieredVectorReachPolicy({
      tier,
      normalVectorDepth: args.normalVectorDepth,
      vectorBudget: budget,
      textBudget: budget,
      indexedFallbackAllowedOnDegradation:
        policy.indexedFallbackAllowedOnDegradation,
    });

    return {
      vectorAllowed: reachPolicy.vectorAllowed,
      vectorDepth: reachPolicy.vectorDepth,
      textAllowed: reachPolicy.textAllowed,
      indexedFallbackAllowed: reachPolicy.indexedFallbackAllowed,
      degraded: reachPolicy.degraded,
      budgetLevel: reachPolicy.budgetLevel,
      reasons: reachPolicy.reasons,
      tier,
      vectorBudget: budget,
      textBudget: budget,
    };
  }

  if (args.skipCostBreaker) {
    return {
      vectorAllowed: true,
      vectorDepth: args.normalVectorDepth,
      textAllowed: true,
      indexedFallbackAllowed: false,
      degraded: false,
      budgetLevel: "normal",
      reasons: [],
    };
  }

  const [vectorBudget, textBudget] = await Promise.all([
    debitKnowledgeBaseQueryCost(ctx, {
      userId: args.userId,
      estimatedVectorQueryBytes: ESTIMATED_KB_VECTOR_QUERY_BYTES,
      estimatedEmbeddingCalls: 1,
      reason: "knowledgeBases.runKnowledgeBaseQuery.vector",
    }),
    debitKnowledgeBaseQueryCost(ctx, {
      userId: args.userId,
      estimatedTextQueryBytes: ESTIMATED_KB_TEXT_QUERY_BYTES,
      reason: "knowledgeBases.runKnowledgeBaseQuery.text",
    }),
  ]);

  const tier = await getUserTierForKbFallback(ctx, args.userId);
  const policy = getKbRetrievalPolicyForTier(tier);
  const reachPolicy = resolveTieredVectorReachPolicy({
    tier,
    normalVectorDepth: args.normalVectorDepth,
    vectorBudget,
    textBudget,
    indexedFallbackAllowedOnDegradation:
      policy.indexedFallbackAllowedOnDegradation,
  });

  return {
    vectorAllowed: reachPolicy.vectorAllowed,
    vectorDepth: reachPolicy.vectorDepth,
    textAllowed: reachPolicy.textAllowed,
    indexedFallbackAllowed: reachPolicy.indexedFallbackAllowed,
    degraded: reachPolicy.degraded,
    budgetLevel: reachPolicy.budgetLevel,
    reasons: reachPolicy.reasons,
    tier,
    vectorBudget,
    textBudget,
  };
}

const normalizeAgentIds = (agentIds?: string[]) => {
  if (!Array.isArray(agentIds)) {
    return undefined;
  }

  const normalized = Array.from(
    new Set(
      agentIds
        .map((agentId) => agentId.trim())
        .filter((agentId) => agentId.length > 0)
    )
  );

  return normalized.length > 0 ? normalized : undefined;
};

const KNOWLEDGE_BASE_AGENT_ALIASES: Record<string, string[]> = {
  "peer-coach": ["coach"],
};

const knowledgeBaseAgentVisibilityVariants = (agentId: string | undefined) => {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) {
    return [];
  }
  return Array.from(
    new Set([
      normalizedAgentId,
      ...(KNOWLEDGE_BASE_AGENT_ALIASES[normalizedAgentId] ?? []),
    ]),
  );
};

const isAgentAllowedByKnowledgeBase = (agentIds: string[] | undefined, agentId: string | undefined) => {
  if (!agentIds || agentIds.length === 0) {
    return true;
  }
  const variants = knowledgeBaseAgentVisibilityVariants(agentId);
  if (variants.length === 0) {
    return false;
  }
  return agentIds.includes("*") || variants.some((variant) => agentIds.includes(variant));
};

const normalizeScope = (scope?: string) => {
  if (typeof scope !== "string") {
    return undefined;
  }

  const normalized = scope.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const isPermissiveSharedMainKnowledgeBase = (
  knowledgeBase: Pick<KnowledgeBaseDoc, "scope" | "peerScopePolicy">,
) =>
  (knowledgeBase.peerScopePolicy ?? "strict") === "permissive" &&
  typeof knowledgeBase.scope === "string" &&
  knowledgeBase.scope.endsWith(":main");

export const resolveDirectKnowledgeBaseQueryContext = (
  knowledgeBase: Pick<KnowledgeBaseDoc, "agentIds" | "scope" | "peerScopePolicy">,
  args: { agentId?: string; channel?: string },
) => {
  const explicitAgentId = args.agentId?.trim() || undefined;
  const explicitChannel = normalizeScope(args.channel);
  const channelAgentId = resolveKnowledgeBaseAgentId(undefined, explicitChannel);
  const allowedAgentIds = normalizeAgentIds(knowledgeBase.agentIds);
  const usableChannelAgentId =
    channelAgentId && isAgentAllowedByKnowledgeBase(allowedAgentIds, channelAgentId)
      ? channelAgentId
      : undefined;
  const fallbackAgentId =
    allowedAgentIds?.includes("main") || allowedAgentIds?.includes("*")
      ? "main"
      : undefined;
  // Final fallback for an explicitly-addressed, owner-verified KB: when the caller
  // gives no agentId and none can be derived from the channel, and the KB is not
  // main/"*"-scoped, default to the KB's own primary agentId. Every caller of this
  // helper (runKnowledgeBaseQuery / getKBMemoriesInternal) has already verified
  // knowledgeBase.userId === caller userId, so this cannot widen cross-tenant
  // access. It only stops an owned, agent-scoped KB from silently returning []
  // when the caller omits agentId — the documented brittleness.
  //
  // CRITICAL: apply this ONLY to permissive (shared, non-peer-isolated) KBs.
  // Strict KBs hold peer-private content and MUST keep returning [] when no
  // agentId/peer context is supplied, so a missing channel can never surface one
  // peer's content to another. The default policy is "strict".
  const isPeerIsolatedKb =
    (knowledgeBase.peerScopePolicy ?? "strict") !== "permissive";
  const ownedKbAgentId = isPeerIsolatedKb
    ? undefined
    : allowedAgentIds?.find((id) => id !== "*");
  const effectiveAgentId =
    explicitAgentId ?? usableChannelAgentId ?? fallbackAgentId ?? ownedKbAgentId;

  if (isPermissiveSharedMainKnowledgeBase(knowledgeBase)) {
    return {
      effectiveAgentId,
      queryChannel: explicitChannel ?? knowledgeBase.scope,
    };
  }

  return {
    effectiveAgentId,
    queryChannel: explicitChannel,
  };
};

export const deriveAgentIdFromChannel = (channel?: string): string | undefined => {
  if (typeof channel !== "string") {
    return undefined;
  }

  const trimmed = channel.trim();
  if (!trimmed) {
    return undefined;
  }

  const separator = trimmed.indexOf(":");
  if (separator <= 0) {
    return trimmed;
  }

  return trimmed.slice(0, separator).trim() || undefined;
};

export const resolveKnowledgeBaseAgentId = (agentId?: string, channel?: string): string | undefined => {
  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (normalizedAgentId.length > 0) {
    return normalizedAgentId;
  }
  return deriveAgentIdFromChannel(channel);
};

// Returns the first agentId that is in PEER_CAPABLE_SCOPES, if any.
export const deriveAgentIdPrefix = (agentIds?: string[]): string | undefined => {
  if (!Array.isArray(agentIds)) return undefined;
  return agentIds.find((id) => PEER_CAPABLE_SCOPES.has(id.trim()));
};

// KB content is global to the authorized agent. `channel` is accepted for API
// compatibility and agentId derivation at call sites, but it must never exclude
// KB hits; peer isolation belongs to non-KB memories.
export const isKnowledgeBaseVisibleToAgent = (
  knowledgeBase: Pick<KnowledgeBaseDoc, "agentIds" | "isActive">,
  agentId: string | undefined,
  _channel: string | ManagementChannel,
): boolean => {
  if (!knowledgeBase.isActive) {
    return false;
  }
  const allowedAgentIds = normalizeAgentIds(knowledgeBase.agentIds);
  if (!agentId && (!allowedAgentIds || allowedAgentIds.length === 0 || allowedAgentIds.includes("*"))) {
    return true;
  }
  return isAgentAllowedByKnowledgeBase(allowedAgentIds, agentId);
};

export const isNonKnowledgeBaseMemoryVisibleInChannel = (
  memoryChannel?: string,
  channel?: string
) => {
  const normalizedChannel = normalizeScope(channel);
  if (!normalizedChannel) {
    return true;
  }

  const normalizedMemoryChannel = normalizeScope(memoryChannel);
  if (normalizedChannel.includes(":")) {
    // Scoped request (e.g. "coder:general" or "myapp:511172388"):
    // show exact matches AND unscoped memories whose channel matches
    // either the prefix (agent name) or suffix (base channel).
    if (normalizedMemoryChannel === normalizedChannel) return true;
    if (!normalizedMemoryChannel) return false; // scoped channels exclude global memories
    const colonIndex = normalizedChannel.indexOf(":");
    const prefix = normalizedChannel.slice(0, colonIndex);
    const suffix = normalizedChannel.slice(colonIndex + 1);
    // Group channels (e.g. "discord:group:<id>", "slack:group:<id>") are shared
    // multi-participant contexts. Bare-prefix memories ("discord") mix every
    // peer/agent's data and other participants may write differently-scoped
    // memories, so allowing prefix OR suffix matches here would surface another
    // agent's private memories into the group. Only the exact channel (handled
    // above) is visible — same fail-closed rule as numeric peer scoping.
    // Detection is case-insensitive and also catches a bare ":group" tail so
    // the fail-closed guard doesn't depend on the producer's exact casing or
    // format; matching itself stays exact on the original strings.
    const isGroupScoped = /(^|:)group(:|$)/.test(normalizedChannel.toLowerCase());
    if (isGroupScoped) {
      return false; // only exact match (handled above) is allowed
    }
    // When the suffix is a numeric peer ID (e.g. "511172388"), this is a
    // peer-scoped channel. Bare-prefix memories ("myapp") contain a
    // mix of all peers' data, so allowing prefix matches would leak other
    // clients' memories. Only exact matches are safe for peer channels.
    const isPeerScoped = /^\d+$/.test(suffix);
    if (isPeerScoped) {
      return false; // only exact match (handled above) is allowed
    }
    return normalizedMemoryChannel === prefix || normalizedMemoryChannel === suffix;
  }

  if (!normalizedMemoryChannel) {
    return true;
  }

  if (normalizedMemoryChannel.includes(":")) {
    return false;
  }

  return normalizedMemoryChannel === normalizedChannel;
};

// ---------------------------------------------------------------------------
// Compact recall + chunk-kind read helpers (KB query path)
// ---------------------------------------------------------------------------

/**
 * Whether compact ("telegraphic") recall is enabled. Default TRUE per the
 * cross-surface contract; only MEMORY_CRYSTAL_COMPACT_RECALL="false" disables it.
 * Re-exported from ./memoryText — the single source of truth shared with the
 * recallMemories action and the /api/mcp/recall HTTP route.
 */
export { isCompactRecallEnabled };

/**
 * Pick the text a KB-query result should expose. When compact recall is on and
 * the row carries a non-empty recallText, use it; otherwise fall back to the
 * full content. Keeps the result `content` field shape stable for clients.
 */
export const resolveKnowledgeBaseRecallContent = (
  memory: { content?: string | null; recallText?: string | null },
  compactEnabled: boolean,
): string => {
  if (compactEnabled) {
    const compact = memory.recallText?.trim();
    if (compact) return compact;
  }
  const content = memory.content ?? "";
  if (content.trim()) return content;
  // Compact-off edge case: fall back to recallText rather than surfacing an
  // empty-content chunk when the full content is missing but recallText survives.
  return memory.recallText?.trim() ?? "";
};

/**
 * A "config" chunk (chunkKind === "config") is a config-header / source-mirror
 * import row with low recall value. Absent chunkKind == real content. Reading
 * this here lets operators drop client-side low-value-chunk filtering.
 */
export const isConfigChunk = (memory: { chunkKind?: string | null }): boolean =>
  typeof memory.chunkKind === "string" && memory.chunkKind.trim().toLowerCase() === "config";

const buildChunkTitle = (knowledgeBase: Pick<KnowledgeBaseDoc, "name">, metadata?: {
  title?: string;
  chunkIndex?: number;
  totalChunks?: number;
  sourceUrl?: string;
}) => {
  const explicitTitle = metadata?.title?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const chunkIndex = typeof metadata?.chunkIndex === "number" ? metadata.chunkIndex + 1 : undefined;
  const totalChunks = typeof metadata?.totalChunks === "number" ? metadata.totalChunks : undefined;
  if (chunkIndex !== undefined) {
    if (totalChunks !== undefined && totalChunks > 0) {
      return `${knowledgeBase.name} — Chunk ${chunkIndex}/${totalChunks}`;
    }
    return `${knowledgeBase.name} — Chunk ${chunkIndex}`;
  }

  const sourceUrl = metadata?.sourceUrl?.trim();
  if (sourceUrl) {
    return `${knowledgeBase.name} — ${sourceUrl}`;
  }

  return `${knowledgeBase.name} — Imported reference`;
};

const buildChunkMetadata = (
  knowledgeBase: Pick<KnowledgeBaseDoc, "_id" | "name" | "sourceType" | "sourceRole">,
  metadata?: {
    title?: string;
    sourceUrl?: string;
    chunkIndex?: number;
    totalChunks?: number;
    sourceType?: string;
  }
) =>
  jsonMetadata({
    knowledgeBaseId: knowledgeBase._id,
    knowledgeBaseName: knowledgeBase.name,
    sourceType: metadata?.sourceType ?? knowledgeBase.sourceType,
    sourceRole: knowledgeBase.sourceRole,
    sourceUrl: metadata?.sourceUrl,
    chunkIndex: metadata?.chunkIndex,
    totalChunks: metadata?.totalChunks,
    importedAt: Date.now(),
  });

const KB_BACKFILL_PAGE_SIZE = 100;
const KB_BACKFILL_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_KB_EMBEDDING_BACKFILL_BATCH_SIZE = 50;
const DEFAULT_KB_GRAPH_BACKFILL_BATCH_SIZE = 25;
const MAX_KB_BACKFILL_BATCH_SIZE = 200;
const KB_EMBEDDING_BACKFILL_DELAY_MS = 500;
const KB_GRAPH_BACKFILL_DELAY_MS = 1_000;
const GRAPH_ENRICHMENT_CONCURRENCY = 8;

type KnowledgeBaseBackfillCursorState = {
  batchNumber: number;
  passNumber: number;
  scanCursor?: string;
  retryRequested: boolean;
  consecutiveFailBatches?: number;
};

type KnowledgeBaseBackfillPage = {
  page: Array<{
    _id: Id<"crystalMemories">;
    userId: string;
    embeddingLength: number;
    graphEnriched: boolean;
  }>;
  isDone: boolean;
  continueCursor?: string;
};

const normalizeBackfillPageSize = (value?: number) => {
  const normalized = Math.trunc(value ?? KB_BACKFILL_PAGE_SIZE);
  if (!Number.isFinite(normalized)) {
    return KB_BACKFILL_PAGE_SIZE;
  }
  return Math.min(Math.max(normalized, 1), KB_BACKFILL_PAGE_SIZE);
};

const normalizeBackfillBatchSize = (value: number | undefined, fallback: number) => {
  const normalized = Math.trunc(value ?? fallback);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }
  return Math.min(Math.max(normalized, 1), MAX_KB_BACKFILL_BATCH_SIZE);
};

// Circuit breaker: stop after this many consecutive 100%-failure batches
const BACKFILL_CIRCUIT_BREAKER_THRESHOLD = 3;
// Exponential backoff multiplier when failure rate > 80%
const BACKFILL_HIGH_FAILURE_BACKOFF_MS = 30_000; // 30s base, doubles each consecutive fail batch

const parseKnowledgeBaseBackfillCursor = (cursor?: string): KnowledgeBaseBackfillCursorState => {
  if (!cursor) {
    return { batchNumber: 1, passNumber: 1, retryRequested: false, consecutiveFailBatches: 0 };
  }

  try {
    const parsed = JSON.parse(cursor) as Partial<KnowledgeBaseBackfillCursorState>;
    const batchNumber = Math.trunc(parsed.batchNumber ?? 1);
    const passNumber = Math.trunc(parsed.passNumber ?? 1);
    return {
      batchNumber: Number.isFinite(batchNumber) && batchNumber > 0 ? batchNumber : 1,
      passNumber: Number.isFinite(passNumber) && passNumber > 0 ? passNumber : 1,
      scanCursor: typeof parsed.scanCursor === "string" && parsed.scanCursor.length > 0 ? parsed.scanCursor : undefined,
      retryRequested: parsed.retryRequested === true,
      consecutiveFailBatches: Math.trunc(parsed.consecutiveFailBatches ?? 0),
    };
  } catch {
    return { batchNumber: 1, passNumber: 1, retryRequested: false, consecutiveFailBatches: 0 };
  }
};

const serializeKnowledgeBaseBackfillCursor = (state: KnowledgeBaseBackfillCursorState) =>
  JSON.stringify({
    batchNumber: state.batchNumber,
    passNumber: state.passNumber,
    scanCursor: state.scanCursor,
    retryRequested: state.retryRequested,
    consecutiveFailBatches: state.consecutiveFailBatches ?? 0,
  });

const listKnowledgeBaseBackfillPageImpl = async (
  ctx: { db: { query: Function } },
  args: { userId: string; knowledgeBaseId?: Id<"knowledgeBases">; cursor?: string; pageSize?: number }
): Promise<KnowledgeBaseBackfillPage> => {
  const targetSize = normalizeBackfillPageSize(args.pageSize);

  if (args.knowledgeBaseId) {
    const query = ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q: any) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId).eq("archived", false)
      );

    const page: any = await query.paginate({
      numItems: targetSize,
      cursor: args.cursor ?? null,
      maximumBytesRead: KB_BACKFILL_MAX_BYTES,
    });

    return {
      page: (page.page as Array<any>).map((memory) => ({
        _id: memory._id as Id<"crystalMemories">,
        userId: memory.userId,
        embeddingLength: Array.isArray(memory.embedding) ? memory.embedding.length : 0,
        graphEnriched: memory.graphEnriched === true,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor as string | undefined,
    };
  }

  // No knowledgeBaseId specified — cannot efficiently scan without a KB-scoped index.
  // Require callers to always specify a knowledgeBaseId.
  return {
    page: [],
    isDone: true,
    continueCursor: undefined,
  };
};

// Callers declare intent via `callSource`: "management" for dashboard/admin
// list surfaces or "peer" when an agent channel is available for deriving
// agentId. The channel does not peer-scope KB visibility.
type ListKnowledgeBasesForUserOptions = {
  includeInactive?: boolean;
  agentId?: string;
  applyVisibilityFilter?: boolean;
} & (
  | { callSource: "management"; channel?: undefined }
  | { callSource: "peer"; channel: string }
);

const listKnowledgeBasesForUserImpl = async (
  ctx: { db: { query: Function } },
  userId: string,
  options: ListKnowledgeBasesForUserOptions,
) => {
  // Runtime belt-and-braces: if the TS types are bypassed (e.g. `as any` at a
  // caller), keep peer callSource tied to a concrete channel so agentId
  // derivation stays deterministic.
  if (options.callSource === "peer" && typeof options.channel !== "string") {
    throw new Error(
      "listKnowledgeBasesForUserImpl: callSource=\"peer\" requires an explicit channel string",
    );
  }
  const includeInactive = options.includeInactive;
  const peerChannel = options.callSource === "peer" ? options.channel : undefined;
  const normalizedChannel = normalizeScope(peerChannel);
  const applyVisibilityFilter = options.applyVisibilityFilter ?? false;

  const knowledgeBases = applyVisibilityFilter
    ? await ctx.db
        .query("knowledgeBases")
        .withIndex("by_user", (q: any) => q.eq("userId", userId))
        .collect()
    : await ctx.db
        .query("knowledgeBases")
        .withIndex("by_user", (q: any) => q.eq("userId", userId))
        .collect();

  const effectiveAgentId = resolveKnowledgeBaseAgentId(options.agentId, normalizedChannel);
  const guardChannel: string | ManagementChannel =
    options.callSource === "management"
      ? MANAGEMENT_CHANNEL_SENTINEL
      : options.channel;

  return knowledgeBases
    .filter((knowledgeBase: KnowledgeBaseDoc) => includeInactive || knowledgeBase.isActive)
    .filter((knowledgeBase: KnowledgeBaseDoc) => {
      if (!applyVisibilityFilter) return true;
      return isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, guardChannel);
    })
    .map(normalizeKnowledgeBaseSummary)
    .sort((a: KnowledgeBaseDoc, b: KnowledgeBaseDoc) => b.updatedAt - a.updatedAt);
};

const getKnowledgeBaseForUserImpl = async (
  ctx: { db: { get: Function; query: Function } },
  userId: string,
  knowledgeBaseId: Id<"knowledgeBases">,
  limit?: number
) => {
  const knowledgeBase = await ctx.db.get(knowledgeBaseId);
  if (!knowledgeBase || knowledgeBase.userId !== userId) {
    return null;
  }

  const memories = await ctx.db
    .query("crystalMemories")
    .withIndex("by_knowledge_base", (q: any) =>
      q.eq("knowledgeBaseId", knowledgeBaseId).eq("userId", userId).eq("archived", false)
    )
    .order("desc")
    .take(Math.min(Math.max(limit ?? 50, 1), 200));

  return {
    ...normalizeKnowledgeBaseSummary(knowledgeBase),
    memories,
  };
};

export const normalizeKnowledgeBaseSummary = <
  T extends {
    _creationTime?: number;
    memoryCount?: number;
    totalChars?: number;
    createdAt?: number;
    updatedAt?: number;
  }
>(knowledgeBase: T) => {
  // Fall back to Convex's auto-populated `_creationTime` (always present on real
  // docs) rather than literal `0`. The old behaviour rendered legacy rows as
  // "Jan 01, 1970" in the UI and pushed them to the bottom of any sort-by-updatedAt.
  const creationFallback = knowledgeBase._creationTime ?? 0;
  return {
    ...knowledgeBase,
    memoryCount: knowledgeBase.memoryCount ?? 0,
    totalChars: knowledgeBase.totalChars ?? 0,
    createdAt: knowledgeBase.createdAt ?? creationFallback,
    updatedAt: knowledgeBase.updatedAt ?? knowledgeBase.createdAt ?? creationFallback,
  };
};

const runBatchImportChunks: any = async (
  ctx: {
    runQuery: Function;
    runMutation: Function;
    runAction: Function;
  },
  userId: string,
  args: {
    knowledgeBaseId: Id<"knowledgeBases">;
    chunks: Array<{ content: string; metadata?: { title?: string; sourceUrl?: string; chunkIndex?: number; totalChunks?: number; sourceType?: string } | undefined }>;
  }
) : Promise<{
  knowledgeBaseId: Id<"knowledgeBases">;
  importedCount: number;
  memoryIds: Id<"crystalMemories">[];
  memoryCount: number;
  totalChars: number;
}> => {
  const knowledgeBase = await ctx.runQuery(
    internal.crystal.knowledgeBases.getKnowledgeBaseByIdInternal,
    { knowledgeBaseId: args.knowledgeBaseId }
  ) as KnowledgeBaseDoc | null;
  if (!knowledgeBase || knowledgeBase.userId !== userId) {
    throw new Error("Knowledge base not found");
  }
  if (!knowledgeBase.isActive) {
    throw new Error("Knowledge base is archived");
  }

  const importedMemoryIds: Id<"crystalMemories">[] = [];

  // M4: first chunk is the parent representative; all others are non-parent.
  // Only the parent receives enrichMemoryGraph — all chunks still get embed + salience.
  let parentMemoryId: Id<"crystalMemories"> | null = null;

  for (let chunkIdx = 0; chunkIdx < args.chunks.length; chunkIdx++) {
    const chunk = args.chunks[chunkIdx];
    const isParent = chunkIdx === 0;

    const { memoryId } = await ctx.runMutation(
      internal.crystal.knowledgeBases.insertKnowledgeBaseChunkInternal,
      {
        knowledgeBaseId: args.knowledgeBaseId,
        userId,
        content: chunk.content,
        metadata: chunk.metadata,
        // M4: designate first chunk as parent
        isKbParent: isParent,
      }
    );

    importedMemoryIds.push(memoryId);
    if (isParent) parentMemoryId = memoryId;

    // Embed every chunk (needed for vector recall)
    await ctx.runAction(internal.crystal.mcp.embedMemory, { memoryId });
    // Salience every chunk
    await ctx.runMutation(internal.crystal.salience.computeAndStoreSalience, { memoryId });
    // M4: enrichment is deferred to after the loop — parent only
  }

  // M4: schedule exactly one enrichMemoryGraph call for the parent chunk
  if (parentMemoryId !== null) {
    const eligibility = shouldEnrich({ store: "semantic", isKbParent: true });
    if (!eligibility.ok) {
      await ctx.runMutation(
        internal.crystal.observability.functionCallMetrics.recordCall,
        { name: "enrichMemoryGraph_skip", userId, tier: "semantic" },
      ).catch(() => null);
    } else {
      await ctx.runAction(internal.crystal.graphEnrich.enrichMemoryGraph, {
        memoryId: parentMemoryId,
        userId,
      });
    }
  }

  const updatedKnowledgeBase = await ctx.runQuery(
    internal.crystal.knowledgeBases.getKnowledgeBaseByIdInternal,
    { knowledgeBaseId: args.knowledgeBaseId }
  ) as KnowledgeBaseDoc | null;

  return {
    knowledgeBaseId: args.knowledgeBaseId,
    importedCount: importedMemoryIds.length,
    memoryIds: importedMemoryIds,
    memoryCount: updatedKnowledgeBase?.memoryCount ?? knowledgeBase.memoryCount,
    totalChars: updatedKnowledgeBase?.totalChars ?? knowledgeBase.totalChars ?? 0,
  };
};

export const getKnowledgeBaseByIdInternal = internalQuery({
  args: { knowledgeBaseId: v.id("knowledgeBases") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.knowledgeBaseId);
  },
});

export const insertKnowledgeBaseChunkInternal = internalMutation({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    userId: v.string(),
    content: v.string(),
    metadata: chunkMetadataValidator,
    // M4: true = parent chunk (receives enrichment); false = non-parent chunk (embed-only)
    isKbParent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== args.userId) {
      throw new Error("Knowledge base not found");
    }
    if (!knowledgeBase.isActive) {
      throw new Error("Knowledge base is archived");
    }

    // Write-side admission (§4 Step 2.4 option b): refuse unscoped inserts
    // into strict peer-capable KBs only when the PARENT KB is itself unscoped.
    // Query visibility is agentId-only; this guard only preserves the legacy
    // write-shape distinction for existing peer-capable KB metadata.
    const insertPolicy = knowledgeBase.peerScopePolicy ?? "strict";
    const insertPrefix = deriveAgentIdPrefix(knowledgeBase.agentIds);
    const parentScope = normalizeScope(knowledgeBase.scope);
    if (insertPolicy === "strict" && insertPrefix && !parentScope) {
      throw new Error(
        `kb-write-admission: refusing unscoped insert into strict peer-capable KB ${knowledgeBase._id}. ` +
        `Provide chunk.scope via bulkInsertChunksInternal or set parent.peerScopePolicy="permissive".`
      );
    }

    const scanResult = scanMemoryContent(args.content);
    if (!scanResult.allowed) {
      throw new Error(`Memory blocked: ${scanResult.reason} [${scanResult.threatId}]`);
    }

    const now = Date.now();
    const title = buildChunkTitle(knowledgeBase, args.metadata ?? undefined);
    const titleScan = scanMemoryContent(title);
    if (!titleScan.allowed) {
      throw new Error(`Memory blocked: ${titleScan.reason} [${titleScan.threatId}]`);
    }

    const memoryId = await ctx.db.insert("crystalMemories", {
      userId: args.userId,
      store: "semantic",
      category: "fact",
      title,
      content: args.content,
      metadata: buildChunkMetadata(knowledgeBase, args.metadata ?? undefined),
      embedding: [],
      strength: 1,
      confidence: 1,
      valence: 0,
      arousal: 0,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      source: "external",
      tags: [],
      archived: false,
      graphEnriched: false,
      knowledgeBaseId: args.knowledgeBaseId,
      // M4: propagate parent designation; undefined = legacy row (treated as parent)
      isKbParent: args.isKbParent,
    });

    await applyDashboardTotalsDelta(
      ctx,
      args.userId,
      buildMemoryCreateDelta({
        store: "semantic",
        archived: false,
        title,
        memoryId,
        createdAt: now,
        strength: 1,
        graphEnriched: false,
      })
    );

    await ctx.db.patch(args.knowledgeBaseId, {
      memoryCount: knowledgeBase.memoryCount + 1,
      totalChars: (knowledgeBase.totalChars ?? 0) + args.content.length,
      updatedAt: now,
    });

    return { memoryId, title };
  },
});

// Bulk insert chunks WITHOUT embedding/enrichment (for large migrations).
// Embedding and graph enrichment must be backfilled separately.
export const bulkInsertChunksInternal = internalMutation({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    userId: v.string(),
    chunks: v.array(v.object({
      content: v.string(),
      title: v.optional(v.string()),
      sourceType: v.optional(v.string()),
      chunkIndex: v.optional(v.number()),
      totalChunks: v.optional(v.number()),
      scope: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== args.userId) {
      throw new Error("Knowledge base not found");
    }
    if (!knowledgeBase.isActive) {
      throw new Error("Knowledge base is archived");
    }

    // Write-side admission remains conservative for legacy peer-capable KBs.
    // Read/query visibility is agentId-only and does not use chunk scope.
    const bulkPolicy = knowledgeBase.peerScopePolicy ?? "strict";
    const bulkPrefix = deriveAgentIdPrefix(knowledgeBase.agentIds);
    const bulkParentScope = normalizeScope(knowledgeBase.scope);
    if (bulkPolicy === "strict" && bulkPrefix && !bulkParentScope) {
      const unscopedChunk = args.chunks.find((c) => !c.scope);
      if (unscopedChunk) {
        throw new Error(
          `kb-write-admission: refusing unscoped chunk insert into strict peer-capable KB ${knowledgeBase._id}. ` +
          `Provide scope on every chunk or set parent.peerScopePolicy="permissive".`
        );
      }
    }

    const now = Date.now();
    const memoryIds: Id<"crystalMemories">[] = [];
    let totalChars = 0;
    let lastInsertedTitle: string | undefined;

    for (const chunk of args.chunks) {
      const scanResult = scanMemoryContent(chunk.content);
      if (!scanResult.allowed) continue; // skip blocked chunks silently

      const metadata = {
        title: chunk.title,
        sourceType: chunk.sourceType,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
      };
      const title = buildChunkTitle(knowledgeBase, metadata);
      const titleScan = scanMemoryContent(title);
      if (!titleScan.allowed) continue;

      const memoryId = await ctx.db.insert("crystalMemories", {
        userId: args.userId,
        store: "semantic" as const,
        category: "fact" as const,
        title,
        content: chunk.content,
        metadata: buildChunkMetadata(knowledgeBase, metadata),
        embedding: [],
        strength: 1,
        confidence: 1,
        valence: 0,
        arousal: 0,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        source: "external" as const,
        tags: [],
        archived: false,
        graphEnriched: false,
        knowledgeBaseId: args.knowledgeBaseId,
        ...(chunk.scope ? { scope: chunk.scope } : {}),
      });

      memoryIds.push(memoryId);
      lastInsertedTitle = title;
      totalChars += chunk.content.length;
    }

    // Update KB counters in bulk
    if (memoryIds.length > 0) {
      await applyDashboardTotalsDelta(ctx, args.userId, {
        totalMemoriesDelta: memoryIds.length,
        activeMemoriesDelta: memoryIds.length,
        archivedMemoriesDelta: 0,
        totalStrengthDelta: memoryIds.length,
        graphEligiblePendingMemoriesDelta: memoryIds.length,
        activeMemoriesByStoreDelta: { semantic: memoryIds.length },
        lastCaptureMemoryId: memoryIds[memoryIds.length - 1],
        lastCaptureStore: "semantic",
        lastCaptureTitle: lastInsertedTitle,
        lastCaptureCreatedAt: now,
      });

      await ctx.db.patch(args.knowledgeBaseId, {
        memoryCount: knowledgeBase.memoryCount + memoryIds.length,
        totalChars: (knowledgeBase.totalChars ?? 0) + totalChars,
        updatedAt: now,
      });
    }

    return { importedCount: memoryIds.length, memoryIds };
  },
});

export const archiveKnowledgeBaseMemoryInternal = internalMutation({
  args: { memoryId: v.id("crystalMemories"), archivedAt: v.number() },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (!memory || memory.archived) {
      return;
    }

    await applyDashboardTotalsDelta(
      ctx,
      memory.userId,
      buildMemoryTransitionDelta({
        oldArchived: false,
        oldStore: memory.store,
        oldGraphEnriched: memory.graphEnriched === true,
        oldEnrichmentSkippedReason: memory.enrichmentSkippedReason,
        oldAccessCount: memory.accessCount,
        newArchived: true,
        newStore: memory.store,
        newGraphEnriched: memory.graphEnriched === true,
        newEnrichmentSkippedReason: memory.enrichmentSkippedReason,
        newAccessCount: memory.accessCount,
      })
    );

    await ctx.db.patch(args.memoryId, {
      archived: true,
      archivedAt: args.archivedAt,
    });

    // Keep KB counters consistent. Without this, every per-memory archive
    // (including via deleteKnowledgeBase) leaks 1 from memoryCount and N
    // chars from totalChars, so KB metadata drifts above the true count of
    // active chunks over time.
    if (memory.knowledgeBaseId) {
      const kb = await ctx.db.get(memory.knowledgeBaseId);
      if (kb) {
        await ctx.db.patch(memory.knowledgeBaseId, {
          memoryCount: Math.max(0, (kb.memoryCount ?? 1) - 1),
          totalChars: Math.max(0, (kb.totalChars ?? 0) - (memory.content?.length ?? 0)),
          updatedAt: args.archivedAt,
        });
      }
    }
  },
});

// Inverse of archiveKnowledgeBaseMemoryInternal: un-archive one chunk, reversing
// the dashboard totals delta and restoring the KB counters that archival decremented.
export const restoreKnowledgeBaseMemoryInternal = internalMutation({
  args: { memoryId: v.id("crystalMemories"), restoredAt: v.number() },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (!memory || !memory.archived) {
      return;
    }

    await applyDashboardTotalsDelta(
      ctx,
      memory.userId,
      buildMemoryTransitionDelta({
        oldArchived: true,
        oldStore: memory.store,
        oldGraphEnriched: memory.graphEnriched === true,
        oldEnrichmentSkippedReason: memory.enrichmentSkippedReason,
        oldAccessCount: memory.accessCount,
        newArchived: false,
        newStore: memory.store,
        newGraphEnriched: memory.graphEnriched === true,
        newEnrichmentSkippedReason: memory.enrichmentSkippedReason,
        newAccessCount: memory.accessCount,
      })
    );

    await ctx.db.patch(args.memoryId, {
      archived: false,
      archivedAt: undefined,
    });

    // Re-add the chunk to the KB counters that archival decremented, so metadata
    // returns to its pre-archive value.
    if (memory.knowledgeBaseId) {
      const kb = await ctx.db.get(memory.knowledgeBaseId);
      if (kb) {
        await ctx.db.patch(memory.knowledgeBaseId, {
          memoryCount: (kb.memoryCount ?? 0) + 1,
          totalChars: (kb.totalChars ?? 0) + (memory.content?.length ?? 0),
          updatedAt: args.restoredAt,
        });
      }
    }
  },
});

// Inverse of deleteKnowledgeBase: reactivate an archived knowledge base and
// un-archive all of its chunks.
export const restoreKnowledgeBase = mutation({
  args: { knowledgeBaseId: v.id("knowledgeBases") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== userId) {
      throw new Error("Knowledge base not found");
    }

    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", userId).eq("archived", true)
      )
      .collect();

    const restoredAt = Date.now();
    for (const memory of memories) {
      await ctx.runMutation(internal.crystal.knowledgeBases.restoreKnowledgeBaseMemoryInternal, {
        memoryId: memory._id,
        restoredAt,
      });
    }

    await ctx.db.patch(args.knowledgeBaseId, {
      isActive: true,
      updatedAt: restoredAt,
    });

    return {
      knowledgeBaseId: args.knowledgeBaseId,
      restoredMemoryCount: memories.length,
    };
  },
});

export const createKnowledgeBase = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    agentIds: v.optional(v.array(v.string())),
    scope: v.optional(v.string()),
    sourceType: v.optional(v.string()),
    sourceRole: sourceRoleValidator,
    peerScopePolicy: peerScopePolicyValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const now = Date.now();

    return ctx.db.insert("knowledgeBases", {
      userId,
      name: args.name.trim(),
      description: args.description?.trim() || undefined,
      agentIds: normalizeAgentIds(args.agentIds),
      scope: normalizeScope(args.scope),
      sourceType: args.sourceType?.trim() || undefined,
      sourceRole: normalizeKnowledgeBaseSourceRole(args.sourceRole),
      peerScopePolicy: args.peerScopePolicy,
      isActive: true,
      memoryCount: 0,
      totalChars: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const createKnowledgeBaseInternal = internalMutation({
  args: {
    userId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    agentIds: v.optional(v.array(v.string())),
    scope: v.optional(v.string()),
    sourceType: v.optional(v.string()),
    sourceRole: sourceRoleValidator,
    peerScopePolicy: peerScopePolicyValidator,
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return ctx.db.insert("knowledgeBases", {
      userId: args.userId,
      name: args.name.trim(),
      description: args.description?.trim() || undefined,
      agentIds: normalizeAgentIds(args.agentIds),
      scope: normalizeScope(args.scope),
      sourceType: args.sourceType?.trim() || undefined,
      sourceRole: normalizeKnowledgeBaseSourceRole(args.sourceRole),
      peerScopePolicy: args.peerScopePolicy,
      isActive: true,
      memoryCount: 0,
      totalChars: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateKnowledgeBase = mutation({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    agentIds: v.optional(v.array(v.string())),
    scope: v.optional(v.string()),
    sourceType: v.optional(v.string()),
    sourceRole: sourceRoleValidator,
    isActive: v.optional(v.boolean()),
    peerScopePolicy: peerScopePolicyValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== userId) {
      throw new Error("Knowledge base not found");
    }

    const patch: Partial<KnowledgeBaseDoc> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.description !== undefined) patch.description = args.description.trim() || undefined;
    if (args.agentIds !== undefined) patch.agentIds = normalizeAgentIds(args.agentIds);
    if (args.scope !== undefined) patch.scope = normalizeScope(args.scope);
    if (args.sourceType !== undefined) patch.sourceType = args.sourceType.trim() || undefined;
    if (args.sourceRole !== undefined) patch.sourceRole = normalizeKnowledgeBaseSourceRole(args.sourceRole);
    if (args.isActive !== undefined) patch.isActive = args.isActive;
    if (args.peerScopePolicy !== undefined) patch.peerScopePolicy = args.peerScopePolicy;

    await ctx.db.patch(args.knowledgeBaseId, patch);
  },
});

export const patchKnowledgeBaseInternal = internalMutation({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
    patch: v.object({
      name: v.optional(v.string()),
      description: v.optional(v.string()),
      agentIds: v.optional(v.array(v.string())),
      scope: v.optional(v.string()),
      sourceType: v.optional(v.string()),
      sourceRole: sourceRoleValidator,
      isActive: v.optional(v.boolean()),
      peerScopePolicy: peerScopePolicyValidator,
      updatedAt: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== args.userId) {
      throw new Error("Knowledge base not found");
    }
    const patch: Record<string, unknown> = {};
    if (args.patch.updatedAt !== undefined) patch.updatedAt = args.patch.updatedAt;
    if (args.patch.agentIds !== undefined) patch.agentIds = normalizeAgentIds(args.patch.agentIds);
    if (args.patch.scope !== undefined) patch.scope = normalizeScope(args.patch.scope);
    if (args.patch.sourceType !== undefined) patch.sourceType = args.patch.sourceType.trim() || undefined;
    if (args.patch.sourceRole !== undefined) patch.sourceRole = normalizeKnowledgeBaseSourceRole(args.patch.sourceRole);
    if (args.patch.description !== undefined) patch.description = args.patch.description.trim() || undefined;
    if (args.patch.name !== undefined) patch.name = args.patch.name.trim() || undefined;
    if (args.patch.isActive !== undefined) patch.isActive = args.patch.isActive;
    if (args.patch.peerScopePolicy !== undefined) patch.peerScopePolicy = args.patch.peerScopePolicy;
    await ctx.db.patch(args.knowledgeBaseId, patch);
  },
});

export const listKnowledgeBases = query({
  args: {
    includeInactive: v.optional(v.boolean()),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);
    // Dashboard/admin surface: if no channel is supplied, treat as management.
    // If a channel IS supplied, it's a peer request (agentId implies the same).
    const base = {
      includeInactive: args.includeInactive,
      agentId: args.agentId,
      applyVisibilityFilter: args.agentId !== undefined || args.channel !== undefined,
    };
    return typeof args.channel === "string"
      ? listKnowledgeBasesForUserImpl(ctx, userId, {
          ...base,
          callSource: "peer",
          channel: args.channel,
        })
      : listKnowledgeBasesForUserImpl(ctx, userId, {
          ...base,
          callSource: "management",
        });
  },
});

export const listMyKnowledgeBases = listKnowledgeBases;

export const listKnowledgeBasesInternal = internalQuery({
  args: {
    userId: v.string(),
    includeInactive: v.optional(v.boolean()),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const base = {
      includeInactive: args.includeInactive,
      agentId: args.agentId,
      applyVisibilityFilter: args.agentId !== undefined || args.channel !== undefined,
    };
    return typeof args.channel === "string"
      ? listKnowledgeBasesForUserImpl(ctx, args.userId, {
          ...base,
          callSource: "peer",
          channel: args.channel,
        })
      : listKnowledgeBasesForUserImpl(ctx, args.userId, {
          ...base,
          callSource: "management",
        });
  },
});

export const listRequestedKnowledgeBasesForRecallInternal = internalQuery({
  args: {
    userId: v.string(),
    knowledgeBaseIds: v.array(v.id("knowledgeBases")),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result: KnowledgeBaseDoc[] = [];
    const seen = new Set<string>();

    for (const knowledgeBaseId of args.knowledgeBaseIds) {
      const id = String(knowledgeBaseId);
      if (seen.has(id)) continue;
      seen.add(id);

      const knowledgeBase = await ctx.db.get(knowledgeBaseId);
      if (!knowledgeBase || knowledgeBase.userId !== args.userId || !knowledgeBase.isActive) {
        continue;
      }

      const { effectiveAgentId, queryChannel } =
        resolveDirectKnowledgeBaseQueryContext(knowledgeBase, args);
      if (!isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, queryChannel ?? "")) {
        continue;
      }

      result.push(knowledgeBase);
    }

    return result.map(normalizeKnowledgeBaseSummary);
  },
});

export const listKnowledgeBasesForAgent = query({
  args: {
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);
    const base = {
      includeInactive: false,
      agentId: args.agentId,
      applyVisibilityFilter: true,
    };
    // Peer-driven surface: when a channel is supplied, derive the agentId from
    // it if needed. KB visibility remains agentId-only.
    return typeof args.channel === "string"
      ? listKnowledgeBasesForUserImpl(ctx, userId, {
          ...base,
          callSource: "peer",
          channel: args.channel,
        })
      : listKnowledgeBasesForUserImpl(ctx, userId, {
          ...base,
          callSource: "management",
        });
  },
});

export const getKnowledgeBase = query({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = stableUserId(identity.subject);
    return getKnowledgeBaseForUserImpl(ctx, userId, args.knowledgeBaseId, args.limit);
  },
});

export const getKnowledgeBaseForUserInternal = internalQuery({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return getKnowledgeBaseForUserImpl(ctx, args.userId, args.knowledgeBaseId, args.limit);
  },
});

export const listKnowledgeBaseMemories = query({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = stableUserId(identity.subject);

    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== userId) {
      return [];
    }

    return ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", userId).eq("archived", false)
      )
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 100, 1), 500));
  },
});

export const deleteKnowledgeBase = mutation({
  args: { knowledgeBaseId: v.id("knowledgeBases") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== userId) {
      throw new Error("Knowledge base not found");
    }

    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", userId).eq("archived", false)
      )
      .collect();

    const archivedAt = Date.now();
    for (const memory of memories) {
      await ctx.runMutation(internal.crystal.knowledgeBases.archiveKnowledgeBaseMemoryInternal, {
        memoryId: memory._id,
        archivedAt,
      });
    }

    await ctx.db.patch(args.knowledgeBaseId, {
      isActive: false,
      updatedAt: archivedAt,
    });

    return {
      knowledgeBaseId: args.knowledgeBaseId,
      archivedMemoryCount: memories.length,
    };
  },
});

// Permanently delete one batch of an archived knowledge base's chunks (with full
// FK cascade) and, once none remain, the knowledge-base row itself. Ownership is
// re-verified on every call, and the KB must already be archived (isActive:false)
// — permanent deletion is gated behind archival so it can never run on a live KB.
export const purgeKnowledgeBaseBatchInternal = internalMutation({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
    batch: v.number(),
  },
  handler: async (ctx, args) => {
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== args.userId) {
      throw new Error("Knowledge base not found");
    }
    if (knowledgeBase.isActive !== false) {
      throw new Error("Archive the knowledge base before deleting it permanently");
    }
    const batch = Math.min(Math.max(Math.floor(args.batch), 1), 100);
    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId),
      )
      .take(batch);
    for (const memory of memories) {
      await cascadeDeleteMemory(ctx, memory);
    }
    if (memories.length < batch) {
      // No more chunks remain — remove the knowledge-base row itself.
      await ctx.db.delete(args.knowledgeBaseId);
      return { deleted: memories.length, done: true };
    }
    return { deleted: memories.length, done: false };
  },
});

// Public action: permanently delete an archived knowledge base and all of its
// chunks. Loops the batched mutation so it scales to large corpora without
// exceeding per-mutation limits. The UI only surfaces this for archived KBs.
export const permanentlyDeleteKnowledgeBase = action({
  args: { knowledgeBaseId: v.id("knowledgeBases") },
  handler: async (ctx, args): Promise<{ deletedMemories: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    let deletedMemories = 0;
    let done = false;
    let guard = 0;
    while (!done && guard < 2000) {
      const result: { deleted: number; done: boolean } = await ctx.runMutation(
        internal.crystal.knowledgeBases.purgeKnowledgeBaseBatchInternal,
        { userId, knowledgeBaseId: args.knowledgeBaseId, batch: 100 },
      );
      deletedMemories += result.deleted;
      done = result.done;
      guard++;
    }
    return { deletedMemories };
  },
});

export const deleteKnowledgeBaseInternal: any = internalAction({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
  },
  handler: async (ctx, args): Promise<{ knowledgeBaseId: Id<"knowledgeBases">; archivedMemoryCount: number }> => {
    const knowledgeBase = await ctx.runQuery(
      internal.crystal.knowledgeBases.getKnowledgeBaseByIdInternal,
      { knowledgeBaseId: args.knowledgeBaseId }
    ) as KnowledgeBaseDoc | null;
    if (!knowledgeBase || knowledgeBase.userId !== args.userId) {
      throw new Error("Knowledge base not found");
    }

    const memories = await ctx.runQuery(
      internal.crystal.knowledgeBases.getKBMemoriesInternal,
      { knowledgeBaseId: args.knowledgeBaseId, limit: 10000 }
    ) as Array<{ _id: Id<"crystalMemories"> }>;

    const archivedAt = Date.now();
    for (const memory of memories) {
      await ctx.runMutation(internal.crystal.knowledgeBases.archiveKnowledgeBaseMemoryInternal, {
        memoryId: memory._id,
        archivedAt,
      });
    }

    await ctx.runMutation(internal.crystal.knowledgeBases.patchKnowledgeBaseInternal, {
      userId: args.userId,
      knowledgeBaseId: args.knowledgeBaseId,
      patch: {
        isActive: false,
        updatedAt: archivedAt,
      },
    });

    return {
      knowledgeBaseId: args.knowledgeBaseId,
      archivedMemoryCount: memories.length,
    };
  },
});

export const importChunk: any = mutation({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    content: v.string(),
    metadata: chunkMetadataValidator,
  },
  handler: async (ctx, args): Promise<{ memoryId: Id<"crystalMemories"> }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    // M4: single-chunk imports are their own parent (isKbParent: true)
    const { memoryId } = await ctx.runMutation(
      internal.crystal.knowledgeBases.insertKnowledgeBaseChunkInternal,
      {
        knowledgeBaseId: args.knowledgeBaseId,
        userId,
        content: args.content,
        metadata: args.metadata,
        isKbParent: true,
      }
    ) as { memoryId: Id<"crystalMemories"> };

    await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, { memoryId });
    await ctx.scheduler.runAfter(50, internal.crystal.salience.computeAndStoreSalience, { memoryId });
    {
      // M4: single-chunk imports are parents — eligible for enrichment
      const eligibility = shouldEnrich({ store: "semantic", isKbParent: true });
      if (!eligibility.ok) {
        await ctx.runMutation(
          internal.crystal.observability.functionCallMetrics.recordCall,
          { name: "enrichMemoryGraph_skip", userId, tier: "semantic" },
        ).catch(() => null);
      } else {
        await ctx.scheduler.runAfter(100, internal.crystal.graphEnrich.enrichMemoryGraph, {
          memoryId,
          userId,
        });
      }
    }

    return { memoryId };
  },
});

export const batchImportChunks = action({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    chunks: v.array(batchImportChunkValidator),
  },
  handler: async (ctx, args): Promise<{
    knowledgeBaseId: Id<"knowledgeBases">;
    importedCount: number;
    memoryIds: Id<"crystalMemories">[];
    memoryCount: number;
    totalChars: number;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    return runBatchImportChunks(ctx, userId, args);
  },
});

export const batchImportChunksInternal = internalAction({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
    chunks: v.array(batchImportChunkValidator),
  },
  handler: async (ctx, args) => {
    return runBatchImportChunks(ctx as any, args.userId, args);
  },
});

export const listKnowledgeBaseMemoriesPageForBackfill = internalQuery({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.optional(v.id("knowledgeBases")),
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return listKnowledgeBaseBackfillPageImpl(ctx, args);
  },
});

export const countKnowledgeBaseBackfillPage = internalQuery({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.optional(v.id("knowledgeBases")),
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const page = await listKnowledgeBaseBackfillPageImpl(ctx, args);

    return {
      total: page.page.length,
      unembedded: page.page.filter((memory) => memory.embeddingLength === 0).length,
      unenriched: page.page.filter((memory) => !memory.graphEnriched).length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const backfillKBEmbeddings = internalAction({
  args: {
    userId: v.string(),
    batchSize: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batchSize = normalizeBackfillBatchSize(args.batchSize, DEFAULT_KB_EMBEDDING_BACKFILL_BATCH_SIZE);
    const state = parseKnowledgeBaseBackfillCursor(args.cursor);

    // Fetch all active KBs for this user so we scan per-KB via the by_knowledge_base index
    const activeKBs = await ctx.runQuery(internal.crystal.knowledgeBases.getActiveKBsForUser, {
      userId: args.userId,
    }) as Array<{ _id: Id<"knowledgeBases"> }>;

    let scanCursor = state.scanCursor;
    let exhaustedScan = false;

    // Phase 1: Collect unembedded memory IDs by iterating each active KB
    const unembeddedIds: Id<"crystalMemories">[] = [];

    if (activeKBs.length === 0) {
      exhaustedScan = true;
    } else {
      for (const kb of activeKBs) {
        // Each KB gets its own targeted scan using by_knowledge_base index
        let kbCursor: string | undefined = undefined;
        let kbDone = false;

        while (!kbDone && unembeddedIds.length < batchSize) {
          const page = await ctx.runQuery(internal.crystal.knowledgeBases.listKnowledgeBaseMemoriesPageForBackfill, {
            userId: args.userId,
            knowledgeBaseId: kb._id,
            cursor: kbCursor,
            pageSize: KB_BACKFILL_PAGE_SIZE,
          }) as KnowledgeBaseBackfillPage;

          for (const memory of page.page) {
            if (memory.embeddingLength > 0) continue;
            unembeddedIds.push(memory._id);
            if (unembeddedIds.length >= batchSize) break;
          }

          if (page.isDone || !page.continueCursor) {
            kbDone = true;
          } else {
            kbCursor = page.continueCursor;
          }
        }

        if (unembeddedIds.length >= batchSize) break;
      }

      // If we iterated all KBs without filling the batch, scan is exhausted
      if (unembeddedIds.length < batchSize) {
        exhaustedScan = true;
        scanCursor = undefined;
      }
    }

    const processed = unembeddedIds.length;
    let succeeded = 0;
    let failed = 0;

    if (unembeddedIds.length > 0) {
      // Phase 2: Fetch content for all unembedded memories
      const memories = await ctx.runQuery(internal.crystal.mcp.getMemoriesByIds, {
        memoryIds: unembeddedIds,
      }) as Array<{ _id: Id<"crystalMemories">; userId?: string; content?: string }>;

      const memoriesWithContent = memories.filter(
        (m): m is typeof m & { content: string } => Boolean(m.content?.trim())
      );

      // Phase 3: Batch embed all texts in a single API call
      const texts = memoriesWithContent.map((m) => m.content);
      const embeddings = await batchEmbedTexts(texts, ctx, {
        userId: args.userId,
        source: "knowledgeBases.backfillKnowledgeBaseEmbeddings",
      });

      // Phase 4: Collect successful embeddings and write them all in one mutation
      const patchItems: Array<{ memoryId: Id<"crystalMemories">; embedding: number[] }> = [];

      for (let i = 0; i < memoriesWithContent.length; i++) {
        const embedding = embeddings[i];
        if (Array.isArray(embedding) && embedding.length > 0) {
          patchItems.push({ memoryId: memoriesWithContent[i]._id, embedding });
        } else {
          failed += 1;
          console.log(`[kb backfill][embeddings] memory ${memoriesWithContent[i]._id} embedding returned null`);
        }
      }

      // Count memories that had no content as failures
      failed += unembeddedIds.length - memoriesWithContent.length;

      if (patchItems.length > 0) {
        // Write embeddings in batches of 50 to stay within mutation size limits
        const PATCH_CHUNK_SIZE = 50;
        const patchResults = await Promise.allSettled(
          Array.from({ length: Math.ceil(patchItems.length / PATCH_CHUNK_SIZE) }, (_, i) =>
            ctx.runMutation(internal.crystal.mcp.patchMemoryEmbeddingBatch, {
              items: patchItems.slice(i * PATCH_CHUNK_SIZE, (i + 1) * PATCH_CHUNK_SIZE),
            })
          )
        );

        for (const result of patchResults) {
          if (result.status === "fulfilled") {
            succeeded += (result.value as { patched: number }).patched;
          } else {
            // Count the failed chunk's items
            console.log(`[kb backfill][embeddings] batch patch failed`, result.reason);
          }
        }

        // Any patchItems not accounted for in succeeded are failures
        const patchedTotal = succeeded;
        failed += patchItems.length - patchedTotal;
      }
    }

    const retryRequested = state.retryRequested || failed > 0;
    const shouldRestart = exhaustedScan && retryRequested;

    // Circuit breaker: track consecutive 100%-failure batches
    const isFullFailure = processed > 0 && succeeded === 0;
    const consecutiveFailBatches = isFullFailure
      ? (state.consecutiveFailBatches ?? 0) + 1
      : 0; // reset on any success

    const circuitBroken = consecutiveFailBatches >= BACKFILL_CIRCUIT_BREAKER_THRESHOLD;
    const shouldScheduleNext = !circuitBroken && (!exhaustedScan || shouldRestart);

    if (circuitBroken) {
      console.log(
        `[kb backfill][embeddings] CIRCUIT BREAKER: ${consecutiveFailBatches} consecutive full-failure batches. Stopping self-scheduling. Re-trigger manually when API quota resets.`
      );
    }

    if (shouldScheduleNext) {
      // Exponential backoff when failure rate is high
      const failureRate = processed > 0 ? failed / processed : 0;
      const delay = failureRate > 0.8
        ? Math.min(BACKFILL_HIGH_FAILURE_BACKOFF_MS * Math.pow(2, consecutiveFailBatches), 300_000)
        : KB_EMBEDDING_BACKFILL_DELAY_MS;

      await ctx.scheduler.runAfter(
        delay,
        internal.crystal.knowledgeBases.backfillKBEmbeddings,
        {
          userId: args.userId,
          batchSize,
          cursor: serializeKnowledgeBaseBackfillCursor({
            batchNumber: state.batchNumber + 1,
            passNumber: shouldRestart ? state.passNumber + 1 : state.passNumber,
            scanCursor: shouldRestart ? undefined : scanCursor,
            retryRequested: shouldRestart ? false : retryRequested,
            consecutiveFailBatches,
          }),
        }
      );
    }

    console.log(
      `[kb backfill][embeddings] pass ${state.passNumber} batch ${state.batchNumber}: processed=${processed} succeeded=${succeeded} failed=${failed} exhaustedScan=${exhaustedScan} scheduled=${shouldScheduleNext} activeKBs=${activeKBs.length}`
    );

    return {
      batchNumber: state.batchNumber,
      passNumber: state.passNumber,
      processed,
      succeeded,
      failed,
      scheduled: shouldScheduleNext,
      done: !shouldScheduleNext,
    };
  },
});

export const backfillKBGraphEnrichment = internalAction({
  args: {
    userId: v.string(),
    batchSize: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batchSize = normalizeBackfillBatchSize(args.batchSize, DEFAULT_KB_GRAPH_BACKFILL_BATCH_SIZE);
    const state = parseKnowledgeBaseBackfillCursor(args.cursor);
    let scanCursor = state.scanCursor;
    let exhaustedScan = false;

    // Phase 1: Collect unenriched memory IDs
    const unenriched: Array<{ _id: Id<"crystalMemories">; userId: string }> = [];

    while (unenriched.length < batchSize) {
      const page = await ctx.runQuery(internal.crystal.knowledgeBases.listKnowledgeBaseMemoriesPageForBackfill, {
        userId: args.userId,
        cursor: scanCursor,
        pageSize: KB_BACKFILL_PAGE_SIZE,
      }) as KnowledgeBaseBackfillPage;

      if (page.page.length === 0) {
        if (page.isDone || !page.continueCursor) {
          exhaustedScan = true;
          scanCursor = undefined;
          break;
        }

        scanCursor = page.continueCursor;
        continue;
      }

      for (const memory of page.page) {
        if (memory.graphEnriched) continue;
        unenriched.push({ _id: memory._id, userId: memory.userId });
        if (unenriched.length >= batchSize) break;
      }

      if (page.isDone || !page.continueCursor) {
        exhaustedScan = true;
        scanCursor = undefined;
        break;
      }

      scanCursor = page.continueCursor;
    }

    const processed = unenriched.length;
    let succeeded = 0;
    let failed = 0;

    if (unenriched.length > 0) {
      // Phase 2: Process with controlled concurrency
      let cursor = 0;
      const results: PromiseSettledResult<{ enriched?: boolean; reason?: string }>[] = [];

      while (cursor < unenriched.length) {
        const chunk = unenriched.slice(cursor, cursor + GRAPH_ENRICHMENT_CONCURRENCY);
        const chunkResults = await Promise.allSettled(
          chunk.map((memory) =>
            ctx.runAction(internal.crystal.graphEnrich.enrichMemoryGraph, {
              memoryId: memory._id,
              userId: memory.userId,
            }) as Promise<{ enriched?: boolean; reason?: string }>
          )
        );
        results.push(...chunkResults);
        cursor += GRAPH_ENRICHMENT_CONCURRENCY;
      }

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled" && result.value?.enriched) {
          succeeded += 1;
        } else {
          failed += 1;
          if (result.status === "fulfilled") {
            console.log(`[kb backfill][graph] memory ${unenriched[i]._id} was not enriched`, result.value?.reason);
          } else {
            console.log(`[kb backfill][graph] memory ${unenriched[i]._id} failed`, result.reason);
          }
        }
      }
    }

    const retryRequested = state.retryRequested || failed > 0;
    const shouldRestart = exhaustedScan && retryRequested;

    // Circuit breaker: track consecutive 100%-failure batches
    const isFullFailure = processed > 0 && succeeded === 0;
    const consecutiveFailBatches = isFullFailure
      ? (state.consecutiveFailBatches ?? 0) + 1
      : 0;

    const circuitBroken = consecutiveFailBatches >= BACKFILL_CIRCUIT_BREAKER_THRESHOLD;
    const shouldScheduleNext = !circuitBroken && (!exhaustedScan || shouldRestart);

    if (circuitBroken) {
      console.log(
        `[kb backfill][graph] CIRCUIT BREAKER: ${consecutiveFailBatches} consecutive full-failure batches. Stopping self-scheduling. Re-trigger manually when API quota resets.`
      );
    }

    if (shouldScheduleNext) {
      const failureRate = processed > 0 ? failed / processed : 0;
      const delay = failureRate > 0.8
        ? Math.min(BACKFILL_HIGH_FAILURE_BACKOFF_MS * Math.pow(2, consecutiveFailBatches), 300_000)
        : KB_GRAPH_BACKFILL_DELAY_MS;

      await ctx.scheduler.runAfter(
        delay,
        internal.crystal.knowledgeBases.backfillKBGraphEnrichment,
        {
          userId: args.userId,
          batchSize,
          cursor: serializeKnowledgeBaseBackfillCursor({
            batchNumber: state.batchNumber + 1,
            passNumber: shouldRestart ? state.passNumber + 1 : state.passNumber,
            scanCursor: shouldRestart ? undefined : scanCursor,
            retryRequested: shouldRestart ? false : retryRequested,
            consecutiveFailBatches,
          }),
        }
      );
    }

    console.log(
      `[kb backfill][graph] pass ${state.passNumber} batch ${state.batchNumber}: processed=${processed} succeeded=${succeeded} failed=${failed} exhaustedScan=${exhaustedScan} scheduled=${shouldScheduleNext}`
    );

    return {
      batchNumber: state.batchNumber,
      passNumber: state.passNumber,
      processed,
      succeeded,
      failed,
      scheduled: shouldScheduleNext,
      done: !shouldScheduleNext,
    };
  },
});

const embedText = async (
  text: string,
  ctx?: Pick<any, "runQuery" | "runMutation">,
  accounting?: { userId?: string; source?: string },
) => {
  if (!ctx || !accounting?.userId) return null;
  return embedTextWithUserOpenRouter(ctx, text, {
    userId: accounting.userId,
    source: accounting.source ?? "knowledgeBases.embedText",
    allowSharedFallback: true,
  });
};

const batchEmbedTexts = async (
  texts: string[],
  ctx?: Pick<any, "runQuery" | "runMutation">,
  accounting?: { userId?: string; source?: string },
): Promise<(number[] | null)[]> => {
  if (texts.length === 0) return [];
  if (!ctx || !accounting?.userId) return texts.map(() => null);

  try {
    return await embedTextsWithUserOpenRouter(ctx, texts, {
      userId: accounting.userId,
      source: accounting.source ?? "knowledgeBases.batchEmbedTexts",
      allowSharedFallback: true,
    });
  } catch (error) {
    // F8: re-throw cap-exceeded so the caller (backfillKBEmbeddings) aborts the
    // whole batch immediately — no point retrying remaining chunks if the user
    // is over their daily limit.
    if (error instanceof ConvexError && (error.data as any)?.code === "embedding_cap_exceeded") {
      const userId = (error.data as any)?.userId;
      const dailyLimit = (error.data as any)?.dailyLimit;
      console.log(`[kb] daily cap hit for user ${userId} (limit=${dailyLimit}); aborting remaining chunks`);
      throw error;
    }
    console.error("[batchEmbedTexts] OpenRouter batch threw; returning all-null", error);
    return texts.map(() => null);
  }
};

const runKnowledgeBaseQuery: any = async (
  ctx: {
    runQuery: Function;
    runMutation: Function;
    vectorSearch: Function;
  },
  userId: string,
  args: {
    knowledgeBaseId: Id<"knowledgeBases">;
    query: string;
    limit?: number;
    agentId?: string;
    channel?: string;
    skipCostBreaker?: boolean;
    queryEmbedding?: number[];
    precomputedCostBudget?: CostBudgetResult | null;
    vectorDepth?: number;
    includeGraphContext?: boolean;
  }
) : Promise<{ knowledgeBase: KnowledgeBaseDoc; memories: Array<any>; retrieval?: Record<string, any>; graphContext?: any; degradation?: Record<string, any> } | { knowledgeBase: KnowledgeBaseDoc; memories: []; retrieval?: Record<string, any>; graphContext?: any; degradation?: Record<string, any> }> => {
  const knowledgeBase = await ctx.runQuery(
    internal.crystal.knowledgeBases.getKnowledgeBaseByIdInternal,
    { knowledgeBaseId: args.knowledgeBaseId }
  ) as KnowledgeBaseDoc | null;

  if (!knowledgeBase || knowledgeBase.userId !== userId) {
    throw new Error("Knowledge base not found");
  }

  const { effectiveAgentId, queryChannel } =
    resolveDirectKnowledgeBaseQueryContext(knowledgeBase, args);
  if (!isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, queryChannel ?? "")) {
    return { knowledgeBase, memories: [] };
  }

  const normalizedLimit = Math.min(Math.max(args.limit ?? 8, 1), 20);
  const defaultVectorDepth = Math.min(Math.max(normalizedLimit * 4, 12), 80);
  const normalVectorDepth =
    typeof args.vectorDepth === "number"
      ? Math.max(0, Math.floor(args.vectorDepth))
      : defaultVectorDepth;
  const retrievalMode = await resolveKbRetrievalMode(ctx, {
    userId,
    normalVectorDepth,
    skipCostBreaker: args.skipCostBreaker,
    precomputedCostBudget: args.precomputedCostBudget,
  });
  let queryEmbedding: number[] | null = Array.isArray(args.queryEmbedding)
    ? args.queryEmbedding
    : null;
  if (retrievalMode.vectorAllowed && retrievalMode.vectorDepth > 0 && !queryEmbedding) {
    try {
      queryEmbedding = await embedText(args.query.trim(), ctx, {
        userId,
        source: "knowledgeBases.runKnowledgeBaseQuery",
      });
      if (!Array.isArray(queryEmbedding)) {
        await applyKbEmbeddingDegradation(ctx, {
          userId,
          retrievalMode,
          reason: "embedding_failed",
        });
        queryEmbedding = null;
      }
    } catch (error) {
      if (!isEmbeddingCapExceeded(error)) {
        console.warn("[knowledgeBases] query embedding failed; falling back to non-vector KB retrieval", error);
      }
      await applyKbEmbeddingDegradation(ctx, {
        userId,
        retrievalMode,
        reason: isEmbeddingCapExceeded(error) ? "embedding_cap_exceeded" : "embedding_failed",
      });
      queryEmbedding = null;
    }
  }

  const [vectorResults, textResults] = await Promise.all([
    retrievalMode.vectorAllowed && retrievalMode.vectorDepth > 0 && Array.isArray(queryEmbedding)
      ? ctx.vectorSearch("crystalMemories", "by_embedding", {
          vector: queryEmbedding,
          limit: retrievalMode.vectorDepth,
          // Scope the vector search to THIS knowledge base (and active rows).
          // Without the knowledgeBaseId predicate, the top-N nearest-neighbor
          // search returns the user's whole corpus and a small KB chunk gets
          // crowded out before the post-filter at line 1793 ever sees it,
          // collapsing vectorScore to 0 for legitimate KB hits.
          filter: (q: any) => q.eq("knowledgeBaseId", args.knowledgeBaseId),
        }) as Promise<Array<{ _id: Id<"crystalMemories">; _score: number }>>
      : Promise.resolve([] as Array<{ _id: Id<"crystalMemories">; _score: number }>),
    retrievalMode.textAllowed
      ? ctx.runQuery(internal.crystal.recall.searchMemoriesByText, {
          userId,
          query: args.query,
          limit: normalVectorDepth,
          // KB-scope the BM25 pool so user-wide text matches don't crowd out
          // legitimate KB hits in the candidate set.
          knowledgeBaseId: String(args.knowledgeBaseId),
        }) as Promise<Array<{ _id: string }>>
      : Promise.resolve([] as Array<{ _id: string }>),
  ]);

  const vectorScoreMap = new Map<string, number>();
  for (const result of vectorResults) {
    vectorScoreMap.set(String(result._id), result._score ?? 0);
  }

  const candidateIds = Array.from(new Set<string>([
    ...vectorResults.map((result) => String(result._id)),
    ...textResults.map((result) => String(result._id)),
  ]));

  // Fallback diagnostics: record what each retrieval stage produced and which
  // fallback (if any) actually fired. Surfaced on the response as `retrieval`
  // so operators can observe hybrid-search behavior (e.g. "vector returned 0,
  // lexical BM25 carried the query"). Purely additive — never changes results.
  const retrievalDiagnostics: {
    vectorCount: number;
    lexicalCount: number;
    indexedFillCount: number;
    fallback: "none" | "lexical_only" | "indexed_fill" | "lexical_and_indexed";
    vectorAttempted: boolean;
    lexicalAttempted: boolean;
  } = {
    vectorCount: vectorResults.length,
    lexicalCount: textResults.length,
    indexedFillCount: 0,
    fallback: "none",
    vectorAttempted:
      retrievalMode.vectorAllowed && retrievalMode.vectorDepth > 0 && Array.isArray(queryEmbedding),
    lexicalAttempted: retrievalMode.textAllowed,
  };
  // Lexical carried the query when vector produced nothing but BM25 found hits.
  if (retrievalDiagnostics.vectorCount === 0 && retrievalDiagnostics.lexicalCount > 0) {
    retrievalDiagnostics.fallback = "lexical_only";
  }

  const candidateDocs = (
    await Promise.all(
      candidateIds.map((memoryId: string) =>
        ctx.runQuery(internal.crystal.memories.getMemoryInternal, {
          memoryId: memoryId as Id<"crystalMemories">,
        })
      )
    )
  ).filter((memory): memory is NonNullable<typeof memory> =>
    Boolean(
      memory &&
        memory.userId === userId &&
        memory.knowledgeBaseId === args.knowledgeBaseId &&
        !memory.archived &&
        // Drop config-header / source-mirror chunks so operators can retire
        // their client-side low-value-chunk filter. Absent chunkKind == content.
        !isConfigChunk(memory),
    )
  );

  const indexedKbFillAllowed = retrievalMode.indexedFallbackAllowed || !retrievalMode.degraded;
  if (indexedKbFillAllowed && candidateDocs.length < normalizedLimit) {
    // getKBMemoriesInternal now returns config-free content rows, so `limit`
    // reflects real content. Over-fetch a modest multiple only to absorb overlap
    // with rows already surfaced by the semantic/lexical stages (deduped by
    // existingIds below), never to compensate for config chunks eating the budget.
    const fallbackDocs = await ctx.runQuery(internal.crystal.knowledgeBases.getKBMemoriesInternal, {
      knowledgeBaseId: args.knowledgeBaseId,
      limit: normalizedLimit * 2,
      agentId: effectiveAgentId,
      channel: queryChannel,
    }) as Array<any>;
    const existingIds = new Set(candidateDocs.map((memory) => String(memory._id)));
    let addedFallbackDocs = 0;
    for (const memory of fallbackDocs) {
      if (!memory || existingIds.has(String(memory._id))) continue;
      if (isConfigChunk(memory)) continue; // defensive: internal query already excludes these
      existingIds.add(String(memory._id));
      candidateDocs.push(memory);
      addedFallbackDocs += 1;
      if (candidateDocs.length >= normalizedLimit) break;
    }
    if (addedFallbackDocs > 0) {
      retrievalDiagnostics.indexedFillCount = addedFallbackDocs;
      retrievalDiagnostics.fallback =
        retrievalDiagnostics.fallback === "lexical_only" ? "lexical_and_indexed" : "indexed_fill";
      if (retrievalMode.indexedFallbackAllowed) {
        retrievalMode.degraded = true;
        retrievalMode.reasons.push("indexed_fallback_used");
      } else {
        metric("mc.metric.kb-indexed-fill", {
          kbId: String(args.knowledgeBaseId),
          addedFallbackDocs,
          candidateDocs: candidateDocs.length,
        });
      }
    }
  }

  const compactRecallEnabled = isCompactRecallEnabled();
  const ranked = rankRecallCandidates(
    candidateDocs.map((memory) => ({
      memoryId: String(memory._id),
      title: memory.title,
      // Inject the compact recallText when present and compact recall is on;
      // fall back to full content otherwise. Text matching below still runs on
      // the full content so ranking quality is unaffected by compaction.
      content: resolveKnowledgeBaseRecallContent(memory, compactRecallEnabled),
      // Dedup on the untouched full content so two chunks whose compacted
      // recallText collides but whose full content differs are not deduped.
      dedupeText: memory.content,
      store: memory.store,
      category: memory.category,
      tags: memory.tags ?? [],
      strength: memory.strength ?? 0,
      confidence: memory.confidence ?? 0,
      accessCount: memory.accessCount ?? 0,
      lastAccessedAt: memory.lastAccessedAt,
      createdAt: memory.createdAt,
      salienceScore: memory.salienceScore,
      channel: memory.channel,
      vectorScore: vectorScoreMap.get(String(memory._id)) ?? 0,
      textMatchScore: deriveTextMatchScore(args.query, memory.title, memory.content, memory.tags ?? []),
      knowledgeBaseId: String(args.knowledgeBaseId),
      knowledgeBaseName: knowledgeBase.name,
      sourceRole: normalizeKnowledgeBaseSourceRole(knowledgeBase.sourceRole),
      })),
    {
      query: args.query,
      channel: queryChannel,
      weights: {
        ...defaultRecallRankingWeights,
        knowledgeBaseWeight: 0.08,
      },
    }
  ).slice(0, normalizedLimit);

  if (ranked.length > 0) {
    await ctx.runMutation(internal.crystal.mcp.bumpAccessCounts, {
      memoryIds: ranked.map((memory) => memory.memoryId),
    });
  }
  const degradationReasons = Array.from(new Set(retrievalMode.reasons));
  const upgradePrompt = buildKbUpgradePrompt(retrievalMode.tier, degradationReasons);
  const graphContext =
    args.includeGraphContext === true && ranked.length > 0
      ? await ctx
          .runQuery(
            (internal as any).crystal.graphQuery
              .getGraphContextForMemoriesInternal,
            {
              userId,
              memoryIds: ranked
                .map((memory) => memory.memoryId)
                .filter(Boolean) as Id<"crystalMemories">[],
              channel: queryChannel,
              agentId: effectiveAgentId,
              maxEntities: 30,
              maxRelations: 20,
            },
          )
          .catch((error: unknown) => {
            console.warn(
              "[knowledgeBases] graph context lookup failed; continuing without graphContext",
              error,
            );
            return undefined;
          })
      : undefined;

  return {
    knowledgeBase,
    memories: ranked,
    // Additive observability: how the hybrid pipeline resolved this query and
    // which fallback (if any) fired. Never affects `memories`.
    retrieval: {
      ...retrievalDiagnostics,
      resultCount: ranked.length,
    },
    ...(graphContext ? { graphContext } : {}),
    ...(retrievalMode.degraded
      ? {
          degradation: {
            code: "kb_retrieval_degraded",
            reasons: degradationReasons,
            vectorAllowed: retrievalMode.vectorAllowed,
            vectorDepth: retrievalMode.vectorDepth,
            textAllowed: retrievalMode.textAllowed,
            indexedFallbackAllowed: retrievalMode.indexedFallbackAllowed,
            tier: retrievalMode.tier,
            budgetLevel: retrievalMode.budgetLevel,
            recoverable: true,
            ...(upgradePrompt ? { upgradePrompt } : {}),
          },
        }
      : {}),
  };
};

export const queryKnowledgeBase: any = action({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    query: v.string(),
    limit: v.optional(v.number()),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    includeGraphContext: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);
    return runKnowledgeBaseQuery(ctx as any, userId, args);
  },
});

export const queryKnowledgeBaseInternal = internalAction({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
    query: v.string(),
    limit: v.optional(v.number()),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    skipCostBreaker: v.optional(v.boolean()),
    queryEmbedding: v.optional(v.array(v.number())),
    precomputedCostBudget: v.optional(precomputedCostBudgetValidator),
    vectorDepth: v.optional(v.number()),
    includeGraphContext: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    return runKnowledgeBaseQuery(ctx as any, args.userId, args);
  },
});

export const getActiveKBsForUser = internalQuery({
  args: {
    userId: v.string(),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const base = {
      includeInactive: false,
      agentId: args.agentId,
      applyVisibilityFilter: true,
    };
    // Recall path: channel is always supplied by the plugin for peer-capable
    // agents (peer-coach:<peerId>). If omitted, fall back to management
    // visibility (e.g. agentId-only internal callers).
    return typeof args.channel === "string"
      ? listKnowledgeBasesForUserImpl(ctx, args.userId, {
          ...base,
          callSource: "peer",
          channel: args.channel,
        })
      : listKnowledgeBasesForUserImpl(ctx, args.userId, {
          ...base,
          callSource: "management",
        });
  },
});

export const getKBMemoriesInternal = internalQuery({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    limit: v.number(),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase) {
      return [];
    }

    const { effectiveAgentId, queryChannel } =
      resolveDirectKnowledgeBaseQueryContext(knowledgeBase, args);
    if (!isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, queryChannel ?? "")) {
      return [];
    }

    // Exclude config-header / source-mirror chunks (chunkKind === "config") here
    // so `limit` reflects real content rows. The indexed-fill fallback in
    // runKnowledgeBaseQuery relies on this: filtering config chunks *after* a
    // fixed .take() could under-fill below the requested limit when a KB is
    // config-heavy. We iterate the index (newest-first) and stop as soon as
    // `limit` content rows are collected, only scanning past skipped config
    // chunks — so the common case reads no more docs than the old .take(limit).
    const collected: Array<Doc<"crystalMemories">> = [];
    const cursor = ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", knowledgeBase.userId).eq("archived", false)
      )
      .order("desc");
    for await (const memory of cursor) {
      if (isConfigChunk(memory)) continue;
      collected.push(memory);
      if (collected.length >= args.limit) break;
    }
    return collected;
  },
});

export const backfillScopeFromTitle = internalMutation({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
    patchedSoFar: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (!knowledgeBase || knowledgeBase.userId !== args.userId) {
      throw new Error("Knowledge base not found");
    }
    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q) => q.eq("knowledgeBaseId", args.knowledgeBaseId))
      .filter((q) => q.eq(q.field("scope"), undefined))
      .take(100);
    let patched = args.patchedSoFar ?? 0;
    for (const mem of memories) {
      if (mem.userId !== args.userId) continue;
      if (mem.title?.startsWith("tg-")) {
        const telegramId = mem.title.replace(/^tg-/, "");
        await ctx.db.patch(mem._id, { scope: telegramId });
        patched++;
      }
    }
    if (memories.length === 100) {
      await ctx.scheduler.runAfter(100, internal.crystal.knowledgeBases.backfillScopeFromTitle, {
        userId: args.userId,
        knowledgeBaseId: args.knowledgeBaseId,
        patchedSoFar: patched,
      });
      return { patched, isDone: false };
    }
    return { patched, isDone: true };
  },
});

export const reassignKnowledgeBasesForAgentScopesInternal = internalAction({
  args: {
    userId: v.string(),
    sharedKnowledgeBaseNames: v.array(v.string()),
    sharedAgentIds: v.array(v.string()),
    sharedScope: v.string(),
    duplicateKnowledgeBaseName: v.string(),
    duplicateMaxMemoryCount: v.number(),
    privateKnowledgeBaseNames: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{
    updatedKnowledgeBases: Array<{
      knowledgeBaseId: Id<"knowledgeBases">;
      name: string;
      scope: string;
      peerScopePolicy: "permissive";
      agentIds: string[];
    }>;
    deletedKnowledgeBase: {
      knowledgeBaseId: Id<"knowledgeBases">;
      name: string;
      memoryCount: number;
    };
    untouchedPrivateKnowledgeBases: Array<{
      knowledgeBaseId: Id<"knowledgeBases">;
      name: string;
      memoryCount: number;
      scope: string | null;
      peerScopePolicy: "strict" | "permissive" | null;
      agentIds: string[];
    }>;
  }> => {
    const allKnowledgeBases = await ctx.runQuery(internal.crystal.knowledgeBases.listKnowledgeBasesInternal, {
      userId: args.userId,
      includeInactive: true,
    }) as Array<KnowledgeBaseDoc & { _id: Id<"knowledgeBases"> }>;

    const findSharedKnowledgeBase = (name: string): KnowledgeBaseDoc & { _id: Id<"knowledgeBases"> } => {
      const matches = allKnowledgeBases.filter((knowledgeBase) => knowledgeBase.name === name);
      if (matches.length === 1) {
        return matches[0];
      }
      const sorted = [...matches].sort((left, right) => (right.memoryCount ?? 0) - (left.memoryCount ?? 0));
      const canonical = sorted[0];
      if (!canonical || (canonical.memoryCount ?? 0) <= args.duplicateMaxMemoryCount) {
        throw new Error(`Could not resolve canonical knowledge base named "${name}"`);
      }
      return canonical;
    };

    const findExactlyOne = (name: string): KnowledgeBaseDoc & { _id: Id<"knowledgeBases"> } => {
      const matches = allKnowledgeBases.filter((knowledgeBase) => knowledgeBase.name === name);
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one knowledge base named "${name}", found ${matches.length}`);
      }
      return matches[0];
    };

    const sharedKnowledgeBases = args.sharedKnowledgeBaseNames.map(findSharedKnowledgeBase);
    const privateKnowledgeBases = (args.privateKnowledgeBaseNames ?? []).map(findExactlyOne);
    const duplicateMatches = allKnowledgeBases.filter(
      (knowledgeBase) =>
        knowledgeBase.name === args.duplicateKnowledgeBaseName &&
        (knowledgeBase.memoryCount ?? 0) <= args.duplicateMaxMemoryCount
    );
    if (duplicateMatches.length !== 1) {
      throw new Error(
        `Expected exactly one duplicate "${args.duplicateKnowledgeBaseName}" with <= ${args.duplicateMaxMemoryCount} memories, found ${duplicateMatches.length}`
      );
    }
    const duplicateKnowledgeBase = duplicateMatches[0];

    for (const knowledgeBase of sharedKnowledgeBases) {
      await ctx.runMutation(internal.crystal.knowledgeBases.patchKnowledgeBaseInternal, {
        userId: args.userId,
        knowledgeBaseId: knowledgeBase._id,
        patch: {
          agentIds: args.sharedAgentIds,
          scope: args.sharedScope,
          peerScopePolicy: "permissive",
          updatedAt: Date.now(),
        },
      });
    }

    await ctx.runAction((internal as any).crystal.knowledgeBases.deleteKnowledgeBaseInternal, {
      userId: args.userId,
      knowledgeBaseId: duplicateKnowledgeBase._id,
    });

    return {
      updatedKnowledgeBases: sharedKnowledgeBases.map((knowledgeBase: any) => ({
        knowledgeBaseId: knowledgeBase._id,
        name: knowledgeBase.name,
        scope: args.sharedScope,
        peerScopePolicy: "permissive",
        agentIds: args.sharedAgentIds,
      })),
      deletedKnowledgeBase: {
        knowledgeBaseId: duplicateKnowledgeBase._id,
        name: duplicateKnowledgeBase.name,
        memoryCount: duplicateKnowledgeBase.memoryCount ?? 0,
      },
      untouchedPrivateKnowledgeBases: privateKnowledgeBases.map((knowledgeBase) => ({
        knowledgeBaseId: knowledgeBase._id,
        name: knowledgeBase.name,
        memoryCount: knowledgeBase.memoryCount ?? 0,
        scope: knowledgeBase.scope ?? null,
        peerScopePolicy: knowledgeBase.peerScopePolicy ?? null,
        agentIds: knowledgeBase.agentIds ?? [],
      })),
    };
  },
});
