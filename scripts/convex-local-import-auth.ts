#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(new URL("..", import.meta.url).pathname);
const memoryHome = process.env.MEMORY_CRYSTAL_HOME || join(process.env.HOME || "", ".memorycrystal");
const authPath = join(memoryHome, "local-auth.json");

type LocalAuth = {
  userId?: unknown;
  localTokenSha256?: unknown;
};

const convexEnv = {
  ...process.env,
  CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210",
  CONVEX_SELF_HOSTED_ADMIN_KEY: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY || "",
};

function readLocalAuth(): { userId: string; keyHash: string } | null {
  if (!existsSync(authPath)) return null;
  const parsed = JSON.parse(readFileSync(authPath, "utf8")) as LocalAuth;
  if (typeof parsed.userId !== "string" || !/^local_[A-Za-z0-9_-]{8,}$/.test(parsed.userId)) {
    throw new Error(`${authPath} has an invalid userId`);
  }
  if (typeof parsed.localTokenSha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.localTokenSha256)) {
    throw new Error(`${authPath} has an invalid localTokenSha256`);
  }
  return { userId: parsed.userId, keyHash: parsed.localTokenSha256 };
}

function convexRun(functionName: string, args: Record<string, unknown>): string {
  const result = spawnSync("npx", ["convex", "run", functionName, JSON.stringify(args)], {
    cwd: repoRoot,
    env: convexEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`npx convex run ${functionName} failed\n${result.stdout}\n${result.stderr}`.trim());
  }
  return result.stdout;
}

function main(): void {
  const localAuth = readLocalAuth();
  if (!localAuth) {
    console.log(`No local installer auth bridge found at ${authPath}; skipping local API key import.`);
    return;
  }

  convexRun("crystal/localAuth:upsertLocalInstallerApiKey", {
    userId: localAuth.userId,
    keyHash: localAuth.keyHash,
    label: "local installer",
    now: Date.now(),
  });
  console.log(`Imported local installer API key hash for ${localAuth.userId}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
