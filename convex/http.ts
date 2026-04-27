import { httpRouter } from "convex/server";
import { auth } from "./auth";
import {
  mcpAuth,
  mcpCapture,
  mcpAsset,
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
  mcpGraphStatus,
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
import { deviceStart, deviceStatus } from "./crystal/deviceHttp";
import {
  organicListIdeas,
  organicUpdateIdea,
  organicPendingIdeas,
  organicRecallLog,
} from "./crystal/organic/http";
import { knowledgeBasesItem, knowledgeBasesRoot } from "./crystal/knowledgeHttp";

const http = httpRouter();

auth.addHttpRoutes(http);

http.route({ path: "/api/mcp/capture", method: "POST", handler: mcpCapture });
http.route({ path: "/api/mcp/asset", method: "POST", handler: mcpAsset });
http.route({ path: "/api/mcp/memory", method: "POST", handler: mcpGetMemory });
http.route({ path: "/api/mcp/edit", method: "POST", handler: mcpEdit });
http.route({ path: "/api/mcp/update", method: "POST", handler: mcpUpdate });
http.route({ path: "/api/mcp/supersede", method: "POST", handler: mcpSupersede });
http.route({ path: "/api/mcp/supercede", method: "POST", handler: mcpSupersede });
http.route({ path: "/api/mcp/forget", method: "POST", handler: mcpForget });
http.route({ path: "/api/mcp/recall", method: "POST", handler: mcpRecall });
http.route({ path: "/api/mcp/triggers", method: "GET", handler: mcpGetTriggers });
http.route({ path: "/api/mcp/triggers", method: "POST", handler: mcpGetTriggers });
http.route({ path: "/api/mcp/search-messages", method: "POST", handler: mcpSearchMessages });
http.route({ path: "/api/mcp/recent-messages", method: "POST", handler: mcpRecentMessages });
http.route({ path: "/api/mcp/session", method: "POST", handler: mcpDescribeSession });
http.route({ path: "/api/mcp/checkpoint", method: "POST", handler: mcpCheckpoint });
http.route({ path: "/api/mcp/wake", method: "GET", handler: mcpWakeGet });
http.route({ path: "/api/mcp/wake", method: "POST", handler: mcpWakePost });
http.route({ path: "/api/mcp/log", method: "POST", handler: mcpLog });
http.route({ path: "/api/mcp/metric", method: "POST", handler: mcpMetric });
http.route({ path: "/api/mcp/reflect", method: "POST", handler: mcpReflect });
http.route({ path: "/api/mcp/stats", method: "GET", handler: mcpStats });
http.route({ path: "/api/mcp/stats", method: "POST", handler: mcpStats });
http.route({ path: "/api/mcp/graph-status", method: "GET", handler: mcpGraphStatus });
http.route({ path: "/api/mcp/rate-limit-check", method: "POST", handler: mcpRateLimitCheck });
http.route({ path: "/api/mcp/upload-url", method: "POST", handler: mcpUploadUrl });
http.route({ path: "/api/mcp/trace", method: "POST", handler: mcpTrace });
http.route({ path: "/api/mcp/snapshot", method: "POST", handler: mcpSnapshot });
http.route({ path: "/api/organic/conversationPulse", method: "POST", handler: mcpConversationPulse });
http.route({ path: "/api/organic/ideas", method: "POST", handler: organicListIdeas });
http.route({ path: "/api/organic/ideas/update", method: "POST", handler: organicUpdateIdea });
http.route({ path: "/api/organic/ideas/pending", method: "POST", handler: organicPendingIdeas });
http.route({ path: "/api/organic/recallLog", method: "POST", handler: organicRecallLog });
http.route({ path: "/api/knowledge-bases", method: "GET", handler: knowledgeBasesRoot });
http.route({ path: "/api/knowledge-bases", method: "POST", handler: knowledgeBasesRoot });
http.route({ pathPrefix: "/api/knowledge-bases/", method: "GET", handler: knowledgeBasesItem });
http.route({ pathPrefix: "/api/knowledge-bases/", method: "POST", handler: knowledgeBasesItem });
http.route({ pathPrefix: "/api/knowledge-bases/", method: "DELETE", handler: knowledgeBasesItem });
http.route({ pathPrefix: "/api/knowledge-bases/", method: "PATCH", handler: knowledgeBasesItem });
http.route({ path: "/api/device/start", method: "POST", handler: deviceStart });
http.route({ path: "/api/device/status", method: "GET", handler: deviceStatus });
// Backwards-compatible auth aliases
http.route({ path: "/api/mcp-auth", method: "POST", handler: mcpAuth });
http.route({ path: "/api/mcp/auth", method: "GET", handler: mcpAuth });
http.route({ path: "/api/mcp/auth", method: "POST", handler: mcpAuth });

export default http;
