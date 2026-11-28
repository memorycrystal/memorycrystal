#!/usr/bin/env node
// Copy the canonical MCP tool contract into both server packages.
// `node scripts/generate-mcp-tool-contract.mjs --check` fails when a copy drifts.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main() {

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "shared/mcp-tool-contract/toolContract.ts");
const destinations = [
  resolve(root, "mcp-server/src/contract/toolContract.ts"),
  resolve(root, "packages/mcp-server/src/contract/toolContract.ts"),
];

const source = readFileSync(sourcePath);
const check = process.argv.includes("--check");
let drifted = false;

for (const destination of destinations) {
  if (check) {
    let current;
    try {
      current = readFileSync(destination);
    } catch {
      console.error(`missing ${destination}`);
      drifted = true;
      continue;
    }
    if (!current.equals(source)) {
      console.error(`stale ${destination}`);
      drifted = true;
    }
    continue;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
  console.log(`wrote ${destination}`);
}

if (drifted) {
  console.error("MCP tool contract copies are stale. Run node scripts/generate-mcp-tool-contract.mjs");
  process.exit(1);
}
}

if (isDirectRun()) {
  await main();
}
