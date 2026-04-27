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
    contentHash: v.optional(v.string()),
    sourceMessageIds: v.optional(v.array(v.id("crystalMessages"))),
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
    .index("by_session", ["sessionId"])
    .index("by_supersedes", ["supersedesMemoryId"])
    .index("by_superseded_by", ["supersededByMemoryId"])
    .index("by_graph_enriched", ["graphEnriched", "userId"])
    .index("by_salience", ["userId", "salienceScore"])
    .index("by_store_archived_salience", ["userId", "store", "archived", "salienceScore"])
    .index("by_user_created", ["userId", "createdAt", "archived"])
    .index("by_store_archived_created", ["userId", "store", "archived", "createdAt"])
    .index("by_user_content_hash", ["userId", "contentHash", "archived"])
    .index("by_user_content_hash_channel", ["userId", "contentHash", "channel", "archived"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["userId", "archived"],
    })
    .index("by_knowledge_base", ["knowledgeBaseId", "userId", "archived"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["userId", "archived"],
    }),

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
    sessionId: v.optional(v.id("crystalSessions")),
    memorySnapshot: v.array(
      v.object({
        memoryId: v.id("crystalMemories"),
        strength: v.float64(),
        content: v.string(),
        store: v.string(),
      })
    ),
    semanticSummary: v.string(),
    tags: v.array(v.string()),
  })
    .index("by_user", ["userId", "createdAt"])
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
    .index("by_user_ltm_extracted_time", ["userId", "ltmExtractedAt", "timestamp"])
    .index("by_embedded", ["embedded", "timestamp"])
    .index("by_expires", ["expiresAt"])
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
    .index("by_user_time", ["userId", "createdAt"])
    .index("by_expires", ["expiresAt"]),

  crystalAssets: defineTable({
    userId: v.string(),
    kind: v.union(v.literal("image"), v.literal("audio"), v.literal("video"), v.literal("pdf"), v.literal("text")),
    storageKey: v.string(),
    mimeType: v.string(),
    title: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    embedded: v.boolean(),
    channel: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_kind", ["userId", "kind"])
    .index("by_user_channel", ["userId", "channel"])
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

  crystalDashboardTotals: defineTable({
    userId: v.string(),
    totalMemories: v.number(),
    activeMemories: v.number(),
    archivedMemories: v.number(),
    totalMessages: v.number(),
    enrichedMemories: v.optional(v.number()),
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])

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
    triggerSource: v.union(v.literal("scheduled"), v.literal("manual"), v.literal("conversation")),
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
    contradictionChecks: v.number(),
    contradictionsFound: v.number(),
    resonanceChecks: v.number(),
    resonancesFound: v.number(),
    ideasCreated: v.optional(v.number()),
    estimatedInputTokens: v.number(),
    estimatedOutputTokens: v.number(),
    estimatedCostUsd: v.float64(),
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
    lastUpdatedAt: v.number(),  // Unix ms of last increment
  })
    .index("by_date", ["dateKey"])
    .index("by_user_date", ["userId", "dateKey"]),
});
