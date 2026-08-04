#!/usr/bin/env node
// crystal-hooks.mjs — Memory Crystal hook handler for AI coding assistants
// Handles: SessionStart (wake), UserPromptSubmit (capture + recall), Stop (first-turn + response capture)
// Works with: Claude Code, Codex CLI, Factory Droid

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import {
  buildChannel,
  capture,
  deriveProjectContext,
  extractFirstTurn,
  firstString,
  getLastAssistantResponse,
  loadConfig,
  logMessage,
  postJson,
  readStdin,
  reportHookError,
  resolveAgentId,
  resolvePlatform,
  resolveSessionKey,
  sanitizeUserMessageContent,
} from "./_lib.mjs";

export {
  buildChannel,
  capture,
  deriveProjectContext,
  extractFirstTurn,
  getLastAssistantResponse,
  loadConfig,
  logMessage,
  postJson,
  readStdin,
  reportHookError,
  resolveAgentId,
  resolvePlatform,
  resolveSessionKey,
} from "./_lib.mjs";

const INSTRUCTIONS_PATH = join(homedir(), ".memory-crystal", "instructions.md");

const MODEL_CAPACITY = {
  "claude-opus": { effective: 600000, pct: 0.15 },
  "claude-sonnet": { effective: 500000, pct: 0.15 },
  "claude-haiku": { effective: 120000, pct: 0.12 },
  "gpt-5": { effective: 500000, pct: 0.15 },
  "gpt-4.1": { effective: 500000, pct: 0.15 },
  "gpt-4o": { effective: 80000, pct: 0.12 },
  "gemini-2.5-pro": { effective: 500000, pct: 0.15 },
  "gemini-2.5-flash": { effective: 400000, pct: 0.12 },
  "gemini-3-pro": { effective: 800000, pct: 0.15 },
  "gemini-3-flash": { effective: 400000, pct: 0.12 },
  codex: { effective: 500000, pct: 0.15 },
  default: { effective: 75000, pct: 0.10 },
};

const HOOK_DISPLAY_CEILING_CHARS = 8_000;
const STOP_CAPTURE_TIMEOUT_MS = 5_000;

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

export async function recall(config, query, opts = {}) {
  const data = await postJson(
    config,
    "/api/mcp/recall",
    {
      query,
      // Fallback aligned to the fleet-wide default recall limit (12).
      limit: opts.limit ?? 12,
      mode: opts.mode ?? "general",
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.repoSlug ? { repoSlug: opts.repoSlug } : {}),
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
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.repoSlug ? { repoSlug: opts.repoSlug } : {}),
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
  // Explicit recall requests use the fleet-wide default limit (12); the other
  // intents keep deliberately narrower, intent-tuned limits.
  recall: { limit: 12, mode: "general" },
  decision: { limit: 5, mode: "decision" },
  workflow: { limit: 6, mode: "workflow" },
  people: { limit: 5, mode: "people" },
  store: { limit: 3, mode: "general" },
  general: { limit: 5, mode: "general" },
};

const MEMORY_PREVIEW_CHARS = 280;
// Matches the fleet-wide max memories surfaced by default (12) so the
// formatter never truncates below what the backend default returns.
const MAX_SURFACED_MEMORIES = 12;

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
    const preview = trimInline(String(m.content || "").replace(/\s+/g, " ").trim(), MEMORY_PREVIEW_CHARS);
    lines.push(`**${title}**${tags}`);
    if (preview) lines.push(preview);
  }
  if (truncatedCount > 0) {
    lines.push("", `_+${truncatedCount} additional memories — expand via crystal_recall_`);
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

function outputContext(eventName, context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } }));
}

function readInstructions() {
  if (!existsSync(INSTRUCTIONS_PATH)) return "";
  try { return readFileSync(INSTRUCTIONS_PATH, "utf-8").trim(); } catch { return ""; }
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
    if (titles.length > 0) lines.push(`Recent memory: ${titles.join("; ")}`);
  }
  if (data.lastCheckpoint?.label) lines.push(`Last checkpoint: ${data.lastCheckpoint.label}`);
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

function truncateAssistant(response) {
  return response.length > 4000 ? `${response.slice(0, 4000)}\n... [truncated]` : response;
}

function withTimeout(promise, timeoutMs, context) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  return Promise.race([promise.then(() => "ok", () => "error"), timeout]).then((result) => {
    clearTimeout(timer);
    if (result === "timeout") reportHookError(context, `timed out after ${timeoutMs}ms`);
    return result;
  });
}

function conversationCapturePayload({ title, content, platform, channel, sessionKey, agentId, projectId, repoSlug, extraTags = [] }) {
  return {
    title,
    content,
    store: "sensory",
    category: "conversation",
    tags: ["auto-capture", platform, ...extraTags],
    channel,
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(repoSlug ? { repoSlug } : {}),
  };
}

async function captureStopTurn({ config, input, platform, channel, sessionKey, agentId, projectContext, ts }) {
  const firstTurn = extractFirstTurn(input.transcript_path);
  const sanitizedUser = firstTurn.userText ? sanitizeUserMessageContent(firstTurn.userText) : null;
  const userText = sanitizedUser && !sanitizedUser.malformed && sanitizedUser.content.trim()
    ? sanitizedUser.content
    : undefined;
  const assistantText = firstString(input.last_assistant_message, firstTurn.assistantText, getLastAssistantResponse(input.transcript_path));
  const writes = [];

  if (userText) {
    writes.push(logMessage({ ...config, timeoutMs: STOP_CAPTURE_TIMEOUT_MS }, {
      role: "user",
      content: userText,
      channel,
      ...(sessionKey ? { sessionKey } : {}),
      ...(agentId ? { agentId } : {}),
      ...projectContext,
      ...(input.turn_id ? { turnId: String(input.turn_id) } : {}),
      turnMessageIndex: 0,
    }));
    writes.push(capture({ ...config, timeoutMs: STOP_CAPTURE_TIMEOUT_MS }, conversationCapturePayload({
      title: `User — ${ts}`,
      content: `User: ${userText}`,
      platform,
      channel,
      sessionKey,
      agentId,
      ...projectContext,
      extraTags: [firstTurn.userSource || "first-turn"],
    })));
  }

  if (assistantText) {
    const truncated = truncateAssistant(assistantText);
    writes.push(logMessage({ ...config, timeoutMs: STOP_CAPTURE_TIMEOUT_MS }, {
      role: "assistant",
      content: truncated,
      channel,
      ...(sessionKey ? { sessionKey } : {}),
      ...(agentId ? { agentId } : {}),
      ...projectContext,
      ...(input.turn_id ? { turnId: String(input.turn_id) } : {}),
      turnMessageIndex: 1,
    }));
    writes.push(capture({ ...config, timeoutMs: STOP_CAPTURE_TIMEOUT_MS }, conversationCapturePayload({
      title: `Assistant — ${ts}`,
      content: `Assistant: ${truncated}`,
      platform,
      channel,
      sessionKey,
      agentId,
      ...projectContext,
      extraTags: ["response"],
    })));
  }

  if (writes.length > 0) {
    await withTimeout(Promise.allSettled(writes), STOP_CAPTURE_TIMEOUT_MS, "Stop capture");
  }
}

export async function main() {
  const input = await readStdin();
  const config = loadConfig();

  if (!config.apiKey) process.exit(0);

  const event = input.hook_event_name;
  const platform = resolvePlatform(config, input);
  const cwd = input.cwd || process.cwd();
  const channel = buildChannel(platform, cwd);
  const sessionKey = resolveSessionKey(input);
  const projectContext = deriveProjectContext(cwd, { projectSalt: config.projectSalt });
  const agentId = resolveAgentId(config, input);
  const scope = {
    channel,
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...projectContext,
  };
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const budget = getInjectionBudget(input.model || input.model_name || process.env.CRYSTAL_MODEL || "");

  switch (event) {
    case "SessionStart": {
      const wakeResult = await wake(config, scope);
      const text = buildSessionStartContext(wakeResult ?? formatWake(wakeResult), readInstructions());
      if (text) outputContext("SessionStart", trimToCharBudget(text, budget.maxChars));
      break;
    }

    case "UserPromptSubmit": {
      const sanitizedPrompt = sanitizeUserMessageContent(input.prompt || "");
      if (sanitizedPrompt.malformed) break;
      const prompt = sanitizedPrompt.content;
      if (!prompt.trim()) break;

      void logMessage(config, {
        role: "user",
        content: String(prompt),
        ...scope,
        ...(input.turn_id ? { turnId: String(input.turn_id) } : {}),
        turnMessageIndex: 0,
      });

      void capture(config, conversationCapturePayload({
        title: `User — ${ts}`,
        content: `User: ${prompt}`,
        platform,
        ...scope,
      }));

      const intent = classifyIntent(prompt);
      const params = RECALL_PARAMS[intent] || RECALL_PARAMS.general;
      const memories = await recall(config, prompt, { ...params, ...scope });
      const context = formatMemories(memories);
      if (context) outputContext("UserPromptSubmit", trimToCharBudget(context, budget.maxChars));
      break;
    }

    case "Stop": {
      await captureStopTurn({ config, input, platform, channel, sessionKey, agentId, projectContext, ts });
      break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
