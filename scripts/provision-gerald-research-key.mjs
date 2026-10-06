#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(new URL("..", import.meta.url).pathname);
const memoryHome = process.env.MEMORY_CRYSTAL_HOME || join(process.env.HOME || "", ".memorycrystal");
const authPath = join(memoryHome, "local-auth.json");
const handoffPath = process.env.GERALD_RESEARCH_HANDOFF_FILE
  || join(memoryHome, "handoffs", "gerald-research-read.json");

function option(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  throw new Error(message);
}

function main() {
  const collectionId = option("--collection-id");
  if (!collectionId || !/^[a-z0-9]{10,40}$/.test(collectionId)) fail("--collection-id is required");
  if (!existsSync(authPath)) fail(`Local auth bridge not found: ${authPath}`);
  const localAuth = JSON.parse(readFileSync(authPath, "utf8"));
  if (typeof localAuth.userId !== "string") fail("Local auth bridge userId is invalid");
  const args = {
    userId: localAuth.userId,
    label: "gerald-dashboard-read-only",
    capabilities: ["research:read"],
    boundWorkspaceId: option("--workspace") || "gerald",
    boundAgentId: option("--agent") || "gerald-dashboard",
    boundChannel: option("--channel") || "trading-research",
    boundCollectionIds: [collectionId],
  };
  const { CONVEX_DEPLOYMENT: _ignored, ...env } = process.env;
  const result = spawnSync("npx", ["convex", "run", "crystal/apiKeys:provisionScopedResearchKeyInternal", JSON.stringify(args)], {
    cwd: repoRoot,
    env: {
      ...env,
      CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail(`Scoped key provisioning failed: ${result.stderr.trim() || "Convex command failed"}`);
  const provisioned = JSON.parse(result.stdout.trim());
  if (typeof provisioned.rawKey !== "string" || provisioned.rawKey.length < 32) fail("Convex did not return a valid one-time key");
  const document = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    apiUrl: process.env.CRYSTAL_CONVEX_SITE_URL || "http://127.0.0.1:3211",
    credential: provisioned.rawKey,
    capabilities: args.capabilities,
    immutableScope: {
      workspaceId: args.boundWorkspaceId,
      agentId: args.boundAgentId,
      channel: args.boundChannel,
      collectionIds: args.boundCollectionIds,
    },
  };
  mkdirSync(dirname(handoffPath), { recursive: true, mode: 0o700 });
  const temporary = `${handoffPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, handoffPath);
  chmodSync(handoffPath, 0o600);
  process.stdout.write(`Provisioned Gerald read-only handoff at ${handoffPath} (credential redacted).\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
