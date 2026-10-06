#!/usr/bin/env node
/**
 * Pack @memorycrystal/mcp-server, install that tarball in a clean directory,
 * start the packed bin, and list tools over stdio.
 *
 * `npm pack` does not contact the registry. Installing the tarball does:
 * npm resolves the packed package's dependency manifests, which is not covered
 * by an earlier `npm ci` cache, so this step needs network.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_TOOL_NAMES = [
  "crystal_recall",
  "crystal_remember",
  "crystal_health",
  "crystal_search_messages",
];

export function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-pack-smoke", version: "0.0.0" },
    },
  };
}

export function initializedNotification() {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

export function toolsListRequest() {
  return { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
}

export function frameMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function toolsFromListResponse(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list response did not include a tools array");
  }
  return tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
}

export function assertRequiredTools(names) {
  const missing = REQUIRED_TOOL_NAMES.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`packed server is missing tools: ${missing.join(", ")}`);
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

function readToolsList(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for tools/list; stdout so far: ${buffer.slice(0, 500)}; stderr: ${stderr.slice(0, 500)}`));
    }, 20000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(frameMessage(initializedNotification()));
          child.stdin.write(frameMessage(toolsListRequest()));
        } else if (message.id === 2) {
          clearTimeout(timer);
          resolve(message);
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`packed server exited ${code} before tools/list; stderr: ${stderr.slice(0, 500)}`));
    });
  });
}

export async function smokePackedServer(repoRoot) {
  const pkgDir = path.join(repoRoot, "mcp-server");
  run("npx", ["tsc", "-p", "tsconfig.json"], { cwd: pkgDir });
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json"], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  if ((packed.status ?? 1) !== 0) {
    throw new Error(packed.stderr || "npm pack failed");
  }
  const entries = JSON.parse(packed.stdout);
  const filename = entries[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a filename");
  const tarball = path.join(pkgDir, filename);
  const dest = mkdtempSync(path.join(tmpdir(), "crystal-mcp-pack-"));
  try {
    run("npm", ["init", "-y"], { cwd: dest });
    run("npm", ["install", "--ignore-scripts", "--no-fund", "--no-audit", tarball], { cwd: dest });
    const bin = path.join(dest, "node_modules", ".bin", "crystal-mcp");
    const child = spawn(bin, [], { cwd: dest, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.write(frameMessage(initializeRequest()));
    const listed = await readToolsList(child);
    child.kill();
    const names = toolsFromListResponse(listed);
    assertRequiredTools(names);
    console.log(`packed server listed ${names.length} tools`);
    return names;
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  smokePackedServer(repoRoot).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
