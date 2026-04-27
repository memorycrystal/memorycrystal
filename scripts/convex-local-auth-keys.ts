#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const repoRoot = join(new URL("..", import.meta.url).pathname);
const rotate = process.argv.includes("--rotate");
const convexEnv = {
  ...process.env,
  CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210",
  CONVEX_SELF_HOSTED_ADMIN_KEY: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY || "",
};

function requireRuntimeEnvNames() {
  const checks = [
    {
      path: "node_modules/@convex-dev/auth/dist/server/implementation/tokens.js",
      pattern: 'requireEnv("JWT_PRIVATE_KEY")',
    },
    {
      path: "node_modules/@convex-dev/auth/dist/server/implementation/index.js",
      pattern: 'requireEnv("JWKS")',
    },
  ];
  for (const check of checks) {
    const file = join(repoRoot, check.path);
    if (!existsSync(file)) {
      throw new Error(`Cannot verify @convex-dev/auth runtime env names; missing ${check.path}. Run npm install first.`);
    }
    const body = readFileSync(file, "utf8");
    if (!body.includes(check.pattern)) {
      throw new Error(`@convex-dev/auth env name drift: ${check.path} no longer contains ${check.pattern}`);
    }
  }
}

function convex(args: string[], input?: string) {
  const result = spawnSync("npx", ["convex", ...args], {
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
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)(?:\s|=|$)/);
    if (match) names.add(match[1]);
  }
  return names;
}

function generateAuthKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  return {
    JWT_PRIVATE_KEY: privatePem.trimEnd().replace(/\n/g, " "),
    JWKS: JSON.stringify({ keys: [{ use: "sig", alg: "RS256", ...publicJwk }] }),
  };
}

function setEnv(name: string, value: string) {
  convex(["env", "set", name, value]);
}

function main() {
  requireRuntimeEnvNames();
  const existing = parseEnvNames(convex(["env", "list"]));
  const hasAuthKeys = existing.has("JWT_PRIVATE_KEY") && existing.has("JWKS");
  const writes: string[] = [];

  if (!hasAuthKeys || rotate) {
    const generated = generateAuthKeys();
    setEnv("JWT_PRIVATE_KEY", generated.JWT_PRIVATE_KEY);
    setEnv("JWKS", generated.JWKS);
    writes.push("JWT_PRIVATE_KEY", "JWKS");
  }

  if (!existing.has("CONVEX_SITE_URL") || rotate) {
    setEnv("CONVEX_SITE_URL", process.env.CRYSTAL_CONVEX_SITE_URL || "http://127.0.0.1:3211");
    writes.push("CONVEX_SITE_URL");
  }

  if (writes.length === 0) {
    console.log("Convex Auth keys already provisioned; no writes.");
  } else {
    console.log(`Provisioned deployment env: ${writes.join(", ")}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
