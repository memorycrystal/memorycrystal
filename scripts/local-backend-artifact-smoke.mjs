#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");
const runPostgres = args.has("--postgres");
const install = args.has("--install") || args.has("--docker") || runPostgres;
const runDocker = args.has("--docker");
const artifact = mkdtempSync(join(tmpdir(), "memorycrystal-local-artifact-"));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
  }
  return result;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

const importPattern = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const extensions = [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"];

function resolveRelativeImport(sourceFile, specifier) {
  const base = resolve(dirname(sourceFile), specifier);
  const candidates = [base];
  if (!extname(base)) {
    for (const extension of extensions) candidates.push(`${base}${extension}`);
    for (const extension of extensions) candidates.push(join(base, `index${extension}`));
  } else if (base.endsWith(".js")) {
    candidates.push(base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx");
  }
  return candidates.find(existsSync) ?? null;
}

try {
  run("node", ["scripts/package-local-backend.mjs", "--version", "artifact-smoke", "--out", artifact]);
  const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8"));
  assert.equal(manifest.name, "memorycrystal-local-backend");
  assert.ok(manifest.files.length > 100, "artifact manifest should contain the full local backend");
  assert.equal(existsSync(join(artifact, "convex/crystal/adminEmails.ts")), true);
  assert.equal(existsSync(join(artifact, "convex/crystal/adminSupport.ts")), true);
  assert.equal(existsSync(join(artifact, "convex/crystal/adminSettings/resolvers.ts")), true);
  assert.equal(existsSync(join(artifact, "convex/crystal/adminSettings/mutations.ts")), false);
  assert.equal(existsSync(join(artifact, "convex/crystal/adminSettings/queries.ts")), false);

  const missing = [];
  for (const file of walk(join(artifact, "convex")).filter((path) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(path) && !path.includes("/_generated/"))) {
    const content = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const match of content.matchAll(importPattern)) {
      if (!resolveRelativeImport(file, match[1])) missing.push(`${file.slice(artifact.length + 1)} -> ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `artifact has unresolved relative imports:\n${missing.join("\n")}`);

  if (install) {
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: artifact, stdio: "inherit" });
  }

  if (runDocker || runPostgres) {
    const dockerInfo = spawnSync("docker", ["info"], { encoding: "utf8" });
    if (dockerInfo.status !== 0) {
      throw new Error("Docker artifact verification requested but Docker is unavailable");
    }
  }
  if (runDocker) {
    run("bash", ["scripts/local-backend-artifact-docker.test.sh"], {
      cwd: repoRoot,
      env: { ...process.env, CRYSTAL_TEST_ARTIFACT_ROOT: artifact },
      stdio: "inherit",
    });
  }
  if (runPostgres) {
    run("bash", ["scripts/local-backend-postgres.test.sh"], {
      cwd: repoRoot,
      env: { ...process.env, CRYSTAL_TEST_ARTIFACT_ROOT: artifact },
      stdio: "inherit",
    });
  }

  console.log(`Local backend artifact smoke passed: ${artifact}`);
} finally {
  if (!keep) rmSync(artifact, { recursive: true, force: true });
}
