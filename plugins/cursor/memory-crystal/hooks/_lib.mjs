import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";

export const CRYSTAL_DIR = join(homedir(), ".memory-crystal");
export const CONFIG_PATH = join(CRYSTAL_DIR, "config.json");
export const DEFAULT_URL = "https://convex.memorycrystal.ai";
export const DEFAULT_PLATFORM = "claude-code";

export function loadConfig() {
  let config = { apiKey: "", convexUrl: DEFAULT_URL, platform: DEFAULT_PLATFORM, agentId: "", projectSalt: "" };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
    } catch {}
  }
  config.apiKey = config.apiKey || process.env.MEMORY_CRYSTAL_API_KEY || "";
  config.convexUrl = process.env.MEMORY_CRYSTAL_URL || config.convexUrl || DEFAULT_URL;
  config.platform = process.env.CRYSTAL_PLATFORM || config.platform || DEFAULT_PLATFORM;
  config.agentId = process.env.MEMORY_CRYSTAL_AGENT_ID || config.agentId || "";
  config.projectSalt = process.env.MEMORY_CRYSTAL_PROJECT_SALT || config.projectSalt || "";
  return config;
}

export function isGrokInvocation() {
  return Boolean(process.env.GROK_HOOK_EVENT) || process.env.CRYSTAL_PLATFORM === "grok";
}

/**
 * Determine whether automatic recall/wake should inject on this host.
 * - Grok invocation → false always (Capture tier).
 * - MEMORY_CRYSTAL_INJECT_RECALL env var set and non-empty → true for truthy values (1/true/TRUE), else false. Env wins over config.
 * - config.injectRecall === true → true.
 * - Else false.
 */
export function injectRecallEnabled(config = {}) {
  if (isGrokInvocation()) return false;
  const envVal = process.env.MEMORY_CRYSTAL_INJECT_RECALL;
  if (envVal !== undefined && envVal !== null && envVal !== "") {
    return envVal === "1" || envVal === "true" || envVal === "TRUE";
  }
  if (config.injectRecall === true) return true;
  return false;
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function headers(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

const __mcHookErrorTimestamps = new Map();
export function reportHookError(context, detail) {
  const key = `${context}|${detail}`;
  const now = Date.now();
  const lastAt = __mcHookErrorTimestamps.get(key) ?? 0;
  if (now - lastAt < 60_000) return;
  __mcHookErrorTimestamps.set(key, now);
  try {
    const stamp = new Date(now).toISOString();
    process.stderr.write(`[memory-crystal][${context}] ${stamp} ${detail}\n`);
  } catch {}
}

export async function postJson(config, path, body, timeoutMs) {
  try {
    const res = await fetch(`${config.convexUrl}${path}`, {
      method: "POST",
      headers: headers(config.apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      reportHookError(`post ${path}`, `HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    reportHookError(`post ${path}`, err?.message ?? String(err));
    return null;
  }
}

export async function capture(config, payload) {
  try {
    const res = await fetch(`${config.convexUrl}/api/mcp/capture`, {
      method: "POST",
      headers: headers(config.apiKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs ?? 8000),
    });
    if (!res.ok) reportHookError("capture", `HTTP ${res.status}`);
  } catch (err) {
    reportHookError("capture", err?.message ?? String(err));
  }
}

export async function logMessage(config, payload) {
  const normalizedPayload = normalizeLogMessagePayload(payload);
  if (!normalizedPayload) return { ok: true, skipped: true, reason: "synthetic_context_only" };
  try {
    const res = await fetch(`${config.convexUrl}/api/mcp/log`, {
      method: "POST",
      headers: headers(config.apiKey),
      body: JSON.stringify(normalizedPayload),
      signal: AbortSignal.timeout(config.timeoutMs ?? 8000),
    });
    if (!res.ok) reportHookError("logMessage", `HTTP ${res.status}`);
  } catch (err) {
    reportHookError("logMessage", err?.message ?? String(err));
  }
}

const RECALLED_OPEN = "<recalled_context>";
const RECALLED_TAG_RE = /<\/?recalled_context>/g;

function findLeadingRecalledContextBoundary(value) {
  const start = value.search(/\S/);
  if (start < 0) return { starts: false, end: -1 };
  if (!value.startsWith(RECALLED_OPEN, start)) return { starts: false, end: -1 };

  RECALLED_TAG_RE.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = RECALLED_TAG_RE.exec(value)) !== null) {
    if (match[0] === RECALLED_OPEN) {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) return { starts: true, end: RECALLED_TAG_RE.lastIndex };
      if (depth < 0) return { starts: true, end: -1 };
    }
  }
  return { starts: true, end: -1 };
}

export function sanitizeUserMessageContent(input) {
  let content = String(input ?? "");
  let stripped = false;
  let strippedChars = 0;

  while (true) {
    const boundary = findLeadingRecalledContextBoundary(content);
    if (!boundary.starts) break;
    if (boundary.end < 0) {
      return {
        content: "",
        stripped,
        strippedChars,
        hadTrailingPrompt: false,
        malformed: true,
      };
    }
    stripped = true;
    strippedChars += boundary.end;
    content = content.slice(boundary.end).replace(/^\s+/, "");
  }

  return {
    content,
    stripped,
    strippedChars,
    hadTrailingPrompt: stripped && content.trim().length > 0,
    malformed: false,
  };
}

export function normalizeLogMessagePayload(payload) {
  if (!payload || payload.role !== "user") return payload;
  const sanitized = sanitizeUserMessageContent(payload.content);
  if (sanitized.malformed || !sanitized.content.trim()) return null;
  if (!sanitized.stripped) return payload;
  return { ...payload, content: sanitized.content };
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

export function resolvePlatform(config, input = {}) {
  return firstString(process.env.CRYSTAL_PLATFORM, config?.platform, input.platform) || DEFAULT_PLATFORM;
}

export function resolveAgentId(config, input = {}) {
  return firstString(input.agent_id, input.agentId, process.env.MEMORY_CRYSTAL_AGENT_ID, config?.agentId);
}

export function resolveSessionKey(input = {}) {
  const explicit = firstString(input.session_id, input.sessionId, input.sessionKey, input.session_key);
  if (explicit) return explicit;
  const transcriptPath = firstString(input.transcript_path, input.transcriptPath);
  if (!transcriptPath) return undefined;
  const name = basename(transcriptPath).replace(/\.(jsonl|json)$/i, "");
  return name || undefined;
}

export function buildChannel(platform, cwd) {
  const workspace = firstString(cwd) || process.cwd();
  return `${platform}:${workspace}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitValue(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function normalizeGitRemoteUrl(value) {
  const remote = firstString(value);
  if (!remote) return "";
  const withoutCredentials = remote.replace(/:\/\/[^/@]+@/, "://");
  return withoutCredentials.replace(/\.git$/i, "").toLowerCase();
}

export function deriveProjectContext(cwd, options = {}) {
  const workspace = firstString(cwd) || process.cwd();
  const root = gitValue(workspace, ["rev-parse", "--show-toplevel"]) || workspace;
  const repoSlug = basename(root.replace(/[\\/]+$/, "")) || "workspace";
  const remote = normalizeGitRemoteUrl(gitValue(root, ["config", "--get", "remote.origin.url"]));
  const salt = firstString(options.projectSalt, process.env.MEMORY_CRYSTAL_PROJECT_SALT) || "";
  const hashInput = remote ? `${remote}\n${repoSlug}` : `local\n${repoSlug}\n${salt}`;
  return {
    projectId: `proj_${sha256(hashInput).slice(0, 24)}`,
    repoSlug,
  };
}

function textFromContent(content, role) {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && (role !== "assistant" || part.type === "text" || !part.type)) {
      parts.push(part.text);
      continue;
    }
    if (typeof part.content === "string" && role !== "assistant") {
      parts.push(part.content);
      continue;
    }
    if (Array.isArray(part.content) && role !== "assistant") {
      const nested = textFromContent(part.content, role);
      if (nested) parts.push(nested);
    }
  }

  const text = parts.join("\n").trim();
  return text || undefined;
}

function messageRole(entry) {
  return firstString(entry?.message?.role, entry?.role, entry?.type);
}

function messageText(entry, expectedRole) {
  const role = messageRole(entry);
  if (role !== expectedRole) return undefined;
  return textFromContent(entry?.message?.content ?? entry?.content, expectedRole);
}

function parseJsonl(path) {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}


// AC9: classify whether a prompt is self-contained and should skip recall entirely
const SELF_CONTAINED_EXACT = new Set([
  "ok", "okay", "thanks", "thank you", "yes", "no", "yep", "nope", "sure",
  "thx", "ty", "got it", "i see", "understood", "makes sense", "right", "correct",
]);

export function classifySelfContained(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim().toLowerCase();
  if (SELF_CONTAINED_EXACT.has(t)) return true;
  if (t === "restart" || t === "restart gateway" || t === "restart this gateway") return true;
  if (/^(ok|okay|yes|yep|sure)\s+(thanks?|thank you)$/i.test(t)) return true;
  return false;
}

export function injectMinScore() {
  const raw = process.env.MEMORY_CRYSTAL_INJECT_MIN_SCORE;
  if (raw) {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return 0.35;
}

export function adaptiveInjectionBudget(historyChars, defaultMaxChars) {
  if (!historyChars || historyChars <= 0) return defaultMaxChars;
  const clamped = Math.min(historyChars, 32000);
  const reduction = Math.min(0.75, clamped / 32000);
  const adaptive = Math.floor(defaultMaxChars * (1 - reduction));
  return Math.max(2000, adaptive);
}

export function extractFirstTurn(transcriptPath) {
  const entries = parseJsonl(transcriptPath);
  let userText;
  let userSource;
  let assistantText;
  let assistantSource;
  let sessionId;

  for (const entry of entries) {
    if (!sessionId) sessionId = firstString(entry.sessionId, entry.session_id, entry.sessionKey, entry.session_key);
    if (!userText && entry.type === "queue-operation" && entry.operation === "enqueue") {
      userText = firstString(entry.content, entry.prompt, entry.message);
      if (userText) {
        userSource = "queue-operation";
        sessionId = firstString(entry.sessionId, entry.session_id, entry.sessionKey, sessionId);
      }
    }
    if (!assistantText) {
      const text = messageText(entry, "assistant");
      if (text) {
        assistantText = text;
        assistantSource = "assistant-message";
      }
    }
  }

  if (!userText) {
    for (const entry of entries) {
      const text = messageText(entry, "user");
      if (text) {
        userText = text;
        userSource = text.includes("<command-name>") || text.includes("<command-message>") || text.includes("<local-command-stdout>")
          ? "user-string-cmd"
          : "user-message";
        break;
      }
    }
  }

  return {
    userText,
    assistantText,
    source: userSource || assistantSource ? "jsonl" : "none",
    userSource,
    assistantSource,
    sessionId,
    status: userText && !assistantText ? "abandoned-before-assistant" : userText && assistantText ? "complete" : "missing",
  };
}

export function getLastAssistantResponse(transcriptPath) {
  const entries = parseJsonl(transcriptPath);
  for (let i = entries.length - 1; i >= Math.max(0, entries.length - 50); i -= 1) {
    const text = messageText(entries[i], "assistant");
    if (text) return text;
  }
  return null;
}
