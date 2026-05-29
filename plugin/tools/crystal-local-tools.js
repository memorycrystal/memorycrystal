// crystal-local-tools.js — Local in-session retrieval tools for Memory Crystal
// Plain JavaScript ES module. No TypeScript.

import { estimateTokens } from "../compaction/crystal-summarizer.js";

// ── Return format helpers (mirrors index.js pattern) ─────────────────────────

function toToolResult(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function toToolError(err) {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
  };
}

// ── Text search helpers ───────────────────────────────────────────────────────

function matchesFullText(text, query) {
  return text.toLowerCase().includes(query.toLowerCase());
}

function matchesRegex(text, pattern) {
  try {
    const re = new RegExp(pattern, "i");
    return re.test(text);
  } catch {
    // If pattern is an invalid regex, fall through to false
    return false;
  }
}

function matches(text, query, mode) {
  if (mode === "regex") return matchesRegex(text, query);
  return matchesFullText(text, query);
}

// ── createLocalTools ──────────────────────────────────────────────────────────

/**
 * Factory — returns array of 3 tool objects for the crystal-memory plugin.
 *
 * `store` is the same store interface used by CrystalCompactionEngine:
 *   getContextItems(sessionKey)   → ContextItem[]
 *   getMessageById(messageId)     → message|null
 *   getSummary(summaryId)         → SummaryRecord|null
 *
 * The `ctx` passed to execute() is the OpenClaw ctx object.
 * Session key resolution defaults to ctx?.sessionKey || ctx?.sessionId, but the
 * plugin can inject a canonicalizer for transport-specific normalization.
 */
export function createLocalTools(store, options = {}) {
  const externalResolveSessionKey = typeof options.resolveSessionKey === "function"
    ? options.resolveSessionKey
    : null;

  function resolveSessionKey(ctx) {
    if (externalResolveSessionKey) {
      return externalResolveSessionKey(ctx);
    }
    return (
      ctx?.sessionKey ||
      ctx?.sessionId ||
      ctx?.event?.sessionKey ||
      "unknown-session"
    );
  }

  return [
    // ── crystal_grep ────────────────────────────────────────────────────────
    {
      name: "crystal_grep",
      description:
        "Search local in-session history (messages and compacted summaries) using text search.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          mode: {
            type: "string",
            enum: ["full_text", "regex"],
            default: "full_text",
            description: "Search mode: full_text (substring match) or regex",
          },
          scope: {
            type: "string",
            enum: ["messages", "summaries", "both"],
            default: "both",
            description: "Which context items to search",
          },
          limit: {
            type: "number",
            default: 30,
            description: "Maximum results to return",
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const query = params?.query;
          if (typeof query !== "string" || query.trim().length === 0) {
            throw new Error("query is required");
          }
          const mode = params?.mode === "regex" ? "regex" : "full_text";
          const scope = ["messages", "summaries", "both"].includes(params?.scope)
            ? params.scope
            : "both";
          const limit = Number.isFinite(Number(params?.limit)) ? Math.max(1, Number(params.limit)) : 30;

          const sessionKey = resolveSessionKey(ctx);
          const contextItems = await store.getContextItems(sessionKey);

          const results = [];

          for (const item of contextItems) {
            if (results.length >= limit) break;

            if (item.itemType === "message" && item.messageId != null) {
              if (scope === "summaries") continue;
              const msg = await store.getMessageById(item.messageId);
              if (!msg) continue;
              const text = msg.content || "";
              if (!matches(text, query, mode)) continue;
              results.push({
                type: "message",
                messageId: item.messageId,
                ordinal: item.ordinal,
                role: msg.role || "unknown",
                snippet: text.length > 400 ? text.slice(0, 400) + "..." : text,
                tokenCount: typeof msg.tokenCount === "number" ? msg.tokenCount : estimateTokens(text),
              });
            } else if (item.itemType === "summary" && item.summaryId != null) {
              if (scope === "messages") continue;
              const summary = await store.getSummary(item.summaryId);
              if (!summary) continue;
              const text = summary.content || "";
              if (!matches(text, query, mode)) continue;
              results.push({
                type: "summary",
                summaryId: item.summaryId,
                ordinal: item.ordinal,
                kind: summary.kind || "unknown",
                depth: summary.depth || 0,
                snippet: text.length > 400 ? text.slice(0, 400) + "..." : text,
                tokenCount: typeof summary.tokenCount === "number" ? summary.tokenCount : estimateTokens(text),
              });
            }
          }

          const payload = {
            query,
            mode,
            scope,
            resultCount: results.length,
            results,
          };
          return toToolResult(payload);
        } catch (err) {
          return toToolError(err);
        }
      },
    },

    // ── crystal_describe ────────────────────────────────────────────────────
    {
      name: "crystal_describe",
      description:
        "Inspect a local summary node by ID. Returns kind, depth, content, parents, token count.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Summary ID (sum_xxx format)",
          },
        },
        required: ["id"],
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const id = params?.id;
          if (typeof id !== "string" || !id.startsWith("sum_")) {
            throw new Error("id must be a summary ID in sum_xxx format");
          }

          const summary = await store.getSummary(id);
          if (!summary) {
            return toToolError(new Error(`Summary not found: ${id}`));
          }

          const tokenCount =
            typeof summary.tokenCount === "number"
              ? summary.tokenCount
              : estimateTokens(summary.content || "");

          const payload = {
            summaryId: summary.summaryId,
            kind: summary.kind || "unknown",
            depth: typeof summary.depth === "number" ? summary.depth : 0,
            tokenCount,
            contentPreview:
              (summary.content || "").length > 600
                ? summary.content.slice(0, 600) + "..."
                : summary.content || "",
            contentLength: (summary.content || "").length,
            earliestAt: summary.earliestAt
              ? (summary.earliestAt instanceof Date
                  ? summary.earliestAt.toISOString()
                  : String(summary.earliestAt))
              : null,
            latestAt: summary.latestAt
              ? (summary.latestAt instanceof Date
                  ? summary.latestAt.toISOString()
                  : String(summary.latestAt))
              : null,
            createdAt: summary.createdAt
              ? (summary.createdAt instanceof Date
                  ? summary.createdAt.toISOString()
                  : String(summary.createdAt))
              : null,
            descendantCount: summary.descendantCount ?? null,
            descendantTokenCount: summary.descendantTokenCount ?? null,
            sourceMessageTokenCount: summary.sourceMessageTokenCount ?? null,
            parentSummaryIds: Array.isArray(summary.parentSummaryIds)
              ? summary.parentSummaryIds
              : [],
            childSummaryIds: Array.isArray(summary.childSummaryIds)
              ? summary.childSummaryIds
              : [],
            sourceMessageIds: Array.isArray(summary.sourceMessageIds)
              ? summary.sourceMessageIds
              : [],
          };
          return toToolResult(payload);
        } catch (err) {
          return toToolError(err);
        }
      },
    },

    // ── crystal_expand ──────────────────────────────────────────────────────
    {
      name: "crystal_expand",
      description: "Expand a summary to its children and/or source messages.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Summary ID (sum_xxx format)",
          },
          depth: {
            type: "number",
            default: 1,
            description: "How many levels of child summaries to expand (1 = immediate children)",
          },
          include_messages: {
            type: "boolean",
            default: false,
            description: "Whether to also return source messages linked to the summary",
          },
        },
        required: ["id"],
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const id = params?.id;
          if (typeof id !== "string" || !id.startsWith("sum_")) {
            throw new Error("id must be a summary ID in sum_xxx format");
          }
          const maxDepth = Number.isFinite(Number(params?.depth))
            ? Math.max(1, Number(params.depth))
            : 1;
          const includeMessages = params?.include_messages === true;

          const rootSummary = await store.getSummary(id);
          if (!rootSummary) {
            return toToolError(new Error(`Summary not found: ${id}`));
          }

          // Recursively expand children up to maxDepth levels
          async function expandSummary(summaryId, currentDepth) {
            const s = await store.getSummary(summaryId);
            if (!s) return null;

            const node = {
              summaryId: s.summaryId,
              kind: s.kind || "unknown",
              depth: typeof s.depth === "number" ? s.depth : 0,
              tokenCount:
                typeof s.tokenCount === "number"
                  ? s.tokenCount
                  : estimateTokens(s.content || ""),
              contentPreview:
                (s.content || "").length > 300
                  ? s.content.slice(0, 300) + "..."
                  : s.content || "",
              children: [],
              messages: [],
            };

            if (currentDepth < maxDepth) {
              const childIds = Array.isArray(s.childSummaryIds) ? s.childSummaryIds : [];
              for (const childId of childIds) {
                const child = await expandSummary(childId, currentDepth + 1);
                if (child) node.children.push(child);
              }
            }

            if (includeMessages) {
              const messageIds = Array.isArray(s.sourceMessageIds) ? s.sourceMessageIds : [];
              for (const msgId of messageIds) {
                const msg = await store.getMessageById(msgId);
                if (!msg) continue;
                const text = msg.content || "";
                node.messages.push({
                  messageId: msg.messageId,
                  role: msg.role || "unknown",
                  snippet: text.length > 300 ? text.slice(0, 300) + "..." : text,
                  tokenCount:
                    typeof msg.tokenCount === "number"
                      ? msg.tokenCount
                      : estimateTokens(text),
                });
              }
            }

            return node;
          }

          const expanded = await expandSummary(id, 0);
          const payload = {
            summaryId: id,
            expandedDepth: maxDepth,
            includeMessages,
            tree: expanded,
          };
          return toToolResult(payload);
        } catch (err) {
          return toToolError(err);
        }
      },
    },
  ];
}
