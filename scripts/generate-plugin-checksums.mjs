#!/usr/bin/env node
// Generates plugin/checksums.txt covering EXACTLY the files plugin/update.sh
// downloads (its PLUGIN_FILES array).
//
// Why not a glob: `shasum *.js *.json ...` sweeps in files update.sh never
// manages — test files (harmless warnings) and, critically, package-lock.json,
// which update.sh's own `npm install better-sqlite3 --save-optional` step
// rewrites on the client. A listed-but-unmanaged, locally-mutated file can
// never match, so every client's verification failed with
// "Files may be corrupted or tampered with" and exited 1 before restarting the
// gateway. The manifest must describe only what update.sh actually delivers.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function managedPluginFiles(root = repoRoot) {
  const updateSh = readFileSync(join(root, "plugin", "update.sh"), "utf8");
  const block = updateSh.split("PLUGIN_FILES=(")[1]?.split(")")[0];
  if (!block) throw new Error("PLUGIN_FILES array not found in plugin/update.sh");
  const files = [...block.matchAll(/"plugin\/([^"]+)"/g)].map((m) => m[1]);
  if (files.length === 0) throw new Error("PLUGIN_FILES parsed empty");
  // update.sh fetches checksums.txt itself; it cannot checksum itself.
  return files.filter((f) => f !== "checksums.txt").sort();
}

export function buildChecksums(root = repoRoot) {
  return managedPluginFiles(root)
    .map((rel) => {
      const digest = createHash("sha256")
        .update(readFileSync(join(root, "plugin", rel)))
        .digest("hex");
      return `${digest}  ${rel}`;
    })
    .join("\n");
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const out = join(repoRoot, "plugin", "checksums.txt");
  writeFileSync(out, `${buildChecksums()}\n`, "utf8");
  console.log(`plugin/checksums.txt written (${managedPluginFiles().length} managed files)`);
}
