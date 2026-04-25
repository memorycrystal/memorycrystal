import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { stableUserId } from "./auth";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  applyDashboardTotalsDelta,
  buildMemoryCreateDelta,
  buildMemoryTransitionDelta,
} from "./dashboardTotals";
import { scanMemoryContent } from "./contentScanner";
import { defaultRecallRankingWeights, deriveTextMatchScore, rankRecallCandidates } from "./recallRanking";
import { metric } from "./metrics";

type KnowledgeBaseDoc = Doc<"knowledgeBases">;

// Registry of agent-prefix scopes that run in a multi-peer context (e.g.
// Telegram bots where {prefix}:{peerId} identifies the end-user). Extend only
// when a new peer-capable agent launches; unknown prefixes are treated as
// legacy (non-peer) by isKnowledgeBaseVisibleToAgent.
export const PEER_CAPABLE_SCOPES: ReadonlySet<string> = new Set([
  "morrow-coach",
  "cass-coach",
]);

// Sentinel used by management/admin surfaces (dashboard list, internal
// enumeration) to bypass peer-scoping. NEVER use a nullish fallback
// (`?? MANAGEMENT_CHANNEL_SENTINEL`) at call sites — callers must pass an
// explicit channel or the sentinel by name.
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

const jsonMetadata = (value: Record<string, unknown>) => JSON.stringify(value);

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

const normalizeScope = (scope?: string) => {
  if (typeof scope !== "string") {
    return undefined;
  }

  const normalized = scope.trim();
  return normalized.length > 0 ? normalized : undefined;
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

// Pre-2026-04-16 guard body, extracted verbatim. Retained so the
// MC_KB_PEER_STRICT="false" kill-switch is a one-line branch instead of a
// conditional tangle inside the new guard. Do NOT evolve this function — if
// you change the legacy path, rollback semantics change with it.
const isKnowledgeBaseVisibleLegacy = (
  knowledgeBase: Pick<KnowledgeBaseDoc, "agentIds" | "isActive" | "scope">,
  agentId: string | undefined,
  channel: string | undefined,
): boolean => {
  if (!knowledgeBase.isActive) {
    return false;
  }

  const normalizedScope = normalizeScope(knowledgeBase.scope);
  const normalizedChannel = normalizeScope(channel);
  if (normalizedScope && normalizedScope !== normalizedChannel) {
    return false;
  }

  const allowedAgentIds = normalizeAgentIds(knowledgeBase.agentIds);
  if (!allowedAgentIds || allowedAgentIds.length === 0) {
    return true;
  }

  const normalizedAgentId = agentId?.trim();
  return normalizedAgentId ? allowedAgentIds.includes(normalizedAgentId) : false;
};

// `channel` is REQUIRED. Callers must pass either:
//   - a real channel string (e.g. "morrow-coach:511172388", "general"), or
//   - `MANAGEMENT_CHANNEL_SENTINEL` for management/admin surfaces.
// Do NOT use `?? MANAGEMENT_CHANNEL_SENTINEL` at call sites — that silently
// upgrades every unscoped caller to management-level visibility (bypass). If a
// caller genuinely has no channel, thread a `callSource: "management"` flag
// through the surrounding code and pass the sentinel explicitly.
export const isKnowledgeBaseVisibleToAgent = (
  knowledgeBase: Pick<KnowledgeBaseDoc, "agentIds" | "isActive" | "scope" | "peerScopePolicy"> & { _id?: unknown },
  agentId: string | undefined,
  channel: string | ManagementChannel,
): boolean => {
  if (!knowledgeBase.isActive) {
    return false;
  }

  // Kill-switch: setting env MC_KB_PEER_STRICT="false" reverts the guard to
  // its pre-2026-04-16 (agentIds-only) body without a redeploy. Default
  // (unset) is STRICT. Any value other than the exact string "false" is
  // treated as strict. Read on every call; Convex runs the module per-request
  // so flag flips propagate within the edge-cache TTL (≤60s).
  if (process.env.MC_KB_PEER_STRICT === "false") {
    return isKnowledgeBaseVisibleLegacy(
      knowledgeBase,
      agentId,
      channel === MANAGEMENT_CHANNEL_SENTINEL ? undefined : channel,
    );
  }

  // Management calls (dashboard list, admin enumeration) bypass peer logic.
  if (channel === MANAGEMENT_CHANNEL_SENTINEL) {
    const allowedAgentIds = normalizeAgentIds(knowledgeBase.agentIds);
    if (!allowedAgentIds || allowedAgentIds.length === 0) {
      return true;
    }
    const normalizedAgentId = agentId?.trim();
    return normalizedAgentId ? allowedAgentIds.includes(normalizedAgentId) : true;
  }

  const normalizedScope = normalizeScope(knowledgeBase.scope);
  const normalizedChannel = normalizeScope(channel);

  // Bare-scope equality preserved for non-peer-capable prefixes.
  if (normalizedScope && normalizedScope !== normalizedChannel) {
    // Fall through to peer logic if scope looks like it could match the
    // suffix of a peer channel (e.g. scope="511172388",
    // channel="morrow-coach:511172388"). Handled below.
    if (!normalizedChannel || !normalizedChannel.includes(":")) {
      return false;
    }
  }

  const normalizedChannelStr = normalizedChannel ?? "";
  const colonIdx = normalizedChannelStr.indexOf(":");
  const prefix = colonIdx >= 0 ? normalizedChannelStr.slice(0, colonIdx) : normalizedChannelStr;
  const suffix = colonIdx >= 0 ? normalizedChannelStr.slice(colonIdx + 1) : "";
  const isPeerCapablePrefix = PEER_CAPABLE_SCOPES.has(prefix);
  const isNumericPeer = suffix.length > 0 && /^\d+$/.test(suffix);
  const policy = knowledgeBase.peerScopePolicy ?? "strict";
  const kbId = (knowledgeBase as { _id?: unknown })._id;
  const kbIdTag = typeof kbId === "string" ? kbId : null;

  if (isPeerCapablePrefix) {
    // FAIL-CLOSED: bare peer-capable scope with no colon → DENY unless
    // KB is expressly permissive.
    if (colonIdx < 0) {
      if (policy !== "permissive") {
        metric("mc.metric.kb-peer-block", { reason: "bare-peer-capable", kbId: kbIdTag });
        return false;
      }
    } else if (!isNumericPeer) {
      // FAIL-CLOSED: peer-capable prefix with non-numeric suffix (e.g.
      // "morrow-coach:team") → DENY unless permissive.
      if (policy !== "permissive") {
        metric("mc.metric.kb-peer-block", { reason: "non-numeric-peer-suffix", kbId: kbIdTag });
        return false;
      }
    } else {
      // Numeric peer: strict exact match required.
      if (policy === "strict") {
        const scopeMatchesPeer =
          normalizedScope === normalizedChannelStr ||
          normalizedScope === suffix;
        if (!scopeMatchesPeer) {
          metric("mc.metric.kb-peer-block", { reason: "peer-scope-mismatch", kbId: kbIdTag });
          return false;
        }
      }
    }
  } else {
    // Non-peer-capable prefix: preserve legacy bare-scope equality.
    // (Already enforced at top; reassert for the colon-channel case where we
    // deferred the scope-mismatch decision.)
    if (normalizedScope && normalizedScope !== normalizedChannelStr) {
      return false;
    }
  }

  const allowedAgentIds = normalizeAgentIds(knowledgeBase.agentIds);
  if (!allowedAgentIds || allowedAgentIds.length === 0) {
    return true;
  }

  const normalizedAgentId = agentId?.trim();
  return normalizedAgentId ? allowedAgentIds.includes(normalizedAgentId) : false;
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
  knowledgeBase: Pick<KnowledgeBaseDoc, "_id" | "name" | "sourceType">,
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

const hasEmbeddingProviderCredentials = () => {
  return Boolean(process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY);
};

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

// `channel` is REQUIRED at the internal type level. Callers must declare
// intent via `callSource`: "management" (dashboard/admin list surfaces, no
// peer-scoping) or "peer" (a real channel string, peer-scoping applies). Do
// NOT use `?? MANAGEMENT_CHANNEL_SENTINEL` — that fallback is a visibility
// bypass (B2 from the iter-3 plan).
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
  // caller), still reject visibility-filtered peer calls with no channel
  // instead of silently upgrading to management-level visibility.
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
    .filter((knowledgeBase: KnowledgeBaseDoc) =>
      !applyVisibilityFilter || isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, guardChannel)
    )
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

  for (const chunk of args.chunks) {
    const { memoryId } = await ctx.runMutation(
      internal.crystal.knowledgeBases.insertKnowledgeBaseChunkInternal,
      {
        knowledgeBaseId: args.knowledgeBaseId,
        userId,
        content: chunk.content,
        metadata: chunk.metadata,
      }
    );

    importedMemoryIds.push(memoryId);

    await ctx.runAction(internal.crystal.mcp.embedMemory, { memoryId });
    await ctx.runMutation(internal.crystal.salience.computeAndStoreSalience, { memoryId });
    await ctx.runAction(internal.crystal.graphEnrich.enrichMemoryGraph, {
      memoryId,
      userId,
    });
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
    // into strict peer-capable KBs only when the PARENT KB is itself unscoped
    // — if the parent carries an explicit scope (e.g. "morrow-coach:12345"),
    // child chunks inherit it at read time via the chunk-filter match-form,
    // so unscoped inserts there are fine. The bug we're defending against is
    // "unscoped chunks in an unscoped peer-capable parent" which is a
    // structural leak risk.
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

    // Write-side admission (§4 Step 2.4): only gate unscoped chunks when
    // the parent KB is ALSO unscoped. Parents with an explicit peer scope
    // transitively cover their children via the read-side match-form.
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
      totalChars += chunk.content.length;
    }

    // Update KB counters in bulk
    if (memoryIds.length > 0) {
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
        newArchived: true,
        newStore: memory.store,
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

export const createKnowledgeBase = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    agentIds: v.optional(v.array(v.string())),
    scope: v.optional(v.string()),
    sourceType: v.optional(v.string()),
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
    // Peer-driven surface: when a channel is supplied, the guard peer-scopes.
    // When omitted (agentId-only), fall back to management-visibility — this
    // preserves pre-fix behavior for agentId-only callers (e.g. "coder")
    // while peer-capable agents that travel via channel get strict scoping.
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

    const { memoryId } = await ctx.runMutation(
      internal.crystal.knowledgeBases.insertKnowledgeBaseChunkInternal,
      {
        knowledgeBaseId: args.knowledgeBaseId,
        userId,
        content: args.content,
        metadata: args.metadata,
      }
    ) as { memoryId: Id<"crystalMemories"> };

    await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, { memoryId });
    await ctx.scheduler.runAfter(50, internal.crystal.salience.computeAndStoreSalience, { memoryId });
    await ctx.scheduler.runAfter(100, internal.crystal.graphEnrich.enrichMemoryGraph, {
      memoryId,
      userId,
    });

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

    if (!hasEmbeddingProviderCredentials()) {
      console.log(
        `[kb backfill][embeddings] pass ${state.passNumber} batch ${state.batchNumber}: skipped, no embedding provider credentials configured`
      );
      return {
        batchNumber: state.batchNumber,
        passNumber: state.passNumber,
        processed: 0,
        succeeded: 0,
        failed: 0,
        scheduled: false,
        done: true,
      };
    }

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
      }) as Array<{ _id: Id<"crystalMemories">; content?: string }>;

      const memoriesWithContent = memories.filter(
        (m): m is typeof m & { content: string } => Boolean(m.content?.trim())
      );

      // Phase 3: Batch embed all texts in a single API call
      const texts = memoriesWithContent.map((m) => m.content);
      const embeddings = await batchEmbedTexts(texts);

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

const REQUIRED_EMBEDDING_DIMENSIONS = 3072;

const assertGeminiProvider = (): void => {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "gemini").toLowerCase();
  if (provider !== "gemini") {
    throw new Error(
      `Only Gemini embeddings are supported in production. Got EMBEDDING_PROVIDER="${provider}".`
    );
  }
};

const embedText = async (text: string) => {
  assertGeminiProvider();
  const apiKey = process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2-preview";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    }
  );

  const payload = await response.json().catch(() => null) as { embedding?: { values?: number[] } } | null;
  const vector = response.ok && Array.isArray(payload?.embedding?.values) ? payload.embedding.values : null;

  if (vector && vector.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch in knowledgeBases: got ${vector.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}`
    );
  }
  return vector;
};

const batchEmbedTexts = async (texts: string[]): Promise<(number[] | null)[]> => {
  if (texts.length === 0) return [];
  assertGeminiProvider();

  const apiKey = process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) return texts.map(() => null);
  const model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2-preview";

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        }),
      }
    );

    if (!response.ok) {
      // On 429 (rate limit) or 5xx (server error), do NOT fall back to individual calls —
      // that would amplify N failed calls into N+1 calls against an already-failing API.
      // Return all-null and let the circuit breaker / next cron handle retries.
      if (response.status === 429 || response.status >= 500) {
        console.error(
          `[batchEmbedTexts] Gemini batch failed with ${response.status} — returning all-null (no fallback to avoid amplification)`
        );
        return texts.map(() => null);
      }
      console.log(`[batchEmbedTexts] Gemini batch failed (${response.status}), falling back to individual calls`);
      return Promise.all(texts.map((text) => embedText(text)));
    }

    const payload = await response.json().catch(() => null) as {
      embeddings?: Array<{ values?: number[] }>;
    } | null;

    if (!Array.isArray(payload?.embeddings)) {
      console.log(`[batchEmbedTexts] Gemini batch returned invalid payload, falling back`);
      return Promise.all(texts.map((text) => embedText(text)));
    }

    return payload.embeddings.map((embedding) => {
      if (!Array.isArray(embedding?.values)) return null;
      if (embedding.values.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Batch embedding dimension mismatch: got ${embedding.values.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}`
        );
      }
      return embedding.values;
    });
  } catch (error) {
    // Network errors or other exceptions — don't amplify by falling back to individual calls
    console.error(`[batchEmbedTexts] Gemini batch threw — returning all-null (no fallback to avoid amplification)`, error);
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
  }
) : Promise<{ knowledgeBase: KnowledgeBaseDoc; memories: Array<any> } | { knowledgeBase: KnowledgeBaseDoc; memories: [] }> => {
  const knowledgeBase = await ctx.runQuery(
    internal.crystal.knowledgeBases.getKnowledgeBaseByIdInternal,
    { knowledgeBaseId: args.knowledgeBaseId }
  ) as KnowledgeBaseDoc | null;

  if (!knowledgeBase || knowledgeBase.userId !== userId) {
    throw new Error("Knowledge base not found");
  }

  const effectiveAgentId = resolveKnowledgeBaseAgentId(args.agentId, args.channel);
  // Peer-first fallback: runKnowledgeBaseQuery is called by the MCP
  // queryKnowledgeBase tool (plugin → MCP) and by internal recall assembly.
  // Both surfaces are peer-facing. If a caller forgets `channel`, "" makes
  // isKnowledgeBaseVisibleToAgent reject any KB with a concrete peer scope
  // instead of silently upgrading to management-level visibility. The
  // chunk-level scope filter below also fails-closed on trailing-colon.
  const guardChannel: string | ManagementChannel =
    typeof args.channel === "string" ? args.channel : "";
  if (!isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, guardChannel)) {
    return { knowledgeBase, memories: [] };
  }

  const normalizedLimit = Math.min(Math.max(args.limit ?? 8, 1), 20);
  const queryEmbedding = await embedText(args.query.trim());

    const [vectorResults, textResults] = await Promise.all([
      Array.isArray(queryEmbedding)
        ? ctx.vectorSearch("crystalMemories", "by_embedding", {
          vector: queryEmbedding,
          limit: Math.min(Math.max(normalizedLimit * 4, 12), 80),
          // Scope the vector search to THIS knowledge base (and active rows).
          // Without the knowledgeBaseId predicate, the top-N nearest-neighbor
          // search returns the user's whole corpus and a small KB chunk gets
          // crowded out before the post-filter at line 1793 ever sees it,
          // collapsing vectorScore to 0 for legitimate KB hits.
          filter: (q: any) => q.eq("knowledgeBaseId", args.knowledgeBaseId),
        }) as Promise<Array<{ _id: Id<"crystalMemories">; _score: number }>>
        : Promise.resolve([] as Array<{ _id: Id<"crystalMemories">; _score: number }>),
      ctx.runQuery(internal.crystal.recall.searchMemoriesByText, {
        userId,
        query: args.query,
        limit: Math.min(Math.max(normalizedLimit * 4, 12), 80),
        // KB-scope the BM25 pool so user-wide text matches don't crowd out
        // legitimate KB hits in the candidate set.
        knowledgeBaseId: String(args.knowledgeBaseId),
      }) as Promise<Array<{ _id: string }>>,
    ]);

  const vectorScoreMap = new Map<string, number>();
  for (const result of vectorResults) {
    vectorScoreMap.set(String(result._id), result._score ?? 0);
  }

    const candidateIds = Array.from(new Set<string>([
      ...vectorResults.map((result) => String(result._id)),
      ...textResults.map((result) => String(result._id)),
    ]));

    const candidateDocs = (
      await Promise.all(
        candidateIds.map((memoryId: string) =>
          ctx.runQuery(internal.crystal.memories.getMemoryInternal, {
            memoryId: memoryId as Id<"crystalMemories">,
          })
        )
      )
    ).filter((memory): memory is NonNullable<typeof memory> =>
      Boolean(memory && memory.userId === userId && memory.knowledgeBaseId === args.knowledgeBaseId && !memory.archived)
    );

  // Hard scope filter: if the channel has a peer ID (e.g. 'morrow-coach:123'),
  // only return KB memories scoped to that specific peer. The pre-2026-04-16
  // admission of `!m.scope` allowed unscoped chunks to leak across peers and
  // was the primary read-side carrier of the Cass/Morrow PII incident.
  // A chunk is admitted when EITHER (a) its own scope matches the peer/channel,
  // OR (b) its parent KB carries a matching peer scope — parents with an
  // explicit peer scope transitively cover their children.
  const peerIdFromChannel = args.channel?.includes(":") ? args.channel.split(":").pop() : undefined;
  // Trailing-colon guard: a channel like "morrow-coach:" would produce an empty
  // peerId which would match every chunk with scope==="". Fail-closed.
  if (peerIdFromChannel === "") {
    return { knowledgeBase, memories: [] };
  }
  const parentScopeMatchesPeer =
    !!peerIdFromChannel &&
    (knowledgeBase.scope === peerIdFromChannel || knowledgeBase.scope === args.channel);
  const allowSharedMainChunksForPeer =
    (knowledgeBase.peerScopePolicy ?? "strict") === "permissive" &&
    typeof knowledgeBase.scope === "string" &&
    knowledgeBase.scope.endsWith(":main");
  const scopedDocs = peerIdFromChannel
    ? candidateDocs.filter((m: any) => {
        const keep =
          m.scope === peerIdFromChannel ||
          m.scope === args.channel ||
          (parentScopeMatchesPeer && !m.scope) ||
          (allowSharedMainChunksForPeer && !m.scope);
        if (!keep) {
          metric("mc.metric.kb-chunk-drop", {
            kbId: String(args.knowledgeBaseId),
            scope: typeof m.scope === "string" ? m.scope : null,
          });
        }
        return keep;
      })
    : candidateDocs;

  const ranked = rankRecallCandidates(
    scopedDocs.map((memory) => ({
      memoryId: String(memory._id),
      title: memory.title,
      content: memory.content,
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
    })),
    {
      query: args.query,
      channel: args.channel,
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

  return {
    knowledgeBase,
    memories: ranked,
  };
};

export const queryKnowledgeBase: any = action({
  args: {
    knowledgeBaseId: v.id("knowledgeBases"),
    query: v.string(),
    limit: v.optional(v.number()),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
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
    // agents (morrow-coach:<peerId>). If omitted, fall back to management
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

    const effectiveAgentId = resolveKnowledgeBaseAgentId(args.agentId, args.channel);
    // Peer-first fallback: same invariant as runKnowledgeBaseQuery — missing
    // channel means no peer identity, so we fail-closed on any KB with a
    // concrete peer scope rather than silently upgrading to management.
    const guardChannel: string | ManagementChannel =
      typeof args.channel === "string" ? args.channel : "";
    if (!isKnowledgeBaseVisibleToAgent(knowledgeBase, effectiveAgentId, guardChannel)) {
      return [];
    }

    // Chunk-level peer scope filter. Without this, a permissive shared KB
    // would leak cross-peer chunks under `by_knowledge_base` index reads
    // even though the KB-level guard above passed. The admission rules
    // mirror runKnowledgeBaseQuery (knowledgeBases.ts lines 1820-1850):
    // a chunk is kept when EITHER (a) its scope matches the peer/channel,
    // (b) its parent KB carries a matching peer scope transitively, or
    // (c) the KB is permissive and parent scope ends in ":main".
    const peerIdFromChannel = args.channel?.includes(":")
      ? args.channel.split(":").pop()
      : undefined;
    // Trailing-colon guard: "morrow-coach:" produces empty peerId which
    // would match every chunk with scope==="". Fail-closed.
    if (peerIdFromChannel === "") {
      return [];
    }

    // Over-fetch then filter so the final slice still honors args.limit when
    // the peer filter drops cross-peer chunks. Ceiling mirrors
    // runKnowledgeBaseQuery's 12..80 candidate pool.
    const overFetchLimit = peerIdFromChannel
      ? Math.min(Math.max(args.limit * 4, 12), 80)
      : args.limit;
    const candidates = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", knowledgeBase.userId).eq("archived", false)
      )
      .order("desc")
      .take(overFetchLimit);

    if (!peerIdFromChannel) {
      return candidates.slice(0, args.limit);
    }

    const parentScopeMatchesPeer =
      knowledgeBase.scope === peerIdFromChannel || knowledgeBase.scope === args.channel;
    const allowSharedMainChunksForPeer =
      (knowledgeBase.peerScopePolicy ?? "strict") === "permissive" &&
      typeof knowledgeBase.scope === "string" &&
      knowledgeBase.scope.endsWith(":main");

    return candidates
      .filter((m: any) =>
        m.scope === peerIdFromChannel ||
        m.scope === args.channel ||
        (parentScopeMatchesPeer && !m.scope) ||
        (allowSharedMainChunksForPeer && !m.scope)
      )
      .slice(0, args.limit);
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
