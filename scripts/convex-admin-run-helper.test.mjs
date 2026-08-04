import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HELPER_PATH = fileURLToPath(
  new URL("./lib/convex-admin-run-helper.mjs", import.meta.url),
);

const SYNTHETIC_RAW_KEY = `mc_live_${"k".repeat(48)}`;
const SYNTHETIC_NONCE = `nonce_${"n".repeat(64)}`;
const SYNTHETIC_ADMIN = `admin-key-${"a".repeat(32)}`;
const FUNCTION_NAME =
  "crystal/apiKeys:prepareApiKeyRotationForUserInternal";

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), "memorycrystal-admin-helper-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function baseEnv(overrides = {}) {
  return {
    ...process.env,
    CONVEX_SELF_HOSTED_ADMIN_KEY: SYNTHETIC_ADMIN,
    CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:9",
    CONVEX_DEPLOYMENT: "",
    CONVEX_DEPLOY_KEY: "",
    ...overrides,
  };
}

/**
 * Standalone synthetic Convex HTTP server in a child process so spawnSync in
 * the parent does not freeze the accept loop.
 */
function startSyntheticConvexServer(t, { body, errorBody } = {}) {
  const directory = tempDir(t);
  const readyPath = join(directory, "ready.json");
  const hitPath = join(directory, "hits.count");
  writeFileSync(hitPath, "0");
  const payload = errorBody
    ? errorBody
    : (body ?? {
        status: "success",
        value: {
          keyId: "key-1",
          rawKey: SYNTHETIC_RAW_KEY,
          rotationId: "rot-1",
          rotationNonce: SYNTHETIC_NONCE,
        },
      });
  const serverScript = join(directory, "synthetic-convex-server.mjs");
  writeFileSync(
    serverScript,
    `import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
const payload = ${JSON.stringify(payload)};
const hitPath = ${JSON.stringify(hitPath)};
const readyPath = ${JSON.stringify(readyPath)};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const n = Number(readFileSync(hitPath, "utf8") || "0") + 1;
    writeFileSync(hitPath, String(n));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(readyPath, JSON.stringify({ port }));
});
`,
  );

  const child = spawn(process.execPath, [serverScript], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
  });

  const deadline = Date.now() + 5000;
  let port;
  while (Date.now() < deadline) {
    if (existsSync(readyPath)) {
      port = JSON.parse(readFileSync(readyPath, "utf8")).port;
      break;
    }
    spawnSync(process.execPath, ["-e", ""], { timeout: 20 });
  }
  if (!port) {
    throw new Error("synthetic Convex server failed to become ready");
  }

  return {
    url: `http://127.0.0.1:${port}`,
    hitCount: () => Number(readFileSync(hitPath, "utf8") || "0"),
    hitPath,
  };
}

function runHelper({
  env,
  functionName = FUNCTION_NAME,
  stdin = "{}",
  stdio,
  extraArgv = [],
  timeout = 8000,
}) {
  return spawnSync(
    process.execPath,
    [HELPER_PATH, functionName, ...extraArgv],
    {
      encoding: "utf8",
      env,
      input: stdin,
      stdio,
      timeout,
    },
  );
}

test("direct helper without fd 3 never calls the network and prints no credentials", (t) => {
  const server = startSyntheticConvexServer(t);

  // Only standard stdio — no parent response pipe on fd 3.
  const result = runHelper({
    env: baseEnv({ CONVEX_SELF_HOSTED_URL: server.url }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /parent response channel \(fd 3\)/);
  assert.equal(result.stdout, "");
  assert.equal(server.hitCount(), 0);
  const combined = `${result.stdout}${result.stderr}`;
  assert.equal(combined.includes(SYNTHETIC_RAW_KEY), false);
  assert.equal(combined.includes(SYNTHETIC_NONCE), false);
  assert.equal(combined.includes(SYNTHETIC_ADMIN), false);
});

test("fd 3 redirected to a regular file is rejected before any network call", (t) => {
  const directory = tempDir(t);
  const outPath = join(directory, "response.out");
  const fd = openSync(outPath, "w");
  t.after(() => {
    try {
      closeSync(fd);
    } catch {
      // closed
    }
  });

  const server = startSyntheticConvexServer(t);
  const result = runHelper({
    env: baseEnv({ CONVEX_SELF_HOSTED_URL: server.url }),
    stdio: ["pipe", "pipe", "pipe", fd],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a pipe or socket|not a file/);
  assert.equal(result.stdout, "");
  assert.equal(server.hitCount(), 0);
  assert.equal(readFileSync(outPath, "utf8"), "");
  const combined = `${result.stdout}${result.stderr}`;
  assert.equal(combined.includes(SYNTHETIC_RAW_KEY), false);
  assert.equal(combined.includes(SYNTHETIC_NONCE), false);
});

test("parent anonymous pipe receives response only on fd 3; stdout/stderr stay secret-free", (t) => {
  const server = startSyntheticConvexServer(t);

  const result = runHelper({
    env: baseEnv({ CONVEX_SELF_HOSTED_URL: server.url }),
    stdin: JSON.stringify({ userId: "user-1", label: "local-dev" }),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(server.hitCount() > 0, true);

  const channel = result.output?.[3] ?? "";
  assert.match(channel, new RegExp(SYNTHETIC_RAW_KEY));
  assert.match(channel, new RegExp(SYNTHETIC_NONCE));

  const combined = `${result.stdout}${result.stderr}`;
  assert.equal(combined.includes(SYNTHETIC_RAW_KEY), false);
  assert.equal(combined.includes(SYNTHETIC_NONCE), false);
  assert.equal(combined.includes(SYNTHETIC_ADMIN), false);
  assert.equal(result.stderr.includes(SYNTHETIC_RAW_KEY), false);
});

test("argv still contains only helper path + function name", (t) => {
  const server = startSyntheticConvexServer(t);
  const result = runHelper({
    env: baseEnv({ CONVEX_SELF_HOSTED_URL: server.url }),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  // Contract used by runConvexJson: spawn(execPath, [helper, functionName]).
  // Secrets never appear as argv tokens — only the function path is positional.
  const argv = [HELPER_PATH, FUNCTION_NAME];
  assert.equal(argv.length, 2);
  assert.equal(JSON.stringify(argv).includes(SYNTHETIC_ADMIN), false);
  assert.equal(JSON.stringify(argv).includes(SYNTHETIC_RAW_KEY), false);
  assert.equal(JSON.stringify(argv).includes(SYNTHETIC_NONCE), false);
  assert.equal(result.stdout, "");
});

test("extra argv tokens are refused before network", (t) => {
  const server = startSyntheticConvexServer(t);
  const result = runHelper({
    env: baseEnv({ CONVEX_SELF_HOSTED_URL: server.url }),
    extraArgv: [JSON.stringify({ rawKey: SYNTHETIC_RAW_KEY })],
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /extra argv tokens/);
  assert.equal(server.hitCount(), 0);
  assert.equal(
    `${result.stdout}${result.stderr}`.includes(SYNTHETIC_RAW_KEY),
    false,
  );
});

test("failed Convex responses stay suppressed on stdout/stderr and fd 3", (t) => {
  // Return a body that makes the client throw while embedding secrets.
  const server = startSyntheticConvexServer(t, {
    errorBody: {
      status: "error",
      errorMessage: `boom rawKey=${SYNTHETIC_RAW_KEY} nonce=${SYNTHETIC_NONCE}`,
      errorData: { rawKey: SYNTHETIC_RAW_KEY },
    },
  });
  const result = runHelper({
    env: baseEnv({ CONVEX_SELF_HOSTED_URL: server.url }),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  const combined = `${result.stdout}${result.stderr}`;
  assert.equal(combined.includes(SYNTHETIC_RAW_KEY), false);
  assert.equal(combined.includes(SYNTHETIC_NONCE), false);
  assert.match(combined, /suppressed|failed|Refusing/);
  const channel = result.output?.[3] ?? "";
  assert.equal(channel.includes(SYNTHETIC_RAW_KEY), false);
  assert.equal(channel.includes(SYNTHETIC_NONCE), false);
});

test("runConvexJson parent parses only fd 3 and ignores polluted stdout", async () => {
  const { runConvexJson } = await import("./rotate-mcp-api-key.mjs");
  const rawKey = `parent-parse-${"p".repeat(40)}`;
  const fakeSpawn = (_execPath, argv, options) => {
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe", "pipe"]);
    assert.equal(argv.length, 2);
    assert.equal(argv[1], FUNCTION_NAME);
    return {
      status: 0,
      stdout: `LEAK:${rawKey}`,
      stderr: `LEAK:${rawKey}`,
      output: [
        null,
        `LEAK:${rawKey}`,
        `LEAK:${rawKey}`,
        JSON.stringify({ keyId: "k1", rawKey, rotationNonce: SYNTHETIC_NONCE }),
      ],
    };
  };

  const result = runConvexJson({
    args: { userId: "u1", label: "local-dev" },
    env: baseEnv(),
    functionName: FUNCTION_NAME,
    operation: "preparation",
    adminRunHelper: HELPER_PATH,
    spawn: fakeSpawn,
  });

  assert.deepEqual(result, {
    keyId: "k1",
    rawKey,
    rotationNonce: SYNTHETIC_NONCE,
  });
});

test("malformed fd-3 payload is not replayed by runConvexJson", async () => {
  const { runConvexJson } = await import("./rotate-mcp-api-key.mjs");
  let threw = false;
  try {
    runConvexJson({
      args: {},
      env: baseEnv(),
      functionName: FUNCTION_NAME,
      operation: "preparation",
      adminRunHelper: HELPER_PATH,
      spawn: () => ({
        status: 0,
        stdout: SYNTHETIC_RAW_KEY,
        stderr: SYNTHETIC_NONCE,
        output: [null, SYNTHETIC_RAW_KEY, SYNTHETIC_NONCE, SYNTHETIC_RAW_KEY + "{"],
      }),
    });
  } catch (error) {
    threw = true;
    assert.match(String(error.message), /invalid JSON|suppressed/);
    assert.equal(String(error.message).includes(SYNTHETIC_RAW_KEY), false);
    assert.equal(String(error.message).includes(SYNTHETIC_NONCE), false);
  }
  assert.equal(threw, true);
});
