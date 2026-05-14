#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const repoRoot = join(new URL("..", import.meta.url).pathname);
const templatePath = join(repoRoot, "infra/convex/.env.local.template");
const memoryHome = process.env.MEMORY_CRYSTAL_HOME || join(process.env.HOME || "", ".memorycrystal");
const localAuthPath = join(memoryHome, "local-auth.json");
const startMarker = "# >>> memory-crystal local-backend overlay (managed by scripts/convex-local-write-env.ts) >>>";
const endMarker = "# <<< memory-crystal local-backend overlay <<<";
const managedStarts = [
  "# >>> memory-crystal local-backend overlay ",
  "# >>> memory-crystal web-backend overlay ",
];
const managedEnds = [
  "# <<< memory-crystal local-backend overlay <<<",
  "# <<< memory-crystal web-backend overlay <<<",
];

const destinations: Array<{ path: string; keys: string[] }> = [
  { path: ".env.local", keys: ["CONVEX_URL", "CRYSTAL_CONVEX_URL", "CRYSTAL_CONVEX_SITE_URL", "MEMORY_CRYSTAL_API_URL", "MEMORY_CRYSTAL_API_KEY", "CRYSTAL_BACKEND", "CRYSTAL_LOCAL_LLM_STUB", "CRYSTAL_EMAIL_DRY_RUN", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"] },
  { path: "apps/web/.env.local", keys: ["NEXT_PUBLIC_CONVEX_URL", "CRYSTAL_CONVEX_SITE_URL", "NEXT_PUBLIC_SITE_URL", "CRYSTAL_BACKEND"] },
  { path: "mcp-server/.env", keys: ["CONVEX_URL", "CRYSTAL_CONVEX_URL", "CRYSTAL_CONVEX_SITE_URL", "MEMORY_CRYSTAL_API_URL", "MEMORY_CRYSTAL_API_KEY", "CRYSTAL_LOCAL_LLM_STUB", "CRYSTAL_EMAIL_DRY_RUN"] },
];

function parseEnv(path: string) {
  const values: Record<string, string> = {};
  const input = readFileSync(path, "utf8").replace(/\$\{GENERATED_ADMIN_KEY\}/g, process.env.CONVEX_SELF_HOSTED_ADMIN_KEY || "");
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    values[key.trim()] = rest.join("=").trim();
  }
  return values;
}

function readLocalInstallerToken(): string | null {
  if (!existsSync(localAuthPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(localAuthPath, "utf8")) as { localToken?: unknown };
    if (typeof parsed.localToken === "string" && parsed.localToken.trim().length > 0) {
      return parsed.localToken.trim();
    }
  } catch {
    // Ignore malformed local auth here; convex-local-doctor reports it explicitly.
  }
  return null;
}

function withoutManagedBlock(content: string) {
  const out: string[] = [];
  let skipping = false;
  for (const line of content.split(/\r?\n/)) {
    if (managedStarts.some((prefix) => line.startsWith(prefix))) {
      skipping = true;
      continue;
    }
    if (managedEnds.includes(line)) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").trimEnd();
}

function assertNoConflictingBackend(path: string, bodyWithoutBlock: string) {
  for (const raw of bodyWithoutBlock.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^CRYSTAL_BACKEND=(.*)$/);
    if (match && match[1].trim() !== "local") {
      throw new Error(`${path} has CRYSTAL_BACKEND=${match[1]} outside the managed block; refusing to clobber a manual backend override.`);
    }
  }
}

function writeDestination(relativePath: string, keys: string[], values: Record<string, string>) {
  const path = join(repoRoot, relativePath);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const base = withoutManagedBlock(existing);
  assertNoConflictingBackend(relativePath, base);
  const overlayLines = [startMarker];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(values, key)) overlayLines.push(`${key}=${values[key]}`);
  }
  overlayLines.push(endMarker);
  const next = `${base ? `${base}\n\n` : ""}${overlayLines.join("\n")}\n`;
  if (next === existing) return false;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, path);
  return true;
}

function main() {
  const values = parseEnv(templatePath);
  const localInstallerToken = readLocalInstallerToken();
  if (localInstallerToken) values.MEMORY_CRYSTAL_API_KEY = localInstallerToken;
  const webSiteUrl = process.env.MEMORY_CRYSTAL_WEB_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (webSiteUrl) values.NEXT_PUBLIC_SITE_URL = webSiteUrl;
  for (const destination of destinations) {
    const changed = writeDestination(destination.path, destination.keys, values);
    console.log(`${changed ? "updated" : "unchanged"} ${destination.path}`);
  }
}

main();
