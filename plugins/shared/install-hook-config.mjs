#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

function usage() {
  console.error("usage: node install-hook-config.mjs <host> <config-path> <hook-command>");
  process.exit(1);
}

const [, , host, configPath, hookCommand] = process.argv;
if (!host || !configPath || !hookCommand) usage();

const supportedHosts = new Set(["codex", "claude", "factory", "cursor", "grok"]);
if (!supportedHosts.has(host)) {
  console.error(`unsupported host: ${host}`);
  process.exit(1);
}

// Grok lifecycle events (SessionStart, SessionEnd, Stop, UserPromptSubmit)
// reject a matcher. Encode that here — not in the installer shell.
const GROK_LIFECYCLE_EVENTS = new Set(["SessionStart", "SessionEnd", "Stop", "UserPromptSubmit"]);

function lifecycleMatcher(eventHost, event) {
  if (eventHost === "grok" && GROK_LIFECYCLE_EVENTS.has(event)) return undefined;
  if (eventHost === "codex" && event === "SessionStart") return "startup|resume";
  return undefined;
}

function lifecycleHook(eventHost, event, command, timeout) {
  const entry = {
    hooks: [{ type: "command", command, timeout }],
  };
  const matcher = lifecycleMatcher(eventHost, event);
  if (matcher !== undefined) entry.matcher = matcher;
  return entry;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function ensureHooksRoot(host, config) {
  if (host === "codex") {
    if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
      config.hooks = {};
    }
    delete config.UserPromptSubmit;
    delete config.Stop;
    delete config.SessionStart;
    return config.hooks;
  }

  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  return config.hooks;
}

function isCrystalCommand(command) {
  return typeof command === "string" && /crystal-hooks\.mjs|cursor-hooks\.mjs/.test(command);
}

function upsertEvent(hooksRoot, event, hook) {
  const existing = Array.isArray(hooksRoot[event]) ? hooksRoot[event] : [];
  const next = existing.filter((entry) => {
    if (typeof entry?.command === "string" && isCrystalCommand(entry.command)) return false;
    if (!Array.isArray(entry?.hooks)) return true;
    return !entry.hooks.some((candidate) => isCrystalCommand(candidate?.command));
  });
  next.push(hook);
  hooksRoot[event] = next;
}

const config = readJson(configPath);
const hooksRoot = ensureHooksRoot(host, config);

if (host === "cursor") {
  if (config.version == null) config.version = 1;
  upsertEvent(hooksRoot, "sessionStart", { command: hookCommand, timeout: 15 });
  upsertEvent(hooksRoot, "beforeSubmitPrompt", { command: hookCommand, timeout: 10 });
  upsertEvent(hooksRoot, "afterAgentResponse", { command: hookCommand, timeout: 10 });
  upsertEvent(hooksRoot, "stop", { command: hookCommand, timeout: 10 });
  // ILL-272: postToolUse awaits recall() then emitCursorContext. The host must
  // not kill the hook before MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT (16s).
  upsertEvent(hooksRoot, "postToolUse", { command: hookCommand, timeout: 16 });
} else {
  // ILL-272: UserPromptSubmit runs capture + auto-recall. The host must not
  // kill the hook before MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT (16s).
  upsertEvent(hooksRoot, "UserPromptSubmit", lifecycleHook(host, "UserPromptSubmit", hookCommand, 16));
  upsertEvent(hooksRoot, "Stop", lifecycleHook(host, "Stop", hookCommand, 10));
  upsertEvent(hooksRoot, "SessionStart", lifecycleHook(host, "SessionStart", hookCommand, 15));
}

mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
