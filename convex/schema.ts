import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

const memoryStore = v.union(
  v.literal("sensory"),
  v.literal("episodic"),
  v.literal("semantic"),
  v.literal("procedural"),
  v.literal("prospective")
);

const memoryCategory = v.union(
  v.literal("decision"),
  v.literal("lesson"),
  v.literal("person"),
  v.literal("rule"),
  v.literal("event"),
  v.literal("fact"),
  v.literal("goal"),
  v.literal("skill"),
  v.literal("workflow"),
  v.literal("conversation")
);

const memorySource = v.union(
  v.literal("conversation"),
  v.literal("cron"),
  v.literal("observation"),
  v.literal("inference"),
  v.literal("external")
);

const assetModality = v.union(
  v.literal("image"),
  v.literal("audio"),
  v.literal("video"),
  v.literal("pdf"),
  v.literal("document"),
  v.literal("other")
);

const assetStorageProvider = v.union(
  v.literal("convex"),
  v.literal("local"),
  v.literal("r2")
);

const assetStatus = v.union(
  v.literal("uploaded"),
  v.literal("queued"),
  v.literal("processing"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("soft_deleted"),
  v.literal("hard_deleted"),
  v.literal("skipped")
);

const assetSource = v.union(
  v.literal("conversation"),
  v.literal("mcp"),
  v.literal("dashboard"),
  v.literal("external"),
  v.literal("inference")
);

const graphNodeType = v.union(
  v.literal("person"),
  v.literal("project"),
  v.literal("goal"),
  v.literal("decision"),
  v.literal("concept"),
  v.literal("tool"),
  v.literal("event"),
  v.literal("resource"),
  v.literal("channel")
);

const graphNodeStatus = v.union(v.literal("active"), v.literal("deprecated"));

const graphRelationType = v.union(
  v.literal("mentions"),
  v.literal("decided_in"),
  v.literal("leads_to"),
  v.literal("depends_on"),
  v.literal("owns"),
  v.literal("uses"),
  v.literal("conflicts_with"),
  v.literal("supports"),
  v.literal("occurs_with"),
  v.literal("assigned_to")
);

const graphLinkRole = v.union(v.literal("subject"), v.literal("object"), v.literal("topic"));

export default defineSchema({
  ...authTables,

  crystalMemories: defineTable({
    userId: v.string(),
    store: memoryStore,
    category: memoryCategory,
    title: v.string(),
    content: v.string(),
    metadata: v.optional(v.string()),
    embedding: v.array(v.float64()),
    strength: v.float64(),
    confidence: v.float64(),
    valence: v.float64(),
    arousal: v.float64(),
    accessCount: v.number(),
    lastAccessedAt: v.number(),
    createdAt: v.number(),
    source: memorySource,
    sessionId: v.optional(v.id("crystalSessions")),
    channel: v.optional(v.string()),
    tags: v.array(v.string()),
    archived: v.boolean(),
    archivedAt: v.optional(v.number()),
    promotedFrom: v.optional(v.id("crystalMemories")),
    checkpointId: v.optional(v.id("crystalCheckpoints")),
    graphEnriched: v.optional(v.boolean()),
    graphEnrichedAt: v.optional(v.number()),
    salienceScore: v.optional(v.float64()),
    actionTriggers: v.optional(v.array(v.string())),
    supersedesMemoryId: v.optional(v.id("crystalMemories")),
    supersededByMemoryId: v.optional(v.id("crystalMemories")),
    supersededAt: v.optional(v.number()),
    sourceSnapshotId: v.optional(v.id("crystalSnapshots")),
    knowledgeBaseId: v.optional(v.id("knowledgeBases")),
    scope: v.optional(v.string()),
    // Upsert-by-key for KB chunks: a caller-supplied stable key (e.g. a song
    // title) that identifies one logical chunk within a KB. Importing a chunk
    // with an existing (knowledgeBaseId, dedupeKey) replaces that chunk in place
    // instead of appending a duplicate.
    dedupeKey: v.optional(v.string()),
    contentHash: v.optional(v.string()),
    sourceMessageIds: v.optional(v.array(v.id("crystalMessages"))),
    summary: v.optional(v.string()),
    summaryCreatedAt: v.optional(v.number()),
    summarySource: v.optional(v.union(
      v.literal("baseline_reflection"),
      v.literal("organic_pulse"),
      v.literal("backfill"),
      v.literal("manual"),
      v.literal("imported")
    )),
    summaryModel: v.optional(v.string()),
    summaryCostUsd: v.optional(v.float64()),
    recallText: v.optional(v.string()),
    // Compact "telegraphic" recall form generated at extraction time; the read
    // side injects this when present and MEMORY_CRYSTAL_COMPACT_RECALL is on.
    // Chunk provenance tag: "content" == real memory content (default when
    // absent), "config" == config-header / source-mirror import chunk. Lets the
    // read side (and clients) drop low-value config chunks from recall.
    chunkKind: v.optional(v.string()),
    rawContentExpiresAt: v.optional(v.number()),
    rawContentWipedAt: v.optional(v.number()),
    contentWipedAt: v.optional(v.number()),
    contentTombstone: v.optional(v.string()),
    rawRetentionState: v.optional(v.union(
      v.literal("raw"),
      v.literal("summarized"),
      v.literal("wiped"),
      v.literal("wiped_without_summary"),
      v.literal("protected")
    )),
    sensoryRawTtlDaysApplied: v.optional(v.number()),
    embeddingSource: v.optional(v.union(
      v.literal("raw"),
      v.literal("summary"),
      v.literal("none")
    )),
    reflectionRunId: v.optional(v.id("crystalReflectionRuns")),
    // M2 — enrichment failure persistence
    enrichmentAttempts: v.optional(v.number()),
    enrichmentSkippedReason: v.optional(v.string()),
    // M4 — KB chunk fanout: true on the parent representative, false on non-parent chunks
    isKbParent: v.optional(v.boolean()),
  })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 3072,
      filterFields: ["userId", "archived", "knowledgeBaseId"],
    })
    .index("by_user", ["userId", "archived"])
    .index("by_store_category", ["userId", "store", "category", "archived"])
    .index("by_store_category_title", ["userId", "store", "category", "archived", "title"])
    .index("by_user_category_strength", ["userId", "category", "archived", "strength"])
    .index("by_strength", ["userId", "strength", "archived"])
    .index("by_user_strength", ["userId", "archived", "strength"])
    .index("by_last_accessed", ["userId", "lastAccessedAt"])
    .index("by_user_archived_last_accessed", ["userId", "archived", "lastAccessedAt"])
    .index("by_user_channel_archived_last_accessed", ["userId", "channel", "archived", "lastAccessedAt"])
    .index("by_session", ["sessionId"])
    .index("by_supersedes", ["supersedesMemoryId"])
    .index("by_superseded_by", ["supersededByMemoryId"])
    // archived + enrichmentSkippedReason live IN the index so the hourly
    // graph-backfill cron seeks straight to pending rows; a post-index
    // .filter() here re-reads every permanently-skipped row each tick
    // (2026-07-07 cost audit: ~11 GB/day of egress).
    .index("by_graph_enriched", ["graphEnriched", "userId", "archived", "enrichmentSkippedReason"])
    .index("by_user_archived_skip_reason", ["userId", "archived", "enrichmentSkippedReason"])
    .index("by_salience", ["userId", "salienceScore"])
    .index("by_store_archived_salience", ["userId", "store", "archived", "salienceScore"])
    .index("by_user_created", ["userId", "createdAt", "archived"])
    .index("by_store_archived_created", ["userId", "store", "archived", "createdAt"])
    .index("by_raw_retention_due", ["store", "archived", "rawRetentionState", "rawContentExpiresAt"])
    .index("by_user_raw_retention_due", ["userId", "store", "archived", "rawRetentionState", "rawContentExpiresAt"])
    .index("by_user_content_hash", ["userId", "contentHash", "archived"])
    .index("by_user_content_hash_channel", ["userId", "contentHash", "channel", "archived"])
    // Lazy recallText backfill: find memories still missing a compact recallText.
    .index("by_user_recall_text", ["userId", "recallText", "archived"])
    // Upsert-by-key: locate the existing chunk for a (KB, dedupeKey) pair.
    .index("by_kb_dedupe_key", ["knowledgeBaseId", "dedupeKey"])
    // knowledgeBaseId is a search filterField so KB-scoped BM25 lookups
    // (runKnowledgeBaseQuery → searchMemoriesByText) filter at the index
    // instead of over-fetching 4× full docs and post-filtering (2026-07-07
    // cost audit: each discarded candidate doc carries a ~24 KB embedding).
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["userId", "archived", "knowledgeBaseId"],
    })
    .searchIndex("search_recall_text", {
      searchField: "recallText",
      filterFields: ["userId", "archived", "knowledgeBaseId"],
    })
    .index("by_knowledge_base", ["knowledgeBaseId", "userId", "archived"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["userId", "archived", "knowledgeBaseId"],
    }),

  crystalMemoryCleanupIndex: defineTable({
    memoryId: v.id("crystalMemories"),
    userId: v.string(),
    store: memoryStore,
    category: memoryCategory,
    archived: v.boolean(),
    createdAt: v.number(),
    strength: v.float64(),
    lastAccessedAt: v.number(),
    knowledgeBaseId: v.optional(v.id("knowledgeBases")),
    rawContentExpiresAt: v.optional(v.number()),
    rawContentWipedAt: v.optional(v.number()),
    rawRetentionState: v.optional(v.union(
      v.literal("raw"),
      v.literal("summarized"),
      v.literal("wiped"),
      v.literal("wiped_without_summary"),
      v.literal("protected")
    )),
    sensoryRawTtlDaysApplied: v.optional(v.number()),
    hasSummary: v.boolean(),
    hasRecallText: v.boolean(),
    protectedSensoryCandidate: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_memory", ["memoryId"])
    .index("by_user_archived_created", ["userId", "archived", "createdAt"])
    .index("by_user_archived_store_created", ["userId", "archived", "store", "createdAt"])
    .index("by_user_sensory_due_state", ["userId", "store", "archived", "rawRetentionState", "rawContentExpiresAt"]),

  crystalCleanupProjectionState: defineTable({
    userId: v.string(),
    lastCreatedAt: v.number(),
    cursor: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // Opaque pagination cursors for rotating background jobs (e.g. the Organic
  // recallText backfill) so each tick resumes where the previous one stopped
  // instead of re-reading the whole profiles table every run.
  crystalJobCursors: defineTable({
    jobName: v.string(),
    cursor: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_job", ["jobName"]),

  crystalMemoryTriggers: defineTable({
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    toolName: v.string(),
    lastAccessedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_user_tool", ["userId", "toolName", "lastAccessedAt"])
    .index("by_user", ["userId", "lastAccessedAt"])
    .index("by_memory", ["memoryId"]),

  crystalAssociations: defineTable({
    fromMemoryId: v.id("crystalMemories"),
    toMemoryId: v.id("crystalMemories"),
    userId: v.optional(v.string()),
    relationshipType: v.union(
      v.literal("supports"),
      v.literal("contradicts"),
      v.literal("derives_from"),
      v.literal("co_occurred"),
      v.literal("generalizes"),
      v.literal("precedes")
    ),
    weight: v.float64(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_from", ["fromMemoryId"])
    .index("by_to", ["toMemoryId"])
    .index("by_user", ["userId"]),

  crystalNodes: defineTable({
    userId: v.string(),
    label: v.string(),
    nodeType: graphNodeType,
    alias: v.array(v.string()),
    canonicalKey: v.string(),
    description: v.string(),
    strength: v.float64(),
    confidence: v.float64(),
    tags: v.array(v.string()),
    metadata: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    sourceMemoryIds: v.array(v.id("crystalMemories")),
    status: graphNodeStatus,
  })
    .index("by_user", ["userId"])
    .index("by_user_canonical", ["userId", "canonicalKey"])
    .index("by_canonical_key", ["canonicalKey"])
    .index("by_node_type", ["nodeType"])
    .index("by_status", ["status"]),

  crystalRelations: defineTable({
    userId: v.string(),
    fromNodeId: v.id("crystalNodes"),
    toNodeId: v.id("crystalNodes"),
    relationType: graphRelationType,
    weight: v.float64(),
    evidenceMemoryIds: v.array(v.id("crystalMemories")),
    evidenceWindow: v.optional(
      v.object({
        from: v.optional(v.number()),
        to: v.optional(v.number()),
      })
    ),
    channels: v.array(v.string()),
    proofNote: v.optional(v.string()),
    confidence: v.float64(),
    confidenceReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    promotedFrom: v.optional(v.id("crystalRelations")),
  })
    .index("by_user", ["userId"])
    .index("by_from_node", ["fromNodeId"])
    .index("by_to_node", ["toNodeId"])
    .index("by_relation", ["relationType", "fromNodeId", "toNodeId"])
    .index("by_from_to_relation", ["fromNodeId", "toNodeId", "relationType"]),

  crystalMemoryNodeLinks: defineTable({
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    nodeId: v.id("crystalNodes"),
    role: graphLinkRole,
    linkConfidence: v.float64(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_memory", ["memoryId"])
    .index("by_node", ["nodeId"]),

  crystalSessions: defineTable({
    userId: v.optional(v.string()),
    channel: v.string(),
    channelId: v.optional(v.string()),
    startedAt: v.number(),
    lastActiveAt: v.number(),
    endedAt: v.optional(v.number()),
    messageCount: v.number(),
    memoryCount: v.number(),
    summary: v.optional(v.string()),
    participants: v.array(v.string()),
    model: v.optional(v.string()),
    checkpointId: v.optional(v.id("crystalCheckpoints")),
  })
    .index("by_user", ["userId", "lastActiveAt"])
    .index("by_user_channel", ["userId", "channel", "lastActiveAt"])
    .index("by_channel", ["channel", "lastActiveAt"]),

  crystalCheckpoints: defineTable({
    userId: v.string(),
    label: v.string(),
    description: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    sessionId: v.optional(v.id("crystalSessions")),
    memorySnapshot: v.array(
      v.object({
        memoryId: v.id("crystalMemories"),
        strength: v.float64(),
        content: v.string(),
        store: v.string(),
        title: v.optional(v.string()),
        category: v.optional(v.string()),
        source: v.optional(v.string()),
        tags: v.optional(v.array(v.string())),
        channel: v.optional(v.string()),
        sessionKey: v.optional(v.string()),
        createdAt: v.optional(v.number()),
        updatedAt: v.optional(v.number()),
        lastAccessedAt: v.optional(v.number()),
      })
    ),
    semanticSummary: v.string(),
    tags: v.array(v.string()),
    kind: v.optional(v.union(v.literal("memory_checkpoint"), v.literal("legacy_artifact"))),
    createdVia: v.optional(v.union(
      v.literal("dashboard"),
      v.literal("mcp"),
      v.literal("legacy_external"),
      v.literal("seed"),
      v.literal("migration")
    )),
    memoryCount: v.optional(v.number()),
    snapshotCap: v.optional(v.number()),
    snapshotByteLimit: v.optional(v.number()),
    sourceVersion: v.optional(v.number()),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_user_kind_created", ["userId", "kind", "createdAt"])
    .index("by_created", ["createdAt"]),

  crystalWakeState: defineTable({
    userId: v.optional(v.string()),
    sessionId: v.id("crystalSessions"),
    injectedMemoryIds: v.array(v.id("crystalMemories")),
    wakePrompt: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_session", ["sessionId"]),

  crystalMessages: defineTable({
    userId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    turnId: v.optional(v.string()),
    turnMessageIndex: v.optional(v.number()),
    timestamp: v.number(),
    embedding: v.optional(v.array(v.float64())),
    embedded: v.boolean(),
    expiresAt: v.number(),
    metadata: v.optional(v.string()),
    contentHash: v.optional(v.string()),
    dedupeScopeHash: v.optional(v.string()),
    dedupeCheckedAt: v.optional(v.number()),
    ltmExtractedAt: v.optional(v.number()),
    ltmExtractionSkippedReason: v.optional(v.string()),
    retirementQueuedAt: v.optional(v.number()),
    // Number of times retirement has been attempted for this message. Bounded by
    // MAX_RETIREMENT_ATTEMPTS: once reached, the message is force-retired (capsuled
    // + deleted) so a message that can never terminally LTM-process still drains
    // instead of churning forever.
    retirementAttempts: v.optional(v.number()),
    retiredAt: v.optional(v.number()),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_user_time", ["userId", "timestamp"])
    .index("by_channel_time", ["userId", "channel", "timestamp"])
    .index("by_session_time", ["userId", "sessionKey", "timestamp"])
    .index("by_user_content_hash", ["userId", "contentHash"])
    .index("by_user_content_hash_time", ["userId", "contentHash", "timestamp"])
    .index("by_user_dedupe_scope_hash_time", ["userId", "dedupeScopeHash", "timestamp"])
    .index("by_user_dedupe_checked_time", ["userId", "dedupeCheckedAt", "timestamp"])
    .index("by_message_dedupe_time", [
      "userId",
      "contentHash",
      "role",
      "channel",
      "sessionKey",
      "turnId",
      "turnMessageIndex",
      "timestamp",
    ])
    // Cheap (userId, turnId) lookups for idempotent turn-capture delivery
    // (POST /api/mcp/turn). Re-delivery of a known turnId is a no-op.
    .index("by_user_turn", ["userId", "turnId"])
    .index("by_user_ltm_extracted_time", ["userId", "ltmExtractedAt", "timestamp"])
    .index("by_user_embedded_time", ["userId", "embedded", "timestamp"])
    .index("by_embedded", ["embedded", "timestamp"])
    .index("by_expires", ["expiresAt"])
    // Retirement scan index. Lets expireOldMessages SEEK never-queued expired rows
    // (retirementQueuedAt == undefined && expiresAt <= now) and retryStuckRetirements
    // seek stale-queued rows (retirementQueuedAt in [1, retryBefore)), instead of
    // reading the entire expired range with a post-read .filter() — which re-scanned
    // the whole backlog on every self-scheduled pass (O(N^2) Database I/O).
    .index("by_retirement_queue", ["retirementQueuedAt", "expiresAt"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 3072,
      filterFields: ["userId", "channel", "role"],
    })
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["userId", "role"],
    }),

  crystalTelemetry: defineTable({
    userId: v.string(),
    kind: v.string(),
    sessionKey: v.optional(v.string()),
    channel: v.optional(v.string()),
    payload: v.string(),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
  })
    .index("by_user_kind", ["userId", "kind"])
    .index("by_user_kind_time", ["userId", "kind", "createdAt"])
    .index("by_user_time", ["userId", "createdAt"])
    .index("by_expires", ["expiresAt"]),

  crystalAssets: defineTable({
    userId: v.string(),
    kind: v.union(v.literal("image"), v.literal("audio"), v.literal("video"), v.literal("pdf"), v.literal("text")),
    modality: v.optional(assetModality),
    storageKey: v.string(),
    storageProvider: v.optional(assetStorageProvider),
    mimeType: v.string(),
    extension: v.optional(v.string()),
    originalFilenameHash: v.optional(v.string()),
    safeDisplayName: v.optional(v.string()),
    bytes: v.optional(v.number()),
    checksum: v.optional(v.string()),
    thumbnailKey: v.optional(v.string()),
    previewKey: v.optional(v.string()),
    status: v.optional(assetStatus),
    visibility: v.optional(v.union(v.literal("private"))),
    source: v.optional(assetSource),
    sourceMessageId: v.optional(v.id("crystalMessages")),
    sourceSessionId: v.optional(v.id("crystalSessions")),
    sourceMemoryId: v.optional(v.id("crystalMemories")),
    sourceMemoryIds: v.optional(v.array(v.id("crystalMemories"))),
    knowledgeBaseIds: v.optional(v.array(v.id("knowledgeBases"))),
    turnId: v.optional(v.string()),
    peerScope: v.optional(v.string()),
    extractedText: v.optional(v.string()),
    title: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    entities: v.optional(v.array(v.string())),
    processingMetadata: v.optional(v.string()),
    processingError: v.optional(v.string()),
    processingAttempts: v.optional(v.number()),
    derivedMemoryIds: v.optional(v.array(v.id("crystalMemories"))),
    embedding: v.optional(v.array(v.float64())),
    embedded: v.boolean(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    idempotencyKey: v.optional(v.string()),
    captureManifestId: v.optional(v.string()),
    sourceAttachmentId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    queuedAt: v.optional(v.number()),
    processedAt: v.optional(v.number()),
    softDeletedAt: v.optional(v.number()),
    hardDeletedAt: v.optional(v.number()),
    retentionUntil: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_kind", ["userId", "kind"])
    .index("by_user_channel", ["userId", "channel"])
    .index("by_user_status", ["userId", "status"])
    .index("by_user_modality", ["userId", "modality"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_user_session", ["userId", "sessionKey"])
    .index("by_user_message", ["userId", "sourceMessageId"])
    .index("by_user_memory", ["userId", "sourceMemoryId"])
    .index("by_user_checksum", ["userId", "checksum"])
    .index("by_user_idempotency", ["userId", "idempotencyKey"])
    .index("by_capture_manifest", ["userId", "captureManifestId"])
    .index("by_deletion_cleanup", ["status", "retentionUntil"])
    .index("by_user_embedded", ["userId", "embedded", "createdAt"])
    .index("by_embedded", ["embedded", "createdAt"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 3072,
      filterFields: ["userId", "kind"],
    })
    .searchIndex("search_transcript", {
      searchField: "transcript",
      filterFields: ["userId", "kind"],
    }),

  crystalAssetUsage: defineTable({
    userId: v.string(),
    usedBytes: v.number(),
    pendingDeletionBytes: v.number(),
    assetCount: v.optional(v.number()),
    failedCount: v.optional(v.number()),
    pendingDeletionCount: v.optional(v.number()),
    quotaBytesOverride: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  crystalAssetManifests: defineTable({
    manifestId: v.string(),
    userId: v.string(),
    sourceUserId: v.string(),
    targetUserId: v.string(),
    mode: v.union(v.literal("dry_run"), v.literal("apply")),
    selectedKnowledgeBaseIds: v.array(v.string()),
    selectedAssetIds: v.array(v.string()),
    privateKnowledgeBaseAllowlist: v.array(v.string()),
    peerKnowledgeBaseAllowlist: v.array(v.string()),
    idempotencyKeys: v.array(v.string()),
    sourceDigest: v.string(),
    status: v.union(v.literal("dry_run"), v.literal("approved"), v.literal("applied"), v.literal("expired")),
    createdAt: v.number(),
    expiresAt: v.number(),
    approvedAt: v.optional(v.number()),
  })
    .index("by_manifestId", ["manifestId"])
    .index("by_user_status", ["userId", "status"]),

  crystalDashboardTotals: defineTable({
    userId: v.string(),
    totalMemories: v.number(),
    activeMemories: v.number(),
    archivedMemories: v.number(),
    totalMessages: v.number(),
    enrichedMemories: v.optional(v.number()),
    graphEligiblePendingMemories: v.optional(v.number()),
    graphSkippedMemories: v.optional(v.number()),
    // M7 — Sum of strength values across all (active+archived) memories.
    // Optional because pre-M7 rows do not have it; backfill populates it.
    totalStrength: v.optional(v.number()),
    activeRecallCount: v.optional(v.number()),
    activeRecalledMemories: v.optional(v.number()),
    activeMemoriesByStore: v.object({
      sensory: v.number(),
      episodic: v.number(),
      semantic: v.number(),
      procedural: v.number(),
      prospective: v.number(),
    }),
    activeStoreCount: v.number(),
    lastCaptureMemoryId: v.optional(v.id("crystalMemories")),
    lastCaptureStore: v.optional(memoryStore),
    lastCaptureTitle: v.optional(v.string()),
    lastCaptureCreatedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  crystalUserProfiles: defineTable({
    userId: v.string(),
      v.literal("inactive"),
      v.literal("cancelled"),
      v.literal("trialing"),
      v.literal("unlimited")
    ),
    sensoryRawTtlDaysOverride: v.optional(v.number()),
    capacityPolicy: v.optional(v.union(
      v.literal("managed_free"),
      v.literal("managed_pro"),
      v.literal("managed_ultra"),
      v.literal("managed_unlimited"),
      v.literal("self_hosted_unmetered")
    )),
    entitlementSource: v.optional(v.union(
      v.literal("billing"),
      v.literal("admin"),
      v.literal("local_installer")
    )),
    entitlementExpiresAt: v.optional(v.number()),
    entitlementGraceEndsAt: v.optional(v.number()),
    entitlementRevokedAt: v.optional(v.number()),
    entitlementUpdatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])

  crystalReflectionRuns: defineTable({
    userId: v.string(),
    trigger: v.union(
      v.literal("cron"),
      v.literal("manual"),
      v.literal("organic_pulse"),
      v.literal("on_write"),
      v.literal("backfill_dry_run"),
      v.literal("backfill_execute"),
      v.literal("cleanup")
    ),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    tier: v.string(),
    sensoryRawTtlDays: v.optional(v.number()),
    summarized: v.number(),
    wiped: v.number(),
    wipedWithoutSummary: v.number(),
    skipped: v.number(),
    promoted: v.number(),
    archived: v.number(),
    errors: v.number(),
    estimatedCostUsd: v.float64(),
    costProvider: v.optional(v.string()),
    costModel: v.optional(v.string()),
    keySource: v.optional(v.union(
      v.literal("platform"),
      v.literal("user_byok"),
      v.literal("provider_export"),
      v.literal("manual"),
      v.literal("unknown"),
    )),
    payer: v.optional(v.union(v.literal("company"), v.literal("user"), v.literal("unknown"))),
    estimatedInputTokens: v.optional(v.float64()),
    estimatedOutputTokens: v.optional(v.float64()),
    memoryIds: v.optional(v.array(v.id("crystalMemories"))),
    samples: v.optional(v.array(v.object({
      memoryId: v.id("crystalMemories"),
      title: v.string(),
      action: v.string(),
      reason: v.optional(v.string()),
    }))),
    errorMessage: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    metadata: v.optional(v.string()),
  })
    .index("by_user_started", ["userId", "startedAt"])
    .index("by_started", ["startedAt"])
    .index("by_status_started", ["status", "startedAt"])
    .index("by_user_trigger_started", ["userId", "trigger", "startedAt"])
    .index("by_user_tier_started", ["userId", "tier", "startedAt"]),

  crystalApiKeys: defineTable({
    userId: v.string(),
    keyHash: v.string(),
    label: v.optional(v.string()),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    active: v.boolean(),
    expiresAt: v.optional(v.number()), // Unix ms timestamp, null = never expires
  })
    .index("by_user", ["userId"])
    .index("by_key_hash", ["keyHash"]),

  crystalDeviceAuth: defineTable({
    deviceCode: v.string(),
    userCode: v.string(),
    status: v.union(v.literal("pending"), v.literal("complete"), v.literal("expired")),
    apiKey: v.optional(v.string()),
    userId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_device_code", ["deviceCode"])
    .index("by_user_code", ["userCode"]),

  crystalRateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  crystalAuditLog: defineTable({
    userId: v.string(),
    keyHash: v.string(),
    action: v.string(), // "capture", "recall", "forget", "checkpoint", etc.
    ts: v.number(),
    actorUserId: v.optional(v.string()),
    effectiveUserId: v.optional(v.string()),
    targetUserId: v.optional(v.string()),
    targetType: v.optional(v.string()),
    targetId: v.optional(v.string()),
    meta: v.optional(v.string()), // JSON string with extra info (memory id, query, etc.)
  })
    .index("by_user", ["userId", "ts"])
    .index("by_user_action_time", ["userId", "action", "ts"])
    .index("by_key", ["keyHash", "ts"]),

  crystalImpersonationSessions: defineTable({
    actorUserId: v.string(),
    targetUserId: v.string(),
    reason: v.optional(v.string()),
    startedAt: v.number(),
    expiresAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    active: v.boolean(),
  })
    .index("by_actor", ["actorUserId", "startedAt"])
    .index("by_actor_active", ["actorUserId", "active"]),

  crystalStatsCache: defineTable({
    userId: v.string(),
    computedAt: v.number(),
    totalMemories: v.number(),
    graphEnrichedCount: v.number(),
    graphEnrichedPercent: v.number(),
    staleCount30d: v.number(),
    staleCount60d: v.number(),
    staleCount90d: v.number(),
    neverRecalledCount: v.number(),
    neverRecalledPercent: v.number(),
    avgStrength: v.number(),
    totalAccessCount: v.number(),
    avgRecallsPerMemory: v.number(),
    recallSummaryComputedAt: v.optional(v.number()),
    recallSummaryWindowStartMs: v.optional(v.number()),
    recallSummaryWindowDays: v.optional(v.number()),
    recentMemoryRecallEvents: v.optional(v.number()),
    recentActiveMemoryRecallEvents: v.optional(v.number()),
    recentRetrievalEventCount: v.optional(v.number()),
    scannedSample: v.number(),
    byStore: v.object({
      sensory: v.number(),
      episodic: v.number(),
      semantic: v.number(),
      procedural: v.number(),
      prospective: v.number(),
    }),
  }).index("by_user", ["userId"]),

  crystalEmailTemplates: defineTable({
    slug: v.string(),
    subject: v.string(),
    htmlBody: v.string(),
    textBody: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  }).index("by_slug", ["slug"]),

  crystalEmailLog: defineTable({
    userId: v.string(),
    email: v.string(),
    templateSlug: v.string(),
    subject: v.string(),
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("skipped")),
    error: v.optional(v.string()),
    sentAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_template_slug", ["templateSlug"])
    .index("by_sent_at", ["sentAt"]),

  crystalDryRunEmails: defineTable({
    to: v.string(),
    subject: v.string(),
    body: v.string(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  crystalSnapshots: defineTable({
    userId: v.string(),
    sessionKey: v.optional(v.string()),
    channel: v.optional(v.string()),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        timestamp: v.optional(v.number()),
      })
    ),
    messageCount: v.number(),
    totalTokens: v.number(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_session", ["userId", "sessionKey", "createdAt"]),

  // ── Knowledge Bases ────────────────────────────────────────────────

  knowledgeBases: defineTable({
    userId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    agentIds: v.optional(v.array(v.string())),
    scope: v.optional(v.string()),
    sourceType: v.optional(v.string()),
    sourceRole: v.optional(v.string()),
    isActive: v.boolean(),
    memoryCount: v.number(),
    totalChars: v.optional(v.number()),
    peerScopePolicy: v.optional(v.union(v.literal("strict"), v.literal("permissive"))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_scope", ["userId", "scope"])
    .index("by_user_active", ["userId", "isActive"]),

  crystalKbCopyMemoryMaps: defineTable({
    idempotencyKey: v.string(),
    sourceUserId: v.string(),
    targetUserId: v.string(),
    sourceKnowledgeBaseId: v.string(),
    targetKnowledgeBaseId: v.id("knowledgeBases"),
    sourceMemoryId: v.string(),
    targetMemoryId: v.id("crystalMemories"),
    createdAt: v.number(),
  })
    .index("by_run", ["idempotencyKey", "sourceKnowledgeBaseId"])
    .index("by_source_memory", ["idempotencyKey", "sourceMemoryId"])
    .index("by_target_memory", ["idempotencyKey", "targetMemoryId"]),

  crystalKbCopyNodeMaps: defineTable({
    idempotencyKey: v.string(),
    sourceUserId: v.string(),
    targetUserId: v.string(),
    sourceNodeId: v.string(),
    targetNodeId: v.id("crystalNodes"),
    createdAt: v.number(),
  })
    .index("by_run", ["idempotencyKey"])
    .index("by_source_node", ["idempotencyKey", "sourceNodeId"]),

  crystalKnowledgeBaseLifecycleJobs: defineTable({
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
    operation: v.union(v.literal("archive"), v.literal("delete"), v.literal("reindex"), v.literal("recount")),
    status: v.union(
      v.literal("queued"), v.literal("running"), v.literal("paused"),
      v.literal("completed"), v.literal("failed"), v.literal("cancelled")
    ),
    cursor: v.optional(v.string()),
    processedCount: v.number(),
    totalChars: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_user_kb_operation", ["userId", "knowledgeBaseId", "operation", "createdAt"])
    .index("by_status_updated", ["status", "updatedAt"]),

  // ── Research and Experiment Plane ─────────────────────────────────

  crystalResearchCollections: defineTable({
    userId: v.string(),
    workspaceId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    visibility: v.union(v.literal("private"), v.literal("scoped")),
    name: v.string(),
    domain: v.string(),
    description: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("archived")),
    retentionPolicy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_status_updated", ["userId", "status", "updatedAt"])
    .index("by_user_workspace_updated", ["userId", "workspaceId", "updatedAt"])
    .index("by_user_updated", ["userId", "updatedAt"]),

  crystalResearchCounterShards: defineTable({
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    shard: v.number(),
    sources: v.number(),
    artifacts: v.number(),
    items: v.number(),
    variants: v.number(),
    datasets: v.number(),
    runs: v.number(),
    jobs: v.number(),
    rejected: v.number(),
    quarantined: v.number(),
    artifactBytes: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_collection_shard", ["collectionId", "shard"])
    .index("by_user_collection", ["userId", "collectionId"]),

  crystalResearchSources: defineTable({
    userId: v.string(),
    workspaceId: v.optional(v.string()),
    collectionId: v.id("crystalResearchCollections"),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    visibility: v.union(v.literal("private"), v.literal("scoped")),
    stableKey: v.string(),
    idempotencyKey: v.string(),
    sourceType: v.string(),
    host: v.string(),
    canonicalUrl: v.optional(v.string()),
    repositoryOwner: v.optional(v.string()),
    repositoryName: v.optional(v.string()),
    immutableVersion: v.optional(v.string()),
    filePath: v.optional(v.string()),
    retrievedAt: v.number(),
    contentHash: v.string(),
    licenseId: v.optional(v.string()),
    licenseDisposition: v.union(
      v.literal("pending"), v.literal("acceptable"), v.literal("restricted"),
      v.literal("rejected"), v.literal("unknown")
    ),
    securityDisposition: v.union(
      v.literal("pending"), v.literal("clean"), v.literal("suspicious"),
      v.literal("malicious"), v.literal("rejected")
    ),
    quarantineState: v.union(v.literal("quarantined"), v.literal("released"), v.literal("rejected")),
    parserVersion: v.string(),
    rejectionReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_collection_stable_key", ["collectionId", "stableKey"])
    .index("by_collection_idempotency", ["collectionId", "idempotencyKey"])
    .index("by_collection_updated", ["collectionId", "updatedAt"])
    .index("by_collection_license", ["collectionId", "licenseDisposition", "updatedAt"])
    .index("by_collection_security", ["collectionId", "securityDisposition", "updatedAt"])
    .index("by_user_collection", ["userId", "collectionId"]),

  crystalResearchArtifacts: defineTable({
    userId: v.string(),
    workspaceId: v.optional(v.string()),
    collectionId: v.id("crystalResearchCollections"),
    sourceId: v.optional(v.id("crystalResearchSources")),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    visibility: v.union(v.literal("private"), v.literal("scoped")),
    stableKey: v.string(),
    idempotencyKey: v.string(),
    artifactType: v.string(),
    storageId: v.optional(v.id("_storage")),
    checksum: v.string(),
    mimeType: v.string(),
    compressedBytes: v.number(),
    uncompressedBytes: v.optional(v.number()),
    status: v.union(
      v.literal("prepared"), v.literal("uploaded"), v.literal("accepted"),
      v.literal("rejected"), v.literal("quarantined")
    ),
    rejectionReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_collection_stable_key", ["collectionId", "stableKey"])
    .index("by_collection_status", ["collectionId", "status", "updatedAt"])
    .index("by_source", ["sourceId", "updatedAt"])
    .index("by_user_collection", ["userId", "collectionId"]),

  crystalResearchItems: defineTable({
    userId: v.string(),
    workspaceId: v.optional(v.string()),
    collectionId: v.id("crystalResearchCollections"),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    visibility: v.union(v.literal("private"), v.literal("scoped")),
    stableKey: v.string(),
    idempotencyKey: v.string(),
    itemType: v.string(),
    contentHash: v.string(),
    ruleHash: v.string(),
    normalizedRuleJson: v.string(),
    strategyCard: v.string(),
    sourceIds: v.array(v.id("crystalResearchSources")),
    indicators: v.array(v.string()),
    entries: v.array(v.string()),
    exits: v.array(v.string()),
    riskControls: v.array(v.string()),
    directions: v.array(v.string()),
    markets: v.array(v.string()),
    assets: v.array(v.string()),
    timeframes: v.array(v.string()),
    causalTimestampPolicy: v.string(),
    parserVersion: v.string(),
    reviewStatus: v.union(
      v.literal("pending"), v.literal("reviewed"), v.literal("qualified"),
      v.literal("rejected"), v.literal("deprecated")
    ),
    securityStatus: v.union(v.literal("pending"), v.literal("clean"), v.literal("quarantined"), v.literal("rejected")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_collection_stable_key", ["collectionId", "stableKey"])
    .index("by_collection_content_hash", ["collectionId", "contentHash"])
    .index("by_collection_type_status", ["collectionId", "itemType", "reviewStatus", "updatedAt"])
    .index("by_collection_review", ["collectionId", "reviewStatus", "updatedAt"])
    .index("by_user_collection", ["userId", "collectionId"])
    .searchIndex("search_strategy_card", {
      searchField: "strategyCard",
      filterFields: ["userId", "collectionId", "reviewStatus", "securityStatus"],
    }),

  crystalResearchItemEmbeddings: defineTable({
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    scopeKey: v.string(),
    itemId: v.id("crystalResearchItems"),
    contentHash: v.string(),
    model: v.string(),
    embedding: v.array(v.float64()),
    createdAt: v.number(),
  })
    .index("by_content_model", ["contentHash", "model"])
    .index("by_item_model", ["itemId", "model"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 3072,
      filterFields: ["scopeKey"],
    }),

  crystalResearchVariants: defineTable({
    userId: v.string(),
    workspaceId: v.optional(v.string()),
    collectionId: v.id("crystalResearchCollections"),
    itemId: v.id("crystalResearchItems"),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    visibility: v.union(v.literal("private"), v.literal("scoped")),
    stableKey: v.string(),
    idempotencyKey: v.string(),
    parameterJson: v.string(),
    parameterHash: v.string(),
    market: v.string(),
    venue: v.optional(v.string()),
    symbol: v.string(),
    timeframe: v.string(),
    direction: v.string(),
    executionAssumptionsJson: v.string(),
    variantHash: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_collection_stable_key", ["collectionId", "stableKey"])
    .index("by_user_collection", ["userId", "collectionId", "updatedAt"])
    .index("by_item_variant_hash", ["itemId", "variantHash"])
    .index("by_collection_market", ["collectionId", "market", "timeframe", "updatedAt"]),

  crystalResearchDatasets: defineTable({
    userId: v.string(),
    workspaceId: v.optional(v.string()),
    collectionId: v.id("crystalResearchCollections"),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    visibility: v.union(v.literal("private"), v.literal("scoped")),
    stableKey: v.string(),
    idempotencyKey: v.string(),
    provider: v.string(),
    venue: v.optional(v.string()),
    symbols: v.array(v.string()),
    resolution: v.string(),
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    retrievedAt: v.number(),
    checksum: v.string(),
    adjustmentPolicy: v.string(),
    missingDataPolicy: v.string(),
    timezonePolicy: v.string(),
    causalityStatus: v.union(v.literal("pending"), v.literal("valid"), v.literal("invalid")),
    artifactId: v.optional(v.id("crystalResearchArtifacts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_collection_stable_key", ["collectionId", "stableKey"])
    .index("by_user_collection", ["userId", "collectionId", "updatedAt"])
    .index("by_collection_provider", ["collectionId", "provider", "resolution", "updatedAt"])
    .index("by_collection_checksum", ["collectionId", "checksum"]),

  crystalResearchRuns: defineTable({
    userId: v.string(),
    workspaceId: v.optional(v.string()),
    collectionId: v.id("crystalResearchCollections"),
    itemId: v.id("crystalResearchItems"),
    variantId: v.id("crystalResearchVariants"),
    datasetId: v.id("crystalResearchDatasets"),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    visibility: v.union(v.literal("private"), v.literal("scoped")),
    runSpecHash: v.string(),
    idempotencyKey: v.string(),
    engineVersion: v.string(),
    codeVersion: v.string(),
    fold: v.optional(v.string()),
    seed: v.optional(v.number()),
    splitJson: v.string(),
    costAssumptionsJson: v.string(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    status: v.union(
      v.literal("queued"), v.literal("running"), v.literal("completed"),
      v.literal("failed"), v.literal("rejected"), v.literal("cancelled")
    ),
    netReturn: v.optional(v.float64()),
    sharpe: v.optional(v.float64()),
    maxDrawdown: v.optional(v.float64()),
    winRate: v.optional(v.float64()),
    tradeCount: v.optional(v.number()),
    rankingScore: v.optional(v.float64()),
    robustnessScore: v.optional(v.float64()),
    metricsJson: v.string(),
    failureReason: v.optional(v.string()),
    artifactIds: v.array(v.id("crystalResearchArtifacts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_collection_run_spec", ["collectionId", "runSpecHash"])
    .index("by_user_collection", ["userId", "collectionId", "createdAt"])
    .index("by_collection_idempotency", ["collectionId", "idempotencyKey"])
    .index("by_collection_status_score", ["collectionId", "status", "rankingScore"])
    .index("by_collection_status_updated", ["collectionId", "status", "updatedAt"])
    .index("by_variant_status", ["variantId", "status", "updatedAt"])
    .index("by_dataset_status", ["datasetId", "status", "updatedAt"])
    .index("by_item_status", ["itemId", "status", "updatedAt"]),

  crystalResearchRollups: defineTable({
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    dimensionType: v.string(),
    dimensionKey: v.string(),
    methodologyVersion: v.string(),
    runCount: v.number(),
    survivedCount: v.number(),
    qualifiedCount: v.number(),
    failedCount: v.number(),
    aggregateJson: v.string(),
    score: v.optional(v.float64()),
    updatedAt: v.number(),
  })
    .index("by_collection_dimension", ["collectionId", "dimensionType", "dimensionKey", "methodologyVersion"])
    .index("by_user_collection", ["userId", "collectionId", "updatedAt"])
    .index("by_collection_dimension_score", ["collectionId", "dimensionType", "score"]),

  crystalResearchJobs: defineTable({
    userId: v.string(),
    workspaceId: v.optional(v.string()),
    collectionId: v.id("crystalResearchCollections"),
    agentId: v.optional(v.string()),
    channel: v.optional(v.string()),
    visibility: v.union(v.literal("private"), v.literal("scoped")),
    jobType: v.string(),
    idempotencyKey: v.string(),
    manifestJson: v.string(),
    status: v.union(
      v.literal("queued"), v.literal("running"), v.literal("paused"),
      v.literal("completed"), v.literal("failed"), v.literal("cancelled"), v.literal("dead_letter")
    ),
    totalCount: v.number(),
    preparedCount: v.number(),
    importedCount: v.number(),
    rejectedCount: v.number(),
    quarantinedCount: v.number(),
    failedCount: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_collection_idempotency", ["collectionId", "idempotencyKey"])
    .index("by_collection_status_updated", ["collectionId", "status", "updatedAt"])
    .index("by_user_status_updated", ["userId", "status", "updatedAt"]),

  crystalResearchJobShards: defineTable({
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    jobId: v.id("crystalResearchJobs"),
    shardKey: v.string(),
    ordinal: v.number(),
    status: v.union(
      v.literal("queued"), v.literal("leased"), v.literal("completed"),
      v.literal("failed"), v.literal("dead_letter"), v.literal("cancelled")
    ),
    cursor: v.optional(v.string()),
    leaseOwner: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    heartbeatAt: v.optional(v.number()),
    attempts: v.number(),
    maxAttempts: v.number(),
    progressCount: v.number(),
    totalCount: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_job_shard", ["jobId", "shardKey"])
    .index("by_user_collection", ["userId", "collectionId", "createdAt"])
    .index("by_job_status_ordinal", ["jobId", "status", "ordinal"])
    .index("by_status_lease", ["status", "leaseExpiresAt"]),

  crystalResearchIngestRecords: defineTable({
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    jobId: v.id("crystalResearchJobs"),
    shardId: v.id("crystalResearchJobShards"),
    recordType: v.string(),
    idempotencyKey: v.string(),
    payloadJson: v.string(),
    status: v.union(v.literal("prepared"), v.literal("imported"), v.literal("rejected"), v.literal("quarantined")),
    rejectionReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_job_idempotency", ["jobId", "idempotencyKey"])
    .index("by_shard_status", ["shardId", "status", "createdAt"]),

  crystalResearchPromotions: defineTable({
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    itemId: v.id("crystalResearchItems"),
    runId: v.id("crystalResearchRuns"),
    datasetId: v.id("crystalResearchDatasets"),
    knowledgeBaseId: v.id("knowledgeBases"),
    memoryId: v.optional(v.id("crystalMemories")),
    dedupeKey: v.string(),
    status: v.union(v.literal("promoted"), v.literal("demoted")),
    reason: v.string(),
    paperTradingState: v.union(v.literal("ineligible"), v.literal("eligible"), v.literal("active"), v.literal("stopped")),
    lineageJson: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_collection_dedupe", ["collectionId", "dedupeKey"])
    .index("by_user_collection", ["userId", "collectionId", "updatedAt"])
    .index("by_collection_status", ["collectionId", "status", "updatedAt"])
    .index("by_item", ["itemId", "updatedAt"]),

  crystalResearchRelations: defineTable({
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    fromType: v.string(),
    fromId: v.string(),
    relationType: v.string(),
    toType: v.string(),
    toId: v.string(),
    deterministicKey: v.string(),
    evidenceJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_collection_key", ["collectionId", "deterministicKey"])
    .index("by_from", ["collectionId", "fromType", "fromId", "relationType"])
    .index("by_to", ["collectionId", "toType", "toId", "relationType"]),

  crystalResearchRejections: defineTable({
    userId: v.string(),
    collectionId: v.id("crystalResearchCollections"),
    entityType: v.string(),
    idempotencyKey: v.string(),
    payloadHash: v.optional(v.string()),
    reason: v.string(),
    securityDisposition: v.optional(v.string()),
    licenseDisposition: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_collection_created", ["collectionId", "createdAt"])
    .index("by_collection_idempotency", ["collectionId", "idempotencyKey"]),

  // ── User provider settings ────────────────────────────────────────

  userProviderSettings: defineTable({
    userId: v.string(),
    provider: v.union(v.literal("openrouter")),
    apiKey: v.string(),
    keyPrefix: v.string(),
    keyLast4: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_provider", ["userId", "provider"]),

  crystalGraphEnrichmentSettings: defineTable({
    userId: v.string(),
    hourlySuccessCap: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // ── Organic Memory tables ──────────────────────────────────────────

  organicActivityLog: defineTable({
    userId: v.string(),
    eventType: v.union(
      v.literal("memory_stored"),
      v.literal("memory_recalled"),
      v.literal("memory_expired"),
      v.literal("memory_archived")
    ),
    memoryId: v.id("crystalMemories"),
    timestamp: v.number(),
    metadata: v.optional(v.string()),
  })
    .index("by_user_time", ["userId", "timestamp"])
    .index("by_user_event", ["userId", "eventType", "timestamp"])
    .index("by_memory", ["memoryId"])
    .index("by_timestamp", ["timestamp"]),

  organicProspectiveTraces: defineTable({
    userId: v.string(),
    createdAt: v.number(),
    tickId: v.string(),
    predictedQuery: v.string(),
    predictedContext: v.string(),
    traceType: v.union(
      v.literal("query"),
      v.literal("context"),
      v.literal("contradiction"),
      v.literal("action"),
      v.literal("resonance")
    ),
    confidence: v.float64(),
    expiresAt: v.number(),
    validated: v.union(v.boolean(), v.null()),
    validatedAt: v.optional(v.number()),
    sourceMemoryIds: v.array(v.id("crystalMemories")),
    sourcePattern: v.string(),
    accessCount: v.number(),
    usefulness: v.float64(),
    nodeId: v.optional(v.string()),
    orchestratorId: v.optional(v.string()),
    resonanceCluster: v.optional(v.string()),
    // Trace v2: document-style matching
    documentDescription: v.optional(v.string()),
    documentEmbedding: v.optional(v.array(v.float64())),
    matchThreshold: v.optional(v.float64()),
    recallCoverage: v.optional(v.float64()),
  })
    .index("by_user", ["userId"])
    .index("by_user_expires", ["userId", "expiresAt"])
    .index("by_user_validated", ["userId", "validated"])
    .index("by_user_type", ["userId", "traceType"])
    .index("by_tick", ["tickId"])
    .index("by_expires", ["expiresAt"])
    .searchIndex("search_predicted_query", {
      searchField: "predictedQuery",
      filterFields: ["userId"],
    })
    .vectorIndex("by_document_embedding", {
      vectorField: "documentEmbedding",
      dimensions: 3072,
      filterFields: ["userId", "traceType"],
    }),

  organicEnsembles: defineTable({
    userId: v.string(),
    ensembleType: v.union(
      v.literal("cluster"),
      v.literal("motif"),
      v.literal("conflict_group"),
      v.literal("trajectory"),
      v.literal("project_arc")
    ),
    label: v.string(),
    summary: v.string(),
    memberMemoryIds: v.array(v.id("crystalMemories")),
    centroidEmbedding: v.array(v.float64()),
    strength: v.float64(),
    confidence: v.float64(),
    metadata: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastTickId: v.optional(v.string()),
    archived: v.boolean(),
  })
    .index("by_user", ["userId", "archived"])
    .index("by_user_type", ["userId", "ensembleType", "archived"])
    .index("by_updated", ["userId", "updatedAt"])
    .vectorIndex("by_centroid", {
      vectorField: "centroidEmbedding",
      dimensions: 3072,
      filterFields: ["userId", "ensembleType", "archived"],
    }),

  organicEnsembleMemberships: defineTable({
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    ensembleId: v.id("organicEnsembles"),
    addedAt: v.number(),
    joinedAt: v.optional(v.number()),
  })
    .index("by_memory", ["memoryId"])
    .index("by_ensemble", ["ensembleId"])
    .index("by_user", ["userId"])
    .index("by_user_memory", ["userId", "memoryId"]),

  organicAlertBudget: defineTable({
    userId: v.string(),
    date: v.string(),
    contradictionsFired: v.number(),
    resonancesFired: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_date", ["userId", "date"]),

  digestLease: defineTable({
    leaseHolderAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
  }),

  organicTickState: defineTable({
    userId: v.string(),
    lastTickAt: v.number(),
    lastTickId: v.string(),
    tickCount: v.number(),
    totalTracesGenerated: v.number(),
    totalTracesValidated: v.number(),
    hitRate: v.float64(),
    enabled: v.boolean(),
    pulseMode: v.optional(v.union(
      v.literal("live"),
      v.literal("on_write"),
      v.literal("interval")
    )),
    onWritePendingAt: v.optional(v.number()),
    tickIntervalMs: v.number(),
    updatedAt: v.number(),
    isRunning: v.optional(v.boolean()),
    leaseExpiresAt: v.optional(v.number()),
    organicModel: v.optional(v.string()),
    // Notification preferences
    notificationEmail: v.optional(v.boolean()),
    notificationEmailDelay: v.optional(v.number()),
    ideaFrequency: v.optional(v.union(
      v.literal("aggressive"),
      v.literal("balanced"),
      v.literal("conservative")
    )),
    lastIdeaNotificationAt: v.optional(v.number()),
    lastPolicyTuneAt: v.optional(v.number()),
    lastSkipReason: v.optional(v.string()),
    lastSkippedAt: v.optional(v.number()),
    lastEnsembleTickAt: v.optional(v.number()),
    lastEnsembleMemoryCount: v.optional(v.number()),
    // Warm cache: pre-fetched memory IDs for fast recall
    warmCacheMemoryIds: v.optional(v.array(v.string())),
    warmCacheExpiresAt: v.optional(v.number()),
    openrouterApiKey: v.optional(v.string()),
    // BYOK: user-provided Gemini API key (Ultra tier only)
    geminiApiKey: v.optional(v.string()),
    // User-set daily Gemini call cap (Ultra tier only; null = use tier default)
    geminiDailyCap: v.optional(v.number()),
    // Rolling 24h USD spend cap for the organic engine. When set, processUserTick
    // will skip runs whose current 24h spend has already hit the cap, preventing
    // Live-mode (0ms tick) users from burning unbounded LLM budget on the shared key.
    dailySpendCapUsd: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_enabled", ["enabled"]),

  organicTickRuns: defineTable({
    userId: v.string(),
    tickId: v.string(),
    triggerSource: v.union(
      v.literal("scheduled"),
      v.literal("manual"),
      v.literal("conversation"),
      v.literal("memory_write")
    ),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    tickIntervalMs: v.number(),
    previousTickAt: v.number(),
    tracesGenerated: v.number(),
    tracesValidated: v.number(),
    tracesExpired: v.number(),
    ensemblesCreated: v.number(),
    ensemblesUpdated: v.number(),
    ensemblesArchived: v.number(),
    phase1VectorSearches: v.optional(v.number()),
    phase2VectorSearches: v.optional(v.number()),
    phase2Skipped: v.optional(v.boolean()),
    ensembleBudgetExhausted: v.optional(v.boolean()),
    ensembleSkippedReason: v.optional(v.string()),
    contradictionChecks: v.number(),
    contradictionsFound: v.number(),
    resonanceChecks: v.number(),
    resonancesFound: v.number(),
    ideasCreated: v.optional(v.number()),
    estimatedInputTokens: v.number(),
    estimatedOutputTokens: v.number(),
    estimatedCostUsd: v.float64(),
    keySource: v.optional(v.union(
      v.literal("platform"),
      v.literal("user_byok"),
      v.literal("provider_export"),
      v.literal("manual"),
      v.literal("unknown"),
    )),
    payer: v.optional(v.union(v.literal("company"), v.literal("user"), v.literal("unknown"))),
    errorMessage: v.optional(v.string()),
    fibers: v.optional(v.array(v.object({
      fiberId: v.string(),
      fiberType: v.union(
        v.literal("prediction"),
        v.literal("discovery"),
        v.literal("procedural"),
        v.literal("security"),
        v.literal("warm_cache")
      ),
      startedAt: v.number(),
      completedAt: v.optional(v.number()),
      tracesGenerated: v.optional(v.number()),
      ideasGenerated: v.optional(v.number()),
      error: v.optional(v.string()),
    }))),
    // Phase 1 traces instrumentation — bucketed counts of active (non-validated, non-expired)
    // traces by age at finalize time. Buckets: [0-1h, 1-6h, 6-24h, 24-72h]
    activeTraceAgeBuckets: v.optional(v.array(v.number())),
  })
    .index("by_user_started", ["userId", "startedAt"])
    .index("by_user_status_started", ["userId", "status", "startedAt"])
    .index("by_started", ["startedAt"])
    .index("by_tick", ["tickId"]),

  organicIdeas: defineTable({
    userId: v.string(),
    title: v.string(),
    summary: v.string(),
    ideaType: v.union(
      v.literal("connection"),
      v.literal("pattern"),
      v.literal("contradiction_resolved"),
      v.literal("insight"),
      v.literal("action_suggested"),
      v.literal("skill_suggestion")
    ),
    sourceMemoryIds: v.array(v.id("crystalMemories")),
    sourceEnsembleIds: v.optional(v.array(v.id("organicEnsembles"))),
    confidence: v.float64(),
    status: v.union(
      v.literal("pending_notification"),
      v.literal("notified"),
      v.literal("read"),
      v.literal("dismissed"),
      v.literal("starred")
    ),
    notifiedAt: v.optional(v.number()),
    emailDigestSentAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    dismissedAt: v.optional(v.number()),
    starredAt: v.optional(v.number()),
    pulseId: v.string(),
    fiberId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_user_type", ["userId", "ideaType", "status"])
    .searchIndex("search_ideas", {
      searchField: "summary",
      filterFields: ["userId", "ideaType", "status"],
    }),

  organicSkillSuggestions: defineTable({
    userId: v.string(),
    skillName: v.string(),
    description: v.string(),
    content: v.string(),
    evidence: v.array(v.object({
      type: v.union(
        v.literal("recall_failure"),
        v.literal("pattern_cluster"),
        v.literal("procedural_gap")
      ),
      memoryId: v.optional(v.string()),
      query: v.optional(v.string()),
      detail: v.string(),
    })),
    confidence: v.float64(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("modified"),
      v.literal("dismissed")
    ),
    generation: v.number(),
    ideaId: v.optional(v.id("organicIdeas")),
    activatedMemoryId: v.optional(v.id("crystalMemories")),
    acceptedAt: v.optional(v.number()),
    dismissedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_user_created", ["userId", "createdAt"]),

  organicRecallPolicies: defineTable({
    userId: v.string(),
    vectorWeight: v.float64(),
    strengthWeight: v.float64(),
    freshnessWeight: v.float64(),
    accessWeight: v.float64(),
    salienceWeight: v.float64(),
    continuityWeight: v.float64(),
    textMatchWeight: v.float64(),
    knowledgeBaseWeight: v.optional(v.float64()),
    sourceRoleWeight: v.optional(v.float64()),
    projectWeight: v.optional(v.float64()),
    personalWeight: v.optional(v.float64()),
    generation: v.number(),
    compositeScore: v.optional(v.float64()),
    evaluatedAt: v.optional(v.number()),
    promotedAt: v.optional(v.number()),
    parentGeneration: v.optional(v.number()),
    status: v.union(
      v.literal("candidate"),
      v.literal("evaluating"),
      v.literal("active"),
      v.literal("rejected"),
      v.literal("superseded")
    ),
    locked: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_user_generation", ["userId", "generation"]),

  organicReplayReports: defineTable({
    userId: v.string(),
    sampleCount: v.number(),
    groundingScore: v.float64(),
    coverageScore: v.float64(),
    precisionScore: v.float64(),
    compositeScore: v.float64(),
    worstQueries: v.array(v.object({
      query: v.string(),
      score: v.float64(),
      reason: v.string(),
    })),
    policyGeneration: v.number(),
    generationDelta: v.optional(v.float64()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId", "createdAt"]),

  organicRecallLog: defineTable({
    userId: v.string(),
    query: v.string(),
    resultCount: v.number(),
    topResultIds: v.array(v.id("crystalMemories")),
    candidateSignals: v.optional(v.array(v.object({
      memoryId: v.id("crystalMemories"),
      strength: v.float64(),
      confidence: v.float64(),
      accessCount: v.number(),
      lastAccessedAt: v.optional(v.number()),
      createdAt: v.number(),
      salienceScore: v.optional(v.float64()),
      vectorScore: v.optional(v.float64()),
      textMatchScore: v.optional(v.float64()),
    }))),
    traceHit: v.optional(v.boolean()),
    traceId: v.optional(v.id("organicProspectiveTraces")),
    source: v.string(),
    sessionKey: v.optional(v.string()),
    policyGeneration: v.optional(v.number()),
    createdAt: v.number(),
    // Phase 1 traces instrumentation — optional, behavior-preserving
    tracesMatchedRaw: v.optional(v.number()),
    tracesAboveThreshold: v.optional(v.number()),
    topTraceVectorScore: v.optional(v.number()),
    tracesSurvivedMerge: v.optional(v.number()),
    activeTracesForUser: v.optional(v.number()),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_created", ["createdAt"])
    .index("by_user_trace", ["userId", "traceHit"]),

  organicRecallStats: defineTable({
    userId: v.string(),
    totalQueries: v.number(),
    traceHits: v.number(),
    totalResultCount: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // ── Gemini API daily usage guardrail ──────────────────────────────
  // One row per (userId, UTC calendar day). Enforces tier-aware per-user
  // daily caps so a single heavy user cannot starve other tenants on the
  // shared counter. `userId` is optional for backwards compatibility with
  // the pre-2026-04-11 global-counter schema; those legacy rows age out
  // naturally after one day.
  crystalGeminiDailyUsage: defineTable({
    userId: v.optional(v.string()),
    dateKey: v.string(),        // "YYYY-MM-DD" UTC
    callCount: v.number(),      // Gemini API calls today for this (userId, dateKey)
    generateContentCalls: v.optional(v.number()),
    embedContentCalls: v.optional(v.number()),
    batchEmbedContentsCalls: v.optional(v.number()),
    batchEmbedContentItems: v.optional(v.number()),
    estimatedInputChars: v.optional(v.number()),
    lastMethod: v.optional(v.string()),
    lastModel: v.optional(v.string()),
    lastSource: v.optional(v.string()),
    keySource: v.optional(v.union(
      v.literal("platform"),
      v.literal("user_byok"),
      v.literal("provider_export"),
      v.literal("manual"),
      v.literal("unknown"),
    )),
    payer: v.optional(v.union(v.literal("company"), v.literal("user"), v.literal("unknown"))),
    lastUpdatedAt: v.number(),  // Unix ms of last increment
  })
    .index("by_date", ["dateKey"])
    .index("by_user_date", ["userId", "dateKey"]),

  crystalCostBreakerLedger: defineTable({
    scope: v.union(v.literal("global"), v.literal("user")),
    scopeId: v.string(),
    dayKey: v.string(),
    surface: v.union(
      v.literal("recall"),
      v.literal("kb"),
      v.literal("messages"),
      v.literal("organic"),
      v.literal("cleanup"),
      v.literal("embedding"),
      v.literal("counter"),
    ),
    estimatedVectorQueryBytes: v.number(),
    estimatedTextQueryBytes: v.number(),
    estimatedDbReadBytes: v.number(),
    estimatedEmbeddingCalls: v.number(),
    estimatedExternalCalls: v.number(),
    status: v.union(v.literal("ok"), v.literal("warn"), v.literal("emergency")),
    emergencyStartedAt: v.optional(v.number()),
    emergencyUntil: v.optional(v.number()),
    lastReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scope_day_surface", ["scope", "scopeId", "dayKey", "surface"])
    .index("by_day_surface_status", ["dayKey", "surface", "status"]),

  // ============ Tenant-Local (Self-Hosted Stack) ============
  // These tables live in the user's local Convex on the Mac (separate
  // deployment from the cloud control plane above). They mirror just enough
  // state for offline-tolerant bearer auth and bootstrap-token redemption.
  // See `convex/local/SCHEMA.md`.

  // Bearer-token table consulted by mcp-server's bearer middleware (R4 Option α).
  // Stores the sha256 hash of the API key only — cleartext lives in the
  // operator's `.env` and never in Convex. `revokedAt` is local-side; the
  // mirrored `cloudRevokedAt` is set by the heartbeat reconciliation in M6.
  localApiKeys: defineTable({
    keyHash: v.string(),
    keyVersion: v.string(),
    label: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    cloudRevokedAt: v.optional(v.number()),
  })
    .index("by_keyHash", ["keyHash"])
    .index("by_revoked", ["revokedAt"]),

  // First-boot bootstrap state singleton — `marker: "singleton"` is enforced by
  // mutations to ensure exactly one row exists. `attemptCount` drives
  // exponential-backoff scheduling (5s → 1.5× → 300s cap, 1h total budget per
  // plan §6.5). The `by_marker` index name avoids Convex's reserved `by_id`
  // name (Convex auto-creates `by_id` and `by_creation_time` on every table).
  bootstrapState: defineTable({
    marker: v.literal("singleton"),
    state: v.union(v.literal("pending"), v.literal("ready"), v.literal("expired")),
    lastFetchAttemptAt: v.optional(v.number()),
    attemptCount: v.number(),
    errorMessage: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    tenantSlug: v.optional(v.string()),
    mcVersion: v.optional(v.string()),
  }).index("by_marker", ["marker"]),

  // Outbound telemetry queue — local stack writes here on heartbeat cadence
  // and the M6 sender drains it to the cloud `telemetry` HTTP action.
  // M5 lays down the schema; the sender lives in M6.
  localTelemetryQueue: defineTable({
    payloadId: v.string(),
    payload: v.any(),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    attemptedCount: v.number(),
    nextAttemptAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_status_nextAttempt", ["status", "nextAttemptAt"])
    .index("by_payloadId", ["payloadId"]),

  // ── M0 cost-reduction instrumentation ────────────────────────────────────
  // One row per (name, bucket, userId?) — upserted by recordCall.
  // `bucket` is an ISO-8601 datetime truncated to the hour ("2026-05-03T18").
  crystalFunctionCallMetrics: defineTable({
    name: v.string(),                       // Convex function name e.g. "enrichMemoryGraph"
    bucket: v.string(),                     // "YYYY-MM-DDTHH" UTC hour bucket
    count: v.number(),                      // invocation count in this bucket
    userId: v.optional(v.string()),         // per-tenant cost attribution
    tier: v.optional(v.string()),           // store-tier breakdown (sensory/episodic/…)
    bandwidthBytes: v.optional(v.number()), // sum of approx bytes-read this bucket (best-effort)
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_name_bucket", ["name", "bucket"])
    .index("by_userId_bucket", ["userId", "bucket"]),

  // M5 — Re-recall enrichment backlog. When recall.ts encounters memories that
  // hit the strength-floor skip, it schedules at most ONE enrichMemoryGraph per
  // request and queues the rest here. The hourly crystal-graph-backfill cron
  // drains up to 5 rows from this table before its standard 25-memory page.
  // Dedupe is enforced via the by_memory index (one row per memory).
  crystalEnrichmentBacklog: defineTable({
    memoryId: v.id("crystalMemories"),
    userId: v.string(),
    reason: v.string(),
    lastQueuedAt: v.number(),
  })
    .index("by_userId_lastQueuedAt", ["userId", "lastQueuedAt"])
    .index("by_memory", ["memoryId"]),

  // ── M8/M9 — Embedding extraction (cost-reduction plan §M8/§M9) ────────────
  // Hot read paths pull the full 24KB inline `crystalMemories.embedding` even
  // when they only need scalar fields, and doc hydration after a vector hit
  // drags it too. M8 extracts the embedding into its own table (dual-write
  // window). M9 moves the vector index here and drops the inline field so
  // memory-doc reads stop paying for the embedding.
  //
  // M9 scalar mirrors: every live vectorSearch on crystalMemories.by_embedding
  // filters by userId OR knowledgeBaseId only (never archived — archived is
  // excluded post-hydration), so this side index needs just those two filter
  // fields. userId/knowledgeBaseId are optional during the A-phase backfill
  // window; dual-write + reconcile populate them, and the clean-pass cutover
  // gate only goes green once every row is mirrored.
  crystalMemoryEmbeddings: defineTable({
    memoryId: v.id("crystalMemories"),
    embedding: v.array(v.float64()),
    model: v.string(),
    dimensions: v.number(),
    createdAt: v.number(),
    userId: v.optional(v.string()),
    knowledgeBaseId: v.optional(v.id("knowledgeBases")),
  })
    .index("by_memoryId", ["memoryId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 3072,
      filterFields: ["userId", "knowledgeBaseId"],
    }),

  // M8 — Cursor-based reconcile state for `reconcileEmbeddingDualWrite`.
  // Persists the last-scanned `_creationTime` so the cron can resume across
  // ticks. `lastTickReconciledCount` drives the backoff decision (0-row tick
  // skips the next tick by setting `nextRunAt = now + 60min`).
  // `consecutiveZeroTicks` powers the cutover-readiness API: 48 consecutive
  // zero ticks (24h at 30-min cadence) signals it's safe to flip the
  // EMBEDDING_TABLE_AS_PRIMARY flag.
  crystalReconcileState: defineTable({
    cronName: v.string(),
    lastScannedCreationTime: v.number(),
    lastTickReconciledCount: v.number(),
    consecutiveZeroTicks: v.number(),
    nextRunAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_cronName", ["cronName"]),
});
