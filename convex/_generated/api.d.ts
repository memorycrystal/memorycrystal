/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as crystal___tests___stubs_emailEngine from "../crystal/__tests__/stubs/emailEngine.js";
import type * as crystal___tests___stubs_userProfiles from "../crystal/__tests__/stubs/userProfiles.js";
import type * as crystal_admin from "../crystal/admin.js";
import type * as crystal_adminDelete from "../crystal/adminDelete.js";
import type * as crystal_adminEmails from "../crystal/adminEmails.js";
import type * as crystal_adminSupport from "../crystal/adminSupport.js";
import type * as crystal_apiKeys from "../crystal/apiKeys.js";
import type * as crystal_assets from "../crystal/assets.js";
import type * as crystal_associations from "../crystal/associations.js";
import type * as crystal_auth from "../crystal/auth.js";
import type * as crystal_authLookup from "../crystal/authLookup.js";
import type * as crystal_checkpoints from "../crystal/checkpoints.js";
import type * as crystal_cleanup from "../crystal/cleanup.js";
import type * as crystal_consolidate from "../crystal/consolidate.js";
import type * as crystal_contentScanner from "../crystal/contentScanner.js";
import type * as crystal_crypto from "../crystal/crypto.js";
import type * as crystal_dashboard from "../crystal/dashboard.js";
import type * as crystal_dashboardTotals from "../crystal/dashboardTotals.js";
import type * as crystal_decay from "../crystal/decay.js";
import type * as crystal_deviceAuth from "../crystal/deviceAuth.js";
import type * as crystal_deviceHttp from "../crystal/deviceHttp.js";
import type * as crystal_emailCrons from "../crystal/emailCrons.js";
import type * as crystal_emailDefaults from "../crystal/emailDefaults.js";
import type * as crystal_emailEngine from "../crystal/emailEngine.js";
import type * as crystal_emailTemplates from "../crystal/emailTemplates.js";
import type * as crystal_emergencyMorrowPurge from "../crystal/emergencyMorrowPurge.js";
import type * as crystal_evalStats from "../crystal/evalStats.js";
import type * as crystal_geminiGuardrail from "../crystal/geminiGuardrail.js";
import type * as crystal_graph from "../crystal/graph.js";
import type * as crystal_graphEnrich from "../crystal/graphEnrich.js";
import type * as crystal_graphQuery from "../crystal/graphQuery.js";
import type * as crystal_httpAuth from "../crystal/httpAuth.js";
import type * as crystal_impersonation from "../crystal/impersonation.js";
import type * as crystal_knowledgeBases from "../crystal/knowledgeBases.js";
import type * as crystal_knowledgeHttp from "../crystal/knowledgeHttp.js";
import type * as crystal_mcp from "../crystal/mcp.js";
import type * as crystal_memories from "../crystal/memories.js";
import type * as crystal_messages from "../crystal/messages.js";
import type * as crystal_morrowPurge from "../crystal/morrowPurge.js";
import type * as crystal_organic_activityLog from "../crystal/organic/activityLog.js";
import type * as crystal_organic_adminTick from "../crystal/organic/adminTick.js";
import type * as crystal_organic_contradictions from "../crystal/organic/contradictions.js";
import type * as crystal_organic_discoveryFiber from "../crystal/organic/discoveryFiber.js";
import type * as crystal_organic_ensembles from "../crystal/organic/ensembles.js";
import type * as crystal_organic_http from "../crystal/organic/http.js";
import type * as crystal_organic_ideaDigest from "../crystal/organic/ideaDigest.js";
import type * as crystal_organic_ideas from "../crystal/organic/ideas.js";
import type * as crystal_organic_models from "../crystal/organic/models.js";
import type * as crystal_organic_organic from "../crystal/organic/organic.js";
import type * as crystal_organic_policyTuner from "../crystal/organic/policyTuner.js";
import type * as crystal_organic_proceduralExtraction from "../crystal/organic/proceduralExtraction.js";
import type * as crystal_organic_recallLog from "../crystal/organic/recallLog.js";
import type * as crystal_organic_replayEval from "../crystal/organic/replayEval.js";
import type * as crystal_organic_replayReport from "../crystal/organic/replayReport.js";
import type * as crystal_organic_resonance from "../crystal/organic/resonance.js";
import type * as crystal_organic_skillSuggestions from "../crystal/organic/skillSuggestions.js";
import type * as crystal_organic_spend from "../crystal/organic/spend.js";
import type * as crystal_organic_tick from "../crystal/organic/tick.js";
import type * as crystal_organic_traces from "../crystal/organic/traces.js";
import type * as crystal_organic_utils from "../crystal/organic/utils.js";
import type * as crystal_permissions from "../crystal/permissions.js";
import type * as crystal_polarWebhook from "../crystal/polarWebhook.js";
import type * as crystal_recall from "../crystal/recall.js";
import type * as crystal_recallRanking from "../crystal/recallRanking.js";
import type * as crystal_reembed from "../crystal/reembed.js";
import type * as crystal_reflection from "../crystal/reflection.js";
import type * as crystal_salience from "../crystal/salience.js";
import type * as crystal_sensoryPurge from "../crystal/sensoryPurge.js";
import type * as crystal_sessions from "../crystal/sessions.js";
import type * as crystal_snapshots from "../crystal/snapshots.js";
import type * as crystal_stats from "../crystal/stats.js";
import type * as crystal_stmEmbedder from "../crystal/stmEmbedder.js";
import type * as crystal_temporalParser from "../crystal/temporalParser.js";
import type * as crystal_userProfiles from "../crystal/userProfiles.js";
import type * as crystal_wake from "../crystal/wake.js";
import type * as email from "../email.js";
import type * as eslint_rules_no_public_userid_arg from "../eslint_rules/no_public_userid_arg.js";
import type * as http from "../http.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  crons: typeof crons;
  "crystal/__tests__/stubs/emailEngine": typeof crystal___tests___stubs_emailEngine;
  "crystal/__tests__/stubs/userProfiles": typeof crystal___tests___stubs_userProfiles;
  "crystal/admin": typeof crystal_admin;
  "crystal/adminDelete": typeof crystal_adminDelete;
  "crystal/adminEmails": typeof crystal_adminEmails;
  "crystal/adminSupport": typeof crystal_adminSupport;
  "crystal/apiKeys": typeof crystal_apiKeys;
  "crystal/assets": typeof crystal_assets;
  "crystal/associations": typeof crystal_associations;
  "crystal/auth": typeof crystal_auth;
  "crystal/authLookup": typeof crystal_authLookup;
  "crystal/checkpoints": typeof crystal_checkpoints;
  "crystal/cleanup": typeof crystal_cleanup;
  "crystal/consolidate": typeof crystal_consolidate;
  "crystal/contentScanner": typeof crystal_contentScanner;
  "crystal/crypto": typeof crystal_crypto;
  "crystal/dashboard": typeof crystal_dashboard;
  "crystal/dashboardTotals": typeof crystal_dashboardTotals;
  "crystal/decay": typeof crystal_decay;
  "crystal/deviceAuth": typeof crystal_deviceAuth;
  "crystal/deviceHttp": typeof crystal_deviceHttp;
  "crystal/emailCrons": typeof crystal_emailCrons;
  "crystal/emailDefaults": typeof crystal_emailDefaults;
  "crystal/emailEngine": typeof crystal_emailEngine;
  "crystal/emailTemplates": typeof crystal_emailTemplates;
  "crystal/emergencyMorrowPurge": typeof crystal_emergencyMorrowPurge;
  "crystal/evalStats": typeof crystal_evalStats;
  "crystal/geminiGuardrail": typeof crystal_geminiGuardrail;
  "crystal/graph": typeof crystal_graph;
  "crystal/graphEnrich": typeof crystal_graphEnrich;
  "crystal/graphQuery": typeof crystal_graphQuery;
  "crystal/httpAuth": typeof crystal_httpAuth;
  "crystal/impersonation": typeof crystal_impersonation;
  "crystal/knowledgeBases": typeof crystal_knowledgeBases;
  "crystal/knowledgeHttp": typeof crystal_knowledgeHttp;
  "crystal/mcp": typeof crystal_mcp;
  "crystal/memories": typeof crystal_memories;
  "crystal/messages": typeof crystal_messages;
  "crystal/morrowPurge": typeof crystal_morrowPurge;
  "crystal/organic/activityLog": typeof crystal_organic_activityLog;
  "crystal/organic/adminTick": typeof crystal_organic_adminTick;
  "crystal/organic/contradictions": typeof crystal_organic_contradictions;
  "crystal/organic/discoveryFiber": typeof crystal_organic_discoveryFiber;
  "crystal/organic/ensembles": typeof crystal_organic_ensembles;
  "crystal/organic/http": typeof crystal_organic_http;
  "crystal/organic/ideaDigest": typeof crystal_organic_ideaDigest;
  "crystal/organic/ideas": typeof crystal_organic_ideas;
  "crystal/organic/models": typeof crystal_organic_models;
  "crystal/organic/organic": typeof crystal_organic_organic;
  "crystal/organic/policyTuner": typeof crystal_organic_policyTuner;
  "crystal/organic/proceduralExtraction": typeof crystal_organic_proceduralExtraction;
  "crystal/organic/recallLog": typeof crystal_organic_recallLog;
  "crystal/organic/replayEval": typeof crystal_organic_replayEval;
  "crystal/organic/replayReport": typeof crystal_organic_replayReport;
  "crystal/organic/resonance": typeof crystal_organic_resonance;
  "crystal/organic/skillSuggestions": typeof crystal_organic_skillSuggestions;
  "crystal/organic/spend": typeof crystal_organic_spend;
  "crystal/organic/tick": typeof crystal_organic_tick;
  "crystal/organic/traces": typeof crystal_organic_traces;
  "crystal/organic/utils": typeof crystal_organic_utils;
  "crystal/permissions": typeof crystal_permissions;
  "crystal/polarWebhook": typeof crystal_polarWebhook;
  "crystal/recall": typeof crystal_recall;
  "crystal/recallRanking": typeof crystal_recallRanking;
  "crystal/reembed": typeof crystal_reembed;
  "crystal/reflection": typeof crystal_reflection;
  "crystal/salience": typeof crystal_salience;
  "crystal/sensoryPurge": typeof crystal_sensoryPurge;
  "crystal/sessions": typeof crystal_sessions;
  "crystal/snapshots": typeof crystal_snapshots;
  "crystal/stats": typeof crystal_stats;
  "crystal/stmEmbedder": typeof crystal_stmEmbedder;
  "crystal/temporalParser": typeof crystal_temporalParser;
  "crystal/userProfiles": typeof crystal_userProfiles;
  "crystal/wake": typeof crystal_wake;
  email: typeof email;
  "eslint_rules/no_public_userid_arg": typeof eslint_rules_no_public_userid_arg;
  http: typeof http;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
