#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

function usage() {
  console.error("usage: node remove-hook-config.mjs <host> <config-path>");
  process.exit(1);
}

const [, , host, configPath] = process.argv;
if (!host || !configPath) usage();

const supportedHosts = new Set(["codex", "claude", "factory"]);
if (!supportedHosts.has(host)) {
  console.error(`unsupported host: ${host}`);
  process.exit(1);
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

function removeEventHooks(hooksRoot, event) {
  const existing = Array.isArray(hooksRoot[event]) ? hooksRoot[event] : [];
  const next = existing.filter(
    (entry) =>
      !Array.isArray(entry?.hooks) ||
      !entry.hooks.some((candidate) => typeof candidate?.command === "string" && candidate.command.includes("crystal-hooks.mjs")),
  );
  if (next.length > 0) {
    hooksRoot[event] = next;
  } else {
    delete hooksRoot[event];
  }
}

const config = readJson(configPath);
const hooksRoot = ensureHooksRoot(host, config);

removeEventHooks(hooksRoot, "UserPromptSubmit");
removeEventHooks(hooksRoot, "Stop");
removeEventHooks(hooksRoot, "SessionStart");

mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
