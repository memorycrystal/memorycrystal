// Canonical MCP tool contract for both servers.
// Edit this file, then run `node scripts/generate-mcp-tool-contract.mjs`.
// The generator copies it into mcp-server and packages/mcp-server. Each package
// compiles its own copy. Neither package depends on this directory at runtime.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const DEFAULT_RECALL_LIMIT = 12;
export const RECALL_MEMORY_CONTENT_MAX = 600;
export const RECALL_MESSAGE_CONTENT_MAX = 200;
export const RECALL_ASSET_CONTENT_MAX = 300;

const SECRET_KEY_NAME = String.raw`(?!(?:[A-Za-z0-9_-]{0,64}token[A-Za-z0-9_-]{0,64}count[A-Za-z0-9_-]{0,64})\b)(?:[A-Za-z0-9_-]{0,64}(?:api[_-]?key|apiKey|token|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|idToken|auth[_-]?token|authToken|secret|client[_-]?secret|clientSecret|password|passwd|private[_-]?key|privateKey)[A-Za-z0-9_-]{0,64})`;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9+/_=.-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{10,}\b/g, "sk-[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, "ghp_[REDACTED]"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [new RegExp(`([?&]${SECRET_KEY_NAME}=)[^&\\s]+`, "gi"), "$1[REDACTED]"],
  [new RegExp(`(\\b["']?${SECRET_KEY_NAME}["']?\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^"',\\s}\\n]+)`, "gi"), "$1[REDACTED]"],
  [new RegExp(`(\\b["']?${SECRET_KEY_NAME}["']?\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^,}\\n]+)`, "gi"), "$1[REDACTED]"],
];

const memoryStores = ["sensory", "episodic", "semantic", "procedural", "prospective"] as const;
const memoryCategories = [
  "decision", "lesson", "person", "rule", "event", "fact", "goal", "skill", "workflow", "conversation",
] as const;
const recallModes = ["general", "decision", "project", "people", "workflow", "conversation"] as const;

export type ToolRoute = { method: "GET" | "POST" | "PATCH"; path: string };

export type ToolContract = {
  name: string;
  title: string;
  description: string;
  route: ToolRoute;
  trimmer: string;
  input: Record<string, z.ZodTypeAny>;
  annotations?: Tool["annotations"];
};

/** Cut recall memory content at `max` characters. `truncated` is set only when the text is cut. */
export function applyRecallContentLimit(
  text: string | undefined,
  max = RECALL_MEMORY_CONTENT_MAX,
): { content: string; truncated?: true } {
  const value = typeof text === "string" ? text : "";
  if (value.length <= max) return { content: value };
  // Cut by code point to avoid splitting a surrogate pair.
  const chars = [...value];
  if (chars.length <= max) return { content: value };
  // If the last full code point at max-1 starts a surrogate pair, cut one
  // code point earlier so we never emit a lone surrogate.
  const lastChar = chars[max - 1];
  const cp = lastChar ? lastChar.codePointAt(0) : undefined;
  if (cp !== undefined && cp >= 0xd800 && cp <= 0xdbff) {
    return { content: chars.slice(0, max - 1).join(""), truncated: true };
  }
  return { content: chars.slice(0, max).join(""), truncated: true };
}

/** Redact likely secrets from recalled message text using the hosted bridge patterns. */
export function redactRecallMessageText(text: string | undefined): string {
  const normalizedText = typeof text === "string" ? text : "";
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), normalizedText);
}

/** Trim one recalled message to the shared hosted shape and bounded excerpt. */
export function trimRecallMessage(message: any, contentMax = RECALL_MESSAGE_CONTENT_MAX) {
  const limited = applyRecallContentLimit(redactRecallMessageText(message.content), contentMax);
  return {
    messageId: message.messageId ?? message._id,
    role: message.role,
    content: limited.truncated ? `${limited.content}…` : limited.content,
    channel: message.channel,
    sessionKey: message.sessionKey,
    timestamp: message.timestamp,
    score: message.score,
    ...(Array.isArray(message.subjects) && message.subjects.length > 0
      ? { subjects: message.subjects }
      : {}),
    ...(typeof message.relevance === "number" ? { relevance: message.relevance } : {}),
  };
}

/** Trim valid recalled message rows and ignore malformed backend entries. */
export function trimRecallMessages(rows: unknown, contentMax = RECALL_MESSAGE_CONTENT_MAX) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row !== null && typeof row === "object" && !Array.isArray(row))
    .map((row) => trimRecallMessage(row, contentMax));
}

/** Pass `relatedExisting` through unchanged in shape, capped at three rows. */
export function trimRememberResponse<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  if (!("relatedExisting" in record)) return result;
  const related = Array.isArray(record.relatedExisting)
    ? record.relatedExisting.slice(0, 3).map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return { memoryId: row.memoryId, title: row.title, createdAt: row.createdAt };
      })
    : record.relatedExisting;
  return { ...record, relatedExisting: related } as T;
}

const scopeFields = {
  channel: z.string().optional().describe("Filter recall to a channel or peer scope"),
  sessionKey: z.string().optional().describe("Session key for transcript-aware recall"),
  agentId: z.string().optional().describe("Agent identifier for scoped KB visibility and source-role ranking"),
  projectId: z.string().optional().describe("Project store ID for repo-scoped recall"),
  repoSlug: z.string().optional().describe("Repository slug for automatic project-store scoping"),
};

export const crystal_recall: ToolContract = {
  name: "crystal_recall",
  title: "Recall memories",
  description: "Lean semantic and lexical recall over durable Memory Crystal memories. Use crystal_query_knowledge_base for explicit named reference corpora and pass agentId/projectId/repoSlug when scoped. Memory content over 600 characters is cut and flagged truncated; call crystal_get_memory with the memoryId for the full text. The message lane returns bounded short-term message matches; retrieval.messageMatchesAvailable is a lower bound capped at messageLimit + 1, and retrieval.messageScan reports scan coverage. messageLimit controls returned matches (0 disables them; default 3, maximum 10). turnId excludes a matching user message from that capture turn when it falls within the own-prompt suppression window; excludeRecentMessagesMs widens that window in milliseconds (effective default at least 120 seconds, backend maximum 24 hours).",
  route: { method: "POST", path: "/api/mcp/recall" },
  trimmer: "trimRecallResponse",
  input: {
    query: z.string().min(1).describe("Search query"),
    mode: z.enum(recallModes).optional().describe(
      "Recall mode preset. 'decision' prioritizes decisions/lessons. 'project' pulls goals/workflows/facts. 'people' focuses on person memories. 'workflow' pulls procedural rules. 'conversation' pulls recent context. Default: 'general'.",
    ),
    stores: z.array(z.enum(memoryStores)).optional().describe("Filter by memory stores"),
    categories: z.array(z.enum(memoryCategories)).optional().describe("Filter by categories"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    limit: z.number().int().min(1).max(20).default(DEFAULT_RECALL_LIMIT).optional().describe("Maximum results"),
    includeArchived: z.boolean().optional().describe("Include archived memories"),
    messageLimit: z.number().int().min(0).max(10).optional().describe("Maximum message matches (0 disables them; default 3, maximum 10)"),
    turnId: z.string().optional().describe("Current capture turn id; a matching user message within the own-prompt suppression window is excluded"),
    excludeRecentMessagesMs: z.number().int().min(0).optional().describe("Widen the own-prompt echo suppression window in milliseconds; its effective default is at least 120 seconds, with a backend maximum of 24 hours"),
    ...scopeFields,
    scopeToSession: z.boolean().optional().describe(
      "Opt-in. When true and a sessionKey is supplied, restrict recall to memories from that session. Off by default.",
    ),
  },
};

export const crystal_remember: ToolContract = {
  name: "crystal_remember",
  title: "Remember",
  description: "Create a Memory Crystal memory. The response includes relatedExisting: up to three active same-scope memories whose title or content is lexically similar. Use crystal_supersede to replace a stale memory instead of saving a duplicate.",
  route: { method: "POST", path: "/api/mcp/capture" },
  trimmer: "trimRememberResponse",
  input: {
    title: z.string().min(5).max(80).describe("Short descriptive title"),
    content: z.string().describe("Memory content"),
    store: z.enum(memoryStores).describe("Memory store"),
    category: z.enum(memoryCategories).describe("Memory category"),
    tags: z.array(z.string()).optional().describe("Tags for the memory"),
    confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1"),
    valence: z.number().min(-1).max(1).optional().describe("Emotional valence -1 to 1"),
    arousal: z.number().min(0).max(1).optional().describe("Arousal level 0-1"),
    channel: z.string().optional().describe("Channel identifier"),
    agentId: z.string().optional().describe("Agent/profile identifier to store in metadata"),
    projectId: z.string().optional().describe("Project store ID for repo-scoped memory"),
    repoSlug: z.string().optional().describe("Repository slug for automatic project-store scoping"),
  },
};

export const crystal_update: ToolContract = {
  name: "crystal_update",
  title: "Update memory",
  description:
    "Update an existing Memory Crystal memory in place. Use for correcting or enriching the same memory without creating a replacement. A title, content, metadata, tags or actionTriggers value containing a redaction placeholder such as [REDACTED] (as returned by memory reads) is refused with 409 redacted_content_write when the stored field holds a secret, so a read-modify-write cannot overwrite it; set allowRedactedContent: true to write the placeholder deliberately.",
  route: { method: "POST", path: "/api/mcp/update" },
  trimmer: "none",
  input: {
    memoryId: z.string().min(1).describe("Memory ID to update"),
    title: z.string().optional().describe("Updated title"),
    content: z.string().optional().describe("Updated content"),
    metadata: z.string().optional().describe("Updated metadata"),
    tags: z.array(z.string()).optional().describe("Updated tags"),
    store: z.enum(memoryStores).optional().describe("Updated memory store"),
    category: z.enum(memoryCategories).optional().describe("Updated memory category"),
    confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1"),
    strength: z.number().min(0).max(1).optional().describe("Strength score 0-1"),
    valence: z.number().min(-1).max(1).optional().describe("Emotional valence -1 to 1"),
    arousal: z.number().min(0).max(1).optional().describe("Arousal level 0-1"),
    actionTriggers: z.array(z.string()).optional().describe("Tool names that should surface this memory before execution"),
    channel: z.string().optional().describe("New stored channel for the memory (re-homes it); use scopeChannel for visibility scope"),
    scopeChannel: z.string().optional().describe("Channel or peer scope for visibility enforcement; the stored channel is unchanged"),
    agentId: z.string().optional().describe("Agent identifier for knowledge-base visibility"),
    allowRedactedContent: z
      .boolean()
      .optional()
      .describe("Set true to deliberately write text containing a redaction placeholder over a stored secret. Sent only when true."),
  },
};

export const crystal_supersede: ToolContract = {
  name: "crystal_supersede",
  title: "Supersede memory",
  description:
    "Atomically replace a stale or incorrect memory with a successor. The old memory is archived and linked to the new memory. A title, content, metadata, tags or actionTriggers value containing a redaction placeholder such as [REDACTED] (as returned by memory reads) is refused with 409 redacted_content_write when the old memory stores a secret in that field, so a read-modify-write cannot overwrite it; set allowRedactedContent: true to write the placeholder deliberately.",
  route: { method: "POST", path: "/api/mcp/supersede" },
  trimmer: "none",
  input: {
    oldMemoryId: z.string().min(1).describe("Memory ID to replace"),
    title: z.string().min(5).max(500).describe("Successor memory title"),
    content: z.string().min(1).max(50000).describe("Successor memory content"),
    store: z.enum(memoryStores).optional().describe("Successor memory store"),
    category: z.enum(memoryCategories).optional().describe("Successor memory category"),
    tags: z.array(z.string()).optional().describe("Successor tags"),
    metadata: z.string().optional().describe("Successor metadata"),
    confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1"),
    strength: z.number().min(0).max(1).optional().describe("Strength score 0-1"),
    valence: z.number().min(-1).max(1).optional().describe("Emotional valence -1 to 1"),
    arousal: z.number().min(0).max(1).optional().describe("Arousal level 0-1"),
    actionTriggers: z.array(z.string()).optional().describe("Tool names that should surface this memory before execution"),
    channel: z.string().optional().describe("Stored channel for the successor (defaults to the old memory's channel); use scopeChannel for visibility scope"),
    scopeChannel: z.string().optional().describe("Channel or peer scope for visibility enforcement on the old memory"),
    agentId: z.string().optional().describe("Agent identifier for knowledge-base visibility"),
    reason: z.string().optional().describe("Reason for superseding the old memory"),
    allowRedactedContent: z
      .boolean()
      .optional()
      .describe("Set true to deliberately write text containing a redaction placeholder over a secret stored in the old memory. Sent only when true."),
  },
};

export const crystal_recent: ToolContract = {
  name: "crystal_recent",
  title: "Recent messages",
  description: "Fetch the most recent short-term messages, optionally bounded to a time window (sinceMs/fromMs/toMs epoch ms or startDate/endDate ISO) and scoped to a channel. Use crystal_search_messages when the question is lexical relevance rather than recency.",
  route: { method: "POST", path: "/api/mcp/recent-messages" },
  trimmer: "trimMessage",
  input: {
    limit: z.number().int().min(1).max(100).default(20).optional().describe("Maximum messages"),
    channel: z.string().optional().describe("Filter by channel"),
    sessionKey: z.string().optional().describe("Filter by exact session key"),
    sinceMs: z.number().optional().describe("Lower time bound (epoch ms). Alias of fromMs."),
    fromMs: z.number().optional().describe("Lower time bound of the window (epoch ms)."),
    toMs: z.number().optional().describe("Upper time bound of the window (epoch ms)."),
    startDate: z.string().optional().describe("Lower time bound as an ISO date or datetime."),
    endDate: z.string().optional().describe("Upper time bound as an ISO date or datetime."),
    order: z.enum(["chronological", "newest"]).optional().describe("Return messages in chronological order or newest first"),
  },
};

export const crystal_search_messages: ToolContract = {
  name: "crystal_search_messages",
  title: "Search messages",
  description: "Lexical search over retained short-term messages. It does not embed the query. Scope with channel and sessionKey, bound a window with sinceMs, fromMs, toMs, startDate, or endDate, and page with offset (response.pagination.hasMore/nextOffset). Never assume the first page is complete; walk all pages before asserting a date range is empty. It is not graph-ranked broad recall.",
  route: { method: "POST", path: "/api/mcp/search-messages" },
  trimmer: "trimMessage",
  input: {
    query: z.string().min(1).describe("Search query"),
    limit: z.number().int().min(1).max(100).default(10).optional().describe("Maximum results"),
    channel: z.string().optional().describe("Filter by exact channel or peer scope"),
    sessionKey: z.string().optional().describe("Filter by exact session key"),
    sinceMs: z.number().optional().describe("Lower time bound (epoch ms). Alias of fromMs."),
    fromMs: z.number().optional().describe("Lower time bound of the window (epoch ms)."),
    toMs: z.number().optional().describe("Upper time bound of the window (epoch ms)."),
    startDate: z.string().optional().describe("Lower time bound as an ISO date or datetime."),
    endDate: z.string().optional().describe("Upper time bound as an ISO date or datetime."),
    offset: z.number().int().min(0).optional().describe("Skip this many ranked results for pagination; use response.pagination.nextOffset to walk the full set."),
  },
};

export const crystal_what_do_i_know: ToolContract = {
  name: "crystal_what_do_i_know",
  title: "What do I know",
  description: "Broad bounded topic scan over durable Memory Crystal memories. Use for planning context; use KB query for named reference corpora.",
  route: { method: "POST", path: "/api/mcp/recall" },
  trimmer: "trimRecallResponse",
  input: {
    topic: z.string().min(3).describe("Topic to scan"),
    limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
    stores: z.array(z.enum(memoryStores)).optional().describe("Filter by stores"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    ...scopeFields,
  },
};

export const crystal_why_did_we: ToolContract = {
  name: "crystal_why_did_we",
  title: "Why did we",
  description: "Decision archaeology across Memory Crystal decision memories.",
  route: { method: "POST", path: "/api/mcp/recall" },
  trimmer: "trimRecallResponse",
  input: {
    decision: z.string().min(3).describe("The decision to investigate"),
    limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
    channel: z.string().optional().describe("Filter recall to a channel or peer scope"),
    sessionKey: z.string().optional().describe("Session key for transcript-aware recall"),
    agentId: z.string().optional().describe("Agent identifier for knowledge-base visibility"),
    projectId: z.string().optional().describe("Project store ID for repo-scoped recall"),
    repoSlug: z.string().optional().describe("Repository slug for automatic project-store scoping"),
  },
};

export const crystal_forget: ToolContract = {
  name: "crystal_forget",
  title: "Forget memory",
  description: "Archive or permanently delete a memory. Use archive (permanent=false, the default) to soft-delete so the memory can be recovered. Use permanent=true only when you are certain the memory should be irretrievably deleted.",
  route: { method: "POST", path: "/api/mcp/forget" },
  trimmer: "none",
  input: {
    memoryId: z.string().describe("The memory ID to archive"),
    permanent: z.boolean().optional().describe("Permanently delete instead of archiving"),
    reason: z.string().optional().describe("Optional reason recorded with the archive or delete"),
    channel: z.string().optional().describe("Channel or peer scope for visibility enforcement"),
    agentId: z.string().optional().describe("Agent identifier for knowledge-base visibility"),
  },
};

export const crystal_stats: ToolContract = {
  name: "crystal_stats",
  title: "Memory stats",
  description: "Get Memory Crystal usage statistics: store counts, archive count, and account identity. This is not the liveness check; use crystal_health for that. channel is accepted and forwarded; the statistics are account-wide.",
  route: { method: "GET", path: "/api/mcp/stats" },
  trimmer: "none",
  input: {
    channel: z.string().optional().describe("Accepted and forwarded. Statistics stay account-wide."),
  },
};

export const crystal_checkpoint: ToolContract = {
  name: "crystal_checkpoint",
  title: "Create checkpoint",
  description: "Create a manual Memory Crystal checkpoint only when the user explicitly asks for a checkpoint or backup, or list checkpoints when mode is list. Checkpoints are bounded durable-memory backups. The backend currently ignores createdBy and semanticSummary.",
  route: { method: "POST", path: "/api/mcp/checkpoint" },
  trimmer: "none",
  input: {
    mode: z.enum(["create", "list"]).optional().describe("create (default) or list"),
    label: z.string().optional().describe("Checkpoint label/summary"),
    description: z.string().optional().describe("Longer description"),
    memoryIds: z.array(z.string()).optional().describe("Memory ids included in the checkpoint"),
    sessionId: z.string().optional().describe("Session id to attach"),
    sessionKey: z.string().optional().describe("Session key"),
    semanticSummary: z.string().optional().describe("Optional semantic summary; the backend currently ignores this field"),
    tags: z.array(z.string()).optional().describe("Checkpoint tags"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum checkpoints to list"),
    createdBy: z.string().optional().describe("Optional creator label; the backend currently ignores this field"),
    channel: z.string().optional().describe("Channel identifier"),
  },
};

export const crystal_wake: ToolContract = {
  name: "crystal_wake",
  title: "Wake briefing",
  description: "Get an opening briefing for the current memory session.",
  route: { method: "POST", path: "/api/mcp/wake" },
  trimmer: "trimWake",
  input: {
    channel: z.string().optional().describe("Channel identifier"),
    agentId: z.string().optional().describe("Agent identifier for scoped KB visibility"),
  },
};

export const crystal_preflight: ToolContract = {
  name: "crystal_preflight",
  title: "Pre-flight check",
  description: "ALWAYS call this before any config change, API write, file deletion, external message send, or production system modification. Bounded recall of scoped rules, lessons, and past decisions. Pass projectId/repoSlug for repo-specific work.",
  route: { method: "POST", path: "/api/mcp/recall" },
  trimmer: "trimRecallResponse",
  input: {
    action: z.string().min(3).describe("Description of the action you are about to take"),
    limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
    channel: z.string().optional().describe("Filter recall to a channel or peer scope"),
    sessionKey: z.string().optional().describe("Session key for transcript-aware recall"),
    agentId: z.string().optional().describe("Agent identifier for scoped KB visibility"),
    projectId: z.string().optional().describe("Project store ID for repo-scoped preflight"),
    repoSlug: z.string().optional().describe("Repository slug for automatic project-store scoping"),
  },
};

export const crystal_trace: ToolContract = {
  name: "crystal_trace",
  title: "Crystal Trace",
  description: "Trace a memory back to its source conversation. Returns the conversation snapshot that created this memory.",
  route: { method: "POST", path: "/api/mcp/trace" },
  trimmer: "none",
  input: {
    memoryId: z.string().min(1).describe("The memory ID to trace"),
    channel: z.string().optional().describe("Channel or peer scope for visibility enforcement"),
    agentId: z.string().optional().describe("Agent identifier for knowledge-base visibility"),
  },
};

export const crystal_get_memory: ToolContract = {
  name: "crystal_get_memory",
  title: "Get full memory",
  description: "Fetch a memory's full text. Use after crystal_recall returns a result flagged truncated to read the complete memory.",
  route: { method: "POST", path: "/api/mcp/memory" },
  trimmer: "none",
  input: {
    memoryId: z.string().min(1).describe("The memory ID to fetch"),
    channel: z.string().optional().describe("Channel or peer scope for visibility enforcement"),
    agentId: z.string().optional().describe("Agent identifier for knowledge-base visibility"),
    projectId: z.string().optional().describe("Project store ID for repo-scoped recall"),
    repoSlug: z.string().optional().describe("Repository slug for automatic project-store scoping"),
  },
};

export const crystal_create_knowledge_base: ToolContract = {
  name: "crystal_create_knowledge_base",
  title: "Create knowledge base",
  description: "Create a Memory Crystal knowledge base for reference material. Set sourceRole for canonical references, voice/style corpora, persona guardrails, or client context.",
  route: { method: "POST", path: "/api/knowledge-bases" },
  trimmer: "none",
  input: {
    name: z.string().describe("Knowledge base name"),
    description: z.string().optional().describe("Optional knowledge base description"),
    scope: z.string().optional().describe("Optional scope for tenant or agent grouping"),
    sourceType: z.string().optional().describe("Optional source type"),
    sourceRole: z.string().optional().describe("Optional source role, e.g. canonical_reference, voice_style, client_context"),
    agentId: z.string().optional().describe("Optional agent identifier"),
    agentIds: z.array(z.string()).optional().describe("Optional agent allowlist"),
    channel: z.string().optional().describe("Optional channel to associate with this knowledge base"),
    peerScopePolicy: z.enum(["strict", "permissive"]).optional().describe("Peer scope policy for the knowledge base"),
  },
};

export const crystal_list_knowledge_bases: ToolContract = {
  name: "crystal_list_knowledge_bases",
  title: "List knowledge bases",
  description: "List available Memory Crystal knowledge bases, including scoped collections. Empty results can reflect agent/scope/peer-policy visibility, not just missing rows.",
  route: { method: "GET", path: "/api/knowledge-bases" },
  trimmer: "none",
  input: {
    includeInactive: z.boolean().default(false).optional().describe("Include inactive knowledge bases"),
    scope: z.string().optional().describe("Optional scope filter"),
    agentId: z.string().optional().describe("Optional agent filter"),
    channel: z.string().optional().describe("Optional channel. Forwarded as the scope filter when scope is omitted."),
  },
};

export const crystal_list_knowledge_base_memories: ToolContract = {
  name: "crystal_list_knowledge_base_memories",
  title: "List knowledge base memories",
  description: "List a bounded page of memories in an owned knowledge base with real cursor pagination. Pass the previous response's continueCursor to fetch the next page until isDone is true.",
  route: { method: "GET", path: "/api/knowledge-bases/:id/memories" },
  trimmer: "none",
  input: {
    knowledgeBaseId: z.string().optional(),
    knowledgeBaseName: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
    cursor: z.string().optional(),
  },
};

export const crystal_empty_knowledge_base: ToolContract = {
  name: "crystal_empty_knowledge_base",
  title: "Empty knowledge base",
  description: "Delete every memory in an owned knowledge base while retaining its settings. Destructive: obtain explicit user approval first.",
  route: { method: "POST", path: "/api/knowledge-bases/:id/empty" },
  trimmer: "none",
  annotations: { destructiveHint: true, readOnlyHint: false },
  input: {
    knowledgeBaseId: z.string().optional(),
    knowledgeBaseName: z.string().optional(),
  },
};

export const crystal_set_knowledge_base_access: ToolContract = {
  name: "crystal_set_knowledge_base_access",
  title: "Set knowledge base access",
  description: "Assign or remove an agent, close a KB, or explicitly open it to every agent. add/remove use agentId or derive it from channel.",
  route: { method: "PATCH", path: "/api/knowledge-bases/:id" },
  trimmer: "none",
  input: {
    knowledgeBaseId: z.string().optional().describe("Knowledge base id"),
    knowledgeBaseName: z.string().optional().describe("Exact knowledge base name"),
    action: z.enum(["add", "remove", "set", "open"]),
    agentId: z.string().optional().describe("Agent to add/remove; defaults from configured identity or channel"),
    agentIds: z.array(z.string()).optional().describe("Exact allowlist for action=set; [] closes the KB"),
    channel: z.string().optional().describe("Channel used to derive the current agent identity"),
  },
};

export const crystal_query_knowledge_base: ToolContract = {
  name: "crystal_query_knowledge_base",
  title: "Query knowledge base",
  description: "Search a specific Memory Crystal knowledge base. Use this for named reference/manual/voice-guide queries instead of broad recall.",
  route: { method: "POST", path: "/api/knowledge-bases/:id/query" },
  trimmer: "none",
  input: {
    knowledgeBaseId: z.string().optional().describe("Knowledge base id"),
    knowledgeBaseName: z.string().optional().describe("Exact knowledge base name"),
    query: z.string().describe("Search query"),
    limit: z.number().int().min(1).max(20).optional().describe("Maximum results"),
    agentId: z.string().optional().describe("Optional agent context"),
    channel: z.string().optional().describe("Optional scope/channel context"),
  },
};

export const crystal_import_knowledge: ToolContract = {
  name: "crystal_import_knowledge",
  title: "Import knowledge",
  description: "Import reference chunks into a specific Memory Crystal knowledge base. A chunk dedupeKey upserts: re-importing the same key replaces that chunk instead of appending a duplicate. On a missing named base, stdio creates it using the supplied metadata; hosted resolves existing bases only and returns an error.",
  route: { method: "POST", path: "/api/knowledge-bases/:id/import" },
  trimmer: "none",
  input: {
    knowledgeBaseId: z.string().optional().describe("Knowledge base id"),
    knowledgeBaseName: z.string().optional().describe("Knowledge base name, resolved when id is omitted"),
    description: z.string().optional().describe("Optional import description"),
    sourceType: z.string().optional(),
    sourceRole: z.string().optional(),
    agentIds: z.array(z.string()).optional(),
    scope: z.string().optional(),
    chunks: z.array(z.object({
      content: z.string().describe("Chunk content"),
      dedupeKey: z.string().optional().describe("Stable upsert key within this knowledge base"),
      metadata: z.object({
        title: z.string().optional(),
        sourceUrl: z.string().optional(),
        chunkIndex: z.number().optional(),
        totalChunks: z.number().optional(),
        sourceType: z.string().optional(),
      }).optional(),
    })).describe("Knowledge chunks to import"),
  },
};

export const crystal_health: ToolContract = {
  name: "crystal_health",
  title: "Memory health",
  description: "Check authenticated liveness and the reported build identity. Provider and vector readiness may be unknown; no memory scan or hygiene worklist is performed.",
  route: { method: "POST", path: "/api/mcp/health" },
  trimmer: "none",
  input: {
    limit: z.number().optional().describe("Deprecated compatibility argument; ignored"),
  },
};

export const MCP_TOOLS: Record<string, ToolContract> = {
  crystal_recall,
  crystal_remember,
  crystal_update,
  crystal_supersede,
  crystal_recent,
  crystal_search_messages,
  crystal_what_do_i_know,
  crystal_why_did_we,
  crystal_forget,
  crystal_stats,
  crystal_checkpoint,
  crystal_wake,
  crystal_preflight,
  crystal_trace,
  crystal_get_memory,
  crystal_create_knowledge_base,
  crystal_list_knowledge_bases,
  crystal_list_knowledge_base_memories,
  crystal_empty_knowledge_base,
  crystal_set_knowledge_base_access,
  crystal_query_knowledge_base,
  crystal_import_knowledge,
  crystal_health,
};

/** Tools that stay on the stdio npm server and are not registered by the hosted server. */
export const STDIO_ONLY_TOOL_NAMES = [
  "crystal_edit",
  "crystal_research_create_collection",
  "crystal_research_ingest",
  "crystal_research_status",
  "crystal_research_query",
  "crystal_research_trace",
  "crystal_research_promote",
] as const;
