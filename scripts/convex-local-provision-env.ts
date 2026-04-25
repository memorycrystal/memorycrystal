#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(new URL("..", import.meta.url).pathname);
const templatePath = join(repoRoot, "infra/convex/deployment-env.template.json");
const convexEnv = {
  ...process.env,
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

function convex(args: string[]) {
  const result = spawnSync("npx", ["convex", ...args], {
    cwd: repoRoot,
    env: convexEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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

function valueFor(name: string, entry: TemplateEntry, hostEnv: Record<string, string | undefined>) {
  if (entry.source === "literal") return { value: entry.value ?? "", source: "literal" };
  const copied = hostEnv[name];
  if (copied) return { value: copied, source: "copied" };
  if (entry.stub !== null && entry.stub !== undefined) return { value: entry.stub, source: "stubbed" };
  throw new Error(`Missing required deployment env ${name}; set it in .env/.env.local or export it before provisioning local Convex.`);
}

function setEnv(name: string, value: string) {
  convex(["env", "set", name, value]);
}

function main() {
  const template = JSON.parse(readFileSync(templatePath, "utf8")) as Template;
  const hostEnv = loadHostEnv();
  const existing = parseEnvNames(convex(["env", "list"]));
  const rows: Array<{ name: string; action: string; source: string }> = [];
  const entries: Record<string, TemplateEntry> = {
    ...(template.required ?? {}),
    ...(template["optional-but-recommended"] ?? {}),
  };
  for (const [name, value] of Object.entries(template.flags ?? {})) {
    entries[name] = { source: "literal", value };
  }

  for (const [name, entry] of Object.entries(entries)) {
    if (existing.has(name)) {
      rows.push({ name, action: "skipped", source: "existing" });
      continue;
    }
    const resolved = valueFor(name, entry, hostEnv);
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
