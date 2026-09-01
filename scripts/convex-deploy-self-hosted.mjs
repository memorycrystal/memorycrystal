#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolveSelfHostedConvexEnv } from "./lib/convex-self-hosted-env.mjs";

const args = process.argv.slice(2);
const allowLocalIndex = args.indexOf("--allow-local");
const allowLocal = allowLocalIndex >= 0;
if (allowLocal) args.splice(allowLocalIndex, 1);

let target;
try {
  target = resolveSelfHostedConvexEnv({ allowLocal });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const result = spawnSync("npx", ["convex", "deploy", ...args], {
  cwd: process.cwd(),
  env: target.env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
