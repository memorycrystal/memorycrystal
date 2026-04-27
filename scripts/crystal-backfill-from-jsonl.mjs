#!/usr/bin/env node
/**
 * Recover first-turn user/assistant captures from Claude Code JSONL transcripts.
 *
 * Dry-run is the default. Use --commit to POST to Memory Crystal. The backend
 * is expected to dedupe duplicate /api/mcp/log and /api/mcp/capture writes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "https://convex.memorycrystal.ai";
const DEFAULT_ROOT = join(homedir(), ".claude", "projects");
const DEFAULT_SINCE = "2026-04-21";
const DEFAULT_UNTIL = "2026-04-24";

const isoDateToMs = (value, endOfDay = false) => {
  if (!value) return undefined;
  const suffix = /^\d{4}-\d{2}-\d{2}$/.test(value) ? (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z") : "";
  const ms = Date.parse(`${value}${suffix}`);
  if (!Number.isFinite(ms)) throw new Error(`Invalid date: ${value}`);
  return ms;
};

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    root: DEFAULT_ROOT,
    since: DEFAULT_SINCE,
    until: DEFAULT_UNTIL,
    commit: false,
    limit: 0,
    channel: "claude-jsonl-backfill",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--root") options.root = readValue(arg);
    else if (arg === "--since") options.since = readValue(arg);
    else if (arg === "--until") options.until = readValue(arg);
    else if (arg === "--channel") options.channel = readValue(arg);
    else if (arg === "--limit") options.limit = Number(readValue(arg));
    else if (arg === "--commit") options.commit = true;
    else if (arg === "--dry-run") options.commit = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.limit) || options.limit < 0) throw new Error("--limit must be a non-negative number");
  return options;
}

function textFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return "";
}

export function contentToText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(textFromContentPart).filter(Boolean).join("\n").trim();
  return "";
}

export function extractFirstTurnFromLines(lines) {
  let queueUserText = "";
  let firstUserText = "";
  let firstAssistantText = "";
  let sessionId = "";
  let queueTimestamp = "";
  let sawAssistantRecord = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type === "queue-operation" && entry.operation === "enqueue" && !queueUserText) {
      queueUserText = contentToText(entry.content);
      sessionId = typeof entry.sessionId === "string" ? entry.sessionId : sessionId;
      queueTimestamp = typeof entry.timestamp === "string" ? entry.timestamp : queueTimestamp;
      continue;
    }

    const role = entry?.message?.role;
    if (entry?.type === "user" && role === "user" && !firstUserText) {
      firstUserText = contentToText(entry.message.content);
      continue;
    }

    if (entry?.type === "assistant" && role === "assistant") {
      sawAssistantRecord = true;
      if (!firstAssistantText) firstAssistantText = contentToText(entry.message.content);
    }

    if ((queueUserText || firstUserText) && firstAssistantText) break;
  }

  const userText = queueUserText || firstUserText;
  return {
    userText,
    assistantText: firstAssistantText,
    userSource: queueUserText ? "queue-operation-enqueue" : firstUserText ? "transcript-user" : "missing",
    assistantSource: firstAssistantText ? "transcript-assistant" : sawAssistantRecord ? "assistant-nontext" : "missing",
    sessionId,
    queueTimestamp,
    abandonedBeforeAssistant: Boolean(userText && !firstAssistantText),
  };
}

export const extractFirstTurnFromText = (text) => extractFirstTurnFromLines(String(text).split(/\r?\n/));

function walkJsonl(root, sinceMs, untilMs, files = []) {
  if (!existsSync(root)) return files;
  const stat = statSync(root);
  if (stat.isFile()) {
    if (root.endsWith(".jsonl") && stat.mtimeMs >= sinceMs && stat.mtimeMs <= untilMs) files.push(root);
    return files;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(path, sinceMs, untilMs, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const childStat = statSync(path);
      if (childStat.mtimeMs >= sinceMs && childStat.mtimeMs <= untilMs) files.push(path);
    }
  }
  return files;
}

function loadConfig() {
  const configPath = join(homedir(), ".memory-crystal", "config.json");
  let config = { apiKey: "", convexUrl: DEFAULT_URL };
  if (existsSync(configPath)) {
    config = { ...config, ...JSON.parse(readFileSync(configPath, "utf8")) };
  }
  return {
    apiKey: process.env.MEMORY_CRYSTAL_API_KEY || config.apiKey || "",
    convexUrl: (process.env.MEMORY_CRYSTAL_URL || config.convexUrl || DEFAULT_URL).replace(/\/$/, ""),
  };
}

async function postJson(config, path, body) {
  const response = await fetch(`${config.convexUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return response.json().catch(() => ({}));
}

async function writeTurn(config, args) {
  await postJson(config, "/api/mcp/log", {
    role: args.role,
    content: args.content,
    channel: args.channel,
    sessionKey: args.sessionKey,
    turnMessageIndex: args.turnMessageIndex,
  });
  await postJson(config, "/api/mcp/capture", {
    title: `${args.role === "user" ? "User" : "Assistant"} — JSONL backfill`,
    content: `${args.role === "user" ? "User" : "Assistant"}: ${args.content}`,
    store: "sensory",
    category: "conversation",
    tags: ["auto-capture", "jsonl-backfill"],
    channel: args.channel,
    sessionKey: args.sessionKey,
  });
}

export async function runBackfill(options, deps = {}) {
  const sinceMs = isoDateToMs(options.since);
  const untilMs = isoDateToMs(options.until, true);
  const readText = deps.readText ?? ((file) => readFileSync(file, "utf8"));
  const files = (deps.files ?? walkJsonl(options.root, sinceMs, untilMs)).sort();
  const config = options.commit ? (deps.config ?? loadConfig()) : null;
  if (options.commit && !config.apiKey) throw new Error("Missing apiKey; configure ~/.memory-crystal/config.json or MEMORY_CRYSTAL_API_KEY");

  const summary = { scanned: 0, candidates: 0, userWrites: 0, assistantWrites: 0, abandoned: 0, errors: [] };
  for (const file of files) {
    if (options.limit && summary.scanned >= options.limit) break;
    summary.scanned += 1;
    const turn = extractFirstTurnFromText(readText(file));
    if (!turn.userText && !turn.assistantText) continue;
    summary.candidates += 1;
    if (turn.abandonedBeforeAssistant) summary.abandoned += 1;
    const sessionKey = turn.sessionId || file;
    if (!options.commit) continue;
    try {
      if (turn.userText) {
        await writeTurn(config, { role: "user", content: turn.userText, channel: options.channel, sessionKey, turnMessageIndex: 0 });
        summary.userWrites += 1;
      }
      if (turn.assistantText) {
        await writeTurn(config, { role: "assistant", content: turn.assistantText, channel: options.channel, sessionKey, turnMessageIndex: 1 });
        summary.assistantWrites += 1;
      }
    } catch (error) {
      summary.errors.push({ file, error: error?.message ?? String(error) });
    }
  }
  return summary;
}

function printHelp() {
  console.log(`Usage: node scripts/crystal-backfill-from-jsonl.mjs [--root DIR] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--dry-run|--commit]\n\nDry-run is default. --commit writes through /api/mcp/log and /api/mcp/capture; backend dedup is authoritative.`);
}

async function main() {
  const options = parseArgs();
  if (options.help) return printHelp();
  const summary = await runBackfill(options);
  console.log(JSON.stringify({ mode: options.commit ? "commit" : "dry-run", root: options.root, since: options.since, until: options.until, summary }, null, 2));
  if (summary.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message ?? String(error));
    process.exit(1);
  });
}
