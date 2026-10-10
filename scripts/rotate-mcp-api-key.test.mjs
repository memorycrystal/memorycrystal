import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertNoEnvFileOptions,
  rewriteEnvContent,
  rotateTargets,
} from "./rotate-mcp-api-key.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./rotate-mcp-api-key.mjs", import.meta.url),
);
const OLD_KEY = `old-${"a".repeat(64)}`;
const NEW_KEY = `new-${"b".repeat(64)}`;
const USER_ID = "user-rotation-fixture";
const LABEL = "local-dev";
const ROTATION_ID = "prepared-rotation-id";
const ROTATION_NONCE = `nonce-${"c".repeat(64)}`;

function makeTempDir(t) {
  const directory = nodeFs.mkdtempSync(join(tmpdir(), "memorycrystal-rotation-"));
  t.after(() => nodeFs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function writeTarget(directory, name, key = OLD_KEY, prefix = "UNCHANGED=value\n") {
  const targetPath = join(directory, name);
  nodeFs.writeFileSync(
    targetPath,
    `${prefix}MEMORY_CRYSTAL_API_KEY=${key}\nTAIL=preserved\n`,
    { mode: 0o644 },
  );
  return targetPath;
}

function readTargetKey(targetPath) {
  return nodeFs
    .readFileSync(targetPath, "utf8")
    .match(/^MEMORY_CRYSTAL_API_KEY=(.*)$/m)?.[1];
}

function ownedStageFiles(directory) {
  return nodeFs
    .readdirSync(directory)
    .filter((entry) => entry.includes(".rotation-"));
}

function fakeServer({ finalizeError } = {}) {
  const activeKeys = new Set([OLD_KEY]);
  const calls = { finalize: [], prepare: [] };
  return {
    activeKeys,
    calls,
    prepare(args) {
      calls.prepare.push(args);
      activeKeys.add(NEW_KEY);
      return {
        keyId: "prepared-key-id",
        rawKey: NEW_KEY,
        rotationId: ROTATION_ID,
        rotationNonce: ROTATION_NONCE,
      };
    },
    finalize(args) {
      calls.finalize.push(args);
      if (finalizeError) throw finalizeError;
      activeKeys.delete(OLD_KEY);
      return { deactivated: 1 };
    },
  };
}

function executeFixture(targetPaths, server, overrides = {}) {
  return rotateTargets({
    finalize: server.finalize,
    label: LABEL,
    prepare: server.prepare,
    targetPaths,
    userId: USER_ID,
    ...overrides,
  });
}

test("environment rewriting preserves unrelated content and accepted assignment forms", () => {
  const original =
    "FIRST=one\n  export MEMORY_CRYSTAL_API_KEY=stale-one\n\n" +
    "\tMEMORY_CRYSTAL_API_KEY=stale-two\nLAST=two";
  const rewritten = rewriteEnvContent(original, NEW_KEY);
  assert.equal(
    rewritten,
    `FIRST=one\nMEMORY_CRYSTAL_API_KEY=${NEW_KEY}\n\nLAST=two`,
  );
  assert.equal(
    (rewritten.match(/^MEMORY_CRYSTAL_API_KEY=/gm) ?? []).length,
    1,
  );

  assert.equal(
    rewriteEnvContent("NO_FINAL_NEWLINE=true", NEW_KEY),
    `NO_FINAL_NEWLINE=true\nMEMORY_CRYSTAL_API_KEY=${NEW_KEY}\n`,
  );
});

test("rejects every env-file token shape on execArgv and script argv", () => {
  for (const token of [
    "--env-file",
    "--env-file=/tmp/seed.env",
    "--env-file-if-exists",
    "--env-file-if-exists=/tmp/seed.env",
  ]) {
    assert.throws(
      () => assertNoEnvFileOptions({ execArgv: [token], scriptArgv: [] }),
      /must never seed deployment credentials/,
    );
    assert.throws(
      () => assertNoEnvFileOptions({ execArgv: [], scriptArgv: [token] }),
      /must never seed deployment credentials/,
    );
  }
});

test("preflight failures at every target position make no server call or file change", async (t) => {
  for (let failureIndex = 0; failureIndex < 3; failureIndex += 1) {
    await t.test(`target ${failureIndex + 1}`, () => {
      const directory = makeTempDir(t);
      const backingPaths = [0, 1, 2].map((index) =>
        writeTarget(directory, `backing-${failureIndex}-${index}.env`),
      );
      const targetPaths = [...backingPaths];
      const symlinkPath = join(directory, `target-${failureIndex}.env`);
      nodeFs.symlinkSync(backingPaths[failureIndex], symlinkPath);
      targetPaths[failureIndex] = symlinkPath;
      const server = fakeServer();

      assert.throws(
        () => executeFixture(targetPaths, server),
        new RegExp(`preflight failed for target ${failureIndex + 1}`),
      );
      assert.equal(server.calls.prepare.length, 0);
      assert.equal(server.calls.finalize.length, 0);
      for (const path of backingPaths) assert.equal(readTargetKey(path), OLD_KEY);
      assert.deepEqual(ownedStageFiles(directory), []);
    });
  }
});

test("staging failures at every target position leave all targets on the active old key", async (t) => {
  for (let failureIndex = 0; failureIndex < 3; failureIndex += 1) {
    await t.test(`target ${failureIndex + 1}`, () => {
      const directory = makeTempDir(t);
      const targetPaths = [0, 1, 2].map((index) =>
        writeTarget(directory, `staging-${failureIndex}-${index}.env`),
      );
      const server = fakeServer();
      let stageOpenIndex = 0;
      const injectedFs = {
        ...nodeFs,
        openSync(path, flags, mode) {
          if (basename(path).includes(".rotation-")) {
            if (stageOpenIndex === failureIndex) {
              const error = new Error("injected stage failure");
              error.code = "EACCES";
              throw error;
            }
            stageOpenIndex += 1;
          }
          return nodeFs.openSync(path, flags, mode);
        },
      };

      assert.throws(
        () => executeFixture(targetPaths, server, { fs: injectedFs }),
        /staging failed/,
      );
      assert.equal(server.calls.prepare.length, 1);
      assert.equal(server.calls.finalize.length, 0);
      for (const path of targetPaths) assert.equal(readTargetKey(path), OLD_KEY);
      assert.equal(server.activeKeys.has(OLD_KEY), true);
      assert.deepEqual(ownedStageFiles(directory), []);
    });
  }
});

test("a failed retained-stage descriptor close blocks finalization and safely retries owned cleanup", (t) => {
  const directory = makeTempDir(t);
  const targetPath = writeTarget(directory, "close-failure.env");
  const server = fakeServer();
  let stageFd;
  const injectedFs = {
    ...nodeFs,
    openSync(path, flags, mode) {
      const fd = nodeFs.openSync(path, flags, mode);
      if (basename(path) === "stage") stageFd = fd;
      return fd;
    },
    closeSync(fd) {
      if (fd === stageFd) {
        stageFd = undefined;
        throw new Error("injected close failure");
      }
      return nodeFs.closeSync(fd);
    },
  };

  assert.throws(
    () => executeFixture([targetPath], server, { fs: injectedFs }),
    /replacement failed/,
  );
  assert.equal(server.activeKeys.has(readTargetKey(targetPath)), true);
  assert.equal(server.calls.finalize.length, 0);
  assert.deepEqual(ownedStageFiles(directory), []);
});

test("replacement failures at every target position leave every file on an active credential", async (t) => {
  for (let failureIndex = 0; failureIndex < 3; failureIndex += 1) {
    await t.test(`target ${failureIndex + 1}`, () => {
      const directory = makeTempDir(t);
      const targetPaths = [0, 1, 2].map((index) =>
        writeTarget(directory, `replace-${failureIndex}-${index}.env`),
      );
      const server = fakeServer();
      let renameIndex = 0;
      const injectedFs = {
        ...nodeFs,
        renameSync(from, to) {
          if (renameIndex === failureIndex) {
            throw new Error("injected replacement failure");
          }
          renameIndex += 1;
          return nodeFs.renameSync(from, to);
        },
      };

      assert.throws(
        () => executeFixture(targetPaths, server, { fs: injectedFs }),
        /replacement failed/,
      );
      assert.equal(server.calls.finalize.length, 0);
      for (const path of targetPaths) {
        const key = readTargetKey(path);
        assert.equal(server.activeKeys.has(key), true);
      }
      assert.equal(server.activeKeys.has(OLD_KEY), true);
      assert.equal(server.activeKeys.has(NEW_KEY), true);
      assert.deepEqual(ownedStageFiles(directory), []);
    });
  }
});

test("replacement durability failure keeps old and prepared credentials active", (t) => {
  const directory = makeTempDir(t);
  const targetPaths = [
    writeTarget(directory, "durability-a.env"),
    writeTarget(directory, "durability-b.env"),
  ];
  const server = fakeServer();
  let fsyncCalls = 0;
  const injectedFs = {
    ...nodeFs,
    fsyncSync(fd) {
      fsyncCalls += 1;
      if (fsyncCalls === targetPaths.length + 1) {
        throw new Error("injected directory fsync failure");
      }
      return nodeFs.fsyncSync(fd);
    },
  };

  assert.throws(
    () => executeFixture(targetPaths, server, { fs: injectedFs }),
    /replacement durability failed/,
  );
  assert.equal(server.calls.finalize.length, 0);
  assert.equal(server.activeKeys.has(OLD_KEY), true);
  assert.equal(server.activeKeys.has(NEW_KEY), true);
  for (const path of targetPaths) assert.equal(readTargetKey(path), NEW_KEY);
  assert.deepEqual(ownedStageFiles(directory), []);
});

test("finalization failure leaves every target on the still-active prepared key", () => {
  const t = { after: () => {} };
  const directory = nodeFs.mkdtempSync(join(tmpdir(), "memorycrystal-finalize-"));
  try {
    const targetPaths = [0, 1, 2].map((index) =>
      writeTarget(directory, `finalize-${index}.env`),
    );
    const server = fakeServer({ finalizeError: new Error("injected finalize failure") });

    assert.throws(() => executeFixture(targetPaths, server), /injected finalize failure/);
    for (const path of targetPaths) {
      assert.equal(readTargetKey(path), NEW_KEY);
      assert.equal(server.activeKeys.has(readTargetKey(path)), true);
    }
    assert.equal(server.activeKeys.has(OLD_KEY), true);
    assert.deepEqual(ownedStageFiles(directory), []);
  } finally {
    nodeFs.rmSync(directory, { force: true, recursive: true });
  }
});

test("successful multi-target rotation stages securely, writes mode 0600, then finalizes", (t) => {
  const directory = makeTempDir(t);
  const targetPaths = [0, 1, 2].map((index) =>
    writeTarget(directory, `success-${index}.env`),
  );
  const server = fakeServer();
  const opens = [];
  const transactions = [];
  const injectedFs = {
    ...nodeFs,
    mkdirSync(path, options) {
      transactions.push({ options, path });
      return nodeFs.mkdirSync(path, options);
    },
    openSync(path, flags, mode) {
      opens.push({ flags, mode, path });
      return nodeFs.openSync(path, flags, mode);
    },
  };

  const result = executeFixture(targetPaths, server, { fs: injectedFs });

  assert.equal(result.deactivated, 1);
  assert.equal(server.calls.prepare.length, 1);
  assert.deepEqual(server.calls.finalize, [
    {
      keyId: "prepared-key-id",
      label: LABEL,
      rotationId: ROTATION_ID,
      rotationNonce: ROTATION_NONCE,
      userId: USER_ID,
    },
  ]);
  assert.equal(server.activeKeys.has(OLD_KEY), false);
  assert.equal(server.activeKeys.has(NEW_KEY), true);
  const stageOpens = opens.filter(({ path }) => basename(path) === "stage");
  assert.equal(stageOpens.length, targetPaths.length);
  assert.equal(transactions.length, targetPaths.length);
  for (let index = 0; index < targetPaths.length; index += 1) {
    const targetPath = targetPaths[index];
    assert.equal(readTargetKey(targetPath), NEW_KEY);
    assert.match(nodeFs.readFileSync(targetPath, "utf8"), /UNCHANGED=value/);
    assert.equal(nodeFs.statSync(targetPath).mode & 0o777, 0o600);
    assert.equal(
      dirname(stageOpens[index].path),
      transactions[index].path,
    );
    assert.equal(dirname(transactions[index].path), dirname(nodeFs.realpathSync(targetPath)));
    assert.equal(transactions[index].options.mode, 0o700);
    assert.equal((stageOpens[index].flags & constants.O_CREAT) !== 0, true);
    assert.equal((stageOpens[index].flags & constants.O_EXCL) !== 0, true);
    if (constants.O_NOFOLLOW !== undefined) {
      assert.equal(
        (stageOpens[index].flags & constants.O_NOFOLLOW) !== 0,
        true,
      );
    }
    assert.equal(stageOpens[index].mode, 0o600);
  }
  assert.deepEqual(ownedStageFiles(directory), []);
});

test("precreated symlink collision cannot capture the key and is never reused", (t) => {
  const directory = makeTempDir(t);
  const targetPath = writeTarget(directory, "collision.env");
  const capturePath = join(directory, "capture.txt");
  nodeFs.writeFileSync(capturePath, "capture-unchanged\n", { mode: 0o600 });
  const collisionHex = "11".repeat(16);
  const safeHex = "22".repeat(16);
  const collisionPath = join(
    directory,
    `.${basename(targetPath)}.rotation-${collisionHex}`,
  );
  nodeFs.symlinkSync(capturePath, collisionPath);
  const randomValues = [collisionHex, safeHex];
  const server = fakeServer();

  executeFixture([targetPath], server, {
    randomBytesFn() {
      return Buffer.from(randomValues.shift() ?? safeHex, "hex");
    },
  });

  assert.equal(nodeFs.readFileSync(capturePath, "utf8"), "capture-unchanged\n");
  assert.equal(readTargetKey(targetPath), NEW_KEY);
  assert.equal(nodeFs.lstatSync(collisionPath).isSymbolicLink(), true);
  assert.deepEqual(ownedStageFiles(directory), [basename(collisionPath)]);
});

test("exhausted exclusive collisions fail without changing the target or creating residue", (t) => {
  const directory = makeTempDir(t);
  const targetPath = writeTarget(directory, "collision-failure.env");
  const capturePath = join(directory, "capture-failure.txt");
  nodeFs.writeFileSync(capturePath, "capture-unchanged\n", { mode: 0o600 });
  const collisionHex = "33".repeat(16);
  const collisionPath = join(
    directory,
    `.${basename(targetPath)}.rotation-${collisionHex}`,
  );
  nodeFs.symlinkSync(capturePath, collisionPath);
  const server = fakeServer();

  assert.throws(
    () =>
      executeFixture([targetPath], server, {
        randomBytesFn: () => Buffer.from(collisionHex, "hex"),
      }),
    /staging failed/,
  );
  assert.equal(readTargetKey(targetPath), OLD_KEY);
  assert.equal(nodeFs.readFileSync(capturePath, "utf8"), "capture-unchanged\n");
  assert.deepEqual(ownedStageFiles(directory), [basename(collisionPath)]);
});

function walkEntries(directory) {
  const entries = [];
  for (const name of nodeFs.readdirSync(directory)) {
    const path = join(directory, name);
    const stat = nodeFs.lstatSync(path);
    entries.push({ path, stat });
    if (stat.isDirectory()) entries.push(...walkEntries(path));
  }
  return entries;
}

function installForeignObject(path, kind, directory, marker) {
  const content = `FOREIGN_${marker}\nMEMORY_CRYSTAL_API_KEY=${OLD_KEY}\n`;
  if (kind === "regular") {
    nodeFs.writeFileSync(path, content, { mode: 0o600 });
    return;
  }
  const backingPath = join(directory, `foreign-backing-${marker}.env`);
  nodeFs.writeFileSync(backingPath, content, { mode: 0o600 });
  nodeFs.symlinkSync(backingPath, path);
}

function assertForeignObjectSurvives(directory, kind, marker) {
  const entries = walkEntries(directory);
  if (kind === "regular") {
    assert.equal(
      entries.some(({ path, stat }) =>
        stat.isFile() && nodeFs.readFileSync(path, "utf8").includes(`FOREIGN_${marker}`),
      ),
      true,
    );
  } else {
    assert.equal(entries.some(({ stat }) => stat.isSymbolicLink()), true);
  }
}

function swapInstalledTarget({ directory, kind, marker, targetPath }) {
  const capturedPreparedPath = join(directory, `prepared-captured-${marker}.env`);
  nodeFs.renameSync(targetPath, capturedPreparedPath);
  installForeignObject(targetPath, kind, directory, marker);
  return capturedPreparedPath;
}

const targetSwapMoments = [
  "post-rename-validation",
  "former-chmod-window",
  "during-descriptor-close",
  "after-descriptor-close",
  "last-pre-finalization-check",
];

for (const kind of ["regular", "symlink"]) {
  for (const moment of targetSwapMoments) {
    test(`${kind} target swap at ${moment} restores an active target and blocks finalization`, (t) => {
      const directory = makeTempDir(t);
      const targetPath = writeTarget(directory, `${kind}-${moment}.env`);
      const installedTargetPath = nodeFs.realpathSync(targetPath);
      const targetDirectory = dirname(installedTargetPath);
      const server = fakeServer();
      const marker = `${kind}-${moment}`;
      let installed = false;
      let stageFd;
      let directoryFd;
      let stageClosed = false;
      let transactionRemoved = false;
      let capturedPreparedPath;

      const swap = () => {
        if (capturedPreparedPath) return;
        capturedPreparedPath = swapInstalledTarget({
          directory,
          kind,
          marker,
          targetPath: installedTargetPath,
        });
      };

      const injectedFs = {
        ...nodeFs,
        renameSync(from, to) {
          const result = nodeFs.renameSync(from, to);
          if (to === installedTargetPath && basename(from) === "stage") installed = true;
          return result;
        },
        openSync(path, flags, mode) {
          const fd = nodeFs.openSync(path, flags, mode);
          if (basename(path) === "stage") stageFd = fd;
          if (installed && path === targetDirectory) directoryFd = fd;
          return fd;
        },
        fsyncSync(fd) {
          if (moment === "former-chmod-window" && fd === directoryFd) swap();
          return nodeFs.fsyncSync(fd);
        },
        closeSync(fd) {
          if (fd === stageFd) {
            if (moment === "during-descriptor-close") swap();
            const result = nodeFs.closeSync(fd);
            stageClosed = true;
            return result;
          }
          return nodeFs.closeSync(fd);
        },
        lstatSync(path) {
          if (
            path === installedTargetPath &&
            installed &&
            !capturedPreparedPath &&
            moment === "post-rename-validation"
          ) {
            const owned = nodeFs.lstatSync(path);
            swap();
            return owned;
          }
          if (
            path === installedTargetPath &&
            stageClosed &&
            !capturedPreparedPath &&
            moment === "after-descriptor-close"
          ) {
            swap();
          }
          if (
            path === installedTargetPath &&
            transactionRemoved &&
            !capturedPreparedPath &&
            moment === "last-pre-finalization-check"
          ) {
            swap();
          }
          return nodeFs.lstatSync(path);
        },
        rmSync(path, options) {
          const result = nodeFs.rmSync(path, options);
          if (installed && basename(path).includes(".rotation-")) {
            transactionRemoved = true;
          }
          return result;
        },
      };

      assert.throws(
        () => executeFixture([targetPath], server, { fs: injectedFs }),
        /cleanup failed|replacement failed|pre-finalization ownership failed/,
      );
      assert.equal(server.calls.finalize.length, 0);
      assert.equal(readTargetKey(targetPath), OLD_KEY);
      assert.equal(server.activeKeys.has(readTargetKey(targetPath)), true);
      assert.equal(nodeFs.existsSync(capturedPreparedPath), true);
      assert.equal(readTargetKey(capturedPreparedPath), NEW_KEY);
      assertForeignObjectSurvives(directory, kind, marker);
      const quarantines = ownedStageFiles(directory);
      assert.equal(quarantines.length >= 1, true);
      for (const quarantine of quarantines) {
        const path = join(directory, quarantine);
        if (nodeFs.lstatSync(path).isDirectory()) {
          assert.equal(nodeFs.statSync(path).mode & 0o777, 0o700);
        }
      }
    });
  }

  test(`${kind} stage replacement during cleanup is preserved and blocks finalization`, (t) => {
    const directory = makeTempDir(t);
    const targetPaths = [
      writeTarget(directory, `stage-cleanup-${kind}-a.env`),
      writeTarget(directory, `stage-cleanup-${kind}-b.env`),
    ];
    const server = fakeServer();
    let firstStagePath;
    let openedStages = 0;
    const capturedPreparedPath = join(directory, `stage-cleanup-owned-${kind}.env`);
    const marker = `stage-cleanup-${kind}`;
    const injectedFs = {
      ...nodeFs,
      openSync(path, flags, mode) {
        if (basename(path) === "stage") {
          if (openedStages === 0) {
            firstStagePath = path;
            openedStages += 1;
          } else {
            nodeFs.renameSync(firstStagePath, capturedPreparedPath);
            installForeignObject(firstStagePath, kind, directory, marker);
            const error = new Error("injected second-stage failure");
            error.code = "EACCES";
            throw error;
          }
        }
        return nodeFs.openSync(path, flags, mode);
      },
    };

    assert.throws(
      () => executeFixture(targetPaths, server, { fs: injectedFs }),
      /staging cleanup failed/,
    );
    assert.equal(server.calls.finalize.length, 0);
    for (const targetPath of targetPaths) {
      assert.equal(readTargetKey(targetPath), OLD_KEY);
      assert.equal(server.activeKeys.has(readTargetKey(targetPath)), true);
    }
    assert.equal(readTargetKey(capturedPreparedPath), NEW_KEY);
    assertForeignObjectSurvives(directory, kind, marker);
  });

  test(`${kind} backup replacement during cleanup is preserved and blocks finalization`, (t) => {
    const directory = makeTempDir(t);
    const targetPaths = [
      writeTarget(directory, `backup-cleanup-${kind}-a.env`),
      writeTarget(directory, `backup-cleanup-${kind}-b.env`),
    ];
    const server = fakeServer();
    const marker = `backup-cleanup-${kind}`;
    const capturedBackupPath = join(directory, `backup-owned-${kind}.env`);
    let replaced = false;
    const injectedFs = {
      ...nodeFs,
      readdirSync(path, options) {
        const backupPath = join(path, "backup");
        if (!replaced && nodeFs.existsSync(backupPath)) {
          replaced = true;
          nodeFs.renameSync(backupPath, capturedBackupPath);
          installForeignObject(backupPath, kind, directory, marker);
        }
        return nodeFs.readdirSync(path, options);
      },
    };

    assert.throws(
      () => executeFixture(targetPaths, server, { fs: injectedFs }),
      /cleanup failed/,
    );
    assert.equal(server.calls.finalize.length, 0);
    for (const targetPath of targetPaths) {
      assert.equal(readTargetKey(targetPath), NEW_KEY);
      assert.equal(server.activeKeys.has(readTargetKey(targetPath)), true);
    }
    assert.equal(readTargetKey(capturedBackupPath), OLD_KEY);
    assertForeignObjectSurvives(directory, kind, marker);
  });
}

test("successful cleanup never calls pathname unlink for stage or backup residue", (t) => {
  const directory = makeTempDir(t);
  const targetPath = writeTarget(directory, "no-unlink-cleanup.env");
  const server = fakeServer();
  let unlinkCalls = 0;
  const injectedFs = {
    ...nodeFs,
    unlinkSync() {
      unlinkCalls += 1;
      throw new Error("legacy check-then-unlink path was invoked");
    },
  };

  executeFixture([targetPath], server, { fs: injectedFs });
  assert.equal(unlinkCalls, 0);
  assert.equal(server.calls.finalize.length, 1);
  assert.equal(readTargetKey(targetPath), NEW_KEY);
  assert.deepEqual(ownedStageFiles(directory), []);
});

function writeAdminRunHelperShim(directory) {
  const shimPath = join(directory, "convex-admin-run-helper-shim.mjs");
  nodeFs.writeFileSync(
    shimPath,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeSync } from "node:fs";

const RESPONSE_FD = 3;
const args = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
if (process.env.SHIM_MARKER) {
  appendFileSync(process.env.SHIM_MARKER, JSON.stringify({
    admin: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY,
    args,
    stdin,
    url: process.env.CONVEX_SELF_HOSTED_URL,
  }) + "\\n");
}
const fn = args[0] || "";
const key = process.env.SHIM_RAW_KEY || "";
const mode = process.env.SHIM_MODE || "success";
function writeResponse(text) {
  writeSync(RESPONSE_FD, text);
}
if (fn.includes("prepareApiKeyRotation")) {
  if (mode === "stdout-failure") {
    process.stdout.write(key);
    process.exit(9);
  }
  if (mode === "stderr-failure") {
    process.stderr.write(key);
    process.exit(9);
  }
  if (mode === "malformed-json") {
    // Put junk on the response channel (and leak on stdout) — parent must suppress.
    writeResponse(key + "{");
    process.stdout.write(key + "{");
    process.exit(0);
  }
  if (mode === "mixed-output") {
    process.stdout.write("banner:" + key + "\\n" + JSON.stringify({ keyId: "shim-key-id", rawKey: key }));
    // No valid fd-3 payload → parent treats as invalid JSON and suppresses.
    process.exit(0);
  }
  writeResponse(JSON.stringify({
    keyId: "shim-key-id",
    rawKey: key,
    rotationId: "shim-rotation-id",
    rotationNonce: "shim-nonce-" + "n".repeat(64),
  }));
  process.exit(0);
}
if (fn.includes("finalizeApiKeyRotation")) {
  if (mode === "finalize-stderr-failure") {
    process.stderr.write(key);
    process.exit(8);
  }
  writeResponse(JSON.stringify({ deactivated: 1 }));
  process.exit(0);
}
process.stderr.write("unexpected shim invocation");
process.exit(11);
`,
    { mode: 0o755 },
  );
  return shimPath;
}

function cleanChildEnv() {
  const env = { ...process.env };
  for (const key of [
    "CONVEX_DEPLOYMENT",
    "CONVEX_DEPLOY_KEY",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
  ]) {
    delete env[key];
  }
  return env;
}

function runCli({ directory, nodeArgs = [], rawKey, scriptArgs, shimMode }) {
  const markerPath = join(directory, "shim-marker.jsonl");
  const helperPath = writeAdminRunHelperShim(directory);
  const env = {
    ...cleanChildEnv(),
    CONVEX_SELF_HOSTED_ADMIN_KEY: "fixture-admin-context",
    CONVEX_SELF_HOSTED_URL: "https://self-hosted.example.test",
    MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER: helperPath,
    SHIM_MARKER: markerPath,
    SHIM_MODE: shimMode,
    SHIM_RAW_KEY: rawKey,
  };
  const result = spawnSync(
    process.execPath,
    [...nodeArgs, SCRIPT_PATH, ...scriptArgs],
    { encoding: "utf8", env },
  );
  return { helperPath, markerPath, result };
}

test("Node pre-script env-file forms are feature-detected and rejected before Convex", async (t) => {
  const forms = [
    {
      name: "--env-file joined",
      nodeArgs: (path) => [`--env-file=${path}`],
    },
    {
      name: "--env-file separated",
      nodeArgs: (path) => ["--env-file", path],
    },
    {
      name: "--env-file-if-exists joined",
      nodeArgs: (path) => [`--env-file-if-exists=${path}`],
    },
    {
      name: "--env-file-if-exists separated",
      nodeArgs: (path) => ["--env-file-if-exists", path],
    },
  ];

  for (const form of forms) {
    const directory = makeTempDir(t);
    const targetPath = join(directory, "seed-and-target.env");
    const seededAdmin = `seeded-admin-${form.name.replaceAll(" ", "-")}`;
    nodeFs.writeFileSync(
      targetPath,
      `CONVEX_SELF_HOSTED_URL=https://seeded.example.test\n` +
        `CONVEX_SELF_HOSTED_ADMIN_KEY=${seededAdmin}\n` +
        `MEMORY_CRYSTAL_API_KEY=${OLD_KEY}\n`,
      { mode: 0o600 },
    );
    const nodeArgs = form.nodeArgs(targetPath);
    const supported =
      spawnSync(process.execPath, [...nodeArgs, "-e", ""], {
        env: cleanChildEnv(),
      }).status === 0;

    await t.test(form.name, { skip: supported ? false : "unsupported by this Node" }, () => {
      const markerPath = join(directory, "pre-script-marker.jsonl");
      const helperPath = writeAdminRunHelperShim(directory);
      const env = {
        ...cleanChildEnv(),
        MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER: helperPath,
        SHIM_MARKER: markerPath,
        SHIM_RAW_KEY: NEW_KEY,
      };
      const before = nodeFs.readFileSync(targetPath, "utf8");
      const result = spawnSync(
        process.execPath,
        [
          ...nodeArgs,
          SCRIPT_PATH,
          "--user",
          USER_ID,
          "--target",
          targetPath,
        ],
        { encoding: "utf8", env },
      );
      const combined = `${result.stdout}${result.stderr}`;

      assert.equal(result.status, 2);
      assert.match(combined, /Refusing Node --env-file/);
      assert.equal(combined.includes(seededAdmin), false);
      assert.equal(combined.includes(OLD_KEY), false);
      assert.equal(nodeFs.existsSync(markerPath), false);
      assert.equal(nodeFs.readFileSync(targetPath, "utf8"), before);
    });
  }
});

test("failed prepare output never replays raw keys from stdout, stderr, or invalid JSON", async (t) => {
  const cases = [
    ["stdout-failure", /exit status 9/],
    ["stderr-failure", /exit status 9/],
    ["malformed-json", /returned invalid JSON/],
    ["mixed-output", /returned invalid JSON/],
  ];

  for (const [shimMode, expectedMessage] of cases) {
    await t.test(shimMode, () => {
      const directory = makeTempDir(t);
      const targetPath = writeTarget(directory, `${shimMode}.env`);
      const rawKey = `${shimMode}-${"c".repeat(64)}`;
      const { result } = runCli({
        directory,
        rawKey,
        scriptArgs: ["--user", USER_ID, "--target", targetPath],
        shimMode,
      });
      const combined = `${result.stdout}${result.stderr}`;

      assert.equal(result.status, 2);
      assert.match(combined, expectedMessage);
      assert.match(combined, /child output was suppressed/);
      assert.equal(combined.includes(rawKey), false);
      assert.equal(readTargetKey(targetPath), OLD_KEY);
      assert.deepEqual(ownedStageFiles(directory), []);
    });
  }
});

test("CLI success updates every target, finalizes once, and never prints the raw key", (t) => {
  const directory = makeTempDir(t);
  const targets = [writeTarget(directory, "cli-a.env"), writeTarget(directory, "cli-b.env")];
  const { markerPath, result } = runCli({
    directory,
    rawKey: NEW_KEY,
    scriptArgs: [
      "--user",
      USER_ID,
      "--label",
      LABEL,
      "--target",
      targets[0],
      "--target",
      targets[1],
    ],
    shimMode: "success",
  });
  const combined = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, combined);
  assert.equal(combined.includes(NEW_KEY), false);
  for (const target of targets) {
    assert.equal(readTargetKey(target), NEW_KEY);
    assert.equal(nodeFs.statSync(target).mode & 0o777, 0o600);
  }
  const calls = nodeFs
    .readFileSync(markerPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.match(calls[0].args[0], /prepareApiKeyRotation/);
  assert.match(calls[1].args[0], /finalizeApiKeyRotation/);
  // Function name only on argv — never JSON args, nonce, or raw key.
  for (const call of calls) {
    assert.equal(call.args.length, 1);
    assert.equal(JSON.stringify(call.args).includes(NEW_KEY), false);
    assert.equal(JSON.stringify(call.args).includes("rotationNonce"), false);
    assert.equal(JSON.stringify(call.args).includes("shim-nonce"), false);
  }
  // Finalization ownership material is confined to stdin.
  assert.match(calls[1].stdin, /rotationNonce/);
  assert.equal(JSON.stringify(calls).includes(NEW_KEY), false);
  assert.deepEqual(ownedStageFiles(directory), []);
});

test("runConvexJson never places rotationNonce or raw credentials on child argv", async () => {
  const { runConvexJson } = await import("./rotate-mcp-api-key.mjs");
  const recorded = [];
  const nonce = `nonce-argv-${"e".repeat(64)}`;
  const rawKey = `raw-argv-${"f".repeat(64)}`;
  const fakeSpawn = (execPath, argv, options) => {
    recorded.push({
      execPath,
      argv,
      input: options.input,
      envAdmin: options.env?.CONVEX_SELF_HOSTED_ADMIN_KEY,
      stdio: options.stdio,
    });
    return {
      status: 0,
      stdout: "",
      stderr: "",
      // Parent parses only the dedicated fd-3 response channel.
      output: [null, "", "", JSON.stringify({ deactivated: 1 })],
    };
  };

  const result = runConvexJson({
    args: {
      keyId: "key-1",
      label: "local-dev",
      rotationId: "rot-1",
      rotationNonce: nonce,
      userId: USER_ID,
      rawKey,
    },
    env: {
      CONVEX_SELF_HOSTED_ADMIN_KEY: "fixture-admin",
      CONVEX_SELF_HOSTED_URL: "https://self-hosted.example.test",
    },
    functionName: "crystal/apiKeys:finalizeApiKeyRotationForUserInternal",
    operation: "finalization",
    adminRunHelper: "/tmp/fake-admin-run-helper.mjs",
    spawn: fakeSpawn,
    execPath: "/usr/bin/node",
  });

  assert.deepEqual(result, { deactivated: 1 });
  assert.equal(recorded.length, 1);
  const argvJoined = recorded[0].argv.join("\0");
  assert.equal(argvJoined.includes(nonce), false);
  assert.equal(argvJoined.includes(rawKey), false);
  assert.equal(argvJoined.includes("rotationNonce"), false);
  assert.equal(argvJoined.includes("fixture-admin"), false);
  assert.deepEqual(recorded[0].argv, [
    "/tmp/fake-admin-run-helper.mjs",
    "crystal/apiKeys:finalizeApiKeyRotationForUserInternal",
  ]);
  assert.deepEqual(recorded[0].stdio, ["pipe", "pipe", "pipe", "pipe"]);
  assert.match(recorded[0].input, new RegExp(nonce));
  assert.equal(recorded[0].envAdmin, "fixture-admin");
});

test("CLI finalization failure keeps new files usable without replaying child output", (t) => {
  const directory = makeTempDir(t);
  const targets = [
    writeTarget(directory, "finalize-cli-a.env"),
    writeTarget(directory, "finalize-cli-b.env"),
  ];
  const rawKey = `finalize-child-${"d".repeat(64)}`;
  const { result } = runCli({
    directory,
    rawKey,
    scriptArgs: [
      "--user",
      USER_ID,
      "--target",
      targets[0],
      "--target",
      targets[1],
    ],
    shimMode: "finalize-stderr-failure",
  });
  const combined = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 2);
  assert.match(combined, /Credential finalization failed \(exit status 8\)/);
  assert.match(combined, /child output was suppressed/);
  assert.equal(combined.includes(rawKey), false);
  for (const target of targets) {
    assert.equal(readTargetKey(target), rawKey);
    assert.equal(nodeFs.statSync(target).mode & 0o777, 0o600);
  }
  assert.deepEqual(ownedStageFiles(directory), []);
});
