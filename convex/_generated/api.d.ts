/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
declare const auth: any; // generated type for an excluded public-mirror module
import type * as authUsers from "../authUsers.js";
declare const cloud_bootstrap: any; // generated type for an excluded public-mirror module
declare const cloud_cfTunnel: any; // generated type for an excluded public-mirror module
declare const cloud_idleCull: any; // generated type for an excluded public-mirror module
declare const cloud_provisionTenant: any; // generated type for an excluded public-mirror module
declare const cloud_provisionTenantPublic: any; // generated type for an excluded public-mirror module
declare const cloud_signupRateLimit: any; // generated type for an excluded public-mirror module
declare const cloud_telemetryHttp: any; // generated type for an excluded public-mirror module
declare const cloud_tenants: any; // generated type for an excluded public-mirror module
declare const cloud_tunnelReclaim: any; // generated type for an excluded public-mirror module
declare const cloud_turnstile: any; // generated type for an excluded public-mirror module
import type * as crons from "../crons.js";
declare const crystal___tests___benchmarkHarness: any; // generated type for an excluded public-mirror module
declare const crystal___tests___stubs_emailEngine: any; // generated type for an excluded public-mirror module
declare const crystal___tests___stubs_userProfiles: any; // generated type for an excluded public-mirror module
declare const crystal___tests___stubs_userProfilesStaleCursor: any; // generated type for an excluded public-mirror module
declare const crystal_accountEmailRepair: any; // generated type for an excluded public-mirror module
import type * as crystal_accountMerge from "../crystal/accountMerge.js";
import type * as crystal_accountRateLimit from "../crystal/accountRateLimit.js";
declare const crystal_admin: any; // generated type for an excluded public-mirror module
declare const crystal_adminCostAnalytics: any; // generated type for an excluded public-mirror module
declare const crystal_adminDelete: any; // generated type for an excluded public-mirror module
declare const crystal_adminEmails: any; // generated type for an excluded public-mirror module
declare const crystal_adminGrantTier: any; // generated type for an excluded public-mirror module
declare const crystal_adminKnowledgeBaseCopy: any; // generated type for an excluded public-mirror module
declare const crystal_adminSettings_mutations: any; // generated type for an excluded public-mirror module
declare const crystal_adminSettings_promoteSecret: any; // generated type for an excluded public-mirror module
declare const crystal_adminSettings_queries: any; // generated type for an excluded public-mirror module
declare const crystal_adminSettings_resolvers: any; // generated type for an excluded public-mirror module
declare const crystal_adminSupport: any; // generated type for an excluded public-mirror module
import type * as crystal_agentRecallPolicies from "../crystal/agentRecallPolicies.js";
import type * as crystal_agentStamp from "../crystal/agentStamp.js";
import type * as crystal_agentStampReport from "../crystal/agentStampReport.js";
import type * as crystal_apiKeyLimits from "../crystal/apiKeyLimits.js";
import type * as crystal_apiKeyRotationGuards from "../crystal/apiKeyRotationGuards.js";
import type * as crystal_apiKeyRotationIntegrity from "../crystal/apiKeyRotationIntegrity.js";
import type * as crystal_apiKeys from "../crystal/apiKeys.js";
import type * as crystal_archivedPurge from "../crystal/archivedPurge.js";
import type * as crystal_assetStorage from "../crystal/assetStorage.js";
import type * as crystal_assets from "../crystal/assets.js";
import type * as crystal_auth from "../crystal/auth.js";
import type * as crystal_authLookup from "../crystal/authLookup.js";
import type * as crystal_backlogDrain from "../crystal/backlogDrain.js";
import type * as crystal_buildInfo from "../crystal/buildInfo.js";
import type * as crystal_capacityPolicy from "../crystal/capacityPolicy.js";
import type * as crystal_channelClassifier from "../crystal/channelClassifier.js";
import type * as crystal_channelScope from "../crystal/channelScope.js";
import type * as crystal_checkpoints from "../crystal/checkpoints.js";
import type * as crystal_cleanup from "../crystal/cleanup.js";
import type * as crystal_cleanupProjection from "../crystal/cleanupProjection.js";
import type * as crystal_contentHash from "../crystal/contentHash.js";
import type * as crystal_contentScanner from "../crystal/contentScanner.js";
import type * as crystal_costBreaker from "../crystal/costBreaker.js";
import type * as crystal_crypto from "../crystal/crypto.js";
declare const crystal_dashboard: any; // generated type for an excluded public-mirror module
declare const crystal_dashboardTotals: any; // generated type for an excluded public-mirror module
import type * as crystal_decay from "../crystal/decay.js";
import type * as crystal_decayModel from "../crystal/decayModel.js";
import type * as crystal_deviceAuth from "../crystal/deviceAuth.js";
import type * as crystal_deviceHttp from "../crystal/deviceHttp.js";
import type * as crystal_distillationModels from "../crystal/distillationModels.js";
import type * as crystal_distillationProfiles from "../crystal/distillationProfiles.js";
import type * as crystal_distillationQueue from "../crystal/distillationQueue.js";
import type * as crystal_distillationRecovery from "../crystal/distillationRecovery.js";
declare const crystal_emailCrons: any; // generated type for an excluded public-mirror module
declare const crystal_emailDefaults: any; // generated type for an excluded public-mirror module
declare const crystal_emailEngine: any; // generated type for an excluded public-mirror module
declare const crystal_emailTemplates: any; // generated type for an excluded public-mirror module
import type * as crystal_embedRetry from "../crystal/embedRetry.js";
import type * as crystal_embeddingInput from "../crystal/embeddingInput.js";
import type * as crystal_embeddings from "../crystal/embeddings.js";
declare const crystal_eval_evalEmbedding: any; // generated type for an excluded public-mirror module
declare const crystal_eval_recallEvalHarness: any; // generated type for an excluded public-mirror module
declare const crystal_eval_recallGate: any; // generated type for an excluded public-mirror module
declare const crystal_eval_recallMetrics: any; // generated type for an excluded public-mirror module
declare const crystal_eval_recallMetricsV2: any; // generated type for an excluded public-mirror module
declare const crystal_eval_recallSplit: any; // generated type for an excluded public-mirror module
declare const crystal_eval_recallV2Harness: any; // generated type for an excluded public-mirror module
declare const crystal_eval_recordedFixture: any; // generated type for an excluded public-mirror module
declare const crystal_evalStats: any; // generated type for an excluded public-mirror module
import type * as crystal_exactDuplicate from "../crystal/exactDuplicate.js";
import type * as crystal_forgetting from "../crystal/forgetting.js";
import type * as crystal_freshnessClassifier from "../crystal/freshnessClassifier.js";
import type * as crystal_frontendJobs from "../crystal/frontendJobs.js";
import type * as crystal_geminiGuardrail from "../crystal/geminiGuardrail.js";
import type * as crystal_httpAuth from "../crystal/httpAuth.js";
declare const crystal_impersonation: any; // generated type for an excluded public-mirror module
import type * as crystal_jobCursors from "../crystal/jobCursors.js";
import type * as crystal_kbCounterReconcile from "../crystal/kbCounterReconcile.js";
import type * as crystal_kbPeerScopeBackfill from "../crystal/kbPeerScopeBackfill.js";
import type * as crystal_knowledgeBaseLifecycle from "../crystal/knowledgeBaseLifecycle.js";
import type * as crystal_knowledgeBases from "../crystal/knowledgeBases.js";
import type * as crystal_knowledgeHttp from "../crystal/knowledgeHttp.js";
import type * as crystal_leakAudit from "../crystal/leakAudit.js";
declare const crystal_leanMigration: any; // generated type for an excluded public-mirror module
import type * as crystal_localAuth from "../crystal/localAuth.js";
import type * as crystal_ltmExtraction from "../crystal/ltmExtraction.js";
import type * as crystal_ltmHygiene from "../crystal/ltmHygiene.js";
import type * as crystal_mcp from "../crystal/mcp.js";
import type * as crystal_memories from "../crystal/memories.js";
import type * as crystal_memoriesExport from "../crystal/memoriesExport.js";
import type * as crystal_memoryInlineStrip from "../crystal/memoryInlineStrip.js";
import type * as crystal_memoryText from "../crystal/memoryText.js";
import type * as crystal_memoryVectorAudit from "../crystal/memoryVectorAudit.js";
import type * as crystal_memoryVectorParity from "../crystal/memoryVectorParity.js";
import type * as crystal_memoryVectors from "../crystal/memoryVectors.js";
import type * as crystal_messageEmbeddingStrip from "../crystal/messageEmbeddingStrip.js";
import type * as crystal_messageRetirement from "../crystal/messageRetirement.js";
import type * as crystal_messages from "../crystal/messages.js";
import type * as crystal_metrics from "../crystal/metrics.js";
import type * as crystal_observability_functionCallMetrics from "../crystal/observability/functionCallMetrics.js";
import type * as crystal_onlineMigration from "../crystal/onlineMigration.js";
import type * as crystal_organicPurge from "../crystal/organicPurge.js";
import type * as crystal_permissions from "../crystal/permissions.js";
declare const crystal_planPricing: any; // generated type for an excluded public-mirror module
declare const crystal_polarUnmatchedEvents: any; // generated type for an excluded public-mirror module
declare const crystal_polarWebhook: any; // generated type for an excluded public-mirror module
declare const crystal_privateMemoryImport: any; // generated type for an excluded public-mirror module
import type * as crystal_projectIdentity from "../crystal/projectIdentity.js";
import type * as crystal_projectMemoryWithoutEmbedding from "../crystal/projectMemoryWithoutEmbedding.js";
import type * as crystal_providerDiagnostics from "../crystal/providerDiagnostics.js";
import type * as crystal_providerGateway from "../crystal/providerGateway.js";
import type * as crystal_providerSettings from "../crystal/providerSettings.js";
import type * as crystal_recall from "../crystal/recall.js";
import type * as crystal_recallBudgetPolicy from "../crystal/recallBudgetPolicy.js";
import type * as crystal_recallCompression from "../crystal/recallCompression.js";
import type * as crystal_recallCoverage from "../crystal/recallCoverage.js";
import type * as crystal_recallEngine_agentLayer from "../crystal/recallEngine/agentLayer.js";
import type * as crystal_recallEngine_budgets from "../crystal/recallEngine/budgets.js";
import type * as crystal_recallEngine_constants from "../crystal/recallEngine/constants.js";
import type * as crystal_recallEngine_dedupe from "../crystal/recallEngine/dedupe.js";
import type * as crystal_recallEngine_degradation from "../crystal/recallEngine/degradation.js";
import type * as crystal_recallEngine_diagnostics from "../crystal/recallEngine/diagnostics.js";
import type * as crystal_recallEngine_earlyReturn from "../crystal/recallEngine/earlyReturn.js";
import type * as crystal_recallEngine_finalize from "../crystal/recallEngine/finalize.js";
import type * as crystal_recallEngine_httpFields from "../crystal/recallEngine/httpFields.js";
import type * as crystal_recallEngine_identifiers from "../crystal/recallEngine/identifiers.js";
import type * as crystal_recallEngine_lanesKnowledge from "../crystal/recallEngine/lanesKnowledge.js";
import type * as crystal_recallEngine_lanesLexical from "../crystal/recallEngine/lanesLexical.js";
import type * as crystal_recallEngine_lanesMessages from "../crystal/recallEngine/lanesMessages.js";
import type * as crystal_recallEngine_lanesParallel from "../crystal/recallEngine/lanesParallel.js";
import type * as crystal_recallEngine_lanesSemantic from "../crystal/recallEngine/lanesSemantic.js";
import type * as crystal_recallEngine_lexicalIo from "../crystal/recallEngine/lexicalIo.js";
import type * as crystal_recallEngine_lexicalShape from "../crystal/recallEngine/lexicalShape.js";
import type * as crystal_recallEngine_limits from "../crystal/recallEngine/limits.js";
import type * as crystal_recallEngine_memoryPolicy from "../crystal/recallEngine/memoryPolicy.js";
import type * as crystal_recallEngine_messagePolicy from "../crystal/recallEngine/messagePolicy.js";
import type * as crystal_recallEngine_messageQueries from "../crystal/recallEngine/messageQueries.js";
import type * as crystal_recallEngine_normalize from "../crystal/recallEngine/normalize.js";
import type * as crystal_recallEngine_presets from "../crystal/recallEngine/presets.js";
import type * as crystal_recallEngine_queryAnalysis from "../crystal/recallEngine/queryAnalysis.js";
import type * as crystal_recallEngine_ranking from "../crystal/recallEngine/ranking.js";
import type * as crystal_recallEngine_response from "../crystal/recallEngine/response.js";
import type * as crystal_recallEngine_run from "../crystal/recallEngine/run.js";
import type * as crystal_recallEngine_scope from "../crystal/recallEngine/scope.js";
import type * as crystal_recallEngine_sourceRole from "../crystal/recallEngine/sourceRole.js";
import type * as crystal_recallEngine_types from "../crystal/recallEngine/types.js";
import type * as crystal_recallProvenance from "../crystal/recallProvenance.js";
import type * as crystal_recallRanking from "../crystal/recallRanking.js";
import type * as crystal_recallTimings from "../crystal/recallTimings.js";
import type * as crystal_redactSecrets from "../crystal/redactSecrets.js";
import type * as crystal_redactedWriteGuard from "../crystal/redactedWriteGuard.js";
import type * as crystal_reembed from "../crystal/reembed.js";
import type * as crystal_reflection from "../crystal/reflection.js";
import type * as crystal_reflectionCycle from "../crystal/reflectionCycle.js";
import type * as crystal_reflectionLog from "../crystal/reflectionLog.js";
import type * as crystal_research from "../crystal/research.js";
import type * as crystal_researchArtifacts from "../crystal/researchArtifacts.js";
import type * as crystal_researchHttp from "../crystal/researchHttp.js";
import type * as crystal_researchTransfer from "../crystal/researchTransfer.js";
import type * as crystal_retention from "../crystal/retention.js";
import type * as crystal_salience from "../crystal/salience.js";
import type * as crystal_scopeReport from "../crystal/scopeReport.js";
import type * as crystal_seed from "../crystal/seed.js";
import type * as crystal_sensoryPolicy from "../crystal/sensoryPolicy.js";
import type * as crystal_sensoryPurge from "../crystal/sensoryPurge.js";
import type * as crystal_sessions from "../crystal/sessions.js";
import type * as crystal_snapshots from "../crystal/snapshots.js";
declare const crystal_stats: any; // generated type for an excluded public-mirror module
import type * as crystal_turnCapture from "../crystal/turnCapture.js";
declare const crystal_userProfiles: any; // generated type for an excluded public-mirror module
import type * as crystal_vectorlessSweep from "../crystal/vectorlessSweep.js";
import type * as crystal_verbatimWindowMigration from "../crystal/verbatimWindowMigration.js";
import type * as crystal_wake from "../crystal/wake.js";
import type * as crystal_writeDedupe from "../crystal/writeDedupe.js";
declare const email: any; // generated type for an excluded public-mirror module
import type * as eslint_rules_no_public_userid_arg from "../eslint_rules/no_public_userid_arg.js";
import type * as http from "../http.js";
import type * as local_apiKeys from "../local/apiKeys.js";
import type * as local_bootstrap from "../local/bootstrap.js";
import type * as local_telemetryPush from "../local/telemetryPush.js";
import type * as local_telemetry_crons from "../local/telemetry_crons.js";
import type * as localCrons from "../localCrons.js";
import type * as selfHosted_adminEmails from "../selfHosted/adminEmails.js";
import type * as selfHosted_adminSettingsResolvers from "../selfHosted/adminSettingsResolvers.js";
import type * as selfHosted_adminSupport from "../selfHosted/adminSupport.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authUsers: typeof authUsers;
  "cloud/bootstrap": typeof cloud_bootstrap;
  "cloud/cfTunnel": typeof cloud_cfTunnel;
  "cloud/idleCull": typeof cloud_idleCull;
  "cloud/provisionTenant": typeof cloud_provisionTenant;
  "cloud/provisionTenantPublic": typeof cloud_provisionTenantPublic;
  "cloud/signupRateLimit": typeof cloud_signupRateLimit;
  "cloud/telemetryHttp": typeof cloud_telemetryHttp;
  "cloud/tenants": typeof cloud_tenants;
  "cloud/tunnelReclaim": typeof cloud_tunnelReclaim;
  "cloud/turnstile": typeof cloud_turnstile;
  crons: typeof crons;
  "crystal/__tests__/benchmarkHarness": typeof crystal___tests___benchmarkHarness;
  "crystal/__tests__/stubs/emailEngine": typeof crystal___tests___stubs_emailEngine;
  "crystal/__tests__/stubs/userProfiles": typeof crystal___tests___stubs_userProfiles;
  "crystal/__tests__/stubs/userProfilesStaleCursor": typeof crystal___tests___stubs_userProfilesStaleCursor;
  "crystal/accountEmailRepair": typeof crystal_accountEmailRepair;
  "crystal/accountMerge": typeof crystal_accountMerge;
  "crystal/accountRateLimit": typeof crystal_accountRateLimit;
  "crystal/admin": typeof crystal_admin;
  "crystal/adminCostAnalytics": typeof crystal_adminCostAnalytics;
  "crystal/adminDelete": typeof crystal_adminDelete;
  "crystal/adminEmails": typeof crystal_adminEmails;
  "crystal/adminGrantTier": typeof crystal_adminGrantTier;
  "crystal/adminKnowledgeBaseCopy": typeof crystal_adminKnowledgeBaseCopy;
  "crystal/adminSettings/mutations": typeof crystal_adminSettings_mutations;
  "crystal/adminSettings/promoteSecret": typeof crystal_adminSettings_promoteSecret;
  "crystal/adminSettings/queries": typeof crystal_adminSettings_queries;
  "crystal/adminSettings/resolvers": typeof crystal_adminSettings_resolvers;
  "crystal/adminSupport": typeof crystal_adminSupport;
  "crystal/agentRecallPolicies": typeof crystal_agentRecallPolicies;
  "crystal/agentStamp": typeof crystal_agentStamp;
  "crystal/agentStampReport": typeof crystal_agentStampReport;
  "crystal/apiKeyLimits": typeof crystal_apiKeyLimits;
  "crystal/apiKeyRotationGuards": typeof crystal_apiKeyRotationGuards;
  "crystal/apiKeyRotationIntegrity": typeof crystal_apiKeyRotationIntegrity;
  "crystal/apiKeys": typeof crystal_apiKeys;
  "crystal/archivedPurge": typeof crystal_archivedPurge;
  "crystal/assetStorage": typeof crystal_assetStorage;
  "crystal/assets": typeof crystal_assets;
  "crystal/auth": typeof crystal_auth;
  "crystal/authLookup": typeof crystal_authLookup;
  "crystal/backlogDrain": typeof crystal_backlogDrain;
  "crystal/buildInfo": typeof crystal_buildInfo;
  "crystal/capacityPolicy": typeof crystal_capacityPolicy;
  "crystal/channelClassifier": typeof crystal_channelClassifier;
  "crystal/channelScope": typeof crystal_channelScope;
  "crystal/checkpoints": typeof crystal_checkpoints;
  "crystal/cleanup": typeof crystal_cleanup;
  "crystal/cleanupProjection": typeof crystal_cleanupProjection;
  "crystal/contentHash": typeof crystal_contentHash;
  "crystal/contentScanner": typeof crystal_contentScanner;
  "crystal/costBreaker": typeof crystal_costBreaker;
  "crystal/crypto": typeof crystal_crypto;
  "crystal/dashboard": typeof crystal_dashboard;
  "crystal/dashboardTotals": typeof crystal_dashboardTotals;
  "crystal/decay": typeof crystal_decay;
  "crystal/decayModel": typeof crystal_decayModel;
  "crystal/deviceAuth": typeof crystal_deviceAuth;
  "crystal/deviceHttp": typeof crystal_deviceHttp;
  "crystal/distillationModels": typeof crystal_distillationModels;
  "crystal/distillationProfiles": typeof crystal_distillationProfiles;
  "crystal/distillationQueue": typeof crystal_distillationQueue;
  "crystal/distillationRecovery": typeof crystal_distillationRecovery;
  "crystal/emailCrons": typeof crystal_emailCrons;
  "crystal/emailDefaults": typeof crystal_emailDefaults;
  "crystal/emailEngine": typeof crystal_emailEngine;
  "crystal/emailTemplates": typeof crystal_emailTemplates;
  "crystal/embedRetry": typeof crystal_embedRetry;
  "crystal/embeddingInput": typeof crystal_embeddingInput;
  "crystal/embeddings": typeof crystal_embeddings;
  "crystal/eval/evalEmbedding": typeof crystal_eval_evalEmbedding;
  "crystal/eval/recallEvalHarness": typeof crystal_eval_recallEvalHarness;
  "crystal/eval/recallGate": typeof crystal_eval_recallGate;
  "crystal/eval/recallMetrics": typeof crystal_eval_recallMetrics;
  "crystal/eval/recallMetricsV2": typeof crystal_eval_recallMetricsV2;
  "crystal/eval/recallSplit": typeof crystal_eval_recallSplit;
  "crystal/eval/recallV2Harness": typeof crystal_eval_recallV2Harness;
  "crystal/eval/recordedFixture": typeof crystal_eval_recordedFixture;
  "crystal/evalStats": typeof crystal_evalStats;
  "crystal/exactDuplicate": typeof crystal_exactDuplicate;
  "crystal/forgetting": typeof crystal_forgetting;
  "crystal/freshnessClassifier": typeof crystal_freshnessClassifier;
  "crystal/frontendJobs": typeof crystal_frontendJobs;
  "crystal/geminiGuardrail": typeof crystal_geminiGuardrail;
  "crystal/httpAuth": typeof crystal_httpAuth;
  "crystal/impersonation": typeof crystal_impersonation;
  "crystal/jobCursors": typeof crystal_jobCursors;
  "crystal/kbCounterReconcile": typeof crystal_kbCounterReconcile;
  "crystal/kbPeerScopeBackfill": typeof crystal_kbPeerScopeBackfill;
  "crystal/knowledgeBaseLifecycle": typeof crystal_knowledgeBaseLifecycle;
  "crystal/knowledgeBases": typeof crystal_knowledgeBases;
  "crystal/knowledgeHttp": typeof crystal_knowledgeHttp;
  "crystal/leakAudit": typeof crystal_leakAudit;
  "crystal/leanMigration": typeof crystal_leanMigration;
  "crystal/localAuth": typeof crystal_localAuth;
  "crystal/ltmExtraction": typeof crystal_ltmExtraction;
  "crystal/ltmHygiene": typeof crystal_ltmHygiene;
  "crystal/mcp": typeof crystal_mcp;
  "crystal/memories": typeof crystal_memories;
  "crystal/memoriesExport": typeof crystal_memoriesExport;
  "crystal/memoryInlineStrip": typeof crystal_memoryInlineStrip;
  "crystal/memoryText": typeof crystal_memoryText;
  "crystal/memoryVectorAudit": typeof crystal_memoryVectorAudit;
  "crystal/memoryVectorParity": typeof crystal_memoryVectorParity;
  "crystal/memoryVectors": typeof crystal_memoryVectors;
  "crystal/messageEmbeddingStrip": typeof crystal_messageEmbeddingStrip;
  "crystal/messageRetirement": typeof crystal_messageRetirement;
  "crystal/messages": typeof crystal_messages;
  "crystal/metrics": typeof crystal_metrics;
  "crystal/observability/functionCallMetrics": typeof crystal_observability_functionCallMetrics;
  "crystal/onlineMigration": typeof crystal_onlineMigration;
  "crystal/organicPurge": typeof crystal_organicPurge;
  "crystal/permissions": typeof crystal_permissions;
  "crystal/planPricing": typeof crystal_planPricing;
  "crystal/polarUnmatchedEvents": typeof crystal_polarUnmatchedEvents;
  "crystal/polarWebhook": typeof crystal_polarWebhook;
  "crystal/privateMemoryImport": typeof crystal_privateMemoryImport;
  "crystal/projectIdentity": typeof crystal_projectIdentity;
  "crystal/projectMemoryWithoutEmbedding": typeof crystal_projectMemoryWithoutEmbedding;
  "crystal/providerDiagnostics": typeof crystal_providerDiagnostics;
  "crystal/providerGateway": typeof crystal_providerGateway;
  "crystal/providerSettings": typeof crystal_providerSettings;
  "crystal/recall": typeof crystal_recall;
  "crystal/recallBudgetPolicy": typeof crystal_recallBudgetPolicy;
  "crystal/recallCompression": typeof crystal_recallCompression;
  "crystal/recallCoverage": typeof crystal_recallCoverage;
  "crystal/recallEngine/agentLayer": typeof crystal_recallEngine_agentLayer;
  "crystal/recallEngine/budgets": typeof crystal_recallEngine_budgets;
  "crystal/recallEngine/constants": typeof crystal_recallEngine_constants;
  "crystal/recallEngine/dedupe": typeof crystal_recallEngine_dedupe;
  "crystal/recallEngine/degradation": typeof crystal_recallEngine_degradation;
  "crystal/recallEngine/diagnostics": typeof crystal_recallEngine_diagnostics;
  "crystal/recallEngine/earlyReturn": typeof crystal_recallEngine_earlyReturn;
  "crystal/recallEngine/finalize": typeof crystal_recallEngine_finalize;
  "crystal/recallEngine/httpFields": typeof crystal_recallEngine_httpFields;
  "crystal/recallEngine/identifiers": typeof crystal_recallEngine_identifiers;
  "crystal/recallEngine/lanesKnowledge": typeof crystal_recallEngine_lanesKnowledge;
  "crystal/recallEngine/lanesLexical": typeof crystal_recallEngine_lanesLexical;
  "crystal/recallEngine/lanesMessages": typeof crystal_recallEngine_lanesMessages;
  "crystal/recallEngine/lanesParallel": typeof crystal_recallEngine_lanesParallel;
  "crystal/recallEngine/lanesSemantic": typeof crystal_recallEngine_lanesSemantic;
  "crystal/recallEngine/lexicalIo": typeof crystal_recallEngine_lexicalIo;
  "crystal/recallEngine/lexicalShape": typeof crystal_recallEngine_lexicalShape;
  "crystal/recallEngine/limits": typeof crystal_recallEngine_limits;
  "crystal/recallEngine/memoryPolicy": typeof crystal_recallEngine_memoryPolicy;
  "crystal/recallEngine/messagePolicy": typeof crystal_recallEngine_messagePolicy;
  "crystal/recallEngine/messageQueries": typeof crystal_recallEngine_messageQueries;
  "crystal/recallEngine/normalize": typeof crystal_recallEngine_normalize;
  "crystal/recallEngine/presets": typeof crystal_recallEngine_presets;
  "crystal/recallEngine/queryAnalysis": typeof crystal_recallEngine_queryAnalysis;
  "crystal/recallEngine/ranking": typeof crystal_recallEngine_ranking;
  "crystal/recallEngine/response": typeof crystal_recallEngine_response;
  "crystal/recallEngine/run": typeof crystal_recallEngine_run;
  "crystal/recallEngine/scope": typeof crystal_recallEngine_scope;
  "crystal/recallEngine/sourceRole": typeof crystal_recallEngine_sourceRole;
  "crystal/recallEngine/types": typeof crystal_recallEngine_types;
  "crystal/recallProvenance": typeof crystal_recallProvenance;
  "crystal/recallRanking": typeof crystal_recallRanking;
  "crystal/recallTimings": typeof crystal_recallTimings;
  "crystal/redactSecrets": typeof crystal_redactSecrets;
  "crystal/redactedWriteGuard": typeof crystal_redactedWriteGuard;
  "crystal/reembed": typeof crystal_reembed;
  "crystal/reflection": typeof crystal_reflection;
  "crystal/reflectionCycle": typeof crystal_reflectionCycle;
  "crystal/reflectionLog": typeof crystal_reflectionLog;
  "crystal/research": typeof crystal_research;
  "crystal/researchArtifacts": typeof crystal_researchArtifacts;
  "crystal/researchHttp": typeof crystal_researchHttp;
  "crystal/researchTransfer": typeof crystal_researchTransfer;
  "crystal/retention": typeof crystal_retention;
  "crystal/salience": typeof crystal_salience;
  "crystal/scopeReport": typeof crystal_scopeReport;
  "crystal/seed": typeof crystal_seed;
  "crystal/sensoryPolicy": typeof crystal_sensoryPolicy;
  "crystal/sensoryPurge": typeof crystal_sensoryPurge;
  "crystal/sessions": typeof crystal_sessions;
  "crystal/snapshots": typeof crystal_snapshots;
  "crystal/stats": typeof crystal_stats;
  "crystal/turnCapture": typeof crystal_turnCapture;
  "crystal/userProfiles": typeof crystal_userProfiles;
  "crystal/vectorlessSweep": typeof crystal_vectorlessSweep;
  "crystal/verbatimWindowMigration": typeof crystal_verbatimWindowMigration;
  "crystal/wake": typeof crystal_wake;
  "crystal/writeDedupe": typeof crystal_writeDedupe;
  email: typeof email;
  "eslint_rules/no_public_userid_arg": typeof eslint_rules_no_public_userid_arg;
  http: typeof http;
  "local/apiKeys": typeof local_apiKeys;
  "local/bootstrap": typeof local_bootstrap;
  "local/telemetryPush": typeof local_telemetryPush;
  "local/telemetry_crons": typeof local_telemetry_crons;
  localCrons: typeof localCrons;
  "selfHosted/adminEmails": typeof selfHosted_adminEmails;
  "selfHosted/adminSettingsResolvers": typeof selfHosted_adminSettingsResolvers;
  "selfHosted/adminSupport": typeof selfHosted_adminSupport;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
