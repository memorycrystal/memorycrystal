#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const memoryHome = process.env.MEMORY_CRYSTAL_HOME || join(process.env.HOME || "", ".memorycrystal");
const authPath = join(memoryHome, "local-auth.json");
const handoffPath = process.env.MOONDEV_RESEARCH_HANDOFF_FILE || join(memoryHome, "handoffs", "moondev-research-ingest.json");

function option(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const collectionId = option("--collection-id");
if (!collectionId || !/^[a-z0-9]{10,40}$/.test(collectionId)) throw new Error("--collection-id is required");
if (!existsSync(authPath)) throw new Error(`Local auth bridge not found: ${authPath}`);
const localAuth = JSON.parse(readFileSync(authPath, "utf8"));
if (typeof localAuth.userId !== "string") throw new Error("Local auth bridge userId is invalid");

const scope = {
  boundWorkspaceId: "gerald",
  boundAgentId: "gerald-dashboard",
  boundChannel: "trading-research",
  boundCollectionIds: [collectionId],
};
const args = {
  userId: localAuth.userId,
  label: "moondev-research-ingest-only",
  capabilities: ["research:ingest"],
  ...scope,
};
const { CONVEX_DEPLOYMENT: _ignored, ...env } = process.env;
const result = spawnSync("npx", ["convex", "run", "crystal/apiKeys:provisionScopedResearchKeyInternal", JSON.stringify(args)], {
  cwd: repoRoot,
  env: { ...env, CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210" },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.status !== 0) throw new Error(`Scoped key provisioning failed: ${result.stderr.trim() || "Convex command failed"}`);
const provisioned = JSON.parse(result.stdout.trim());
if (typeof provisioned.rawKey !== "string" || provisioned.rawKey.length < 32) throw new Error("Convex did not return a valid one-time key");

const document = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  apiUrl: process.env.CRYSTAL_CONVEX_SITE_URL || "http://127.0.0.1:3211",
  credential: provisioned.rawKey,
  capabilities: args.capabilities,
  immutableScope: {
    workspaceId: scope.boundWorkspaceId,
    agentId: scope.boundAgentId,
    channel: scope.boundChannel,
    collectionIds: scope.boundCollectionIds,
  },
};
mkdirSync(dirname(handoffPath), { recursive: true, mode: 0o700 });
const temporary = `${handoffPath}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
chmodSync(temporary, 0o600);
renameSync(temporary, handoffPath);
chmodSync(handoffPath, 0o600);
process.stdout.write(`Provisioned MoonDev ingest-only handoff at ${handoffPath} (credential redacted).\n`);
