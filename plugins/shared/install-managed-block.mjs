#!/usr/bin/env node
// install-managed-block.mjs — Install managed agent instructions blocks.
//
// Reads the platform row from platforms.json and writes managed blocks
// to each platform's agentsFile. For hermes, discovers per-profile AGENTS.md
// files. Shared support files are resolved from ~/.memory-crystal/.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentsFilePath, writeManagedBlock } from "./managed-block.mjs";

function usage() {
  console.error("Usage: node install-managed-block.mjs <platform> [instructions-path]");
  process.exit(1);
}

export function installManagedBlockForPlatform(platform, instructionsPath) {
  const instructions = readFileSync(instructionsPath, "utf-8");
  const paths = agentsFilePath(platform);

  if (!paths) {
    return { platform, results: [], skipped: true, reason: "no-agentsFile" };
  }

  // Normalize to array
  const targetPaths = Array.isArray(paths) ? paths : [paths];
  const results = [];

  for (const target of targetPaths) {
    try {
      const result = writeManagedBlock(target, instructions);
      results.push(result);
    } catch (err) {
      results.push({ action: "error", path: target, error: err.message });
    }
  }

  return { platform, results };
}

async function main() {
  const args = process.argv.slice(2);
  const platform = args[0];
  if (!platform) usage();

  const instructionsPath = args[1] || join(homedir(), ".memory-crystal", "instructions.md");
  if (!existsSync(instructionsPath)) {
    console.error(`Instructions not found at ${instructionsPath}`);
    process.exit(1);
  }

  const result = installManagedBlockForPlatform(platform, instructionsPath);
  console.log(JSON.stringify(result, null, 2));
  const errors = result.results?.filter((r) => r.action === "error") || [];
  if (errors.length > 0) process.exit(1);
}

  if (process.argv[1] && (process.argv[1].endsWith("install-managed-block.mjs") || process.argv[1].endsWith("/install-managed-block.mjs"))) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
