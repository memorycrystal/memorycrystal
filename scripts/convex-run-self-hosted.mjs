#!/usr/bin/env node

// Run a Convex function against the self-hosted deployment (ILL-135).
//
// Mirrors scripts/convex-deploy-self-hosted.mjs: it resolves
// CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY the same way (explicit
// env, else Railway service variables) and shells out with that environment.
// Without this, invoking an internal function against prod means hand-assembling
// admin credentials on the command line.
//
// Usage:
//   npm run convex:run -- <functionPath> ['<jsonArgs>'] [--allow-local]
//
// Output policy (fail-closed):
//   - credential-returning functions: refused before any child runs
//   - safe-observable allowlist (AC-7/8 count crons only): run via the
//     admin helper's fd-3 channel, schema-validate, project count fields, print
//     canonical JSON — never replay raw child stdout/stderr/logs
//   - all other unclassified functions: may execute for operational
//     compatibility, but successful and failed child output is fully suppressed
//   - the ILL-181 backlog gate crystal/backlogDrain:getBacklogDepths is
//     unclassified (not allowlisted), so the wrapper suppresses its payload.
//     Run it via `npm run convex:self-hosted -- run
//     crystal/backlogDrain:getBacklogDepths '{}'` to see the gate output. It is
//     NOT in SAFE_OBSERVABLE_OUTPUT_SCHEMAS because projectSafeObservableOutput
//     requires an exact key-count match of integer-only fields and the gate
//     payload carries booleans/arrays/strings (gatePassed, exact, capped,
//     users, residualRisk) that the completion report needs — allowlisting it
//     would fail schema validation on every run.
//
// Use rotate-mcp-api-key.mjs for the one-time raw-key rotation flow.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveSelfHostedConvexEnv } from "./lib/convex-self-hosted-env.mjs";
import {
  classifyConvexFunctionOutput,
  projectSafeObservableOutput,
} from "./lib/convex-function-output-policy.mjs";
import { resolveConvexRunFunctionName } from "./lib/convex-run-function-name.mjs";
import { parseSafeObservableArgs } from "./lib/convex-run-safe-observable-args.mjs";

const DEFAULT_ADMIN_RUN_HELPER = fileURLToPath(
  new URL("./lib/convex-admin-run-helper.mjs", import.meta.url),
);

const args = process.argv.slice(2);
const allowLocalIndex = args.indexOf("--allow-local");
const allowLocal = allowLocalIndex >= 0;
if (allowLocal) args.splice(allowLocalIndex, 1);

let functionName;
try {
  functionName = resolveConvexRunFunctionName(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const classification = classifyConvexFunctionOutput(functionName);
if (classification === "credential") {
  console.error(
    "Refusing a credential-returning function through the inherited-stdio wrapper. Use scripts/rotate-mcp-api-key.mjs.",
  );
  process.exit(2);
}

// Validate safe-observable grammar before resolving deployment credentials so
// bad argv never triggers Railway/env lookup or helper execution.
let safeObservableArgs = null;
if (classification === "safe-observable") {
  try {
    safeObservableArgs = parseSafeObservableArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

let target;
try {
  target = resolveSelfHostedConvexEnv({ allowLocal });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (classification === "safe-observable") {
  const functionArgs = safeObservableArgs ?? {};

  const adminRunHelper =
    process.env.MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER || DEFAULT_ADMIN_RUN_HELPER;

  const result = spawnSync(process.execPath, [adminRunHelper, functionName], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: target.env,
    input: JSON.stringify(functionArgs),
    // fd 0 stdin, fd 1/2 captured (never replayed), fd 3 parent response pipe
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    console.error(
      `Convex function failed (exit status ${Number.isInteger(result.status) ? result.status : "unknown"}); privileged child output was suppressed.`,
    );
    process.exit(result.status ?? 1);
  }

  const responseChannel =
    Array.isArray(result.output) && typeof result.output[3] === "string"
      ? result.output[3]
      : "";

  let parsed;
  try {
    parsed = JSON.parse(responseChannel.trim());
  } catch {
    console.error(
      `Safe-observable result for ${functionName} failed schema validation; privileged child output was suppressed.`,
    );
    process.exit(1);
  }

  try {
    const projected = projectSafeObservableOutput(functionName, parsed);
    // Canonical JSON only — never replay raw fd-3 content or child logs.
    process.stdout.write(`${JSON.stringify(projected)}\n`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Unclassified: execute via `npx convex run` with fully suppressed I/O.
const result = spawnSync("npx", ["convex", "run", ...args], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: target.env,
  // Default-deny output: an unclassified function may execute for operational
  // compatibility, but privileged child output is never inherited or replayed.
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status !== 0) {
  console.error(
    `Convex function failed (exit status ${Number.isInteger(result.status) ? result.status : "unknown"}); privileged child output was suppressed.`,
  );
}
process.exit(result.status ?? 1);
