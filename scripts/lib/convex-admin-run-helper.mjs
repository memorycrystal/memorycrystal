#!/usr/bin/env node

// Privileged admin runner for internal Convex functions.
//
// Secrets and invocation arguments travel only via:
//   - environment (CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY)
//   - stdin JSON body (function args)
//
// Successful results travel only via a parent-owned anonymous pipe on fd 3.
// stdout is always empty. stderr carries only generic, non-secret errors.
//
// argv is intentionally secret-free: only the function name is accepted as a
// positional argument. Never put rotation nonces, raw keys, or admin keys in
// process arguments.

import { fstatSync, readFileSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const RESPONSE_FD = 3;
const FUNCTION_NAME =
  /^(?:[A-Za-z_][\w.-]*\/)*[A-Za-z_][\w.-]*:[A-Za-z_][\w]*$/;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function fail(message, exitCode = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

/**
 * Require a parent-authenticated IPC channel on fd 3 before any network I/O.
 * Accept only anonymous pipes/sockets. Reject TTYs, regular files, and any
 * non-writable inherited descriptor so direct execution cannot spill results
 * to a terminal, log, or file.
 */
function assertParentResponseChannel() {
  let stats;
  try {
    stats = fstatSync(RESPONSE_FD);
  } catch {
    fail(
      "Refusing to run: parent response channel (fd 3) is required and must be a pipe or socket.",
    );
  }

  if (isatty(RESPONSE_FD) || stats.isCharacterDevice()) {
    fail(
      "Refusing to run: parent response channel (fd 3) must not be a terminal.",
    );
  }
  if (stats.isFile() || stats.isDirectory() || stats.isBlockDevice()) {
    fail(
      "Refusing to run: parent response channel (fd 3) must be a pipe or socket, not a file.",
    );
  }
  if (!stats.isFIFO() && !stats.isSocket()) {
    fail(
      "Refusing to run: parent response channel (fd 3) must be a pipe or socket.",
    );
  }

  // Prove the descriptor is a live, parent-owned writer. Ghost/inherited FIFOs
  // often still fstat as FIFO but fail writes with ENXIO.
  try {
    writeSync(RESPONSE_FD, Buffer.alloc(0));
  } catch {
    fail(
      "Refusing to run: parent response channel (fd 3) is not a writable parent pipe.",
    );
  }
}

function writeResponse(payload) {
  try {
    writeSync(RESPONSE_FD, `${JSON.stringify(payload ?? null)}\n`);
  } catch {
    fail(
      "Refusing to emit result: parent response channel (fd 3) write failed.",
      1,
    );
  }
}

// Validate the parent IPC channel before parsing secrets from the environment
// or contacting Convex. Direct invocation without a parent pipe fails closed.
assertParentResponseChannel();

const functionName = process.argv[2];
if (typeof functionName !== "string" || !FUNCTION_NAME.test(functionName)) {
  fail(
    "usage: convex-admin-run-helper.mjs <functionPath>  # JSON args on stdin; result on fd 3",
  );
}

// Reject any extra argv tokens so callers cannot smuggle secrets onto argv.
if (process.argv.length > 3) {
  fail("Refusing extra argv tokens; supply function arguments only on stdin.");
}

const url = process.env.CONVEX_SELF_HOSTED_URL?.trim();
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim();
if (!url || !adminKey) {
  fail(
    "Refusing to run: CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are required.",
  );
}

let args;
try {
  const raw = readStdin().trim();
  args = raw === "" ? {} : JSON.parse(raw);
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("args must be a JSON object");
  }
} catch {
  fail("Refusing invalid JSON arguments on stdin.");
}

const client = new ConvexHttpClient(url, {
  skipConvexDeploymentUrlCheck: true,
  logger: false,
});
client.setAdminAuth(adminKey);

try {
  const result = await client.function(
    makeFunctionReference(functionName),
    undefined,
    args,
  );
  writeResponse(result);
} catch {
  // Never replay remote/client payloads that may embed credentials.
  fail(
    `Convex admin run failed for ${functionName}; privileged child output was suppressed.`,
    1,
  );
}
