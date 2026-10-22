#!/usr/bin/env node
// Doctor check (ILL-480): every host on a machine shares
// ~/.memory-crystal/config.json, so a managed hook command without
// `--host <slug>` falls back to the shared config.platform and mislabels
// captures from the other hosts. Reads only hook files and config.platform;
// never prints any other config field.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MANAGED_COMMAND_RE = /crystal-hooks\.mjs|cursor-hooks\.mjs/;
const HOST_ARG_RE = /\s--host(?:=|\s+)\S+/;

export function hookFilesFor(home = homedir(), env = process.env) {
  return [
    { host: "claude-code", path: join(home, ".claude", "settings.json") },
    { host: "codex", path: join(env.CODEX_HOME || join(home, ".codex"), "hooks.json") },
    { host: "factory-droid", path: join(home, ".factory", "settings.json") },
    { host: "cursor", path: join(home, ".cursor", "hooks.json") },
    { host: "grok", path: join(env.GROK_HOME || join(home, ".grok"), "hooks", "memory-crystal.json") },
  ];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function managedHookCommands(config) {
  const commands = [];
  const hooksRoot = config?.hooks && typeof config.hooks === "object" ? config.hooks : {};
  for (const entries of Object.values(hooksRoot)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry?.command === "string" && MANAGED_COMMAND_RE.test(entry.command)) commands.push(entry.command);
      for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        if (typeof hook?.command === "string" && MANAGED_COMMAND_RE.test(hook.command)) commands.push(hook.command);
      }
    }
  }
  return commands;
}

export function checkHookHosts({ home = homedir(), env = process.env } = {}) {
  const results = [];
  const installed = [];
  for (const { host, path } of hookFilesFor(home, env)) {
    if (!existsSync(path)) continue;
    const commands = managedHookCommands(readJson(path));
    if (commands.length === 0) continue;
    installed.push(host);
    const missing = commands.filter((command) => !HOST_ARG_RE.test(command)).length;
    if (missing > 0) {
      results.push({
        level: "warn",
        message: `${host}: ${missing} Memory Crystal hook command(s) in ${path} lack --host; captures fall back to the shared config.platform. Re-run the installer for ${host}.`,
      });
    } else {
      results.push({ level: "ok", message: `${host}: Memory Crystal hook commands carry --host (${path})` });
    }
  }

  const runtimeConfig = readJson(join(home, ".memory-crystal", "config.json"));
  const platform = typeof runtimeConfig?.platform === "string" ? runtimeConfig.platform.trim() : "";
  if (platform && installed.length > 1) {
    results.push({
      level: "warn",
      message: `config.platform is "${platform}" but Memory Crystal hooks are installed for ${installed.length} hosts (${installed.join(", ")}); hook commands without --host would all label as "${platform}".`,
    });
  }
  if (installed.length === 0) results.push({ level: "info", message: "No Memory Crystal coding-agent hooks found" });
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { level, message } of checkHookHosts()) {
    process.stdout.write(`${level.toUpperCase()} ${message}\n`);
  }
}
