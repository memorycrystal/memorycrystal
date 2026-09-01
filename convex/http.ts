import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import {
  mcpAuth,
  mcpWhoami,
  mcpCapture,
  mcpAsset,
  mcpAssetUpload,
  mcpAssetDelete,
  mcpAssetMetadata,
  mcpAssetReadProxy,
  mcpAssetReadUrl,
  mcpAssetRetry,
  mcpGetMemory,
  mcpLog,
  mcpCheckpoint,
  mcpRecentMessages,
  mcpRecall,
  mcpSearchMessages,
  mcpDescribeSession,
  mcpEdit,
  mcpUpdate,
  mcpSupersede,
  mcpForget,
  mcpReflect,
  mcpStats,
  mcpHealth,
  mcpGraphDependencyChain,
  mcpGraphExplainConnection,
  mcpGraphStatus,
  mcpGraphWhoOwns,
  mcpGetTriggers,
  mcpWakeGet,
  mcpWakePost,
  mcpUploadUrl,
  mcpMetric,
  mcpTrace,
  mcpSnapshot,
  mcpRateLimitCheck,
  mcpConversationPulse,
} from "./crystal/mcp";
import { memoriesExport } from "./crystal/memoriesExport";
import { turnCapture } from "./crystal/turnCapture";
import { deviceStart, deviceStatus } from "./crystal/deviceHttp";
import {
  organicListIdeas,
  organicUpdateIdea,
  organicPendingIdeas,
  organicRecallLog,
} from "./crystal/organic/http";
import {
  knowledgeBasesItem,
  knowledgeBasesRoot,
} from "./crystal/knowledgeHttp";
import {
  researchCollectionsRoot,
  researchOperations,
} from "./crystal/researchHttp";

const http = httpRouter();

const writesFrozen = httpAction(
  async () =>
    new Response(
      JSON.stringify({
        error:
          "Memory Crystal is temporarily read-only for a database migration.",
        code: "migration_write_freeze",
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": "300",
        },
      },
    ),
);

/**
 * Central cutover guard for application HTTP routes. GET remains available for
 * read-only verification; every other route registered through this helper is
 * replaced with a deterministic 503 while CRYSTAL_WRITE_FREEZE=1. Convex SDK
 * mutations are frozen by stopping the web and MCP Railway services during the
 * final snapshot window. Auth-library routes are omitted entirely during a
 * freeze because they are registered by the auth package outside this helper.
 */
function route(spec: Parameters<typeof http.route>[0]) {
  const isRead = spec.method === "GET";
  http.route(
    !isRead && process.env.CRYSTAL_WRITE_FREEZE === "1"
      ? { ...spec, handler: writesFrozen }
      : spec,
  );
}

if (process.env.CRYSTAL_WRITE_FREEZE !== "1") {
  auth.addHttpRoutes(http);
}

route({ path: "/api/mcp/capture", method: "POST", handler: mcpCapture });
route({ path: "/api/mcp/asset", method: "POST", handler: mcpAsset });
route({
  path: "/api/mcp/asset/upload",
  method: "POST",
  handler: mcpAssetUpload,
});
route({
  path: "/api/mcp/asset/metadata",
  method: "POST",
  handler: mcpAssetMetadata,
});
route({
  path: "/api/mcp/asset/read-url",
  method: "POST",
  handler: mcpAssetReadUrl,
});
route({
  pathPrefix: "/api/assets/",
  method: "GET",
  handler: mcpAssetReadProxy,
});
route({
  path: "/api/mcp/asset/delete",
  method: "POST",
  handler: mcpAssetDelete,
});
route({ path: "/api/mcp/asset/retry", method: "POST", handler: mcpAssetRetry });
route({ path: "/api/mcp/memory", method: "POST", handler: mcpGetMemory });
route({ path: "/api/mcp/edit", method: "POST", handler: mcpEdit });
route({ path: "/api/mcp/update", method: "POST", handler: mcpUpdate });
route({ path: "/api/mcp/supersede", method: "POST", handler: mcpSupersede });
route({ path: "/api/mcp/supercede", method: "POST", handler: mcpSupersede });
route({ path: "/api/mcp/forget", method: "POST", handler: mcpForget });
route({ path: "/api/mcp/recall", method: "POST", handler: mcpRecall });
route({ path: "/api/mcp/triggers", method: "GET", handler: mcpGetTriggers });
route({ path: "/api/mcp/triggers", method: "POST", handler: mcpGetTriggers });
route({
  path: "/api/mcp/search-messages",
  method: "POST",
  handler: mcpSearchMessages,
});
route({
  path: "/api/mcp/recent-messages",
  method: "POST",
  handler: mcpRecentMessages,
});
route({
  path: "/api/mcp/session",
  method: "POST",
  handler: mcpDescribeSession,
});
route({ path: "/api/mcp/checkpoint", method: "POST", handler: mcpCheckpoint });
route({ path: "/api/mcp/wake", method: "GET", handler: mcpWakeGet });
route({ path: "/api/mcp/wake", method: "POST", handler: mcpWakePost });
route({ path: "/api/mcp/log", method: "POST", handler: mcpLog });
// Idempotent by (userId, turnId) — see convex/crystal/turnCapture.ts.
route({ path: "/api/mcp/turn", method: "POST", handler: turnCapture });
route({ path: "/api/mcp/metric", method: "POST", handler: mcpMetric });
route({ path: "/api/mcp/reflect", method: "POST", handler: mcpReflect });
route({ path: "/api/mcp/stats", method: "GET", handler: mcpStats });
route({ path: "/api/mcp/stats", method: "POST", handler: mcpStats });
route({ path: "/api/mcp/health", method: "GET", handler: mcpHealth });
route({ path: "/api/mcp/health", method: "POST", handler: mcpHealth });
route({
  path: "/api/mcp/graph-status",
  method: "GET",
  handler: mcpGraphStatus,
});
route({
  path: "/api/mcp/graph/who-owns",
  method: "POST",
  handler: mcpGraphWhoOwns,
});
route({
  path: "/api/mcp/graph/explain-connection",
  method: "POST",
  handler: mcpGraphExplainConnection,
});
route({
  path: "/api/mcp/graph/dependency-chain",
  method: "POST",
  handler: mcpGraphDependencyChain,
});
route({
  path: "/api/mcp/rate-limit-check",
  method: "POST",
  handler: mcpRateLimitCheck,
});
route({ path: "/api/mcp/upload-url", method: "POST", handler: mcpUploadUrl });
route({ path: "/api/mcp/trace", method: "POST", handler: mcpTrace });
route({ path: "/api/mcp/snapshot", method: "POST", handler: mcpSnapshot });
// API-key-authenticated paginated memory export (migration / GDPR).
route({ path: "/api/memories", method: "GET", handler: memoriesExport });
route({
  path: "/api/organic/conversationPulse",
  method: "POST",
  handler: mcpConversationPulse,
});
route({
  path: "/api/organic/ideas",
  method: "POST",
  handler: organicListIdeas,
});
route({
  path: "/api/organic/ideas/update",
  method: "POST",
  handler: organicUpdateIdea,
});
route({
  path: "/api/organic/ideas/pending",
  method: "POST",
  handler: organicPendingIdeas,
});
route({
  path: "/api/organic/recallLog",
  method: "POST",
  handler: organicRecallLog,
});
route({
  path: "/api/knowledge-bases",
  method: "GET",
  handler: knowledgeBasesRoot,
});
route({
  path: "/api/knowledge-bases",
  method: "POST",
  handler: knowledgeBasesRoot,
});
route({
  pathPrefix: "/api/knowledge-bases/",
  method: "GET",
  handler: knowledgeBasesItem,
});
route({
  pathPrefix: "/api/knowledge-bases/",
  method: "POST",
  handler: knowledgeBasesItem,
});
route({
  pathPrefix: "/api/knowledge-bases/",
  method: "DELETE",
  handler: knowledgeBasesItem,
});
route({
  pathPrefix: "/api/knowledge-bases/",
  method: "PATCH",
  handler: knowledgeBasesItem,
});
route({
  path: "/api/research/collections",
  method: "GET",
  handler: researchCollectionsRoot,
});
route({
  path: "/api/research/collections",
  method: "POST",
  handler: researchCollectionsRoot,
});
route({
  pathPrefix: "/api/research/",
  method: "GET",
  handler: researchOperations,
});
route({
  pathPrefix: "/api/research/",
  method: "POST",
  handler: researchOperations,
});
// Cloud control-plane telemetry push endpoint (M6)

route({ path: "/api/device/start", method: "POST", handler: deviceStart });
route({ path: "/api/device/status", method: "GET", handler: deviceStatus });
// Backwards-compatible auth aliases
route({ path: "/api/mcp-auth", method: "POST", handler: mcpAuth });
route({ path: "/api/mcp/auth", method: "GET", handler: mcpAuth });
route({ path: "/api/mcp/auth", method: "POST", handler: mcpAuth });
route({ path: "/api/mcp/whoami", method: "GET", handler: mcpWhoami });
route({ path: "/api/mcp/whoami", method: "POST", handler: mcpWhoami });

export default http;
