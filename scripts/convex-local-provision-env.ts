#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(new URL("..", import.meta.url).pathname);
const templatePath = join(repoRoot, "infra/convex/deployment-env.template.json");
const { CONVEX_DEPLOYMENT: _ignoredDeployment, ...baseEnv } = process.env;
const convexEnv = {
  ...baseEnv,
  CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210",
  CONVEX_SELF_HOSTED_ADMIN_KEY: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY || "",
};

type TemplateEntry = { source: "copy-from-prod-env" | "literal"; value?: string; stub?: string | null };
type Template = {
  required?: Record<string, TemplateEntry>;
  "optional-but-recommended"?: Record<string, TemplateEntry>;
  flags?: Record<string, string>;
};

function loadEnvFile(path: string) {
  const values: Record<string, string> = {};
  if (!existsSync(path)) return values;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
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

function loadHostEnv() {
  return {
    ...loadEnvFile(join(repoRoot, ".env")),
    ...loadEnvFile(join(repoRoot, ".env.local")),
    ...process.env,
  } as Record<string, string | undefined>;
}

function convex(args: string[], input?: string) {
  const envFileArgs = process.env.CRYSTAL_CONVEX_ENV_FILE ? ["--env-file", process.env.CRYSTAL_CONVEX_ENV_FILE] : [];
  const result = spawnSync("npx", ["convex", ...args, ...envFileArgs], {
    cwd: repoRoot,
    env: convexEnv,
    input,
    encoding: "utf8",
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`npx convex ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`.trim());
  }
  return result.stdout;
}

function parseEnvNames(output: string) {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z0-9_]+)(?:\s|=|$)/);
    if (match) names.add(match[1]);
  }
  return names;
}

function valueFor(name: string, entry: TemplateEntry, hostEnv: Record<string, string | undefined>, required = true) {
  if (entry.source === "literal") return { value: entry.value ?? "", source: "literal" };
  const copied = hostEnv[name];
  if (copied) return { value: copied, source: "copied" };
  if (entry.stub !== null && entry.stub !== undefined) return { value: entry.stub, source: "stubbed" };
  if (!required) return null;
  throw new Error(`Missing required deployment env ${name}; set it in .env/.env.local or export it before provisioning local Convex.`);
}

function setEnv(name: string, value: string) {
  convex(["env", "set", name], value);
}

function main() {
  const template = JSON.parse(readFileSync(templatePath, "utf8")) as Template;
  const hostEnv = loadHostEnv();
  const existing = parseEnvNames(convex(["env", "list"]));
  const rows: Array<{ name: string; action: string; source: string }> = [];
  const entries: Array<[string, TemplateEntry, boolean]> = [
    ...Object.entries(template.required ?? {}).map(([name, entry]) => [name, entry, true] as [string, TemplateEntry, boolean]),
    ...Object.entries(template["optional-but-recommended"] ?? {}).map(([name, entry]) => [name, entry, false] as [string, TemplateEntry, boolean]),
  ];
  for (const [name, value] of Object.entries(template.flags ?? {})) {
    entries.push([name, { source: "literal", value }, true]);
  }

  for (const [name, entry, required] of entries) {
    if (existing.has(name)) {
      rows.push({ name, action: "skipped", source: "existing" });
      continue;
    }
    const resolved = valueFor(name, entry, hostEnv, required);
    if (!resolved) {
      rows.push({ name, action: "skipped", source: "missing" });
      continue;
    }
    setEnv(name, resolved.value);
    rows.push({ name, action: "set", source: resolved.source });
  }

  const width = Math.max(...rows.map((r) => r.name.length), "NAME".length);
  console.log(`${"NAME".padEnd(width)}  ACTION   SOURCE`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(width)}  ${row.action.padEnd(7)}  ${row.source}`);
  }
}

main();
