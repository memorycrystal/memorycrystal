#!/usr/bin/env node
// Install the Memory Crystal transcript sweeper launchd agent on macOS.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const LABEL = "com.memory-crystal.sweep";

export function resolveNodeBin() {
  try {
    const found = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {}
  return process.execPath;
}

export function buildPlist({ nodeBin, scriptPath, username = userInfo().username }) {
  const home = homedir();
  const resolvedScriptPath = scriptPath || join(home, ".memory-crystal", "crystal-hooks-sweep.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${resolvedScriptPath}</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardErrorPath</key><string>/Users/${username}/.memory-crystal/sweep.err.log</string>
  <key>StandardOutPath</key><string>/Users/${username}/.memory-crystal/sweep.out.log</string>
</dict>
</plist>
`;
}

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--script-path") options.scriptPath = argv[++i];
    else if (arg === "--plist-path") options.plistPath = argv[++i];
    else if (arg === "--node-bin") options.nodeBin = argv[++i];
  }
  return options;
}

export function installLaunchAgent(options = {}) {
  const nodeBin = options.nodeBin || resolveNodeBin();
  const scriptPath = options.scriptPath || join(homedir(), ".memory-crystal", "crystal-hooks-sweep.mjs");
  const plistPath = options.plistPath || join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const plist = buildPlist({ nodeBin, scriptPath });

  if (options.dryRun) return { plistPath, plist, installed: false };

  if (platform() !== "darwin") {
    return {
      plistPath,
      plist,
      installed: false,
      message: `Non-macOS fallback: add '* * * * * ${nodeBin} ${scriptPath} >> ~/.memory-crystal/sweep.log 2>&1' to cron.`,
    };
  }

  if (!existsSync(scriptPath)) throw new Error(`sweeper script not found: ${scriptPath}`);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, "utf8");
  return { plistPath, plist, installed: true };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = installLaunchAgent(options);
  if (result.message) console.log(result.message);
  else if (options.dryRun) console.log(result.plist);
  else console.log(`Installed ${result.plistPath}`);
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
