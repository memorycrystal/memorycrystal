#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const GEMINI_MODEL = "gemini-embedding-2-preview";
const GEMINI_URL_BASE = "https://generativelanguage.googleapis.com/v1beta";
const REQUIRED_EMBEDDING_DIMENSIONS = 3072;
const CONVEX_ACTION = "/api/action";
const CONVEX_QUERY = "/api/query";
const DEFAULT_LIMIT = 8;
const RECALL_PATHS = ["crystal/recall:recallMemories"];

const readFileEnv = (filePath) => {
  const values = {};
  if (!fs.existsSync(filePath)) {
    return values;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const [key, value = ""] = trimmed.split("=", 2);
    const normalizedKey = key.trim();
    values[normalizedKey] = value.trim().replace(/^"+|"+$/g, "");
  }
  return values;
};

const loadRuntimeEnv = () => {
  const envCandidates = [
    process.env.CRYSTAL_ENV_FILE,
    path.resolve(__dirname, "..", "mcp-server", ".env"),
    process.env.CRYSTAL_ROOT ? path.resolve(process.env.CRYSTAL_ROOT, "mcp-server", ".env") : null,
  ].filter((entry) => typeof entry === "string" && entry.trim().length > 0);

  const envFile = envCandidates.find((entry) => fs.existsSync(entry));
  const env = { ...process.env };
  if (!env.CRYSTAL_API_KEY && envFile) {
    const fileEnv = readFileEnv(envFile);
    if (fileEnv.CRYSTAL_API_KEY) {
      env.CRYSTAL_API_KEY = fileEnv.CRYSTAL_API_KEY;
    }
  }
  return env;
};

const readInputFromStdin = async () => {
  const chunks = [];
  return await new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
  });
};

const safeGetString = (value) => (typeof value === "string" ? value : "");

const parseInput = async () => {
  const env = loadRuntimeEnv();
  const argQuery = safeGetString(process.argv[2]);
  const rawPayload = (await readInputFromStdin()).trim();

  if (!rawPayload) {
    return {
      query: argQuery,
      channel: "",
      sessionId: "",
      sessionKey: "",
      mode: "",
      env,
    };
  }

  try {
    const parsed = JSON.parse(rawPayload);
    return {
      query: safeGetString(parsed?.query) || argQuery || "",
      channel: safeGetString(parsed?.channel),
      sessionId: safeGetString(parsed?.sessionId),
      sessionKey: safeGetString(parsed?.sessionKey) || safeGetString(parsed?.sessionId),
      mode: safeGetString(parsed?.mode),
      env,
    };
  } catch {
    return {
      query: rawPayload || argQuery,
      channel: "",
      sessionId: "",
      sessionKey: "",
      mode: "",
      env,
    };
  }
};

const toConvexUrl = (value) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/\/+$/, "");
  }
  return `https://${value.replace(/\/+$/, "")}`;
};

const getEmbedding = async (query, env) => {
  if (typeof query !== "string" || query.trim().length === 0) {
    return null;
  }

  const provider = String(env.EMBEDDING_PROVIDER || "gemini").toLowerCase();
  if (provider !== "gemini") {
    throw new Error(
      `Only Gemini embeddings are supported. Got EMBEDDING_PROVIDER="${provider}". ` +
      "Set EMBEDDING_PROVIDER=gemini or remove the variable."
    );
  }

  const geminiKey = env.CRYSTAL_API_KEY;
  if (!geminiKey) {
    process.stderr.write("[crystal][recall-hook] CRYSTAL_API_KEY is not set — skipping embedding\n");
    return null;
  }
  const model = env.GEMINI_EMBEDDING_MODEL || GEMINI_MODEL;
  const response = await fetch(`${GEMINI_URL_BASE}/models/${model}:embedContent?key=${encodeURIComponent(geminiKey)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text: query }] },
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  const vector = Array.isArray(payload?.embedding?.values) ? payload.embedding.values : null;

  if (vector && vector.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch in recall-hook: got ${vector.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}`
    );
  }

  return vector;
};

// Per-memory content preview cap. Full content is still available via the MCP
// `crystal_recall` tool; this keeps the OpenClaw injection block compact so the
// gateway doesn't flood the terminal scrollback on every turn.
const MEMORY_PREVIEW_CHARS = 280;
const MAX_SURFACED_MEMORIES = 8;

const formatBlock = (memories) => {
  if (!Array.isArray(memories) || memories.length === 0) {
    return "## 🧠 Memory Crystal Memory Recall\nNo matching memories found.";
  }

  const surfaced = memories.slice(0, MAX_SURFACED_MEMORIES);
  const truncatedCount = Math.max(0, memories.length - surfaced.length);

  const lines = ["## 🧠 Memory Crystal Memory Recall"];
  for (const memory of surfaced) {
    const store = typeof memory.store === "string" ? memory.store.toUpperCase() : "UNKNOWN";
    const rawTitle = typeof memory.title === "string" ? memory.title : "";
    const title = rawTitle.length > 80 ? `${rawTitle.slice(0, 80)}…` : rawTitle;
    const rawContent = typeof memory.content === "string" ? memory.content.replace(/\s+/g, " ").trim() : "";
    const content =
      rawContent.length > MEMORY_PREVIEW_CHARS
        ? `${rawContent.slice(0, MEMORY_PREVIEW_CHARS)}…`
        : rawContent;
    const tagList = Array.isArray(memory.tags)
      ? memory.tags.filter((tag) => typeof tag === "string" && tag.trim().length > 0).slice(0, 4)
      : [];
    const tags = tagList.join(", ");
    const strength = typeof memory.strength === "number" ? memory.strength.toFixed(2) : "0.00";
    const confidence = typeof memory.confidence === "number" ? memory.confidence.toFixed(2) : "0.00";
    const score = typeof memory.score === "number" ? memory.score.toFixed(2) : "0.00";
    lines.push(`### ${store}: ${title}`);
    if (content) lines.push(content);
    lines.push(`Tags: ${tags.length > 0 ? tags : "none"} | S:${strength} C:${confidence} Score:${score}`);
  }

  if (truncatedCount > 0) {
    lines.push("");
    lines.push(`_+${truncatedCount} additional memories — expand via crystal_recall_`);
  }

  return lines.join("\n").trimEnd();
};

const normalizeMemory = (memory) => {
  if (!memory || typeof memory !== "object") {
    return null;
  }
  return {
    memoryId: safeGetString(memory.memoryId || memory._id),
    store: safeGetString(memory.store),
    category: safeGetString(memory.category),
    title: safeGetString(memory.title),
    content: safeGetString(memory.content),
    strength: Number.isFinite(memory.strength) ? memory.strength : 0,
    confidence: Number.isFinite(memory.confidence) ? memory.confidence : 0,
    tags: Array.isArray(memory.tags) ? memory.tags : [],
    score: Number.isFinite(memory.score) ? memory.score : Number.isFinite(memory._score) ? memory._score : 0,
    scoreValue: Number.isFinite(memory.scoreValue) ? memory.scoreValue : 0,
  };
};

const searchMemories = async ({ embedding, query, mode, channel, sessionKey, env }) => {
  const normalizedMode = mode && mode.trim().length > 0 ? mode.trim() : undefined;
  // Prefer authenticated HTTP endpoint (/api/mcp/recall) when a memory-specific
  // site URL + CRYSTAL_API_KEY are available. Fall back to CONVEX_URL because many
  // live installs already provide that, and the HTTP MCP routes are served from
  // the same .convex.site base.
  const crystalSite = (env.CRYSTAL_SITE || env.CRYSTAL_CONVEX_URL || env.CONVEX_URL || "").replace(/\/+$/, "");
  const crystalApiKey = env.CRYSTAL_API_KEY || "";

  if (crystalSite && crystalApiKey) {
    try {
      const payload = {
        query: query || "",
        limit: DEFAULT_LIMIT,
        ...(channel ? { channel } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(normalizedMode ? { mode: normalizedMode } : {}),
      };
      const mcpResponse = await fetch(`${crystalSite}/api/mcp/recall`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${crystalApiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (mcpResponse.ok) {
        const mcpPayload = await mcpResponse.json().catch(() => null);
        const mcpMemories = Array.isArray(mcpPayload?.memories) ? mcpPayload.memories : [];
        if (mcpMemories.length > 0) {
          return mcpMemories;
        }
      }
    } catch (_) {
      // fall through to Convex action path
    }
  }

  // Fallback: raw Convex action endpoint (requires auth context — only works when
  // called from within an authenticated Convex session or from the MCP server).
  const convexUrl = toConvexUrl(env.CONVEX_URL);
  if (!convexUrl || !Array.isArray(embedding) || embedding.length === 0) {
    return [];
  }

  const args = {
    embedding,
    limit: DEFAULT_LIMIT,
    query: query, // enables BM25 hybrid search
    ...(channel ? { channel } : {}),
    ...(normalizedMode ? { mode: normalizedMode } : {}),
  };

  for (const path of RECALL_PATHS) {
    const actionResponse = await fetch(`${convexUrl}${CONVEX_ACTION}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path,
        args,
      }),
    });

    if (!actionResponse.ok) {
      continue;
    }

    const actionPayload = await actionResponse.json().catch(() => null);
    const actionData = actionPayload?.value ?? actionPayload;
    const actionMemories = Array.isArray(actionData?.memories) ? actionData.memories : [];
    if (actionMemories.length > 0) {
      return actionMemories;
    }
  }

  return [];
};

const fetchRecentMessages = async (channel, sessionKey, limit = 20, env) => {
  const crystalSite = (env.CRYSTAL_SITE || env.CRYSTAL_CONVEX_URL || env.CONVEX_URL || "").replace(/\/+$/, "");
  const crystalApiKey = env.CRYSTAL_API_KEY || "";

  if (crystalSite && crystalApiKey) {
    try {
      const response = await fetch(`${crystalSite}/api/mcp/recent-messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${crystalApiKey}`,
        },
        body: JSON.stringify({
          limit,
          channel,
          sessionKey,
        }),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        return messages.filter((message) => message && typeof message === "object");
      }
    } catch (_) {
      // fall through to raw Convex query
    }
  }

  const convexUrl = toConvexUrl(env.CONVEX_URL);
  if (!convexUrl) {
    return [];
  }

  const response = await fetch(`${convexUrl}${CONVEX_QUERY}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      path: "crystal/messages:getRecentMessages",
      args: {
        limit,
        channel,
        sessionKey,
      },
    }),
  });

  if (!response.ok) {
    return [];
  }

  const payload = await response.json().catch(() => null);
  const data = payload?.value ?? payload;
  const messages = Array.isArray(data)
    ? data
    : Array.isArray(data?.messages)
      ? data.messages
      : [];
  return messages.filter((message) => message && typeof message === "object");
};

const formatRecentMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const lines = messages.map((message) => {
    const timestamp = typeof message.timestamp === "number" ? new Date(message.timestamp).toLocaleTimeString() : "Invalid time";
    const role = typeof message.role === "string" ? message.role : "unknown";
    const content = typeof message.content === "string" ? message.content : "";
    const trimmed = content.length > 150 ? content.slice(0, 150) : content;
    return `[${timestamp}] ${role}: ${trimmed}`;
  });

  return ["## Short-Term Memory (recent messages)", ...lines].join("\n");
};

const addSessionMemoryIds = () => {
  // Session-level suppression is best-effort in the hook path; the backend
  // remains authoritative for recall ranking and duplicate filtering.
};

/**
 * Returns true if this query warrants a memory recall lookup.
 * Skips noisy/trivial queries; forces recall for explicit memory-seeking queries.
 */
function shouldRecall(query) {
  const q = (query || "").trim();

  // Force recall if query explicitly seeks memory context
  const forcePatterns = /\b(remember|recall|previously|last time|earlier|before|memory|forgot|what did we|when did we|history)\b/i;
  if (forcePatterns.test(q)) return true;

  // Skip empty or very short queries
  if (q.length < 4) return false;

  // Skip slash commands
  if (q.startsWith("/")) return false;

  // Skip pure greetings
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|howdy)[!.,\s]*$/i.test(q)) return false;

  // Skip simple confirmations
  if (/^(yes|no|ok|sure|thanks|thank you|nope|yep|yeah|nah)[!.,\s]*$/i.test(q)) return false;

  // Skip pure emoji (no alphabetic characters)
  if (!/[a-zA-Z]/.test(q)) return false;

  // Skip heartbeat patterns
  if (/HEARTBEAT|heartbeat poll/i.test(q)) return false;

  return true;
}

const main = async () => {
  const { query, mode, env, channel, sessionKey } = await parseInput();

  if (!shouldRecall(query)) {
    process.stdout.write(JSON.stringify({ injectionBlock: "", memories: [] }));
    process.exit(0);
  }
  const embedding = await getEmbedding(query, env);
  if (!embedding) {
    process.stdout.write(JSON.stringify({ injectionBlock: "", memories: [] }));
    return;
  }

  const memories = (await searchMemories({ embedding, query, mode, channel, sessionKey, env }))
    .slice(0, DEFAULT_LIMIT)
    .map(normalizeMemory)
    .filter(Boolean);
  addSessionMemoryIds(sessionKey, memories.map((m) => m.memoryId).filter(Boolean));
  const recentMessages = await fetchRecentMessages(channel, sessionKey, 20, env);
  const recentBlock = formatRecentMessages(recentMessages);
  const longTermBlock = formatBlock(memories);
  const injectionBlock = [recentBlock, longTermBlock].filter(Boolean).join("\n\n");

  process.stdout.write(
    JSON.stringify({
      injectionBlock,
      memories,
    })
  );
};

main().catch(() => {
  process.stdout.write(JSON.stringify({ injectionBlock: "", memories: [] }));
  process.exit(0);
});
