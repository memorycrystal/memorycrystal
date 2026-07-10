#!/usr/bin/env node
// Memory Crystal transcript sweeper — recovers first turns from Claude JSONL transcripts.
// Runs as a short-lived process under launchd/cron. Server-side dedup is authoritative.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "https://convex.memorycrystal.ai";
const DEFAULT_PLATFORM = "claude-code";
const DEFAULT_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const LOG_ROTATE_BYTES = 100 * 1024;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractFirstTurn(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  let lines;
  try {
    const raw = readFileSync(transcriptPath, "utf8").trim();
    if (!raw) return null;
    lines = raw.split("\n");
  } catch {
    return null;
  }

  let userText = null;
  let userSource = null;
  let assistantText = null;

  for (const raw of lines) {
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }

    if (
      !userText &&
      row.type === "queue-operation" &&
      row.operation === "enqueue" &&
      typeof row.content === "string" &&
      row.content.trim()
    ) {
      userText = row.content.trim();
      userSource = "queue-operation:enqueue";
      continue;
    }

    if (!userText && row.type === "user" && row.message?.role === "user") {
      const content = row.message.content;
      if (typeof content === "string") {
        const trimmed = content.trim();
        if (trimmed) {
          const isCommandEnvelope = /<command-(name|message|args)>|<local-command-stdout>/.test(trimmed);
          userText = trimmed;
          userSource = isCommandEnvelope ? "user-string-cmd" : "user-string";
        }
      } else {
        const text = textFromContent(content);
        if (text) {
          userText = text;
          userSource = "user-array";
        }
      }
    }

    if (!assistantText && row.type === "assistant" && row.message?.role === "assistant") {
      const text = textFromContent(row.message.content);
      if (text) assistantText = text;
    }

    if (userText && assistantText) break;
  }

  if (!userText && !assistantText) return null;
  return { userText, userSource, assistantText };
}

export function loadConfig(configPath = join(homedir(), ".memory-crystal", "config.json")) {
  let config = { apiKey: "", convexUrl: DEFAULT_URL, platform: DEFAULT_PLATFORM };
  if (existsSync(configPath)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(configPath, "utf8")) };
    } catch {}
  }
  config.apiKey = config.apiKey || process.env.MEMORY_CRYSTAL_API_KEY || process.env.CRYSTAL_API_KEY || "";
  config.convexUrl = (config.convexUrl || process.env.MEMORY_CRYSTAL_URL || DEFAULT_URL).replace(/\/$/, "");
  config.platform = process.env.CRYSTAL_PLATFORM || config.platform || DEFAULT_PLATFORM;
  return config;
}

function transcriptFiles(root, modifiedSinceMs, now = Date.now(), out = []) {
  if (!existsSync(root)) return out;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      transcriptFiles(full, modifiedSinceMs, now, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const st = statSync(full);
      if (now - st.mtimeMs <= modifiedSinceMs) out.push(full);
    } catch {}
  }
  return out;
}

function sessionKeyForTranscript(file) {
  return basename(file).replace(/\.(jsonl|json)$/i, "") || undefined;
}

function channelForTranscript(config, file) {
  if (config.channel) return config.channel;
  const projectDir = basename(dirname(file));
  return `${config.platform || DEFAULT_PLATFORM}:${projectDir || "transcript-sweep"}`;
}

async function postJson(config, path, body, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${config.convexUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res;
}

async function captureTurn({ config, transcriptPath, firstTurn, fetchImpl = globalThis.fetch, dryRun = false, now = new Date() }) {
  const sessionKey = sessionKeyForTranscript(transcriptPath);
  const channel = channelForTranscript(config, transcriptPath);
  const ts = now.toISOString().slice(0, 16).replace("T", " ");
  const calls = [];

  if (firstTurn.userText) {
    calls.push({
      path: "/api/mcp/log",
      body: {
        role: "user",
        content: firstTurn.userText,
        channel,
        ...(sessionKey ? { sessionKey } : {}),
        turnMessageIndex: 0,
      },
    });
    calls.push({
      path: "/api/mcp/capture",
      body: {
        title: `User — ${ts}`,
        content: `User: ${firstTurn.userText}`,
        store: "sensory",
        category: "conversation",
        tags: ["auto-capture", config.platform || DEFAULT_PLATFORM, "sweeper-recovered", `source:${firstTurn.userSource ?? "unknown"}`],
        channel,
        ...(sessionKey ? { sessionKey } : {}),
      },
    });
  }

  if (firstTurn.assistantText) {
    const truncated = firstTurn.assistantText.length > 4000
      ? `${firstTurn.assistantText.slice(0, 4000)}\n... [truncated]`
      : firstTurn.assistantText;
    calls.push({
      path: "/api/mcp/log",
      body: {
        role: "assistant",
        content: truncated,
        channel,
        ...(sessionKey ? { sessionKey } : {}),
        turnMessageIndex: 1,
      },
    });
    calls.push({
      path: "/api/mcp/capture",
      body: {
        title: `Assistant — ${ts}`,
        content: `Assistant: ${truncated}`,
        store: "sensory",
        category: "conversation",
        tags: ["auto-capture", config.platform || DEFAULT_PLATFORM, "sweeper-recovered", "response"],
        channel,
        ...(sessionKey ? { sessionKey } : {}),
      },
    });
  } else if (firstTurn.userText) {
    calls.push({
      path: "warning",
      body: { transcriptPath, warning: "abandoned-before-assistant" },
    });
  }

  if (dryRun) return calls;

  const httpCalls = calls.filter((call) => call.path.startsWith("/api/"));
  await Promise.all(httpCalls.map((call) => postJson(config, call.path, call.body, fetchImpl)));
  return calls;
}

export function acquirePidLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const existing = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(existing) && existing > 0) {
      try {
        process.kill(existing, 0);
        return { acquired: false, pid: existing };
      } catch {}
    }
  }
  writeFileSync(lockPath, `${process.pid}\n`, "utf8");
  return { acquired: true, pid: process.pid };
}

export const acquireSweepLock = acquirePidLock;

export function releasePidLock(lockPath) {
  try {
    if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
      unlinkSync(lockPath);
    }
  } catch {}
}

export function truncateLogIfLarge(path, maxBytes = LOG_ROTATE_BYTES) {
  try {
    if (existsSync(path) && statSync(path).size > maxBytes) truncateSync(path, 0);
  } catch {}
}

export async function sweepTranscripts(options = {}) {
  const crystalDir = options.crystalDir || join(homedir(), ".memory-crystal");
  const config = options.config || loadConfig(options.configPath || join(crystalDir, "config.json"));
  if (!config.apiKey && !options.dryRun) {
    return { ok: false, reason: "missing-api-key", scanned: 0, captured: 0, calls: [] };
  }

  truncateLogIfLarge(join(crystalDir, "sweep.out.log"));
  truncateLogIfLarge(join(crystalDir, "sweep.err.log"));

  const projectsDir = options.projectsDir || join(homedir(), ".claude", "projects");
  const files = options.files || transcriptFiles(projectsDir, options.lookbackMs ?? DEFAULT_LOOKBACK_MS, options.nowMs ?? Date.now());
  const calls = [];
  let captured = 0;
  let partial = 0;

  for (const file of files.sort()) {
    const firstTurn = extractFirstTurn(file);
    if (!firstTurn) continue;
    const turnCalls = await captureTurn({
      config,
      transcriptPath: file,
      firstTurn,
      fetchImpl: options.fetchImpl,
      dryRun: options.dryRun,
      now: options.nowDate || new Date(),
    });
    calls.push(...turnCalls.map((call) => ({ ...call, transcriptPath: file })));
    if (firstTurn.userText || firstTurn.assistantText) captured += 1;
    if (firstTurn.userText && !firstTurn.assistantText) partial += 1;
  }

  return { ok: true, scanned: files.length, captured, partial, calls };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--projects-dir") options.projectsDir = argv[++i];
    else if (arg === "--config") options.configPath = argv[++i];
    else if (arg === "--lock") options.lockPath = argv[++i];
    else if (arg === "--lookback-hours") options.lookbackMs = Number(argv[++i]) * 60 * 60 * 1000;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const crystalDir = join(homedir(), ".memory-crystal");
  const lockPath = options.lockPath || join(crystalDir, "sweep.lock");
  const lock = acquirePidLock(lockPath);
  if (!lock.acquired) {
    console.log(`memory-crystal sweep lock held by pid ${lock.pid}; exiting`);
    return 0;
  }
  const cleanup = () => releasePidLock(lockPath);
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    const result = await sweepTranscripts(options);
    console.log(JSON.stringify({ ...result, calls: undefined }));
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`[memory-crystal][sweep] ${err?.message ?? String(err)}`);
    return 1;
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
