import type { MemoryTextHits } from "./memoryPolicy";
import type { UserTier } from "../../../shared/tierLimits";
import type { CostBudgetResult, TieredVectorReachPolicy } from "../recallBudgetPolicy";
import type { RecallIntent, SourceRole, SourceRoleSource } from "../recallRanking";
import type { createRecallStageTimer } from "../recallTimings";

export type UpgradePrompt = {
  code: string;
  targetTier: string;
  message: string;
  reason: string;
};

export type RecallDegradation = {
  code: string;
  message: string;
  recoverable: boolean;
  affectedStage: string;
  reason?: string;
  surface?: string;
  scope?: string;
  resetsAt?: number;
  tier?: UserTier;
  vectorDepth?: number;
  budgetLevel?: "normal" | "limited" | "blocked";
  upgradePrompt?: UpgradePrompt;
  relatedDegradations?: Array<Record<string, unknown>>;
};

export type DegradationTracker = {
  current: () => RecallDegradation | undefined;
  mark: (next: RecallDegradation) => void;
};

export type RecallDiagnostics = {
  account: { userId: string; email: string | null; name: string | null };
  scope: {
    channel?: string;
    sessionKey?: string;
    agentId?: string;
    effectiveAgentId: string;
    projectId?: string;
    repoSlug?: string;
    projectMatch?: "projectId" | "repoSlug";
  };
  recallIntent: RecallIntent;
  knowledgeBasesSearched: Array<{
    id: string;
    name: string;
    sourceRole: SourceRole;
    sourceRoleSource: SourceRoleSource;
    returned: number;
  }>;
  candidateCounts: {
    semanticInitial: number;
    lexicalRanked: number;
    ltmAfterInitialCap: number;
    activeKnowledgeBases: number;
    knowledgeBasesSearched: number;
    kbAppended: number;
    assetContexts: number;
    messageMatches: number;
    preFinalComposition: number;
    final: number;
  };
  sourceRoles: Record<string, number>;
  suppressions: {
    crossProject: number;
    duplicateOrExisting: number;
    categoryFilter: number;
    requestedKnowledgeBaseFilter: number;
    crossPerson: number;
  };
  trim: {
    requestedLimit: number;
    beforeFinalComposition: number;
    afterFinalComposition: number;
    trimmed: number;
  };
};

export type NormalizedRecallRequest = {
  messageLimit?: number;
  /** Preserve supplied identity fields; memory normalization may synthesize an id. */
  messageProject?: import("../projectIdentity").ProjectIdentity;
  turnId?: string;
  excludeRecentMessagesMs?: number;
  query: string;
  limit: number;
  channel?: string;
  sessionKey?: string;
  scopeToSession: boolean;
  recallSinceMs?: number;
  recallBeforeMs?: number;
  mode: string;
  resolvedStores?: string[];
  resolvedCategories?: string[];
  requestedTags?: string[];
  agentId: string;
  effectiveAgentId: string;
  projectId?: string;
  repoSlug?: string;
  recallIntent: RecallIntent;
  requestedKnowledgeBaseIds?: string[];
  hasKnowledgeBaseScope: boolean;
  peerScope?: string;
  includeAssets: boolean;
  collapseNearDuplicates: boolean;
  includeEmbeddingsFlag: unknown;
  precomputedEmbedding?: number[] | null;
  recordAccess: boolean;
  includeArchived: boolean;
  recentMemoryIds?: string[];
  awaitBookkeeping: boolean;
  excludeProspectiveFromBookkeeping: boolean;
  bookkeepingIdCap?: number;
  // Adapter overrides below are optional. Absent means mcpRecall behavior.
  // normalizeActionRecallArgs sets them so recallMemories keeps its pre-engine
  // lanes, debits, and filters (ILL-305 pre-gate Group A).
  /** false: no message lane, so no "messages" debit and no message queries. */
  includeMessages?: boolean;
  /** false: skip identity lookup, except when people mode needs the display name for its bounded name preference. */
  resolveIdentity?: boolean;
  /** Recall-surface debit reasons; textRequiresQuery skips the text debit for an empty query. */
  recallDebits?: { vectorReason: string; textReason: string; textRequiresQuery: boolean };
  /** Lanes attach the stored strength as `memoryStrength`, a key ranking never reads. */
  carryStoredStrength?: boolean;
  /**
   * Filtered recallMemories calls: normal vector depth for the reach policy.
   * The semantic lane then keeps every hit up to the reach depth for the
   * store/category/tag filters instead of the top `limit`.
   */
  filteredVectorDepth?: number;
};

export type RecallCostDebit = {
  surface: "recall" | "kb" | "messages";
  estimatedVectorQueryBytes?: number;
  estimatedTextQueryBytes?: number;
  estimatedEmbeddingCalls?: number;
  reason: string;
};

export type RecallPendingCredit = {
  surface: "recall" | "kb" | "messages";
  lane: string;
  vectorBytes: number;
  textBytes: number;
};

export type RecallPorts = {
  userId: string;
  benchmarkRecall: boolean;
  embed: (text: string) => Promise<number[] | null>;
  getTier: () => Promise<UserTier>;
  getIdentity: () => Promise<{ userId: string; email: string | null; name: string | null }>;
  getPersonMemoryCandidates?: (args: { userId: string; limit: number }) => Promise<{
    titles: string[];
    candidates: any[];
  }>;
  debit: (args: RecallCostDebit) => Promise<CostBudgetResult | null>;
  textSearch: (args: {
    userId: string;
    query: string;
    limit: number;
    /** Recall requests first-window cursors for an optional filter-pressure refill. */
    recallFilters?: boolean;
  }) => Promise<MemoryTextHits>;
  recent: (args: {
    userId: string;
    limit: number;
    channel?: string;
    sessionKey?: string;
    scopeToSession: boolean;
    recencyIntent?: boolean;
    requestProjectId?: string;
    repoSlug?: string;
  }) => Promise<any[]>;
  scoreRecallCandidates?: (args: {
    userId: string;
    memoryIds: string[];
    queryEmbedding: number[];
  }) => Promise<Array<{ memoryId: string; score: number }>>;
  hydrate: (args: { memoryIds: string[] }) => Promise<any[]>;
  crossSessionIds: (args: { memoryIds: string[]; sessionKey: string }) => Promise<string[]>;
  listKnowledgeBases: (args: {
    userId: string;
    knowledgeBaseIds?: string[];
    agentId: string;
    channel?: string;
  }) => Promise<any[]>;
  vectorSearch: (args: {
    userId: string;
    queryEmbedding: number[];
    query: string;
    limit: number;
    channel?: string;
    sessionKey?: string;
    scopeToSession: boolean;
    vectorDepth: number;
    includeArchived: boolean;
    /** Set only for filtered recallMemories calls: fetch and return this many ranked hits. */
    candidateDepth?: number;
    /** Raw project identity. Absent fields are omitted so unscoped calls stay unchanged. */
    requestProjectId?: string;
    repoSlug?: string;
  }) => Promise<any[]>;
  searchAssets: (args: {
    userId: string;
    query: string;
    channel?: string;
    knowledgeBaseIds?: string[];
    peerScope?: string;
    limit: number;
  }) => Promise<any[]>;
  queryKnowledgeBase: (args: Record<string, unknown>) => Promise<any>;
  searchMessages: (args: {
    query: string;
    limit: number;
    channel?: string;
    sessionKey?: string;
    sinceMs?: number;
    beforeMs?: number;
    textAllowed: boolean;
    messageLaneOutcome: { bm25SkippedForBudget: boolean; tier?: UserTier };
  }) => Promise<any[]>;
  searchMessagePage?: (args: {
    query: string; limit: number; channel?: string; sessionKey?: string;
    sinceMs?: number; beforeMs?: number; textAllowed: boolean;
    messageLaneOutcome: { bm25SkippedForBudget: boolean; tier?: UserTier };
    lane: "text" | "recent"; cursor: string | null; pageSize: number;
  }) => Promise<import("./lanesMessages").MessagePage>;
  shapeMessages: (messages: any[], includeEmbeddings: boolean) => any[];
  includeEmbeddings: () => boolean;
  bookkeep: (memoryIds: string[]) => void | Promise<void>;
  /** Schedule credit for a lane that did not execute (R4). The adapter
   *  tracks receipts from its own debit calls and dispatches creditUnexecuted. */
  creditLane: (args: { surface: "recall" | "kb" | "messages"; vectorBytes: number; textBytes: number }) => Promise<void>;
  resolveReach: (args: {
    tier: UserTier;
    normalVectorDepth: number;
    vectorBudget: CostBudgetResult | null;
    textBudget: CostBudgetResult | null;
    indexedFallbackAllowedOnDegradation: boolean;
  }) => TieredVectorReachPolicy;
};

export type RecallStageTimer = ReturnType<typeof createRecallStageTimer>;

export type RecallRuntime = {
  messageScan?: import("./lanesMessages").MessageScan;
  messageMatchesAvailable?: number;
  request: NormalizedRecallRequest;
  ports: RecallPorts;
  timer: RecallStageTimer;
  startedAt: number;
  diagnostics: RecallDiagnostics;
  degradation: DegradationTracker;
  memories: any[];
  queryEmbedding: number[] | null;
  accountHolderName?: string;
  knownPersonNames: string[];
  personMemoryCandidates: any[];
  userTier: UserTier;
  recallBudget: CostBudgetResult | null;
  textBudget: CostBudgetResult | null;
  messageBudget: CostBudgetResult | null;
  messageLaneOutcome: { bm25SkippedForBudget: boolean; tier?: UserTier };
  reach: TieredVectorReachPolicy;
  assetContexts: any[];
  /** Credits queued during lane execution, dispatched in finalizeRecall. */
  pendingCredits: RecallPendingCredit[];
  /** Hydrated text documents per distinct id set (shared by the early-return probe and the lexical merge). */
  textHydrationMemo?: Map<string, any[]>;
  /** Cross-session answers per memory id (true: saved in another session), shared likewise. */
  crossSessionMemo?: Map<string, boolean>;
  /** Set when the identifier early return fires. Absent otherwise. */
  earlyReturn?: boolean;
};

export type ParallelRecall = {
  lexical: Promise<[MemoryTextHits, any[]]>;
  kbList: Promise<any[]>;
  startMessages: () => void;
  resolveMessages: () => Promise<any[]>;
};

export type RecallEngineSuccess = {
  status: number;
  body: Record<string, unknown>;
};

export type McpNormalizeResult =
  | { ok: false; status: number; error: string }
  | { ok: true; request: NormalizedRecallRequest };
