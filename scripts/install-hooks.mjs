#!/usr/bin/env node
// Local development/runtime installer for Memory Crystal hook support files.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installLaunchAgent } from "../plugins/shared/install-sweep-launchd.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const sharedDir = join(repoRoot, "plugins", "shared");

const SUPPORT_FILES = [
  "_lib.mjs",
  "crystal-hooks.mjs",
  "crystal-hooks-sweep.mjs",
  "install-sweep-launchd.mjs",
  "install-hook-config.mjs",
  "remove-hook-config.mjs",
  "ensure-codex-hooks-flag.mjs",
  "MEMORY_CRYSTAL_INSTRUCTIONS.md",
];

const GUARD_MESSAGE =
  "Refusing to install hooks while inside a Claude Code session.\n" +
  "Memory Crystal hook is loaded by the running Node process; overwriting it\n" +
  "would corrupt in-flight SessionStart / UserPromptSubmit / Stop handlers.\n" +
  "Run from outside a Claude Code session, OR set CRYSTAL_FORCE_INSTALL=1 if\n" +
  "you understand the risk (e.g., installing the sweeper, not the hook itself).";

function parseArgs(argv) {
  const options = { dryRun: false, installLaunchd: true };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-launchd") options.installLaunchd = false;
    else if (arg.startsWith("--target-dir=")) options.targetDir = arg.slice("--target-dir=".length);
  }
  return options;
}

export function installHooks(options = {}) {
  if (process.env.CLAUDE_SESSION_ID && !process.env.CRYSTAL_FORCE_INSTALL) {
    throw new Error(GUARD_MESSAGE);
  }

  const targetDir = options.targetDir || join(homedir(), ".memory-crystal");
  const copied = [];
  if (!options.dryRun) mkdirSync(targetDir, { recursive: true });

  for (const file of SUPPORT_FILES) {
    const source = join(sharedDir, file);
    if (!existsSync(source)) continue;
    const dest = join(targetDir, file === "MEMORY_CRYSTAL_INSTRUCTIONS.md" ? "instructions.md" : file);
    copied.push(dest);
    if (!options.dryRun) cpSync(source, dest);
  }

  let launchd = null;
  if (options.installLaunchd && platform() === "darwin") {
    launchd = installLaunchAgent({
      dryRun: options.dryRun,
      scriptPath: join(targetDir, "crystal-hooks-sweep.mjs"),
    });
  }

  return { targetDir, copied, launchd };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = installHooks(options);
  console.log(`Installed Memory Crystal hook support files to ${result.targetDir}`);
  for (const file of result.copied) console.log(`  ${options.dryRun ? "would copy" : "copied"}: ${file}`);
  if (result.launchd?.plistPath) console.log(`  ${options.dryRun ? "would write" : "launchd"}: ${result.launchd.plistPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
