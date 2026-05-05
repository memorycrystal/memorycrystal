#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const repoRoot = join(new URL("..", import.meta.url).pathname);
const webEnvPath = join(repoRoot, "apps/web/.env.local");
const startMarker = "# >>> memory-crystal web-backend overlay (managed by scripts/web-backend-env.ts) >>>";
const endMarker = "# <<< memory-crystal web-backend overlay <<<";
const managedStarts = [
  "# >>> memory-crystal web-backend overlay ",
  "# >>> memory-crystal local-backend overlay ",
];
const managedEnds = [
  "# <<< memory-crystal web-backend overlay <<<",
  "# <<< memory-crystal local-backend overlay <<<",
];

type Mode = "local" | "remote";

function usage() {
  return [
    "Usage: node --experimental-strip-types scripts/web-backend-env.ts <local|remote> [--convex-url <url>] [--convex-site-url <url>] [--site-url <url>]",
    "",
    "Examples:",
    "  npm run web:backend:local -- --site-url http://localhost:3001",
    "  npm run web:backend:remote -- --convex-url https://your-deployment.convex.cloud --site-url http://localhost:3001",
    "",
    "Remote mode can also read MEMORY_CRYSTAL_REMOTE_CONVEX_URL, NEXT_PUBLIC_REMOTE_CONVEX_URL, or REMOTE_CONVEX_URL.",
  ].join("\n");
}

function parseArgs(argv: string[]) {
  const [modeArg, ...rest] = argv;
  if (modeArg !== "local" && modeArg !== "remote") throw new Error(usage());
  const options: { mode: Mode; convexUrl?: string; convexSiteUrl?: string; siteUrl?: string } = { mode: modeArg };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];
    if (arg === "--convex-url" && next) {
      options.convexUrl = next;
      index += 1;
    } else if (arg === "--convex-site-url" && next) {
      options.convexSiteUrl = next;
      index += 1;
    } else if (arg === "--site-url" && next) {
      options.siteUrl = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function withoutManagedBlocks(content: string) {
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

function parseEnvFile(path: string) {
  const values: Record<string, string> = {};
  if (!existsSync(path)) return values;
  const body = withoutManagedBlocks(readFileSync(path, "utf8"));
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    let value = rest.join("=").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key.trim()] = value;
  }
  return values;
}

function loadEnv() {
  return {
    ...parseEnvFile(join(repoRoot, ".env")),
    ...parseEnvFile(join(repoRoot, ".env.local")),
    ...parseEnvFile(join(repoRoot, "apps/web/.env")),
    ...parseEnvFile(join(repoRoot, "apps/web/.env.local")),
    ...process.env,
  } as Record<string, string | undefined>;
}

function assertHttpUrl(name: string, value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${name} must be an http(s) URL, got: ${value}`);
  }
}

function resolveConvexUrl(mode: Mode, explicit: string | undefined, env: Record<string, string | undefined>) {
  if (explicit) return explicit;
  if (mode === "local") return env.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210";
  return (
    env.MEMORY_CRYSTAL_REMOTE_CONVEX_URL ||
    env.NEXT_PUBLIC_REMOTE_CONVEX_URL ||
    env.REMOTE_CONVEX_URL ||
    env.NEXT_PUBLIC_CONVEX_URL
  );
}

function resolveConvexSiteUrl(mode: Mode, explicit: string | undefined, convexUrl: string, env: Record<string, string | undefined>) {
  if (explicit) return explicit;
  if (mode === "local") return env.CRYSTAL_CONVEX_SITE_URL || "http://127.0.0.1:3211";
  return (
    env.MEMORY_CRYSTAL_REMOTE_CONVEX_SITE_URL ||
    env.REMOTE_CONVEX_SITE_URL ||
    (convexUrl.includes(".convex.cloud") ? convexUrl.replace(".convex.cloud", ".convex.site") : undefined) ||
    env.CRYSTAL_CONVEX_SITE_URL
  );
}

function writeWebEnv(mode: Mode, convexUrl: string, convexSiteUrl: string, siteUrl: string) {
  const existing = existsSync(webEnvPath) ? readFileSync(webEnvPath, "utf8") : "";
  const base = withoutManagedBlocks(existing);
  const overlay = [
    startMarker,
    `CRYSTAL_BACKEND=${mode}`,
    `NEXT_PUBLIC_CONVEX_URL=${convexUrl}`,
    `CRYSTAL_CONVEX_SITE_URL=${convexSiteUrl}`,
    `NEXT_PUBLIC_SITE_URL=${siteUrl}`,
    endMarker,
  ].join("\n");
  const next = `${base ? `${base}\n\n` : ""}${overlay}\n`;
  if (next === existing) return false;
  mkdirSync(dirname(webEnvPath), { recursive: true });
  const tmp = `${webEnvPath}.tmp-${process.pid}`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, webEnvPath);
  return true;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const siteUrl = options.siteUrl || env.MEMORY_CRYSTAL_WEB_URL || env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const convexUrl = resolveConvexUrl(options.mode, options.convexUrl, env);
  if (!convexUrl) {
    throw new Error(`Remote Convex URL not configured.\n\n${usage()}`);
  }
  const convexSiteUrl = resolveConvexSiteUrl(options.mode, options.convexSiteUrl, convexUrl, env);
  if (!convexSiteUrl) {
    throw new Error(`Remote Convex HTTP-actions URL not configured. Pass --convex-site-url for non-.convex.cloud deployments.\n\n${usage()}`);
  }
  assertHttpUrl("NEXT_PUBLIC_CONVEX_URL", convexUrl);
  assertHttpUrl("CRYSTAL_CONVEX_SITE_URL", convexSiteUrl);
  assertHttpUrl("NEXT_PUBLIC_SITE_URL", siteUrl);

  const changed = writeWebEnv(options.mode, convexUrl, convexSiteUrl, siteUrl);
  console.log(`${changed ? "updated" : "unchanged"} apps/web/.env.local`);
  console.log(`web backend: ${options.mode}`);
  console.log(`convex url:  ${convexUrl}`);
  console.log(`site api:    ${convexSiteUrl}`);
  console.log(`site url:    ${siteUrl}`);
  if (options.mode === "remote") {
    console.log("note: password/OAuth auth against a remote Convex deployment also requires that deployment env SITE_URL to match this site URL.");
  }
}

main();
