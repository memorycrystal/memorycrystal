#!/usr/bin/env node
/**
 * Self-hosted Convex deploy. Stamps convex/crystal/buildInfo.generated.ts with
 * the git commit, dirty flag, and build time, then restores the committed
 * placeholder so the worktree does not keep a generated SHA.
 *
 * Refuses a dirty tree unless --allow-dirty (which records dirty: true).
 * --dry-run writes and restores the module without calling convex deploy.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideBuildInfo, renderBuildInfoModule } from "./lib/deploy-build-info.mjs";
import { resolveSelfHostedConvexEnv } from "./lib/convex-self-hosted-env.mjs";

const raw = process.argv.slice(2);
let allowDirty = false;
let dryRun = false;
let allowLocal = false;
let gitDir = process.cwd();
let modulePath = resolve(process.cwd(), "convex/crystal/buildInfo.generated.ts");
const forward = [];
for (let index = 0; index < raw.length; index += 1) {
  const arg = raw[index];
  if (arg === "--allow-dirty") allowDirty = true;
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--allow-local") allowLocal = true;
  else if (arg === "--git-dir") gitDir = raw[++index];
  else if (arg === "--module-path") modulePath = resolve(raw[++index]);
  else forward.push(arg);
}

const porcelain = spawnSync("git", ["-C", gitDir, "status", "--porcelain"], { encoding: "utf8" });
if (porcelain.error || porcelain.status !== 0) {
  console.error(porcelain.stderr || porcelain.error?.message || "git status failed");
  process.exit(2);
}
const head = spawnSync("git", ["-C", gitDir, "rev-parse", "HEAD"], { encoding: "utf8" });
const decision = decideBuildInfo({
  porcelain: porcelain.stdout,
  allowDirty,
  commit: head.stdout?.trim() || "unknown",
  now: Date.now(),
});
if (!decision.ok) {
  console.error(decision.message);
  process.exit(decision.code);
}

const original = readFileSync(modulePath);
let restored = false;
const restore = () => {
  if (restored) return;
  writeFileSync(modulePath, original);
  restored = true;
};

function deploy() {
  try {
    writeFileSync(modulePath, renderBuildInfoModule(decision.info));
    if (dryRun) {
      process.stdout.write(`${JSON.stringify(decision.info)}\n`);
      return;
    }
    let target;
    try {
      target = resolveSelfHostedConvexEnv({ allowLocal });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
      return;
    }
    const result = spawnSync("npx", ["convex", "deploy", ...forward], {
      cwd: process.cwd(),
      env: target.env,
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
  } finally {
    restore();
  }
}
deploy();
