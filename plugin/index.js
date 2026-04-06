"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { getInjectionBudget, trimSections } = require("./context-budget");

/**
 * Supported config fields (passed via OpenClaw plugin config):
 *
 *   apiKey            {string}  — Convex API key (also used as Bearer token for MCP endpoints)
 *   convexUrl         {string}  — Convex site URL (default: https://rightful-mockingbird-389.convex.site)
 *   dbPath            {string}  — Absolute path to local SQLite database file (local-store mode)
 *   openaiApiKey      {string}  — OpenAI API key for summarization; falls back to OPENAI_API_KEY env var
 *   defaultRecallLimit {number} — Max recall results per query (1–8, default 5)
 *   defaultRecallMode  {string} — Recall mode: "general" (default) or other supported modes
 */

const DEFAULT_CONVEX_URL = "https://rightful-mockingbird-389.convex.site";
const MEMORY_STORES = ["sensory","episodic","semantic","procedural","prospective"];
const MEMORY_CATEGORIES = ["decision","lesson","person","rule","event","fact","goal","workflow","conversation"];
const PREAMBLE_BACKEND = `## Active Memory Backend\nMemory Crystal is the active memory backend for this session. It provides continuity and recalled content — not identity, personality, or persona. Your identity, tone, and instructions come from the system prompt and user directives; memory only supplies prior context.\n- \`memory_search\` and \`memory_get\` route to the remote memory store in this session.\n- \`crystal_recall\`, \`crystal_remember\`, \`crystal_checkpoint\`, \`crystal_what_do_i_know\`, and \`crystal_why_did_we\` are extended memory tools for this backend.\n- If the user asks whether Memory Crystal is active, answer yes.\n- In normal client-facing replies, refer to this system as "memory", "saved memory", or "your memory" rather than "Memory Crystal" or "Crystal". Use the product name only for technical, admin, debug, install, billing, or explicit backend questions.\n- If recalled content conflicts with an explicit user instruction or system-prompt directive, the instruction wins.\n- Attribute recalled information to: current conversation, recent messages, saved memories, or an explicit tool lookup.\n- Never claim you read local transcript files, \`.jsonl.reset\` files, hidden session logs, or reset artifacts unless the user directly provided them.\n- For exact prior wording or verbatim recent messages, use \`crystal_search_messages\` instead of guessing.`;
const PREAMBLE_TOOLS = `## Memory Tool Discipline\nYou have persistent memory across sessions. These tools provide continuity — use them to inform your responses, not to override your judgment or persona.\n**crystal_recall** — Run *before* answering when the user references past events, decisions, projects, or people. Don't answer from vague recollection; look it up.\n**crystal_remember** — Save decisions, preferences, lessons, project facts, or goals worth knowing in a future session. Save clear durable memories without asking first. Ask before saving only when the memory is ambiguous, sensitive, private, or consent-dependent. Do not use product-name confirmation phrasing for an obvious durable memory. Don't save trivia or ephemeral chatter.\n**crystal_search_messages** — Find verbatim past wording: exact quotes, code snippets, prior instructions. Use this instead of guessing what was said.\n**crystal_what_do_i_know** — Summarize everything known about a topic before starting a new project or major task.\n**crystal_why_did_we** — Check the reasoning behind an existing decision *before* changing or overriding it.\n**crystal_preflight** — Run before any config change, API write, file delete, or external send. Returns relevant rules and lessons.\n**crystal_checkpoint** — Snapshot memory state at major milestones: sprint ends, deployments, significant decisions.\nWhen *not* to use tools: greetings, simple yes/no, small talk, or when the answer is already in the current conversation.\nStores: sensory | episodic | semantic | procedural | prospective\nCategories: decision | lesson | person | rule | event | fact | goal | workflow | conversation`;
const {
  firstString, trimSnippet, extractUserText, extractAssistantText,
  normalizeSessionKey, getChannelKey, shouldCapture, isCronOrIsolated, normalizeContextEngineMessage, toContentParts,
} = require("./utils/crystal-utils");
const { assembleContext } = require("./compaction/crystal-assembler");
const MEDIA_CAPS_BYTES = {
  image: 5 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
};
function getMediaKind(mimeType) {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  return null;
}
function classifyIntent(text) {
  const value = String(text || "").trim();
  if (!value) return "general";
  if (/\b(remember|save|note|keep|log|write down|store)\b/i.test(value)) return "store";
  if (/\b(reflect|summarize|what have|review|digest|recap)\b/i.test(value)) return "reflect";
  if (/\b(recall|what did|do you know|have we|last time|previously)\b/i.test(value)) return "recall";
  if (/^(how to|how do i|steps to|walk me through|show me how|what's the process)\b/i.test(value) || /\b(workflow|procedure|runbook|playbook)\b/i.test(value)) return "workflow";
  if (value.startsWith("/") || /^(do|run|execute|create|build|make|generate|fix|update|delete)\b/i.test(value)) return "command";
  if (value.endsWith("?") || /^(what|how|why|when|where|who|is|are|can|could|should|would)\b/i.test(value)) return "question";
  return "general";
}
async function captureMediaAsset(filePath, mimeType, apiKey, convexSiteUrl, channel, sessionKey) {
  const kind = getMediaKind(mimeType);
  if (!kind) return;
  let buf;
  try { buf = await fs.promises.readFile(filePath); }
  catch (e) { console.warn("[crystal] media read failed:", getErrorMessage(e)); return; }
  const cap = MEDIA_CAPS_BYTES[kind];
  if (buf.length > cap) {
    console.warn("[crystal] media too large, skipping:", kind, buf.length, "bytes (cap:", cap, ")");
    return;
  }
  const urlRes = await fetch(convexSiteUrl + "/api/mcp/upload-url", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
  });
  if (!urlRes.ok) { console.warn("[crystal] upload-url failed:", urlRes.status); return; }
  const { uploadUrl } = await urlRes.json();
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: buf,
  });
  if (!uploadRes.ok) { console.warn("[crystal] upload failed:", uploadRes.status); return; }
  const { storageId } = await uploadRes.json();
  if (!storageId) { console.warn("[crystal] no storageId in upload response"); return; }
  const body = { storageKey: storageId, kind, mimeType };
  if (channel) body.channel = channel;
  if (sessionKey) body.sessionKey = sessionKey;
  const assetRes = await fetch(convexSiteUrl + "/api/mcp/asset", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify(body),
  });
  if (!assetRes.ok) { console.warn("[crystal] asset register failed:", assetRes.status); return; }
  const result = await assetRes.json();
  console.log("[crystal] media asset captured:", result.id, kind, mimeType);
}
function fireMediaCapture(event, config, channel, sessionKey) {
  const apiKey = config?.apiKey;
  if (!apiKey || apiKey === "local") return;
  const base = (config?.convexUrl || DEFAULT_CONVEX_URL).replace(/\/+$/, "");
  const attachments = [];
  if (Array.isArray(event.attachments)) {
    for (const att of event.attachments) attachments.push(att);
  }
  const singlePath = event.mediaPath || event.filePath;
  const singleMime = event.mimeType || event.mediaType;
  if (singlePath && singleMime) attachments.push({ filePath: singlePath, mimeType: singleMime });
  for (const att of attachments) {
    const fp = att.filePath || att.path;
    const mt = att.mimeType || att.contentType;
    if (fp && mt) {
      captureMediaAsset(fp, mt, apiKey, base, channel, sessionKey)
        .catch(function(e) { console.warn("[crystal] media capture error:", getErrorMessage(e)); });
    }
  }
}
// Capture pluginConfig at module init time as a fallback for tool execute() calls.
// OpenClaw v2026.3.24 does not inject pluginConfig into the ctx/api objects passed
// to tool execute() — only to hooks and the module.exports call itself. Without this
// fallback, all crystal_* tool calls fail with "apiKey is not configured".
// See: https://github.com/openclaw/openclaw/issues/56432
let _capturedPluginConfig = null;

const pendingUserMessages = new Map();
const sessionConfigs = new Map();
const sessionChannelScopes = new Map();
const wakeInjectedSessions = new Set();
const seenCaptureSessions = new Set();
const intentCache = new Map();
const pendingContextEngineMessages = new Map();
const conversationTurnCounters = new Map();
const reinforcementTurnCounters = new Map();
const conversationPulseBuffers = new Map();

// Reinforcement injection: cache top recall results per session so we can
// re-inject them near the end of long conversations ("lost in the middle" fix).
const sessionRecallCache = new Map();
const sessionRecallCacheTimestamps = new Map();
const SESSION_RECALL_CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

// Orphan sweep: track last activity per session and periodically evict stale entries.
// Protects against session_end never firing (crash, network drop, gateway restart).
const sessionLastActivity = new Map();
const ORPHAN_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const ORPHAN_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const INTENT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REINFORCEMENT_TURN_THRESHOLD = 5;
const REINFORCEMENT_MAX_CHARS = 800;
const CONVERSATION_PULSE_TURN_THRESHOLD = 5;
const INJECTION_TAG_PATTERNS = [
  /<\/?system\b[^>]*>/gi,
  /<\/?assistant\b[^>]*>/gi,
  /<\/?user\b[^>]*>/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<\|system\|>/gi,
  /<\|assistant\|>/gi,
  /<\|user\|>/gi,
];
const INJECTION_LINE_PATTERNS = [
  /^\s*ignore (?:all )?(?:any |the )?(?:previous|prior|above) instructions\b.*$/gim,
  /^\s*you are now\b.*$/gim,
  /^\s*system:\s*.*$/gim,
  /^\s*assistant:\s*.*$/gim,
  /^\s*#{2,}\s*system\b.*$/gim,
];
let localStore = null;
let compactionEngine = null;
let storeInitPromise = null;
let localToolsRegistered = false;
function sanitizeForInjection(text) {
  let value = String(text || "");
  for (const pattern of INJECTION_TAG_PATTERNS) value = value.replace(pattern, "");
  for (const pattern of INJECTION_LINE_PATTERNS) value = value.replace(pattern, "");
  value = value.replace(/\n{3,}/g, "\n\n").trim();
  return value.slice(0, 2000);
}
function redactSensitiveContent(text) {
  let value = String(text || "");
  value = value.replace(/\b((?:api[-_ ]?)?(?:key|token|secret|password)|bearer)\b(\s*[:=]?\s*)([A-Za-z0-9+/_=-]{20,})/gi, (_, label, sep) => `${label}${sep}[REDACTED]`);
  value = value.replace(/\b(?:\d{4}[- ]?){3}\d{4}\b/g, "[REDACTED]");
  value = value.replace(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})(\s+(?:password|pass|pwd)\s+)(\S+)/gi, (_, email, middle) => `${email}${middle}[REDACTED]`);
  value = value.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
  return value;
}
function sanitizeErrorMessage(input) {
  let value = String(input || "Unknown error");
  value = value.replace(/(?:\/Users|\/home)\/[^\s:)]+/g, "[path]");
  value = value.replace(/\b((?:api[-_ ]?)?(?:key|token|secret|password)|bearer)\b(\s*[:=]?\s*)([A-Za-z0-9+/_=-]{10,})/gi, (_, label, sep) => `${label}${sep}[REDACTED]`);
  value = value.replace(/\bsk_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
  value = value.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
  return value;
}
function getErrorMessage(err) {
  return sanitizeErrorMessage(err?.message || String(err));
}
function normalizeMemoryId(id, fallback = "unknown") {
  const value = typeof id === "string" ? id.trim() : "";
  return value || fallback;
}
function buildMemoryInjectionBlock(id, lines) {
  return [
    `--- Memory [${normalizeMemoryId(id)}] ---`,
    ...lines.filter(Boolean),
    "--- End Memory ---",
  ].join("\n");
}
function maybeRunAutoUpdate(config, logger) {
  if (config?.autoUpdate !== true) return;
  try {
    const updateScript = path.join(__dirname, "update.sh");
    if (!fs.existsSync(updateScript)) return;
    execFile("bash", [updateScript, "--no-restart"], { timeout: 60000 }, (err, stdout) => {
      if (err && err.code !== 0) return;
      if (stdout && stdout.includes("Updating")) {
        logger?.info?.("[crystal] Auto-update applied");
      }
    });
  } catch (err) {
    logger?.warn?.(`[crystal] auto-update: ${getErrorMessage(err)}`);
  }
}
function clearSessionState(sessionKey) {
  if (!sessionKey) return;
  pendingUserMessages.delete(sessionKey);
  sessionConfigs.delete(sessionKey);
  sessionChannelScopes.delete(sessionKey);
  wakeInjectedSessions.delete(sessionKey);
  seenCaptureSessions.delete(`msg:${sessionKey}`);
  seenCaptureSessions.delete(`out:${sessionKey}`);
  intentCache.delete(sessionKey);
  pendingContextEngineMessages.delete(sessionKey);
  conversationTurnCounters.delete(sessionKey);
  conversationPulseBuffers.delete(sessionKey);
  reinforcementTurnCounters.delete(sessionKey);
  sessionRecallCache.delete(sessionKey);
  sessionRecallCacheTimestamps.delete(sessionKey);
  sessionLastActivity.delete(sessionKey);
}
function touchSession(sessionKey) {
  if (sessionKey) sessionLastActivity.set(sessionKey, Date.now());
}
function sweepStaleSessions() {
  const now = Date.now();
  for (const [key, ts] of sessionLastActivity) {
    if (now - ts > ORPHAN_MAX_AGE_MS) {
      clearSessionState(key);
    }
  }
}
function appendConversationPulseMessage(sessionKey, role, content) {
  if (!sessionKey || !content) return;
  const next = (conversationPulseBuffers.get(sessionKey) || []).concat([{ role, content: String(content) }]).slice(-12);
  conversationPulseBuffers.set(sessionKey, next);
}
function parseSkillMetadata(metadata) {
  if (!metadata || typeof metadata !== "string") return null;
  try {
    const parsed = JSON.parse(metadata);
    if (!parsed || parsed.skillFormat !== true) return null;
    const triggerConditions = Array.isArray(parsed.triggerConditions) ? parsed.triggerConditions.filter((item) => typeof item === "string") : [];
    const pitfalls = Array.isArray(parsed.pitfalls) ? parsed.pitfalls.filter((item) => typeof item === "string") : [];
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps
          .filter((item) => item && typeof item === "object" && typeof item.action === "string")
          .map((step, index) => ({
            order: Number.isFinite(Number(step.order)) ? Number(step.order) : index + 1,
            action: String(step.action),
            ...(typeof step.command === "string" && step.command.trim() ? { command: step.command.trim() } : {}),
          }))
      : [];
    return {
      triggerConditions,
      pitfalls,
      steps,
      verification: typeof parsed.verification === "string" ? parsed.verification : "",
      patternType: typeof parsed.patternType === "string" ? parsed.patternType : "workflow",
      observationCount: Number.isFinite(Number(parsed.observationCount)) ? Number(parsed.observationCount) : 1,
    };
  } catch (_) {
    return null;
  }
}
function formatProceduralMemory(m) {
  const skill = parseSkillMetadata(m?.metadata);
  if (!skill) return formatRecallMemory(m);
  const conf = confidenceLabel(m?.score ?? m?.confidence);
  const triggerLine = skill.triggerConditions.length ? `Triggers: ${skill.triggerConditions.slice(0, 2).map(sanitizeForInjection).filter(Boolean).join(" | ")}` : "";
  const stepLine = skill.steps.length
    ? `Steps: ${skill.steps.slice(0, 4).map((step) => `${step.order}. ${trimSnippet(sanitizeForInjection(step.action), 60)}`).join("  ")}`
    : "";
  const pitfallLine = skill.pitfalls.length ? `Pitfalls: ${skill.pitfalls.slice(0, 2).map(sanitizeForInjection).filter(Boolean).join(" | ")}` : "";
  const verificationLine = skill.verification ? `Verify: ${trimSnippet(sanitizeForInjection(skill.verification), 120)}` : "";
  return buildMemoryInjectionBlock(m?.memoryId || m?._id || m?.id, [
    `Type: procedural/${skill.patternType}${conf}`,
    `Title: ${trimSnippet(sanitizeForInjection(m?.title || "Untitled skill"), 120)}`,
    `Observed: ${skill.observationCount}x`,
    triggerLine,
    stepLine,
    pitfallLine,
    verificationLine,
    `Path: ${buildMemoryPath(m?.memoryId || m?._id || m?.id || "")}`,
  ]);
}
function triggerConversationPulse(api, ctx, sessionKey, text) {
  try {
    const config = getPluginConfig(api, ctx);
    const baseUrlRaw = config?.convexSiteUrl || config?.convexUrl || DEFAULT_CONVEX_URL;
    const apiKey = config?.apiKey;
    const baseUrl = String(baseUrlRaw || "").replace(/\/+$/, "");
    if (!baseUrl || !apiKey || apiKey === "local" || !text || !sessionKey) return;
    const count = (conversationTurnCounters.get(sessionKey) || 0) + 1;
    conversationTurnCounters.set(sessionKey, count);
    reinforcementTurnCounters.set(sessionKey, (reinforcementTurnCounters.get(sessionKey) || 0) + 1);
    if (count < CONVERSATION_PULSE_TURN_THRESHOLD) return;
    conversationTurnCounters.set(sessionKey, 0);
    const buffered = (conversationPulseBuffers.get(sessionKey) || []).slice(-CONVERSATION_PULSE_TURN_THRESHOLD * 2);
    const messages = (buffered.length ? buffered : [{ role: "user", content: String(text) }]).map((message) => ({
      role: message.role,
      content: redactSensitiveContent(message.content),
    }));
    const _intentCached = intentCache.get(sessionKey);
    if (_intentCached && Date.now() - _intentCached.detectedAt > INTENT_CACHE_TTL_MS) {
      intentCache.delete(sessionKey);
    }
    const intent = intentCache.get(sessionKey)?.intent;
    const channelKey = resolveChannelKey(ctx, { sessionKey }, config?.channelScope);
    fetch(`${baseUrl}/api/organic/conversationPulse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ messages, intent, channelKey }),
    }).then(r => r.body?.cancel?.()).catch(() => {});
  } catch (_) {}
}
async function getLocalStore(config, logger) {
  if (localStore) return localStore;
  if (storeInitPromise) return storeInitPromise;
  storeInitPromise = (async () => {
    try {
      const { CrystalLocalStore } = await import("./store/crystal-local-store.js");
      const store = new CrystalLocalStore();
      store.init(config?.dbPath);
      if (!store.db) return null;
      const compMod = await import("./compaction/crystal-compaction.js");
      const sumMod = await import("./compaction/crystal-summarizer.js");
      const summarizerConfig = {
        ...config,
        apiKey: config?.openaiApiKey || process.env.OPENAI_API_KEY || undefined,
      };
      const summarizer = typeof sumMod.createSummarizer === "function" ? sumMod.createSummarizer(summarizerConfig) : null;
      compactionEngine = new compMod.CrystalCompactionEngine(store, config);
      compactionEngine._summarizeFn = summarizer;
      return store;
    } catch (err) {
      logger?.warn?.(`[crystal] Local store unavailable: ${getErrorMessage(err)}`);
      return null;
    }
  })();
  localStore = await storeInitPromise;
  return localStore;
}
function getPluginConfig(api, ctx) {
  const direct = api?.pluginConfig;
  if (direct && typeof direct === "object") return direct;
  const root = ctx?.config || api?.config || {};
  const entry = root?.plugins?.entries?.[api?.id || ""]?.config;
  if (entry && typeof entry === "object") return entry;
  // Fallback: use config captured at module init time.
  // OpenClaw does not forward pluginConfig into tool execute() contexts — only into
  // hook callbacks and the initial module.exports call. Without this, all tool calls
  // fail silently with missing apiKey.
  if (_capturedPluginConfig && typeof _capturedPluginConfig === "object") return _capturedPluginConfig;
  return {};
}
async function request(config, method, path, body, logger) {
  const apiKey = config?.apiKey;
  if (!apiKey) { logger?.warn?.(`[crystal] request skipped (no apiKey): ${method} ${path}`); return null; }
  if (apiKey === "local") { return null; }
  const base = (config?.convexUrl || DEFAULT_CONVEX_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) { logger?.warn?.(`[crystal] ${method} ${path} -> ${res.status}`); return null; }
    return res.json().catch(() => null);
  } catch (err) { logger?.warn?.(`[crystal] request error: ${getErrorMessage(err)}`); return null; }
}
async function crystalRequest(config, path, body) {
  const apiKey = config?.apiKey;
  if (!apiKey) throw new Error("Memory Crystal apiKey is not configured");
  if (apiKey === "local") throw new Error("Memory Crystal cloud tools are not available in local-only mode");
  const base = (config?.convexUrl || DEFAULT_CONVEX_URL).replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
  return data;
}
function toToolResult(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}
function toToolError(err) {
  return { isError: true, content: [{ type: "text", text: `Error: ${getErrorMessage(err)}` }] };
}
function ensureString(v, name, min = 1) {
  if (typeof v !== "string" || v.trim().length < min) throw new Error(`${name} is required`);
  return v.trim();
}
function ensureEnum(v, valid, name) {
  if (!valid.includes(v)) throw new Error(`${name} must be one of: ${valid.join(", ")}`);
  return v;
}
function buildMemoryPath(id) { return `crystal/${String(id)}.md`; }
function parseMemoryPath(v) {
  if (typeof v !== "string") return "";
  const m = /^crystal\/(.+)\.md$/i.exec(v.trim());
  return m ? m[1] : "";
}
function confidenceLabel(score) {
  if (typeof score !== "number" || isNaN(score)) return "";
  if (score >= 0.85) return " [HIGH CONFIDENCE]";
  if (score >= 0.5) return "";
  return " [low confidence]";
}
function formatRecallMemory(m) {
  const id = normalizeMemoryId(m?.memoryId || m?._id || m?.id);
  const conf = confidenceLabel(m?.score ?? m?.confidence);
  return buildMemoryInjectionBlock(id, [
    `Type: ${m?.store || "?"}/${m?.category || "?"}${conf}`,
    `Title: ${trimSnippet(sanitizeForInjection(m?.title || "Untitled"), 120)}`,
    m?.content ? `Content: ${trimSnippet(sanitizeForInjection(m.content), 2000)}` : "",
    `Path: ${buildMemoryPath(id)}`,
  ]);
}
function formatMessageMatch(m) {
  const ts = typeof m?.timestamp === "number" ? new Date(m.timestamp).toLocaleString([], { hour12: false, hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }) : "unknown";
  return `- [${m?.role || "?"}] ${trimSnippet(sanitizeForInjection(m?.content || ""), 220)} (${ts})`;
}
function getSessionKey(ctx, event) {
  const rawSessionKey = firstString(ctx?.sessionKey, ctx?.sessionId, event?.sessionKey, event?.sessionId);
  const conversationId = firstString(ctx?.conversationId, event?.conversationId);
  return normalizeSessionKey(rawSessionKey, conversationId);
}
function normalizeScopedChannelKey(channelKey, channelScope) {
  const scope = typeof channelScope === "string" ? channelScope.trim() : "";
  const value = typeof channelKey === "string" ? channelKey.trim() : "";
  if (!scope || !value.startsWith(`${scope}:`)) return "";
  const peerId = value.slice(scope.length + 1).trim();
  if (!peerId || peerId === "main" || peerId === "default" || peerId === "unknown") return "";
  return value;
}
function resolveEffectiveChannel(ctx, event, fallbackScope) {
  const channelScope = getScopedChannelScope(ctx, event, fallbackScope);
  const explicitChannel = firstString(
    event?.channel,
    event?.channelKey,
    event?.context?.channel,
    ctx?.channel,
    ctx?.channelKey
  );
  const scopedExplicit = normalizeScopedChannelKey(explicitChannel, channelScope);
  if (scopedExplicit) return scopedExplicit;
  return resolveChannelKey(ctx, event, channelScope);
}
function resolveAutomaticInjectionChannel(ctx, event, fallbackScope) {
  const channelScope = getScopedChannelScope(ctx, event, fallbackScope);
  if (!channelScope) return resolveEffectiveChannel(ctx, event, fallbackScope);

  const explicitChannel = firstString(
    event?.channel,
    event?.channelKey,
    event?.context?.channel,
    ctx?.channel,
    ctx?.channelKey
  );
  const scopedExplicit = normalizeScopedChannelKey(explicitChannel, channelScope);
  if (scopedExplicit) return scopedExplicit;

  // Automatic injection must never infer a client scope from the session key.
  // Shared/admin lanes like `agent:coach:main` would otherwise become synthetic
  // channels such as `morrow-coach:main`, which the backend treats as a broad
  // named scope rather than a concrete client peer.
  const meta = event?.metadata || {};
  const explicitPeerId = firstString(
    meta?.from?.id != null ? String(meta.from.id) : "",
    event?.context?.from?.id != null ? String(event.context.from.id) : "",
    ctx?.peerId != null ? String(ctx.peerId) : "",
    event?.peerId != null ? String(event.peerId) : "",
    event?.senderId != null ? String(event.senderId) : "",
    ctx?.senderId != null ? String(ctx.senderId) : "",
    event?.context?.sender_id != null ? String(event.context.sender_id) : "",
    meta?.senderId != null ? String(meta.senderId) : "",
    meta?.authorId != null ? String(meta.authorId) : "",
    event?.context?.authorId != null ? String(event.context.authorId) : "",
    event?.authorId != null ? String(event.authorId) : "",
    ctx?.authorId != null ? String(ctx.authorId) : ""
  );
  return explicitPeerId ? `${channelScope}:${explicitPeerId}` : "";
}
function resolveLocalContextKey(sessionKey, channelKey, channelScope) {
  if (channelScope) return channelKey || "";
  return sessionKey || "";
}
function getScopedChannelScope(ctx, event, fallbackScope) {
  const sessionKey = getSessionKey(ctx, event);
  if (sessionKey && sessionChannelScopes.has(sessionKey)) return sessionChannelScopes.get(sessionKey);
  return fallbackScope;
}
function resolveScopedChannelKey(ctx, event, fallbackScope) {
  const channelScope = getScopedChannelScope(ctx, event, fallbackScope);
  return channelScope ? getChannelKey(ctx, event, channelScope) : "";
}
function resolveChannelKey(ctx, event, fallbackScope) {
  return getChannelKey(ctx, event, getScopedChannelScope(ctx, event, fallbackScope));
}
function queueContextEngineMessages(sessionKey, messages) {
  if (!sessionKey || !Array.isArray(messages) || !messages.length) return;
  const norm = messages.map((m) => normalizeContextEngineMessage(m)).filter(Boolean);
  if (!norm.length) return;
  pendingContextEngineMessages.set(sessionKey, (pendingContextEngineMessages.get(sessionKey) || []).concat(norm));
}
async function logMessage(api, ctx, payload) {
  await request(getPluginConfig(api, ctx), "POST", "/api/mcp/log", payload, api.logger);
}
async function captureTurn(api, event, ctx, userMessage, assistantText) {
  if (!shouldCapture(userMessage, assistantText)) return;
  const config = getPluginConfig(api, ctx);
  await request(config, "POST", "/api/mcp/capture", {
    title: `OpenClaw — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    content: [userMessage ? `User: ${userMessage}` : null, `Assistant: ${assistantText}`].filter(Boolean).join("\n\n"),
    store: "sensory", category: "conversation", tags: ["openclaw", "auto-capture"],
    channel: resolveEffectiveChannel(ctx, event, config?.channelScope),
  }, api.logger);
}
async function flushContextEngineMessages(api, ctx, sessionKey, eventLike) {
  const buffered = pendingContextEngineMessages.get(sessionKey) || [];
  if (!buffered.length) return { flushed: 0 };
  // Atomic swap-and-clear: grab the buffer and delete immediately before async I/O
  // to prevent concurrent calls from double-processing the same messages.
  pendingContextEngineMessages.delete(sessionKey);
  const config = getPluginConfig(api, ctx);
  const channelKey = resolveEffectiveChannel(ctx, eventLike || { sessionKey }, config?.channelScope);
  for (const msg of buffered) {
    await logMessage(api, ctx, { role: msg.role, content: msg.content, channel: channelKey, sessionKey });
  }
  const lastUser = [...buffered].reverse().find((m) => m.role === "user")?.content || "";
  const lastAssist = [...buffered].reverse().find((m) => m.role === "assistant")?.content || "";
  if (lastAssist) await captureTurn(api, eventLike || { sessionKey }, ctx, lastUser, lastAssist);
  return { flushed: buffered.length };
}
async function buildBeforeAgentContext(api, event, ctx) {
  const config = getPluginConfig(api, ctx);
  if (!config?.apiKey || config.apiKey === "local") return "";
  const channel = resolveAutomaticInjectionChannel(ctx, event, config?.channelScope);
  const sessionKey = getSessionKey(ctx, event);
  const cronMode = isCronOrIsolated(ctx, event);
  const sections = cronMode ? [] : [PREAMBLE_BACKEND, PREAMBLE_TOOLS];
  const canAutoInjectScopedMemory = !config?.channelScope || Boolean(channel);
  if (!cronMode && sessionKey && !wakeInjectedSessions.has(sessionKey) && canAutoInjectScopedMemory) {
    const wake = await request(config, "POST", "/api/mcp/wake", { channel }, api.logger);
    const briefing = wake?.briefing || wake?.summary || wake?.text;
    if (briefing) { sections.push(sanitizeForInjection(String(briefing))); wakeInjectedSessions.add(sessionKey); }
  }
  // --- Organic Ideas: inject pending discoveries before recall ---
  if (!cronMode) {
    try {
      const pendingIdeas = await request(config, "POST", "/api/organic/ideas/pending", { limit: 3 }, api.logger);
      const ideas = Array.isArray(pendingIdeas?.ideas) ? pendingIdeas.ideas.filter(i => (i?.confidence ?? 0) > 0.5).slice(0, 3) : [];
      if (ideas.length) {
        const ideaBlocks = ideas.map(i => {
          const sourceCount = Array.isArray(i.sourceMemoryIds) ? i.sourceMemoryIds.length : 0;
          return buildMemoryInjectionBlock(`idea:${i._id || i.id || "unknown"}`, [
            `Title: ${trimSnippet(sanitizeForInjection(i.title || "Untitled discovery"), 120)}`,
            `Content: ${trimSnippet(sanitizeForInjection(i.summary || ""), 2000)}`,
            `Source: Based on ${sourceCount || "multiple"} connected memories`,
          ]);
        });
        sections.push([
          "--- Memory Discovery ---",
          "While you were away, your memory discovered:",
          "",
          ...ideaBlocks,
          "",
          "(Respond naturally -- reference this if relevant to the conversation)",
          "--- End Discovery ---"
        ].join("\n"));
        // Mark ideas as notified (fire-and-forget)
        const ideaIds = ideas.map(i => i._id || i.id).filter(Boolean);
        if (ideaIds.length) {
          request(config, "POST", "/api/organic/ideas/update", { ideaIds, status: "notified" }, api.logger).catch(() => {});
        }
      }
    } catch (_) { /* endpoint may not exist yet — skip silently */ }
  }
  const prompt = String(event?.prompt || "").trim();
  if (prompt.length >= 5 && canAutoInjectScopedMemory) {
    const limit = Math.max(1, Math.min(Number.isFinite(Number(config?.defaultRecallLimit)) ? Number(config.defaultRecallLimit) : 5, 8));
    const recall = await request(config, "POST", "/api/mcp/recall", { query: prompt, limit: limit + 5, channel, mode: config?.defaultRecallMode || "general" }, api.logger);
    let mems = Array.isArray(recall?.memories) ? recall.memories : [];
    // --- Channel isolation: drop cross-client memories in peer-scoped sessions ---
    // When channel is peer-specific (e.g. "morrow-coach:12345"), exclude non-KB
    // memories with continuityScore===0 — they belong to other clients/sessions.
    // KB memories (knowledgeBaseId set) are allowed through since they're curated content.
    if (channel && channel.includes(":")) {
      mems = mems.filter(m => {
        if (m.knowledgeBaseId) return true; // KB content is always allowed
        const cont = m.rankingSignals?.continuityScore ?? m.continuityScore;
        return cont !== 0;
      });
    }
    mems = mems.slice(0, 5);
    // --- Organic: log recall query (fire-and-forget) ---
    request(config, "POST", "/api/organic/recallLog", { query: prompt, resultCount: mems.length, source: "plugin" }, api.logger).catch(() => {});
    // Cache top recall results for reinforcement injection later in the conversation
    if (mems.length && sessionKey) {
      sessionRecallCache.set(sessionKey, mems.slice(0, 3));
      sessionRecallCacheTimestamps.set(sessionKey, Date.now());
    }
    if (mems.length) {
      const hasHighConf = mems.some(m => (m?.score ?? m?.confidence ?? 0) >= 0.85);
      const recallDirective = hasHighConf
        ? "\nHigh-confidence memories found. Reference these where relevant — they reflect actual user history. If a memory conflicts with an explicit user instruction, the instruction takes precedence."
        : "\nCheck if any recalled memories are relevant to this query. Reference them naturally if so.";
      sections.push(["## Relevant Memory Recall", `Prompt: ${trimSnippet(prompt, 180)}`, ...mems.map(formatRecallMemory), "", "Use memory_search for broader lookup and memory_get on the returned crystal/<id>.md path for full detail.", recallDirective].join("\n"));
    }
    if (!cronMode) {
      const isPeerScopedChannel = channel && channel.includes(":");
      if (!isPeerScopedChannel) {
        const msgS = await request(config, "POST", "/api/mcp/search-messages", { query: prompt, limit: 5, channel }, api.logger);
        const msgs = Array.isArray(msgS?.messages) ? msgS.messages.slice(0, 5) : [];
        if (msgs.length) sections.push(["## Recent Message Matches", `Prompt: ${trimSnippet(prompt, 180)}`, ...msgs.map(formatMessageMatch)].join("\n"));

        // Token-budgeted recent message window (~7k chars): fetch up to 30 recent
        // messages ordered by time, trim from oldest until we fit the budget.
        const RECENT_CHAR_BUDGET = 7000;
        const recentR = await request(config, "POST", "/api/mcp/recent-messages", { limit: 30, channel }, api.logger);
        const recentRaw = Array.isArray(recentR?.messages) ? recentR.messages : [];
        if (recentRaw.length) {
          // Build lines from the ascending list (oldest-first from backend)
          const lines = recentRaw.map(m => {
            const role = m.role === "assistant" ? "assistant" : "user";
            const ts = m.createdAt ? new Date(m.createdAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" }) : "";
            const snippet = sanitizeForInjection(String(m.content || m.text || "")).replace(/\n+/g, " ").trim().slice(0, 400);
            return `[${ts}] ${role}: ${snippet}`;
          });
          // Iterate from end (newest) to keep most recent messages on budget overflow
          const kept = [];
          let chars = 0;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (chars + lines[i].length + 1 > RECENT_CHAR_BUDGET) break;
            kept.push(lines[i]);
            chars += lines[i].length + 1;
          }
          if (kept.length) {
            kept.reverse(); // restore chronological order for injection
            sections.push(["## Recent Context (last messages)", ...kept].join("\n"));
          }
        }
      }
    }
    const currentIntent = classifyIntent(prompt);
    if (currentIntent === "command" || currentIntent === "workflow") {
      const skillRecall = await request(config, "POST", "/api/mcp/recall", {
        query: prompt,
        limit: 3,
        channel,
        mode: "workflow",
      }, api.logger);
      const skills = Array.isArray(skillRecall?.memories)
        ? skillRecall.memories.filter((memory) => memory?.store === "procedural").slice(0, 3)
        : [];
      if (skills.length) {
        sections.push([
          "## Relevant Skills",
          `Prompt: ${trimSnippet(prompt, 180)}`,
          ...skills.map(formatProceduralMemory),
          "",
          "Apply these skills if they fit the current task.",
        ].join("\n"));
      }
    }
  }
  // Budget gating: trim injection to fit the model's effective context capacity.
  // Label each section by its header so we can drop lowest-priority first.
  const modelName = event?.model || ctx?.model || ctx?.config?.model || "";
  const budget = getInjectionBudget(modelName);
  const labeledSections = sections.filter(Boolean).map((text) => {
    if (text.includes("Recent Context")) return { label: "Recent Context", text };
    if (text.includes("Recent Message Matches")) return { label: "Recent Message Matches", text };
    if (text.includes("Relevant Skills")) return { label: "Relevant Skills", text };
    if (text.includes("Memory Discovery")) return { label: "Memory Discovery", text };
    if (text.includes("Relevant Recall")) return { label: "Relevant Recall", text };
    return { label: "Preamble", text };
  });
  // Drop order: lowest priority first. Recall is highest priority (dropped last).
  const dropOrder = ["Recent Context", "Recent Message Matches", "Relevant Skills", "Memory Discovery", "Preamble"];
  const trimmed = trimSections(labeledSections, budget.maxChars, dropOrder);
  return trimmed.map((s) => s.text).join("\n\n").trim();
}
function _registerLocalTools(api) {
  if (localToolsRegistered || !localStore) return;
  localToolsRegistered = true;
  import("./tools/crystal-local-tools.js").then(({ createLocalTools }) => {
    for (const tool of createLocalTools(localStore, {
      resolveSessionKey: (ctx) => getSessionKey(ctx, ctx?.event || ctx),
    })) { try { api.registerTool(tool); } catch (_) {} }
    api.logger?.info?.("[crystal] Local tools registered: crystal_grep, crystal_describe, crystal_expand");
  }).catch((err) => { api.logger?.warn?.(`[crystal] Local tools unavailable: ${getErrorMessage(err)}`); });
}
module.exports = (api) => {
  // Capture pluginConfig at init — the only moment it's reliably available.
  // This is the workaround for the OpenClaw pluginConfig-not-forwarded-to-tools bug.
  if (api?.pluginConfig && typeof api.pluginConfig === "object") {
    _capturedPluginConfig = api.pluginConfig;
  }
  maybeRunAutoUpdate(api?.pluginConfig, api?.logger);

  // Periodic sweep of orphaned session state (sessions where session_end never fired)
  const _orphanSweepTimer = setInterval(sweepStaleSessions, ORPHAN_SWEEP_INTERVAL_MS);
  if (_orphanSweepTimer.unref) _orphanSweepTimer.unref(); // don't block process exit

  const hook = typeof api.on === "function"
    ? api.on.bind(api)
    : (typeof api.registerHook === "function" ? api.registerHook.bind(api) : null);
  if (!hook) throw new Error("crystal-memory requires api.on or api.registerHook");
  hook("before_agent_start", async (event, ctx) => {
    try {
      const ctx2 = await buildBeforeAgentContext(api, event, ctx);
      if (ctx2) return { prependContext: ctx2 };
    } catch (err) { api.logger?.warn?.(`[crystal] before_agent_start: ${getErrorMessage(err)}`); }
  }, { name: "crystal-memory.before-agent-start", description: "Inject wake briefing + recall" });
  // before_tool_call: surface actionTriggers warnings if any memories match the tool being called
  try {
    hook("before_tool_call", async (event, ctx) => {
      try {
        const toolName = event?.tool?.name || event?.toolName;
        if (!toolName) return;
        const cfg = getPluginConfig(api, ctx);
        const data = await crystalRequest(cfg, "/api/mcp/triggers", { tools: [toolName] }).catch(() => null);
        const mems = Array.isArray(data?.memories) ? data.memories : [];
        if (mems.length > 0) {
          const warning = mems.map((m) => `[crystal-guardrail] ${sanitizeForInjection(m.title || "")}: ${sanitizeForInjection(String(m.content || "")).slice(0, 200)}`).join("\n");
          return { warning };
        }
      } catch (_) {}
    }, { name: "crystal-memory.before-tool-call", description: "Surface actionTriggers warnings before tool calls" });
  } catch (_) {}
  try {
    hook("before_dispatch", async (event, ctx) => {
      try {
        const cfg = getPluginConfig(api, ctx);
        const sessionKey = getSessionKey(ctx, event);
        const data = await crystalRequest(cfg, "/api/mcp/rate-limit-check", { sessionKey }).catch(() => null);
        if (data?.allowed === false) {
          return {
            block: true,
            reason: "Memory Crystal rate limit reached. Upgrade at memorycrystal.ai/pricing.",
          };
        }
      } catch (_) {}
    }, { name: "crystal-memory.before-dispatch-rate-limit", description: "Check Memory Crystal rate limit before dispatch" });
  } catch (_) {}
  try {
    hook("before_dispatch", async (event, ctx) => {
      try {
        const cfg = getPluginConfig(api, ctx);
        const sessionKey = getSessionKey(ctx, event);
        let cached = sessionKey ? intentCache.get(sessionKey) : null;
        if (cached && Date.now() - cached.detectedAt > INTENT_CACHE_TTL_MS) {
          intentCache.delete(sessionKey);
          cached = null;
        }
        api.logger?.info?.("[crystal] before_dispatch intent=" + (cached?.intent || "unknown"));
        const text = sessionKey ? pendingUserMessages.get(sessionKey) : null;
        if (!text || text.length < 10) return;
        const intent = cached?.intent || "general";
        // Intent-triggered deep recall: vary depth by intent severity
        let recallLimit = 3;
        let recallMode = "general";
        if (intent === "command") {
          // Commands get preflight-style recall (decisions + lessons)
          recallLimit = 5;
          recallMode = "decision";
        } else if (intent === "workflow") {
          recallLimit = 6;
          recallMode = "workflow";
        } else if (intent === "recall" || intent === "question") {
          // Explicit recall/questions get deeper results
          recallLimit = 8;
        } else if (intent === "reflect") {
          recallLimit = 6;
        }
        const channel = resolveAutomaticInjectionChannel(ctx, event, cfg?.channelScope);
        if (cfg?.channelScope && !channel) return;
        const result = await crystalRequest(cfg, "/api/mcp/recall", {
          query: text,
          limit: recallLimit,
          mode: recallMode,
          ...(channel ? { channel } : {}),
        }).catch(() => null);
        if (result?.memories?.length > 0) {
          const formatted = result.memories.slice(0, recallLimit).map(formatRecallMemory);
          const hasHighConf = result.memories.some(m => (m?.score ?? m?.confidence ?? 0) >= 0.85);
          const directive = hasHighConf
            ? "\n[!] High-confidence memories found — prioritize these over general knowledge."
            : "";
          const block = `[Memory recall — ${intent} intent, ${result.memories.length} results]\n${formatted.join("\n")}${directive}`;
          return { prependContext: block };
        }
      } catch (_) {}
    }, { name: "crystal-memory.before-dispatch-proactive-recall", description: "Surface proactive Memory Crystal recall before dispatch" });
  } catch (_) {}

  // Reinforcement injection: re-inject top recall memories near the end of long
  // conversations to combat the "lost in the middle" attention degradation effect.
  // This is lightweight (cached data, no API calls) and only fires after 5+ turns.
  try {
    hook("before_dispatch", async (event, ctx) => {
      try {
        const sessionKey = getSessionKey(ctx, event);
        if (!sessionKey) return;

        const turnCount = reinforcementTurnCounters.get(sessionKey) || 0;
        if (turnCount < REINFORCEMENT_TURN_THRESHOLD) return;

        const cacheTs = sessionRecallCacheTimestamps.get(sessionKey);
        if (!cacheTs || Date.now() - cacheTs > SESSION_RECALL_CACHE_MAX_AGE_MS) {
          sessionRecallCache.delete(sessionKey);
          sessionRecallCacheTimestamps.delete(sessionKey);
          return;
        }

        const cached = sessionRecallCache.get(sessionKey);
        if (!cached || cached.length === 0) return;

        let block = "## Memory Reinforcement\n";
        let charCount = block.length;

        for (const mem of cached.slice(0, 2)) {
          const title = sanitizeForInjection(String(mem.title || "")).slice(0, 80);
          const content = sanitizeForInjection(String(mem.content || "")).slice(0, 300);
          const line = `[Recall: ${title}] ${content}\n`;
          if (charCount + line.length > REINFORCEMENT_MAX_CHARS) break;
          block += line;
          charCount += line.length;
        }

        return { prependContext: block };
      } catch (err) {
        api.logger?.warn?.(`[crystal] reinforcement: ${getErrorMessage(err)}`);
      }
    }, { name: "crystal-memory.before-dispatch-reinforcement", description: "Re-inject cached recall for lost-in-the-middle mitigation" });
  } catch (_) {}

  hook("message_received", async (event, ctx) => {
    try {
      const text = extractUserText(event);
      const sessionKey = getSessionKey(ctx, event);
      touchSession(sessionKey);
      const config = getPluginConfig(api, ctx);
      const channelScope = getScopedChannelScope(ctx, event, config?.channelScope);
      const channelKey = resolveEffectiveChannel(ctx, event, config?.channelScope);
      const localContextKey = resolveLocalContextKey(
        sessionKey,
        resolveAutomaticInjectionChannel(ctx, event, config?.channelScope),
        channelScope
      );
      api.logger?.warn?.(`[crystal] message_received session=${sessionKey || "?"} channel=${channelKey || "?"} textLen=${String(text || "").length}`);
      if (!seenCaptureSessions.has(`msg:${sessionKey}`)) seenCaptureSessions.add(`msg:${sessionKey}`);
      if (text && sessionKey) pendingUserMessages.set(sessionKey, String(text));
      if (text && sessionKey) appendConversationPulseMessage(sessionKey, "user", String(text));
      if (text && sessionKey) {
        const intent = classifyIntent(text);
        intentCache.set(sessionKey, { intent, detectedAt: Date.now() });
      }
      if (text) await logMessage(api, ctx, { role: "user", content: String(text), channel: channelKey, sessionKey: sessionKey || undefined });
      const store = await getLocalStore(config, api.logger);
      if (store && text && localContextKey) { store.addMessage(localContextKey, "user", String(text)); _registerLocalTools(api); }
      if (sessionKey) sessionConfigs.set(sessionKey, { mode: config?.defaultRecallMode || "general", limit: config?.defaultRecallLimit || 8 });
      fireMediaCapture(event, config, channelKey, sessionKey);
      if (text && sessionKey) triggerConversationPulse(api, ctx, sessionKey, String(text));
    } catch (err) { api.logger?.warn?.(`[crystal] message_received: ${getErrorMessage(err)}`); }
  }, { name: "crystal-memory.message-received", description: "Buffer + persist user turn" });
  hook("llm_output", async (event, ctx) => {
    try {
      const assistantText = extractAssistantText(event);
      const sessionKey = getSessionKey(ctx, event);
      touchSession(sessionKey);
      const config = getPluginConfig(api, ctx);
      const channelScope = getScopedChannelScope(ctx, event, config?.channelScope);
      const channelKey = resolveEffectiveChannel(ctx, event, config?.channelScope);
      const localContextKey = resolveLocalContextKey(
        sessionKey,
        resolveAutomaticInjectionChannel(ctx, event, config?.channelScope),
        channelScope
      );
      if (!seenCaptureSessions.has(`out:${sessionKey}`)) { seenCaptureSessions.add(`out:${sessionKey}`); api.logger?.info?.(`[crystal] llm_output session=${sessionKey}`); }
      if (!assistantText) { api.logger?.warn?.("[crystal] llm_output missing assistant text"); return; }
      const userMessage = sessionKey ? pendingUserMessages.get(sessionKey) || "" : "";
      await logMessage(api, ctx, { role: "assistant", content: assistantText, channel: channelKey, sessionKey: sessionKey || undefined });
      const store = await getLocalStore(config, api.logger);
      if (store && localContextKey) { store.addMessage(localContextKey, "assistant", assistantText); _registerLocalTools(api); }
      if (sessionKey) appendConversationPulseMessage(sessionKey, "assistant", assistantText);
      if (sessionKey) pendingUserMessages.delete(sessionKey);
      await captureTurn(api, event, ctx, userMessage, assistantText);
      fireMediaCapture(event, config, channelKey, sessionKey);
    } catch (err) { api.logger?.warn?.(`[crystal] llm_output: ${getErrorMessage(err)}`); }
  }, { name: "crystal-memory.llm-output", description: "Capture AI response" });
  hook("message_sent", async (event, ctx) => {
    try {
      const sessionKey = getSessionKey(ctx, event);
      if (!sessionKey || !pendingUserMessages.has(sessionKey)) return;
      const assistantText = extractAssistantText(event);
      if (!assistantText) return;
      const config = getPluginConfig(api, ctx);
      const channelScope = getScopedChannelScope(ctx, event, config?.channelScope);
      const channelKey = resolveEffectiveChannel(ctx, event, config?.channelScope);
      const localContextKey = resolveLocalContextKey(
        sessionKey,
        resolveAutomaticInjectionChannel(ctx, event, config?.channelScope),
        channelScope
      );
      const userMessage = pendingUserMessages.get(sessionKey) || "";
      await logMessage(api, ctx, { role: "assistant", content: assistantText, channel: channelKey, sessionKey });
      const store = await getLocalStore(config, api.logger);
      if (store && localContextKey) { store.addMessage(localContextKey, "assistant", assistantText); _registerLocalTools(api); }
      appendConversationPulseMessage(sessionKey, "assistant", assistantText);
      pendingUserMessages.delete(sessionKey);
      await captureTurn(api, event, ctx, userMessage, assistantText);
    } catch (err) { api.logger?.warn?.(`[crystal] message_sent fallback: ${getErrorMessage(err)}`); }
  }, { name: "crystal-memory.message-sent-fallback", description: "Fallback assistant capture" });
  // session_start fires when a new session begins (replaces removed command:new typed hook)
  hook("session_start", async (event, ctx) => {
    try { await request(getPluginConfig(api, ctx), "POST", "/api/mcp/reflect", { windowHours: 4 }, api.logger); }
    catch (err) { api.logger?.warn?.(`[crystal] session_start reflect: ${getErrorMessage(err)}`); }
  }, { name: "crystal-memory.session-start", description: "Trigger reflection on new session" });
  // before_reset fires before /reset is processed (replaces removed command:reset typed hook)
  hook("before_reset", async (event, ctx) => {
    try { await request(getPluginConfig(api, ctx), "POST", "/api/mcp/reflect", { windowHours: 4 }, api.logger); }
    catch (err) { api.logger?.warn?.(`[crystal] before_reset reflect: ${getErrorMessage(err)}`); }
  }, { name: "crystal-memory.before-reset", description: "Trigger reflection before session reset" });
  hook("session_end", async (event, ctx) => {
    const sessionKey = getSessionKey(ctx, event);
    clearSessionState(sessionKey);
  }, { name: "crystal-memory.session-end", description: "Clear per-session caches on session end" });
  if (typeof api.registerContextEngine === "function") {
    api.registerContextEngine("crystal-memory", () => ({
      info: { name: "crystal-memory", ownsCompaction: true },
      async ingestBatch(payload, ctx) {
        try {
          const sessionKey = normalizeSessionKey(
            firstString(payload?.sessionKey, payload?.sessionId, ctx?.sessionKey, ctx?.sessionId),
            firstString(payload?.conversationId, ctx?.conversationId)
          );
          const messages = Array.isArray(payload?.messages) ? payload.messages : [];
          queueContextEngineMessages(sessionKey, messages);
          const pluginCfg = getPluginConfig(api, ctx);
          const channelScope = getScopedChannelScope(ctx, { sessionKey }, pluginCfg?.channelScope);
          const channelKey = firstString(payload?.channel, resolveEffectiveChannel(ctx, { sessionKey, channel: payload?.channel }, pluginCfg?.channelScope));
          const flushed = await flushContextEngineMessages(api, ctx, sessionKey, { sessionKey, channel: channelKey });
          const store = await getLocalStore(pluginCfg, api.logger);
          if (store && sessionKey) {
            const localContextKey = resolveLocalContextKey(
              sessionKey,
              resolveAutomaticInjectionChannel(ctx, { sessionKey, channel: payload?.channel }, pluginCfg?.channelScope),
              channelScope
            );
            for (const msg of messages) {
              const nm = normalizeContextEngineMessage(msg);
              if (nm && localContextKey && (nm.role === "user" || nm.role === "assistant")) store.addMessage(localContextKey, nm.role, nm.content);
            }
            _registerLocalTools(api);
          }
          return flushed;
        } catch (err) { api.logger?.warn?.(`[crystal] ingestBatch: ${getErrorMessage(err)}`); }
      },
      async assemble(payload, ctx) {
        try {
          const messages = Array.isArray(payload?.messages) ? payload.messages : [];
          const budget = Number.isFinite(Number(payload?.tokenBudget)) ? Number(payload.tokenBudget) : Infinity;
          const sessionKey = normalizeSessionKey(
            firstString(payload?.sessionKey, payload?.sessionId, ctx?.sessionKey, ctx?.sessionId),
            firstString(payload?.conversationId, ctx?.conversationId)
          ) || "default";
          const pluginCfg = getPluginConfig(api, ctx);
          const channelScope = getScopedChannelScope(ctx, { sessionKey }, pluginCfg?.channelScope);
          const channelKey = resolveEffectiveChannel(ctx, { sessionKey, channel: payload?.channel }, pluginCfg?.channelScope);
          const localContextKey = resolveLocalContextKey(
            sessionKey,
            resolveAutomaticInjectionChannel(ctx, { sessionKey, channel: payload?.channel }, pluginCfg?.channelScope),
            channelScope
          );
          const injectionEnabled = pluginCfg.localSummaryInjection !== false;
          const injectionBudget = pluginCfg.localSummaryMaxTokens || 2000;
          const syntheticEvent = {
            prompt: messages.map((m) => normalizeContextEngineMessage(m, m?.role || "user")?.content || "").filter(Boolean).slice(-6).join("\n\n"),
            sessionKey,
            ...(channelKey ? { channel: channelKey } : {}),
          };
          let localMessages = [];
          const store = localStore || await getLocalStore(pluginCfg, api.logger);
          if (store && localContextKey) {
            try {
              const assembled = await assembleContext(store, localContextKey, budget, undefined, {
                localSummaryInjection: injectionEnabled,
                localSummaryMaxTokens: injectionBudget,
              });
              if (Array.isArray(assembled) && assembled.length) localMessages = assembled;
            } catch (_) {}
          }
          const convexContext = await buildBeforeAgentContext(api, syntheticEvent, { ...(ctx || {}), sessionKey });
          const systemMsg = convexContext ? [{ role: "system", content: convexContext }] : [];
          const TAIL_KEEP = 6;
          const finalMessages = localMessages.length > 0 && messages.length > TAIL_KEEP
            ? [...systemMsg, ...localMessages, ...messages.slice(-TAIL_KEEP)]
            : [...systemMsg, ...localMessages, ...messages];
          try {
            const store = localStore || await getLocalStore(pluginCfg, api.logger);
            if (store && localContextKey) {
              const hotTopics = store.getLessonCountsForSession(localContextKey, 3);
              if (hotTopics.length > 0) {
                const warnings = hotTopics.map((r) => `CIRCUIT BREAKER: You have saved ${r.count} lessons about "${r.topic}" in this session. This suggests repeated failures. Stop and ask your human for guidance before continuing.`).join("\n");
                finalMessages.unshift({ role: "system", content: warnings });
              }
            }
          } catch (_) {}
          const normalizedMessages = finalMessages.map((m) => ({ role: m.role, content: toContentParts(m.content) }));
          return {
            messages: normalizedMessages,
            used: (convexContext?.length || 0) + localMessages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0),
          };
        } catch (err) {
          api.logger?.warn?.(`[crystal] assemble: ${getErrorMessage(err)}`);
          const fallbackMsgs = Array.isArray(payload?.messages) ? payload.messages : [];
          return { messages: fallbackMsgs.map((m) => ({ role: m.role, content: toContentParts(m.content) })), used: 0 };
        }
      },
      async compact(payload, ctx) {
        try {
          const sessionKey = normalizeSessionKey(
            firstString(payload?.sessionKey, payload?.sessionId, ctx?.sessionKey, ctx?.sessionId),
            firstString(payload?.conversationId, ctx?.conversationId)
          );
          const messages = Array.isArray(payload?.messages) ? payload.messages : [];
          queueContextEngineMessages(sessionKey, messages);
          const pluginCfg = getPluginConfig(api, ctx);
          const channelScope = getScopedChannelScope(ctx, { sessionKey }, pluginCfg?.channelScope);
          const channel = firstString(payload?.channel, resolveEffectiveChannel(ctx, { sessionKey, channel: payload?.channel }, pluginCfg?.channelScope));
          const localContextKey = resolveLocalContextKey(
            sessionKey,
            resolveAutomaticInjectionChannel(ctx, { sessionKey, channel: payload?.channel }, pluginCfg?.channelScope),
            channelScope
          );
          const flushed = await flushContextEngineMessages(api, ctx, sessionKey, { sessionKey, channel });
          let summaryCount = 0;
          if (compactionEngine && localContextKey) { try { summaryCount = (await compactionEngine.compact(localContextKey, 32000, compactionEngine._summarizeFn, false))?.summariesCreated ?? 0; } catch (_) {} }
          const label = `OpenClaw compaction — ${new Date().toISOString()}`;
          const cfg = pluginCfg;
          // Snapshot the full conversation before compaction (non-fatal — failure won't break compaction)
          let snapshotId = null;
          try {
            const snap = await request(cfg, "POST", "/api/mcp/snapshot", {
              sessionKey,
              channel,
              messages: messages.map((m) => ({ role: m.role || "user", content: normalizeContextEngineMessage(m, m.role || "user")?.content || "", ...(m.timestamp != null ? { timestamp: m.timestamp } : {}) })),
              reason: payload?.reason || "compaction",
            }, api.logger);
            snapshotId = snap?.id || null;
          } catch (_) {}
          const checkpoint = await request(cfg, "POST", "/api/mcp/checkpoint", { label, description: `Compaction for ${sessionKey} summaries=${summaryCount}` }, api.logger);
          const capture = await request(cfg, "POST", "/api/mcp/capture", {
            title: label,
            content: `Session: ${sessionKey}\nReason: ${payload?.reason || "compaction"}\nLocal summaries: ${summaryCount}`,
            store: "episodic", category: "event", tags: ["openclaw", "compaction"],
            channel,
            sourceSnapshotId: snapshotId || undefined,
          }, api.logger);
          return `Memory Crystal compaction for ${sessionKey || "unknown"}; flushed=${flushed.flushed}; local_summaries=${summaryCount}; checkpoint=${checkpoint?.id || "none"}; capture=${capture?.id || "none"}; snapshot=${snapshotId || "none"}`;
        } catch (err) { api.logger?.warn?.(`[crystal] compact: ${getErrorMessage(err)}`); return null; }
      },
      async afterTurn(payload, ctx) {
        try {
          const sessionKey = normalizeSessionKey(
            firstString(payload?.sessionKey, payload?.sessionId, ctx?.sessionKey, ctx?.sessionId),
            firstString(payload?.conversationId, ctx?.conversationId)
          );
          const pluginCfg = getPluginConfig(api, ctx);
          const channelScope = getScopedChannelScope(ctx, { sessionKey }, pluginCfg?.channelScope);
          const channel = resolveEffectiveChannel(ctx, { sessionKey, channel: payload?.channel }, pluginCfg?.channelScope);
          const localContextKey = resolveLocalContextKey(
            sessionKey,
            resolveAutomaticInjectionChannel(ctx, { sessionKey, channel: payload?.channel }, pluginCfg?.channelScope),
            channelScope
          );
          await flushContextEngineMessages(api, ctx, sessionKey, { sessionKey, channel });
          if (compactionEngine && localContextKey) { try { await compactionEngine.compactLeaf(localContextKey, compactionEngine._summarizeFn); } catch (_) {} }
          if (localStore) _registerLocalTools(api);
        } catch (err) { api.logger?.warn?.(`[crystal] afterTurn: ${getErrorMessage(err)}`); }
      },
      dispose() {
        clearInterval(_orphanSweepTimer);
        pendingUserMessages.clear();
        sessionConfigs.clear();
        sessionChannelScopes.clear();
        wakeInjectedSessions.clear();
        seenCaptureSessions.clear();
        intentCache.clear();
        pendingContextEngineMessages.clear();
        conversationTurnCounters.clear();
        conversationPulseBuffers.clear();
        reinforcementTurnCounters.clear();
        sessionRecallCache.clear();
        sessionRecallCacheTimestamps.clear();
        sessionLastActivity.clear();
        if (localStore) { try { localStore.close(); } catch (_) {} }
      },
    }));
  } else {
    api.logger?.warn?.("[crystal] registerContextEngine unavailable; skipping");
  }
  api.registerTool({
    name: "crystal_set_scope", label: "Crystal Set Scope",
    description: "Override Memory Crystal channel scope for the current session.",
    parameters: {
      type: "object",
      properties: { scope: { type: "string", minLength: 1 } },
      required: ["scope"],
      additionalProperties: false,
    },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const scope = ensureString(params?.scope, "scope", 1);
        const sessionKey = getSessionKey(ctx, ctx);
        if (!sessionKey) throw new Error("sessionKey is required");
        sessionChannelScopes.set(sessionKey, scope);
        return toToolResult(`Memory Crystal session scope set to "${scope}" for ${sessionKey}.`);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "memory_search", label: "Memory Search",
    description: "Search saved memory for relevant long-term context. Returns crystal/<id>.md paths for use with memory_get.",
    parameters: { type: "object", properties: { query: { type: "string", minLength: 2 }, limit: { type: "number", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const query = ensureString(params?.query, "query", 2);
        const limit = Math.max(1, Math.min(Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 5, 20));
        const cfg = getPluginConfig(api, ctx);
        const resolvedChannel = resolveScopedChannelKey(ctx, ctx, cfg?.channelScope);
        const payload = { query, limit, ...(resolvedChannel ? { channel: resolvedChannel } : {}) };
        const data = await crystalRequest(cfg, "/api/mcp/recall", payload);
        const mems = Array.isArray(data?.memories) ? data.memories : [];
        return toToolResult({ query, resultCount: mems.length, results: mems.map((m) => { const mid = m?.memoryId || m?._id || m?.id; return { id: mid, path: buildMemoryPath(mid), title: m?.title, snippet: trimSnippet(m?.content || "", 220), store: m?.store, category: m?.category, score: m?.score }; }) });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_search_messages", label: "Crystal Search Messages",
    description: "Search short-term conversation logs in memory.",
    parameters: { type: "object", properties: { query: { type: "string", minLength: 2 }, limit: { type: "number", minimum: 1, maximum: 20 }, sinceMs: { type: "number", minimum: 0 }, channel: { type: "string" } }, required: ["query"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const query = ensureString(params?.query, "query", 2);
        const limit = Math.max(1, Math.min(Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 5, 20));
        const sinceMs = Number.isFinite(Number(params?.sinceMs)) ? Number(params.sinceMs) : undefined;
        const resolvedChannel = typeof params?.channel === "string" ? params.channel : resolveChannelKey(ctx, ctx, getPluginConfig(api, ctx)?.channelScope);
        let data = await crystalRequest(getPluginConfig(api, ctx), "/api/mcp/search-messages", { query, limit, sinceMs, channel: resolvedChannel });
        let messages = Array.isArray(data?.messages) ? data.messages : [];
        let scope = resolvedChannel ? "channel" : "global";
        if (!messages.length && typeof params?.channel !== "string" && resolvedChannel) {
          data = await crystalRequest(getPluginConfig(api, ctx), "/api/mcp/search-messages", { query, limit, sinceMs });
          messages = Array.isArray(data?.messages) ? data.messages : [];
          if (messages.length) scope = "global-fallback";
        }
        return toToolResult({ query, messageCount: messages.length, searchScope: scope, channel: resolvedChannel || null, topMessages: messages.slice(0, 10) });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "memory_get", label: "Memory Get",
    description: "Read a full saved memory item by memoryId or crystal/<id>.md path.",
    parameters: { type: "object", properties: { path: { type: "string" }, memoryId: { type: "string" } }, additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const memoryId = (typeof params?.memoryId === "string" && params.memoryId.trim()) || parseMemoryPath(params?.path);
        if (!memoryId) throw new Error("memoryId or path required (expected crystal/<id>.md)");
        const data = await crystalRequest(getPluginConfig(api, ctx), "/api/mcp/memory", { memoryId });
        const m = data?.memory;
        if (!m?.id) throw new Error("Memory not found");
        return toToolResult({ id: m.id, path: buildMemoryPath(m.id), title: m.title, content: m.content, store: m.store, category: m.category, tags: m.tags || [], createdAt: m.createdAt, lastAccessedAt: m.lastAccessedAt, accessCount: m.accessCount, confidence: m.confidence, strength: m.strength, source: m.source, channel: m.channel, archived: m.archived });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_recall", label: "Crystal Recall",
    description: "Search memory for relevant past memories.",
    parameters: { type: "object", properties: { query: { type: "string", minLength: 2 }, limit: { type: "number", minimum: 1, maximum: 50 } }, required: ["query"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const query = ensureString(params?.query, "query", 2);
        const limit = Number.isFinite(Number(params?.limit)) ? Number(params.limit) : undefined;
        const cfg = getPluginConfig(api, ctx);
        const resolvedChannel = resolveScopedChannelKey(ctx, ctx, cfg?.channelScope);
        const payload = { query, ...(limit ? { limit } : {}), ...(resolvedChannel ? { channel: resolvedChannel } : {}) };
        const data = await crystalRequest(cfg, "/api/mcp/recall", payload);
        const mems = Array.isArray(data?.memories) ? data.memories : [];
        return toToolResult({ query, memoryCount: mems.length, topMemories: mems.slice(0, 10) });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_remember", label: "Crystal Remember",
    description: "Save a durable memory for future use.",
    parameters: { type: "object", properties: { store: { type: "string", enum: MEMORY_STORES }, category: { type: "string", enum: MEMORY_CATEGORIES }, title: { type: "string", minLength: 5, maxLength: 500 }, content: { type: "string", minLength: 1, maxLength: 50000 }, tags: { type: "array", items: { type: "string" } }, channel: { type: "string" } }, required: ["store","category","title","content"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const store = ensureEnum(params?.store, MEMORY_STORES, "store");
        const category = ensureEnum(params?.category, MEMORY_CATEGORIES, "category");
        const title = ensureString(params?.title, "title", 5);
        const content = ensureString(params?.content, "content", 1);
        const tags = Array.isArray(params?.tags) ? params.tags.map(String) : [];
        const data = await crystalRequest(getPluginConfig(api, ctx), "/api/mcp/capture", { title, content, store, category, tags, channel: typeof params?.channel === "string" ? params.channel : resolveChannelKey(ctx, ctx, getPluginConfig(api, ctx)?.channelScope) });
        if ((data?.ok || data?.id) && category === "lesson") {
          const topic = String(title).slice(0, 60);
          const sessionKey = getSessionKey(ctx, ctx) || "default";
          try {
            const localStoreForCount = localStore || await getLocalStore(getPluginConfig(api, ctx), api.logger);
            if (localStoreForCount) localStoreForCount.incrementLessonCount(sessionKey, topic);
          } catch (_) {}
        }
        return toToolResult({ ok: Boolean(data?.ok), id: data?.id, title, store, category });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_what_do_i_know", label: "Crystal What Do I Know",
    description: "Get a broad snapshot of what memory contains about a topic.",
    parameters: { type: "object", properties: { topic: { type: "string", minLength: 3 }, stores: { type: "array", items: { type: "string", enum: MEMORY_STORES } }, tags: { type: "array", items: { type: "string" } }, limit: { type: "number", minimum: 1, maximum: 20 } }, required: ["topic"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const topic = ensureString(params?.topic, "topic", 3);
        const limit = Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 8;
        const stores = Array.isArray(params?.stores) ? params.stores : undefined;
        const tags = Array.isArray(params?.tags) ? params.tags.map(String).filter(Boolean) : undefined;
        const cfg = getPluginConfig(api, ctx);
        const resolvedChannel = resolveScopedChannelKey(ctx, ctx, cfg?.channelScope);
        const payload = { query: topic, limit, ...(stores ? { stores } : {}), ...(tags ? { tags } : {}), ...(resolvedChannel ? { channel: resolvedChannel } : {}) };
        const data = await crystalRequest(cfg, "/api/mcp/recall", payload);
        const mems = Array.isArray(data?.memories) ? data.memories : [];
        return toToolResult({ topic, memoryCount: mems.length, summary: mems.slice(0, 3).map((m) => m.title).join("; ") || "No matching memories found.", topMemories: mems.slice(0, 10) });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_why_did_we", label: "Crystal Why Did We",
    description: "Decision archaeology over saved memories.",
    parameters: { type: "object", properties: { decision: { type: "string", minLength: 3 }, limit: { type: "number", minimum: 1, maximum: 20 } }, required: ["decision"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const decision = ensureString(params?.decision, "decision", 3);
        const limit = Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 8;
        const cfg = getPluginConfig(api, ctx);
        const resolvedChannel = resolveScopedChannelKey(ctx, ctx, cfg?.channelScope);
        const payload = { query: decision, limit, mode: "decision", categories: ["decision"], stores: MEMORY_STORES, ...(resolvedChannel ? { channel: resolvedChannel } : {}) };
        const data = await crystalRequest(cfg, "/api/mcp/recall", payload);
        const mems = Array.isArray(data?.memories) ? data.memories : [];
        return toToolResult({ decision, reasoning: mems.length > 0 ? `Primary threads around "${decision}"` : "No clear decision thread was surfaced.", relatedMemories: mems.slice(0, 10) });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_checkpoint", label: "Crystal Checkpoint",
    description: "Create a memory checkpoint for this milestone.",
    parameters: { type: "object", properties: { label: { type: "string", minLength: 1 }, description: { type: "string" } }, required: ["label"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const label = ensureString(params?.label, "label", 1);
        const description = typeof params?.description === "string" ? params.description : undefined;
        const data = await crystalRequest(getPluginConfig(api, ctx), "/api/mcp/checkpoint", { label, description });
        return toToolResult({ ok: Boolean(data?.ok), id: data?.id, label });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_preflight", label: "Crystal Preflight",
    description: "Run a pre-flight check before a destructive or production action. Returns relevant rules, lessons, and decisions as a structured checklist. Call this before any config change, API write, file delete, or external send.",
    parameters: { type: "object", properties: { action: { type: "string", minLength: 3, description: "Description of the action you are about to take. Be specific — e.g. 'apply config patch to OpenClaw gateway' or 'send email to customer'." }, limit: { type: "number", minimum: 1, maximum: 20 } }, required: ["action"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const action = ensureString(params?.action, "action", 3);
        const limit = Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 10;
        const cfg = getPluginConfig(api, ctx);
        const resolvedChannel = resolveScopedChannelKey(ctx, ctx, cfg?.channelScope);
        const payload = {
          query: action,
          limit,
          mode: "decision",
          ...(resolvedChannel ? { channel: resolvedChannel } : {}),
        };
        const data = await crystalRequest(cfg, "/api/mcp/recall", payload);
        const mems = Array.isArray(data?.memories) ? data.memories : [];
        const lessons = mems.filter((m) => m?.category === "lesson");
        const decisions = mems.filter((m) => m?.category === "decision");
        const rules = mems.filter((m) => (m?.category === "rule" || m?.store === "procedural") && m?.category !== "lesson" && m?.category !== "decision");
        const categorized = new Set([...rules, ...lessons, ...decisions]);
        const other = mems.filter((m) => !categorized.has(m));
        const lines = [`PRE-FLIGHT CHECK: ${action}`, ""];
        if (rules.length > 0) {
          lines.push("Rules:");
          rules.forEach((m) => lines.push(`  - [rule] ${m.title}`));
          lines.push("");
        }
        if (lessons.length > 0) {
          lines.push("Lessons:");
          lessons.forEach((m) => lines.push(`  - [lesson] ${m.title}`));
          lines.push("");
        }
        if (decisions.length > 0) {
          lines.push("Relevant decisions:");
          decisions.forEach((m) => lines.push(`  - [decision] ${m.title}`));
          lines.push("");
        }
        if (other.length > 0) {
          lines.push("Other context:");
          other.forEach((m) => lines.push(`  - [${m.category}] ${m.title}`));
          lines.push("");
        }
        if (mems.length === 0) {
          lines.push("No relevant memories found. Proceed with standard caution.");
        } else {
          lines.push("Review the above before proceeding. If any item applies, address it first.");
        }
        return toToolResult({
          action,
          checklist: lines.join("\n"),
          itemCount: mems.length,
          rules: rules.map((m) => m.title),
          lessons: lessons.map((m) => m.title),
          decisions: decisions.map((m) => m.title),
        });
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_recent", label: "Crystal Recent",
    description: "Get recent memories.",
    parameters: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 20 }, channel: { type: "string" } }, additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const limit = Number.isFinite(Number(params?.limit)) ? Math.max(1, Math.min(Number(params.limit), 20)) : 10;
        const cfg = getPluginConfig(api, ctx);
        const resolvedChannel = typeof params?.channel === "string" ? params.channel : resolveChannelKey(ctx, ctx, cfg?.channelScope);
        const payload = { limit, ...(resolvedChannel ? { channel: resolvedChannel } : {}) };
        const data = await crystalRequest(cfg, "/api/mcp/recent-messages", payload);
        return toToolResult(data);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_stats", label: "Crystal Stats",
    description: "Get memory store statistics.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _sig, _upd, ctx) {
      try {
        const cfg = getPluginConfig(api, ctx);
        const data = await request(cfg, "GET", "/api/mcp/stats", null, api.logger);
        if (!data) throw new Error("Failed to fetch stats from Memory Crystal");
        return toToolResult(data);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_forget", label: "Crystal Forget",
    description: "Archive or delete a saved memory.",
    parameters: { type: "object", properties: { memoryId: { type: "string", minLength: 1 }, permanent: { type: "boolean" } }, required: ["memoryId"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const memoryId = ensureString(params?.memoryId, "memoryId", 1);
        const permanent = params?.permanent === true;
        const data = await crystalRequest(getPluginConfig(api, ctx), "/api/mcp/forget", { memoryId, permanent });
        return toToolResult(data);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_trace", label: "Crystal Trace",
    description: "Trace a memory back to its source conversation. Returns the conversation snapshot that created this memory.",
    parameters: { type: "object", properties: { memoryId: { type: "string", minLength: 1 } }, required: ["memoryId"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const memoryId = ensureString(params?.memoryId, "memoryId", 1);
        const data = await crystalRequest(getPluginConfig(api, ctx), "/api/mcp/trace", { memoryId });
        return toToolResult(data);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_wake", label: "Crystal Wake",
    description: "Get a wake briefing with recent context, goals, and guardrails.",
    parameters: { type: "object", properties: { channel: { type: "string" } }, additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const cfg = getPluginConfig(api, ctx);
        const resolvedChannel = typeof params?.channel === "string" ? params.channel : resolveChannelKey(ctx, ctx, cfg?.channelScope);
        const payload = resolvedChannel ? { channel: resolvedChannel } : {};
        const data = await crystalRequest(cfg, "/api/mcp/wake", payload);
        return toToolResult(data);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_who_owns", label: "Crystal Who Owns",
    description: "Find who owns, manages, or is assigned to an entity. Returns ownership context from memories.",
    parameters: { type: "object", properties: { topic: { type: "string", minLength: 1 }, limit: { type: "number", minimum: 1, maximum: 20 } }, required: ["topic"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const topic = ensureString(params?.topic, "topic", 1);
        const limit = Math.max(1, Math.min(Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 5, 20));
        const cfg = getPluginConfig(api, ctx);
        const data = await crystalRequest(cfg, "/api/mcp/recall", { query: `who owns ${topic}`, categories: ["person"], limit, mode: "people" });
        return toToolResult(data);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_explain_connection", label: "Crystal Explain Connection",
    description: "Explain the connection or relationship between two concepts, people, or systems.",
    parameters: { type: "object", properties: { from: { type: "string", minLength: 1 }, to: { type: "string", minLength: 1 }, limit: { type: "number", minimum: 1, maximum: 20 } }, required: ["from", "to"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const from = ensureString(params?.from, "from", 1);
        const to = ensureString(params?.to, "to", 1);
        const limit = Math.max(1, Math.min(Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 5, 20));
        const cfg = getPluginConfig(api, ctx);
        const data = await crystalRequest(cfg, "/api/mcp/recall", { query: `connection between ${from} and ${to}`, limit });
        return toToolResult(data);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_dependency_chain", label: "Crystal Dependency Chain",
    description: "Show the dependency chain for a topic, system, or project.",
    parameters: { type: "object", properties: { topic: { type: "string", minLength: 1 }, limit: { type: "number", minimum: 1, maximum: 20 } }, required: ["topic"], additionalProperties: false },
    async execute(_id, params, _sig, _upd, ctx) {
      try {
        const topic = ensureString(params?.topic, "topic", 1);
        const limit = Math.max(1, Math.min(Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 5, 20));
        const cfg = getPluginConfig(api, ctx);
        const data = await crystalRequest(cfg, "/api/mcp/recall", { query: `dependencies for ${topic}`, limit, mode: "project" });
        return toToolResult(data);
      } catch (err) { return toToolError(err); }
    },
  });
  api.registerTool({
    name: "crystal_doctor", label: "Crystal Doctor",
    description: "Run a health check on the Memory Crystal plugin: verify config, connectivity, and backend status.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _sig, _upd, ctx) {
      const PLUGIN_VERSION = "0.7.4";
      const lines = ["Memory Crystal Doctor", "---------------------"];
      let status = "Healthy";
      try {
        const cfg = getPluginConfig(api, ctx);
        const apiKey = cfg?.apiKey;
        const convexUrl = (cfg?.convexUrl || DEFAULT_CONVEX_URL).replace(/\/+$/, "");
        // API key status
        if (!apiKey || apiKey === "local") {
          lines.push(`Plugin version: ${PLUGIN_VERSION}`);
          lines.push("API key: not configured");
          lines.push(`Backend: ${convexUrl}`);
          lines.push("Connectivity: SKIP (no API key)");
          lines.push("Memory count: unknown");
          lines.push("Status: Degraded — API key missing");
          return toToolResult(lines.join("\n"));
        }
        const maskedKey = apiKey.length > 8 ? `***${apiKey.slice(-6)}` : "***";
        lines.push(`Plugin version: ${PLUGIN_VERSION}`);
        lines.push(`API key: configured (${maskedKey})`);
        lines.push(`Backend: ${convexUrl}`);
        // Connectivity check: try /api/mcp/stats (lightweight, no side effects)
        let connectivityOk = false;
        let memoryCount = "unknown";
        try {
          const statsRes = await fetch(`${convexUrl}/api/mcp/stats`, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (statsRes.ok) {
            connectivityOk = true;
            const statsData = await statsRes.json().catch(() => null);
            if (typeof statsData?.totalMemories === "number") memoryCount = statsData.totalMemories;
            else if (typeof statsData?.count === "number") memoryCount = statsData.count;
          } else {
            status = `Degraded — backend returned HTTP ${statsRes.status}`;
          }
        } catch (fetchErr) {
          status = `Degraded — connectivity error: ${getErrorMessage(fetchErr)}`;
        }
        lines.push(`Connectivity: ${connectivityOk ? "OK" : "FAIL"}`);
        // Recall smoke test (only if connectivity passed)
        if (connectivityOk) {
          try {
            const recallRes = await fetch(`${convexUrl}/api/mcp/recall`, {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
              body: JSON.stringify({ query: "crystal doctor health check", limit: 1 }),
            });
            if (!recallRes.ok) {
              status = `Degraded — recall endpoint returned HTTP ${recallRes.status}`;
            }
          } catch (recallErr) {
            status = `Degraded — recall smoke test failed: ${getErrorMessage(recallErr)}`;
          }
        }
        lines.push(`Memory count: ${memoryCount}`);
        lines.push(`Status: ${status}`);
        return toToolResult(lines.join("\n"));
      } catch (err) {
        return toToolError(err);
      }
    },
  });
};
