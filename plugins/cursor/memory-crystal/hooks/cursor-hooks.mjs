#!/usr/bin/env node
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  adaptiveInjectionBudget,
  buildChannel,
  captureTurn,
  classifySelfContained,
  deriveProjectContext,
  injectRecallEnabled,
  loadConfig,
  readStdin,
  resolveAgentId,
  resolveSessionKey,
  sanitizeUserMessageContent,
  stableTurnId,
  shouldInjectRecall,
} from "./_lib.mjs";
import { applyDisciplineFooter, classifyIntent, recall, wake } from "./crystal-hooks.mjs";

const INSTRUCTIONS_PATH = join(homedir(), ".memory-crystal", "instructions.md");

const CURSOR_EVENT_ALIASES = {
  sessionStart: "sessionStart",
  sessionstart: "sessionStart",
  beforeSubmitPrompt: "beforeSubmitPrompt",
  beforesubmitprompt: "beforeSubmitPrompt",
  UserPromptSubmit: "beforeSubmitPrompt",
  afterAgentResponse: "afterAgentResponse",
  afteragentresponse: "afterAgentResponse",
  stop: "stop",
  Stop: "stop",
  postToolUse: "postToolUse",
  posttooluse: "postToolUse",
};

export function normalizeCursorInput(raw) {
  const input = raw && typeof raw === "object" ? { ...raw } : {};
  const rawEvent = String(input.hook_event_name || input.hookEventName || "");
  input.hook_event_name = CURSOR_EVENT_ALIASES[rawEvent] || rawEvent;
  input.prompt = input.prompt || input.text || "";
  input.session_id = input.session_id || input.conversation_id || input.sessionId;
  if (Array.isArray(input.workspace_roots) && input.workspace_roots[0] && !input.cwd) {
    input.cwd = input.workspace_roots[0];
  }
  return input;
}

export function emitCursorContext(context) {
  if (!context) return;
  process.stdout.write(`${JSON.stringify({ additional_context: context })}\n`);
}

function readInstructions() {
  if (!existsSync(INSTRUCTIONS_PATH)) return "";
  try { return readFileSync(INSTRUCTIONS_PATH, "utf-8").trim(); } catch { return ""; }
}

function formatMemories(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return "";
  const lines = ["## Memory Crystal — Recalled Context", ""];
  for (const memory of memories.slice(0, 8)) {
    const title = typeof memory?.title === "string" ? memory.title.trim() : "Memory";
    const preview = String(memory?.content || "").replace(/\s+/g, " ").trim().slice(0, 240);
    lines.push(`**${title}**`);
    if (preview) lines.push(preview);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function main() {
  const input = normalizeCursorInput(await readStdin());
  const config = { ...loadConfig(), platform: "cursor" };
  if (!config.apiKey) process.exit(0);

  const platform = "cursor";
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
  switch (input.hook_event_name) {
    case "sessionStart": {
      // sessionStart injects wake context only when injectRecallEnabled
      if (!injectRecallEnabled(config)) break;
      const wakeResult = await wake(config, scope);
      const parts = ["Memory is active for this Cursor session."];
      if (wakeResult?.briefing) parts.push(String(wakeResult.briefing).slice(0, 400));
      const instructions = readInstructions();
      if (instructions) {
        parts.push("Use crystal_recall for past facts or decisions, crystal_search_messages for exact wording, and crystal_remember for durable facts or preferences.");
      }
      emitCursorContext(parts.join("\n\n"));
      break;
    }
    case "beforeSubmitPrompt": {
      const sanitizedPrompt = sanitizeUserMessageContent(input.prompt || "");
      if (sanitizedPrompt.malformed) break;
      const prompt = sanitizedPrompt.content;
      if (!prompt.trim()) break;
      // Capture is deferred until the response hook can send one completed turn.
      break;
    }
    case "afterAgentResponse":
    case "stop": {
      const assistantText = typeof input.text === "string" ? input.text.trim() : "";
      if (!assistantText) break;
      const rawUser = input.prompt || input.user_message || input.userMessage || "";
      const sanitizedUser = sanitizeUserMessageContent(rawUser);
      const userMessage = sanitizedUser.malformed ? "" : sanitizedUser.content.trim();
      const resolvedSessionKey = sessionKey || `session_${stableTurnId({ channel, userMessage, assistantMessage: assistantText }).slice(-24)}`;
      await captureTurn(config, {
        channel,
        sessionKey: resolvedSessionKey,
        turnId: stableTurnId({ channel, sessionKey: resolvedSessionKey, userMessage, assistantMessage: assistantText, turnId: input.turn_id }),
        ...(userMessage ? { userMessage } : {}),
        assistantMessage: assistantText,
        platform,
        ...(agentId ? { agentId } : {}),
        ...projectContext,
      });
      break;
    }
    case "postToolUse": {
      // postToolUse injects recall context only when injectRecallEnabled
      if (!injectRecallEnabled(config)) break;
      const query = String(input.tool_name || input.agent_message || "recent work");

      // AC9: skip self-contained prompts
      if (classifySelfContained(query)) break;

      const intent = classifyIntent(query);
      const { memories, coverage } = await recall(config, query, { limit: intent === "recall" ? 12 : 5, mode: "general", ...scope });
      if (!shouldInjectRecall(coverage, memories)) break;

      const historyChars = input.conversation_history?.length * 1000 || 0;
      const adaptiveMaxChars = adaptiveInjectionBudget(historyChars, 4000);
      emitCursorContext(applyDisciplineFooter(formatMemories(memories), adaptiveMaxChars));
      break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
