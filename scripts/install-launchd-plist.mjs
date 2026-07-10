#!/usr/bin/env node
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir, userInfo } from "os";
import { join } from "path";

function whichNode() {
  try { return execFileSync("which", ["node"], { encoding: "utf8" }).trim(); } catch { return process.execPath; }
}

const user = userInfo().username;
const nodeBin = whichNode();
const launchAgents = join(homedir(), "Library", "LaunchAgents");
const plistPath = join(launchAgents, "com.memory-crystal.sweep.plist");
const crystalDir = join(homedir(), ".memory-crystal");
const sweeper = join(crystalDir, "crystal-hooks-sweep.mjs");

mkdirSync(launchAgents, { recursive: true });
mkdirSync(crystalDir, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.memory-crystal.sweep</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${sweeper}</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardErrorPath</key><string>/Users/${user}/.memory-crystal/sweep.err.log</string>
  <key>StandardOutPath</key><string>/Users/${user}/.memory-crystal/sweep.out.log</string>
</dict>
</plist>
`;

writeFileSync(plistPath, plist);
console.log(`[ok] wrote ${plistPath}`);
if (!existsSync(sweeper)) {
  console.log(`[warn] ${sweeper} does not exist yet; run npm run install:hooks before loading the agent.`);
}
try {
  execFileSync("plutil", ["-lint", plistPath], { stdio: "inherit" });
} catch {
  process.exit(1);
}
