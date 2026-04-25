import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

export const CRYSTAL_DIR = join(homedir(), ".memory-crystal");
export const CONFIG_PATH = join(CRYSTAL_DIR, "config.json");
export const DEFAULT_URL = "https://convex.memorycrystal.ai";
export const DEFAULT_PLATFORM = "claude-code";

export function loadConfig() {
  let config = { apiKey: "", convexUrl: DEFAULT_URL, platform: DEFAULT_PLATFORM };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
    } catch {}
  }
  config.apiKey = config.apiKey || process.env.MEMORY_CRYSTAL_API_KEY || "";
  config.convexUrl = process.env.MEMORY_CRYSTAL_URL || config.convexUrl || DEFAULT_URL;
  config.platform = process.env.CRYSTAL_PLATFORM || config.platform || DEFAULT_PLATFORM;
  return config;
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
  try {
    const res = await fetch(`${config.convexUrl}/api/mcp/log`, {
      method: "POST",
      headers: headers(config.apiKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs ?? 8000),
    });
    if (!res.ok) reportHookError("logMessage", `HTTP ${res.status}`);
  } catch (err) {
    reportHookError("logMessage", err?.message ?? String(err));
  }
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
