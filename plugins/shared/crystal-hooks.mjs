#!/usr/bin/env node
// crystal-hooks.mjs — Memory Crystal hook handler for AI coding assistants
// Handles: SessionStart (wake), UserPromptSubmit (capture + recall), Stop (response capture)
// Works with: Claude Code, Codex CLI, Factory Droid

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { pathToFileURL } from "url";

const CRYSTAL_DIR = join(homedir(), ".memory-crystal");
const CONFIG_PATH = join(CRYSTAL_DIR, "config.json");
const INSTRUCTIONS_PATH = join(CRYSTAL_DIR, "instructions.md");
const DEFAULT_URL = "https://rightful-mockingbird-389.convex.site";
const DEFAULT_PLATFORM = "claude-code";

// ---------------------------------------------------------------------------
// Context budget — model-aware injection sizing
// ---------------------------------------------------------------------------

const MODEL_CAPACITY = {
  "claude-opus":       { effective: 600000, pct: 0.15 },
  "claude-sonnet":     { effective: 500000, pct: 0.15 },
  "claude-haiku":      { effective: 120000, pct: 0.12 },
  "gpt-5":             { effective: 500000, pct: 0.15 },
  "gpt-4.1":           { effective: 500000, pct: 0.15 },
  "gpt-4o":            { effective:  80000, pct: 0.12 },
  "gemini-2.5-pro":    { effective: 500000, pct: 0.15 },
  "gemini-2.5-flash":  { effective: 400000, pct: 0.12 },
  "gemini-3-pro":      { effective: 800000, pct: 0.15 },
  "gemini-3-flash":    { effective: 400000, pct: 0.12 },
  codex:               { effective: 500000, pct: 0.15 },
  default:             { effective:  75000, pct: 0.10 },
};

// Hard ceiling on injected hook context so the user's terminal scrollback cannot
// be flooded by a single recall — even when the model window would technically
// allow it. The displayed `additionalContext` block ends up printed verbatim by
// the host (Claude Code / Codex / etc.), and anything over ~8 KB is unreadable.
// The model-window budget is used as an additional upper bound.
const HOOK_DISPLAY_CEILING_CHARS = 8_000;

function getInjectionBudget(modelName) {
  const norm = String(modelName || "").toLowerCase();
  let cap = MODEL_CAPACITY.default;
  for (const [key, val] of Object.entries(MODEL_CAPACITY)) {
    if (key !== "default" && norm.includes(key)) { cap = val; break; }
  }
  const modelBudget = Math.floor(cap.effective * cap.pct * 4);
  const maxChars = Math.min(modelBudget, HOOK_DISPLAY_CEILING_CHARS);
  return { maxChars, model: modelName };
}

function trimToCharBudget(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n_[Memory context trimmed to fit model budget]_";
}

function trimInline(text, maxChars) {
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function loadConfig() {
  let config = { apiKey: "", convexUrl: DEFAULT_URL, platform: DEFAULT_PLATFORM };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
    } catch {}
  }
  config.apiKey = config.apiKey || process.env.MEMORY_CRYSTAL_API_KEY || "";
  config.convexUrl = config.convexUrl || process.env.MEMORY_CRYSTAL_URL || DEFAULT_URL;
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

// Rate-limited stderr reporter so persistent backend failures produce visible
// signal without spamming. A single stanza per (context, status) combination
// per minute is enough to surface 401/429/500 to operators + doctor scripts
// while still honoring the "never block the host" contract.
const __mcHookErrorTimestamps = new Map();
function reportHookError(context, detail) {
  const key = `${context}|${detail}`;
  const now = Date.now();
  const lastAt = __mcHookErrorTimestamps.get(key) ?? 0;
  if (now - lastAt < 60_000) return;
  __mcHookErrorTimestamps.set(key, now);
  try {
    const stamp = new Date(now).toISOString();
    process.stderr.write(`[memory-crystal][${context}] ${stamp} ${detail}\n`);
  } catch {
    // Never throw from the error reporter itself
  }
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
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // 401 = bad/expired key, 429 = quota, 5xx = backend — surface all of them so
      // silent memory loss becomes an actionable signal. Still fire-and-forget.
      reportHookError("capture", `HTTP ${res.status}`);
    }
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
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      reportHookError("logMessage", `HTTP ${res.status}`);
    }
  } catch (err) {
    reportHookError("logMessage", err?.message ?? String(err));
  }
}

export async function recall(config, query, opts = {}) {
  const data = await postJson(
    config,
    "/api/mcp/recall",
    {
      query,
      limit: opts.limit ?? 5,
      mode: opts.mode ?? "general",
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
    },
    8000,
  );
  return data?.memories || [];
}

export async function wake(config, opts = {}) {
  return await postJson(
    config,
    "/api/mcp/wake",
    {
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
    },
    12000,
  );
}

export function classifyIntent(text) {
  const t = (text || "").toLowerCase();
  if (/\b(remember|store|save|note this)\b/.test(t)) return "store";
  if (/\b(recall|what do (you|i) know|remind me|what was|tell me about)\b/.test(t)) return "recall";
  if (/\b(how (do|should|to)|steps|workflow|process|procedure)\b/.test(t)) return "workflow";
  if (/\b(why did|decision|chose|picked|decided)\b/.test(t)) return "decision";
  if (/\b(who (owns|is|manages)|people|team)\b/.test(t)) return "people";
  return "general";
}

const RECALL_PARAMS = {
  recall: { limit: 8, mode: "general" },
  decision: { limit: 5, mode: "decision" },
  workflow: { limit: 6, mode: "workflow" },
  people: { limit: 5, mode: "people" },
  store: { limit: 3, mode: "general" },
  general: { limit: 5, mode: "general" },
};

// Per-memory content preview cap. Full content is still available via
// `crystal_recall`; this keeps the terminal-visible injection compact so a
// single prompt doesn't dump pages of prior memories into the user's scrollback.
const MEMORY_PREVIEW_CHARS = 280;
const MAX_SURFACED_MEMORIES = 8;

function formatMemories(memories) {
  if (!memories.length) return "";
  const surfaced = memories.slice(0, MAX_SURFACED_MEMORIES);
  const truncatedCount = Math.max(0, memories.length - surfaced.length);
  const lines = [
    "## Memory Crystal — Recalled Context",
    `_${memories.length} memories recalled. Use crystal_recall for deeper search._`,
    "",
  ];
  for (const m of surfaced) {
    const tags = m.tags?.length ? ` [${m.tags.slice(0, 4).join(", ")}]` : "";
    const title = trimInline(m.title || "Memory", 80);
    const preview = trimInline(
      String(m.content || "").replace(/\s+/g, " ").trim(),
      MEMORY_PREVIEW_CHARS,
    );
    lines.push(`**${title}**${tags}`);
    if (preview) lines.push(preview);
  }
  if (truncatedCount > 0) {
    lines.push("");
    lines.push(`_+${truncatedCount} additional memories — expand via crystal_recall_`);
  }
  return lines.join("\n");
}

function formatWake(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (data.briefing) return data.briefing;
  if (data.message) return data.message;
  return JSON.stringify(data, null, 2);
}

function getLastAssistantResponse(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.role === "assistant") {
          if (typeof msg.content === "string") return msg.content;
          if (Array.isArray(msg.content)) {
            const text = msg.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            if (text) return text;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

function outputContext(eventName, context) {
  if (!context) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: context,
      },
    }),
  );
}

function firstString(...values) {
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

function readInstructions() {
  if (!existsSync(INSTRUCTIONS_PATH)) return "";
  try {
    return readFileSync(INSTRUCTIONS_PATH, "utf-8").trim();
  } catch {
    return "";
  }
}

function summarizeWakeForSessionStart(data) {
  if (!data) return "";
  if (typeof data === "string") {
    const text = data.replace(/\s+/g, " ").trim();
    return text ? `Memory is active for this session.\n${trimInline(text, 220)}` : "";
  }

  const lines = ["Memory is active for this session."];

  if (Array.isArray(data.recentMessages) && data.recentMessages.length > 0) {
    lines.push(`Recent conversation available (${data.recentMessages.length} messages).`);
  }

  if (Array.isArray(data.recentMemories) && data.recentMemories.length > 0) {
    const titles = data.recentMemories
      .map((memory) => (typeof memory?.title === "string" ? memory.title.trim() : ""))
      .filter(Boolean)
      .slice(0, 2);
    if (titles.length > 0) {
      lines.push(`Recent memory: ${titles.join("; ")}`);
    }
  }

  if (data.lastCheckpoint?.label) {
    lines.push(`Last checkpoint: ${data.lastCheckpoint.label}`);
  }

  return lines.join("\n");
}

function buildSessionStartToolHint(instructions) {
  if (!instructions) return "";
  return "Use crystal_recall for past facts or decisions, crystal_search_messages for exact wording, and crystal_remember for durable facts or preferences.";
}

export function buildSessionStartContext(wakeData, instructions) {
  const parts = [];
  const wakeSummary = summarizeWakeForSessionStart(wakeData);
  const toolHint = buildSessionStartToolHint(instructions);
  if (wakeSummary) parts.push(wakeSummary);
  if (toolHint) parts.push(toolHint);
  return parts.join("\n\n");
}

export async function main() {
  const input = await readStdin();
  const config = loadConfig();

  if (!config.apiKey) {
    process.exit(0);
  }

  const event = input.hook_event_name;
  const platform = resolvePlatform(config, input);
  const cwd = input.cwd || process.cwd();
  const channel = buildChannel(platform, cwd);
  const sessionKey = resolveSessionKey(input);
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace("T", " ");

  // Resolve model-aware injection budget
  const modelHint = input.model || input.model_name || process.env.CRYSTAL_MODEL || "";
  const budget = getInjectionBudget(modelHint);

  switch (event) {
    case "SessionStart": {
      const wakeResult = await wake(config, { channel, sessionKey });
      const text = buildSessionStartContext(wakeResult ?? formatWake(wakeResult), readInstructions());
      if (text) outputContext("SessionStart", trimToCharBudget(text, budget.maxChars));
      break;
    }

    case "UserPromptSubmit": {
      const prompt = input.prompt || "";
      if (!prompt.trim()) break;

      void logMessage(config, {
        role: "user",
        content: String(prompt),
        channel,
        ...(sessionKey ? { sessionKey } : {}),
        ...(input.turn_id ? { turnId: String(input.turn_id) } : {}),
        turnMessageIndex: 0,
      });

      void capture(config, {
        title: `User — ${ts}`,
        content: `User: ${prompt}`,
        store: "sensory",
        category: "conversation",
        tags: ["auto-capture", platform],
        channel,
        ...(sessionKey ? { sessionKey } : {}),
      });

      const intent = classifyIntent(prompt);
      const params = RECALL_PARAMS[intent] || RECALL_PARAMS.general;
      const memories = await recall(config, prompt, { ...params, channel, sessionKey });
      const context = formatMemories(memories);

      if (context) outputContext("UserPromptSubmit", trimToCharBudget(context, budget.maxChars));
      break;
    }

    case "Stop": {
      const response = firstString(input.last_assistant_message) || getLastAssistantResponse(input.transcript_path);
      if (response) {
        const truncated = response.length > 4000 ? `${response.slice(0, 4000)}\n... [truncated]` : response;

        void logMessage(config, {
          role: "assistant",
          content: truncated,
          channel,
          ...(sessionKey ? { sessionKey } : {}),
          ...(input.turn_id ? { turnId: String(input.turn_id) } : {}),
          turnMessageIndex: 1,
        });

        await capture(config, {
          title: `Assistant — ${ts}`,
          content: `Assistant: ${truncated}`,
          store: "sensory",
          category: "conversation",
          tags: ["auto-capture", platform, "response"],
          channel,
          ...(sessionKey ? { sessionKey } : {}),
        });
      }
      break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
