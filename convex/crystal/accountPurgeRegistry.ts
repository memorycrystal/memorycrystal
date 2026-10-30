import type { TableNames } from "../_generated/dataModel";
import schema from "../schema";

export type PurgeRule =
  | { kind: "single" | "receiver"; field: string }
  | { kind: "all"; fields: string[] }
  | {
      kind: "parent";
      field: string;
      parent: "sessions" | "accounts" | "memories";
    }
  | { kind: "association" }
  | { kind: "scope" }
  | { kind: "rate" }
  | { kind: "self" }
  | { kind: "exempt"; reason: string };
export type PurgeEntry = {
  rule: PurgeRule;
  access:
    | { kind: "index"; index: string; field: string }
    | { kind: "scan" }
    | { kind: "parent"; index?: string };
  /** All schema user-reference fields, including non-owning provenance. Pins schema drift. */
  references: string[];
};
const single = (
  index?: string,
  field = "userId",
  references = [field],
): PurgeEntry => ({
  rule: { kind: "single", field },
  references,
  access: index ? { kind: "index", index, field } : { kind: "scan" },
});
const parent = (
  field: string,
  parent: "sessions" | "accounts" | "memories",
  index?: string,
  references: string[] = [],
): PurgeEntry => ({
  rule: { kind: "parent", field, parent },
  access: { kind: "parent", index },
  references,
});
const exempt = (reason: string, references: string[] = []): PurgeEntry => ({
  rule: { kind: "exempt", reason },
  access: { kind: "scan" },
  references,
});
const tenantReason =
  "Tenant control-plane state requires separate deprovisioning; the tenant ownership guard refuses its owner.";

/** Explicit, reviewed ownership; never infer ownership from a field's spelling at runtime. */
const definitions = {
  users: { rule: { kind: "self" }, access: { kind: "parent" }, references: [] },
  authSessions: single("userId"),
  authAccounts: single("userIdAndProvider"),
  authRefreshTokens: parent("sessionId", "sessions", "sessionId"),
  authVerifiers: parent("sessionId", "sessions", "by_purge_session"),
  authVerificationCodes: parent("accountId", "accounts", "accountId"),
  authRateLimits: {
    ...parent("identifier", "accounts", "identifier"),
    access: { kind: "scan" },
  },
  crystalAgentRecallPolicies: single("by_user_agent"),
  crystalMemories: single("by_user"),
  crystalMemoryEmbeddings: parent("memoryId", "memories", "by_memoryId", [
    "userId",
    "conversationUserId",
  ]),
  crystalMemoryEmbeddingRefs: parent("memoryId", "memories", "by_memoryId", [
    "userId",
  ]),
  crystalOnlineVectorReceipts: parent(
    "memoryId",
    "memories",
    "by_purge_memory",
  ),
  crystalMemoryCleanupIndex: single("by_user_archived_created"),
  crystalStaleArchiveCursors: single("by_user"),
  crystalStaleArchiveRunAccounts: single(),
  crystalCleanupProjectionState: single("by_user"),
  crystalMemoryTriggers: single("by_user"),
  crystalSessions: single("by_user"),
  // createdBy is checkpoint provenance (often a tool name), not its owner.
  crystalCheckpoints: single("by_user", "userId", ["userId", "createdBy"]),
  crystalWakeState: single("by_user"),
  crystalMessages: single("by_user_time"),
  crystalLtmExtractionAttempts: single("by_user"),
  crystalTelemetry: single("by_user_time"),
  crystalAssets: single("by_user"),
  crystalAssetUsage: single("by_user"),
  crystalAssetManifests: {
    rule: { kind: "all", fields: ["userId", "sourceUserId", "targetUserId"] },
    references: ["userId", "sourceUserId", "targetUserId"],
    access: { kind: "scan" },
  },
  crystalDashboardTotals: single("by_user"),
  crystalAdminSettingsStaging: exempt(
    "Global administrator-authored secret staging, not customer-owned state.",
    ["createdBy"],
  ),
  crystalUserProfiles: single("by_user"),
  crystalReflectionRuns: single("by_user_started"),
  crystalApiKeys: single("by_user"),
  crystalApiKeyRotations: single("by_user_label"),
  crystalDeviceAuth: single(),
  crystalRateLimits: {
    rule: { kind: "rate" },
    access: { kind: "index", index: "by_key", field: "key" },
    references: [],
  },
  crystalAuditLog: {
    rule: {
      kind: "all",
      fields: ["userId", "actorUserId", "effectiveUserId", "targetUserId"],
    },
    references: ["userId", "actorUserId", "effectiveUserId", "targetUserId"],
    access: { kind: "index", index: "by_user", field: "userId" },
  },
  crystalImpersonationSessions: exempt(
    "Administrator audit records belong to the administrator, including sessions targeting a purged account.",
    ["actorUserId", "targetUserId"],
  ),
  crystalStatsCache: single("by_user"),
  crystalEmailPreferences: single("by_user"),
  crystalEmailTemplates: exempt(
    "Global administrator-authored templates, not customer-owned state.",
    ["updatedBy"],
  ),
  crystalEmailLog: single("by_user_template"),
  crystalSnapshots: single("by_user"),
  knowledgeBases: single("by_user"),
  crystalKbCopyMemoryMaps: {
    rule: { kind: "receiver", field: "targetUserId" },
    access: { kind: "scan" },
    references: ["sourceUserId", "targetUserId"],
  },
  crystalKbCopyNodeMaps: {
    rule: { kind: "receiver", field: "targetUserId" },
    access: { kind: "scan" },
    references: ["sourceUserId", "targetUserId"],
  },
  crystalKnowledgeBaseLifecycleJobs: single("by_user_kb_operation"),
  crystalFrontendJobs: single("by_user_dismissed_updated"),
  crystalResearchCollections: single("by_user_updated"),
  crystalResearchCounterShards: single("by_user_collection"),
  crystalResearchSources: single("by_user_collection"),
  crystalResearchArtifacts: single("by_user_collection"),
  crystalResearchItems: single("by_user_collection"),
  crystalResearchItemEmbeddings: single(),
  crystalResearchVariants: single("by_user_collection"),
  crystalResearchDatasets: single("by_user_collection"),
  crystalResearchRuns: single("by_user_collection"),
  crystalResearchRollups: single("by_user_collection"),
  crystalResearchJobs: single(),
  crystalResearchJobShards: single(),
  crystalResearchIngestRecords: single(),
  crystalResearchPromotions: single("by_user_collection"),
  crystalResearchRelations: single(),
  crystalResearchRejections: single(),
  userProviderSettings: single("by_user_provider"),
  crystalDistillationJobs: single("by_user"),
  providerFailureState: single("by_user"),
  crystalGeminiDailyUsage: single("by_user_date"),
  crystalCostBreakerLedger: {
    rule: { kind: "scope" },
    access: { kind: "scan" },
    references: [],
  },
  polarUnmatchedEvents: single(undefined, "reconciledUserId"),
  tenants: exempt(tenantReason, ["userId"]),
  tunnels: exempt(tenantReason),
  apiKeys: exempt(tenantReason),
  telemetry: exempt(tenantReason),
  billing: exempt(tenantReason),
  provisioningLog: exempt(tenantReason),
  bootstrapTokens: exempt(tenantReason),
  bootstrapState: exempt(
    "Deployment-local bootstrap singleton; not a cloud account's tenant record.",
  ),
  signupAttempts: single("by_user_at"),
  crystalFunctionCallMetrics: single(),
  crystalLeanMigrationItems: single(undefined, "ownerId"),
  crystalEnrichmentBacklog: single(),
  organicRecallStats: single(),
  organicRecallLog: single(),
  organicReplayReports: single(),
  organicRecallPolicies: single(),
  organicSkillSuggestions: single(),
  organicIdeas: single(),
  organicTickRuns: single(),
  organicTickState: single(),
  organicAlertBudget: single(),
  organicEnsembleMemberships: single(),
  organicEnsembles: single(),
  organicProspectiveTraces: single(),
  organicActivityLog: single(),
  crystalGraphEnrichmentSettings: single(),
  crystalMemoryNodeLinks: single("by_purge_user"),
  crystalRelations: single("by_purge_user"),
  crystalNodes: single("by_purge_user"),
  crystalAssociations: {
    rule: { kind: "association" },
    access: { kind: "index", index: "by_purge_user", field: "userId" },
    references: ["userId"],
  },
  crystalAccountPurgeTargets: exempt(
    "Private parent and credential evidence must survive account deletion.",
    ["userId"],
  ),
  crystalAccountPurgeProgress: exempt(
    "Independent scan and index cursors must survive account deletion.",
  ),
  crystalAccountPurgeRuns: exempt(
    "Durable purge evidence and resume state must survive account deletion.",
    ["targets.userId"],
  ),
  crystalAccountPurgeLog: exempt(
    "Append-only deletion evidence must survive account deletion.",
    ["userId"],
  ),
} satisfies Record<string, PurgeEntry>;

export type PurgeTable = Extract<keyof typeof definitions, TableNames>;
// The public distribution removes hosted tables. Do not query absent tables or
// exempt a new table automatically: ownership declarations remain explicit and
// the coverage test rejects every undeclared table in the actual schema.
export const ACCOUNT_PURGE_TABLES = Object.fromEntries(
  Object.entries(definitions).filter(([table]) => table in schema.tables),
) as Record<PurgeTable, PurgeEntry>;
export const PURGE_TABLE_NAMES = Object.keys(
  ACCOUNT_PURGE_TABLES,
) as PurgeTable[];
export const AUTH_TABLES: PurgeTable[] = [
  "authVerifiers",
  "authSessions",
  "authVerificationCodes",
  "authRateLimits",
  "authAccounts",
  "crystalApiKeyRotations",
  "crystalApiKeys",
];
const first: PurgeTable[] = [
  "crystalMemories",
  "crystalMemoryEmbeddings",
  "crystalMemoryEmbeddingRefs",
  "crystalOnlineVectorReceipts",
  "crystalLtmExtractionAttempts",
  "crystalMessages",
  "knowledgeBases",
  "crystalMemoryNodeLinks",
  "crystalRelations",
  "crystalAssociations",
  "crystalNodes",
];
export const DATA_TABLES: PurgeTable[] = [
  ...first,
  ...PURGE_TABLE_NAMES.filter(
    (t) =>
      !first.includes(t) &&
      !["users", "crystalUserProfiles"].includes(t) &&
      ACCOUNT_PURGE_TABLES[t].rule.kind !== "exempt",
  ),
];
