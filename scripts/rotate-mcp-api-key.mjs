#!/usr/bin/env node

// Rotate MEMORY_CRYSTAL_API_KEY in local env files (ILL-135 Req 3).
//
// The rotation protocol deliberately overlaps credentials:
//   1. preflight every destination before contacting Convex;
//   2. prepare a new active key while prior same-label keys remain active;
//   3. securely stage and replace every destination;
//   4. finalize by deactivating prior keys for the same user and label.
//
// A failure before finalization therefore leaves each consumer on either the
// old active key or the prepared active key. Child output is always captured
// and never replayed because the prepare response contains the one-time key.
//
// OS threat boundary: the transaction directory is mode 0700 and assumes the
// rotating process's UID exclusively controls its target directories. Node does
// not expose unlinkat(2), renameat2(2), or an unforgeable directory capability,
// so this protocol does not claim protection from a malicious same-UID process
// that can interpose syscalls or rewrite owner-only directories arbitrarily.
// Against other UIDs, residue is validated only after atomic isolation inside
// the retained transaction-directory descriptor and is never deleted through a
// public lstat(path) -> unlink(path) check.
//
// Usage:
//   node scripts/rotate-mcp-api-key.mjs --user <userId> [--label local-dev] \
//     --target mcp-server/.env [--target .env.local] [--allow-local]

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveSelfHostedConvexEnv } from "./lib/convex-self-hosted-env.mjs";

const ENV_VAR = "MEMORY_CRYSTAL_API_KEY";
const PREPARE_FUNCTION = "crystal/apiKeys:prepareApiKeyRotationForUserInternal";
const FINALIZE_FUNCTION = "crystal/apiKeys:finalizeApiKeyRotationForUserInternal";
const PROTECTED_LABELS = new Set(["codex", "gateway", "mcp-gateway", "production"]);
const STAGE_ATTEMPTS = 16;
const DEFAULT_ADMIN_RUN_HELPER = fileURLToPath(
  new URL("./lib/convex-admin-run-helper.mjs", import.meta.url),
);

const defaultFs = {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
};

class RotationError extends Error {
  constructor(message, { exitCode = 2 } = {}) {
    super(message);
    this.name = "RotationError";
    this.exitCode = exitCode;
  }
}

const isEnvFileOption = (value) =>
  value === "--env-file" ||
  value.startsWith("--env-file=") ||
  value === "--env-file-if-exists" ||
  value.startsWith("--env-file-if-exists=");

/**
 * Node consumes pre-script env-file flags before the script begins and exposes
 * them through process.execArgv, not process.argv. Reject both surfaces before
 * target resolution or any privileged child can observe the seeded variables.
 */
export function assertNoEnvFileOptions({
  execArgv = process.execArgv,
  scriptArgv = process.argv.slice(2),
} = {}) {
  if ([...execArgv, ...scriptArgv].some(isEnvFileOption)) {
    throw new RotationError(
      "Refusing Node --env-file/--env-file-if-exists options; rotation destinations must never seed deployment credentials. Use --target for destination files.",
    );
  }
}

function parseCliArgs(argv) {
  const flag = (name) => argv.includes(name);
  const option = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const options = (name) =>
    argv.reduce(
      (values, current, index) =>
        current === name && argv[index + 1]
          ? [...values, argv[index + 1]]
          : values,
      [],
    );

  const userId = option("--user")?.trim();
  const label = (option("--label") || "local-dev").trim();
  const targetPaths = options("--target");
  const allowLocal = flag("--allow-local");
  const force = flag("--force");

  if (!userId) throw new RotationError("--user <userId> is required");
  if (!label) throw new RotationError("--label must not be empty");
  if (targetPaths.length === 0) {
    throw new RotationError("at least one --target <path> is required");
  }
  if (PROTECTED_LABELS.has(label.toLowerCase()) && !force) {
    throw new RotationError(
      `Refusing to rotate the protected label "${label}". Pass --force only if that is genuinely intended.`,
    );
  }

  return { allowLocal, label, targetPaths, userId };
}

/** Preserve unrelated content while normalizing the credential to one entry. */
export function rewriteEnvContent(original, value) {
  const line = `${ENV_VAR}=${value}`;
  const pattern = new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?${ENV_VAR}=.*$`,
  );
  let seen = false;
  const rewritten = original
    .split("\n")
    .flatMap((candidate) => {
      if (!pattern.test(candidate)) return [candidate];
      if (seen) return [];
      seen = true;
      return [line];
    })
    .join("\n");

  if (!seen) {
    return `${original.endsWith("\n") || original === "" ? original : `${original}\n`}${line}\n`;
  }

  return rewritten;
}

function phaseError(phase, targetIndex) {
  return new RotationError(
    `Credential rotation ${phase} failed for target ${targetIndex + 1}; no child output was replayed.`,
  );
}

export function preflightTargets(targetPaths, { fs = defaultFs } = {}) {
  const seenPaths = new Set();
  const seenFiles = new Set();

  return targetPaths.map((inputPath, targetIndex) => {
    try {
      const lexicalPath = resolve(inputPath);
      const lexicalStat = fs.lstatSync(lexicalPath);
      if (!lexicalStat.isFile()) throw new Error("not a regular file");

      const targetPath = fs.realpathSync(lexicalPath);
      const targetStat = fs.lstatSync(targetPath);
      if (!targetStat.isFile()) throw new Error("not a regular file");
      if (
        lexicalStat.dev !== targetStat.dev ||
        lexicalStat.ino !== targetStat.ino
      ) {
        throw new Error("target changed during preflight");
      }
      const identity = `${targetStat.dev}:${targetStat.ino}`;
      if (seenPaths.has(targetPath) || seenFiles.has(identity)) {
        throw new Error("duplicate target");
      }

      const original = fs.readFileSync(targetPath, "utf8");
      seenPaths.add(targetPath);
      seenFiles.add(identity);
      return {
        baseName: basename(targetPath),
        directory: dirname(targetPath),
        original,
        originalIdentity: identity,
        targetIndex,
        targetPath,
      };
    } catch {
      throw phaseError("preflight", targetIndex);
    }
  });
}

function transactionNameFor(target, randomBytesFn) {
  const suffix = randomBytesFn(16).toString("hex");
  return resolve(target.directory, `.${target.baseName}.rotation-${suffix}`);
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function lstatIfPresent(path, fs) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function closeOwnedDescriptor(owner, field, fs) {
  if (owner[field] === undefined) return true;
  try {
    fs.closeSync(owner[field]);
    owner[field] = undefined;
    return true;
  } catch {
    // Node cannot tell whether a failed close released the descriptor. Keep the
    // transaction secured and make the uncertainty block finalization.
    return false;
  }
}

function createTransaction(target, fs, randomBytesFn) {
  for (let attempt = 0; attempt < STAGE_ATTEMPTS; attempt += 1) {
    const transactionPath = transactionNameFor(target, randomBytesFn);
    try {
      fs.mkdirSync(transactionPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }

    let createdIdentity;
    let transactionFd;
    try {
      const pathStat = fs.lstatSync(transactionPath);
      if (!pathStat.isDirectory()) throw new Error("transaction is not a directory");
      createdIdentity = statIdentity(pathStat);
      const noFollow = constants.O_NOFOLLOW ?? 0;
      transactionFd = fs.openSync(transactionPath, constants.O_RDONLY | noFollow);
      const descriptorStat = fs.fstatSync(transactionFd);
      if (
        !descriptorStat.isDirectory() ||
        statIdentity(pathStat) !== statIdentity(descriptorStat)
      ) {
        throw new Error("transaction pathname is not bound to its descriptor");
      }
      fs.fchmodSync(transactionFd, 0o700);
      return {
        transactionFd,
        transactionIdentity: statIdentity(descriptorStat),
        transactionPath,
      };
    } catch (error) {
      if (transactionFd !== undefined) {
        try {
          fs.closeSync(transactionFd);
        } catch {
          // Retain the owner-only directory if descriptor state is uncertain.
          throw error;
        }
      }
      const current = lstatIfPresent(transactionPath, fs);
      if (
        createdIdentity &&
        current?.isDirectory() &&
        statIdentity(current) === createdIdentity
      ) {
        fs.rmSync(transactionPath, { force: false, recursive: true });
      }
      throw error;
    }
  }
  throw new Error("exclusive transaction attempts exhausted");
}

export function stageTargets(
  targets,
  value,
  { fs = defaultFs, randomBytesFn = randomBytes } = {},
) {
  const staged = [];
  try {
    for (const target of targets) {
      const nextContent = rewriteEnvContent(target.original, value);
      const transaction = createTransaction(target, fs, randomBytesFn);
      const stagePath = resolve(transaction.transactionPath, "stage");
      const stage = { ...target, ...transaction, stagePath };
      staged.push(stage);

      const noFollow = constants.O_NOFOLLOW ?? 0;
      stage.fd = fs.openSync(
        stagePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );

      const stageStat = fs.fstatSync(stage.fd);
      if (!stageStat.isFile()) throw new Error("stage descriptor is not a regular file");
      stage.stageIdentity = statIdentity(stageStat);
      fs.fchmodSync(stage.fd, 0o600);
      fs.writeFileSync(stage.fd, nextContent, "utf8");
      fs.fsyncSync(stage.fd);
    }
    return staged;
  } catch {
    const cleanupFailed = cleanupStages(staged, fs);
    const targetIndex = Math.min(staged.length, Math.max(targets.length - 1, 0));
    if (cleanupFailed) {
      throw new RotationError(
        "Credential rotation staging cleanup failed; inspect the target directories without printing file contents.",
      );
    }
    throw phaseError("staging", targetIndex);
  }
}

function createTargetBackup(stage, fs) {
  stage.backupPath = resolve(stage.transactionPath, "backup");
  fs.linkSync(stage.targetPath, stage.backupPath);
  const backupStat = fs.lstatSync(stage.backupPath);
  if (!backupStat.isFile() || statIdentity(backupStat) !== stage.originalIdentity) {
    throw new Error("backup does not reference the original target");
  }
  stage.backupIdentity = stage.originalIdentity;
}

function transactionIsOwned(stage, fs) {
  if (stage.transactionFd === undefined) return false;
  const pathStat = fs.lstatSync(stage.transactionPath);
  const descriptorStat = fs.fstatSync(stage.transactionFd);
  return (
    pathStat.isDirectory() &&
    descriptorStat.isDirectory() &&
    statIdentity(pathStat) === stage.transactionIdentity &&
    statIdentity(descriptorStat) === stage.transactionIdentity
  );
}

function writeOriginalRecovery(stage, fs, randomBytesFn) {
  if (!transactionIsOwned(stage, fs)) {
    const transaction = createTransaction(stage, fs, randomBytesFn);
    Object.assign(stage, transaction);
    stage.cleaned = false;
  }
  const recoveryPath = resolve(stage.transactionPath, "restore");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let recoveryFd = fs.openSync(
    recoveryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    const recoveryStat = fs.fstatSync(recoveryFd);
    if (!recoveryStat.isFile()) throw new Error("recovery descriptor is not a file");
    fs.fchmodSync(recoveryFd, 0o600);
    fs.writeFileSync(recoveryFd, stage.original, "utf8");
    fs.fsyncSync(recoveryFd);
    fs.closeSync(recoveryFd);
    recoveryFd = undefined;
    const pathStat = fs.lstatSync(recoveryPath);
    if (!pathStat.isFile() || statIdentity(pathStat) !== statIdentity(recoveryStat)) {
      throw new Error("recovery pathname changed");
    }
    fs.renameSync(recoveryPath, stage.targetPath);
    return statIdentity(recoveryStat);
  } finally {
    if (recoveryFd !== undefined) {
      try {
        fs.closeSync(recoveryFd);
      } catch {
        // Failure recovery remains conservative; the caller will retain it.
      }
    }
  }
}

function restoreOriginalAfterMismatch(stage, fs, randomBytesFn) {
  const current = fs.lstatSync(stage.targetPath);
  const currentIdentity = statIdentity(current);
  if (
    current.isFile() &&
    (currentIdentity === stage.originalIdentity || currentIdentity === stage.stageIdentity)
  ) {
    return;
  }

  if (!transactionIsOwned(stage, fs)) {
    const transaction = createTransaction(stage, fs, randomBytesFn);
    Object.assign(stage, transaction);
    stage.cleaned = false;
  }
  const foreignPath = resolve(stage.transactionPath, "foreign-target");
  fs.renameSync(stage.targetPath, foreignPath);
  const preserved = fs.lstatSync(foreignPath);
  if (statIdentity(preserved) !== currentIdentity) {
    throw new Error("foreign target changed while being preserved");
  }
  stage.retainTransaction = true;

  const backup = stage.backupPath ? lstatIfPresent(stage.backupPath, fs) : undefined;
  let expectedRestoredIdentity;
  if (
    backup?.isFile() &&
    statIdentity(backup) === stage.backupIdentity
  ) {
    expectedRestoredIdentity = stage.backupIdentity;
    fs.renameSync(stage.backupPath, stage.targetPath);
  } else {
    expectedRestoredIdentity = writeOriginalRecovery(stage, fs, randomBytesFn);
  }
  const restored = fs.lstatSync(stage.targetPath);
  if (
    !restored.isFile() ||
    statIdentity(restored) !== expectedRestoredIdentity
  ) {
    throw new Error("original active target was not restored");
  }
}

function validateInstalledTarget(stage, fs) {
  const installed = fs.lstatSync(stage.targetPath);
  return installed.isFile() && statIdentity(installed) === stage.stageIdentity;
}

function validateInstalledTargetWithDescriptor(stage, fs) {
  let proofFd;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    proofFd = fs.openSync(stage.targetPath, constants.O_RDONLY | noFollow);
    const descriptorStat = fs.fstatSync(proofFd);
    const pathStat = fs.lstatSync(stage.targetPath);
    if (
      !descriptorStat.isFile() ||
      !pathStat.isFile() ||
      statIdentity(descriptorStat) !== stage.stageIdentity ||
      statIdentity(pathStat) !== stage.stageIdentity
    ) {
      return false;
    }
    fs.closeSync(proofFd);
    proofFd = undefined;
    const afterClose = fs.lstatSync(stage.targetPath);
    return afterClose.isFile() && statIdentity(afterClose) === stage.stageIdentity;
  } catch {
    return false;
  } finally {
    if (proofFd !== undefined) {
      try {
        fs.closeSync(proofFd);
      } catch {
        // An uncertain proof-descriptor close invalidates the proof.
      }
    }
  }
}

function validateTransactionContents(stage, fs) {
  if (!transactionIsOwned(stage, fs)) return false;
  const expected = new Map();
  const stageStat = lstatIfPresent(stage.stagePath, fs);
  if (stageStat) expected.set("stage", stage.stageIdentity);
  const backupStat = stage.backupPath
    ? lstatIfPresent(stage.backupPath, fs)
    : undefined;
  if (backupStat) expected.set("backup", stage.backupIdentity);
  const entries = fs.readdirSync(stage.transactionPath);
  if (entries.length !== expected.size) return false;
  return entries.every((entry) => {
    const identity = expected.get(entry);
    if (!identity) return false;
    const current = fs.lstatSync(resolve(stage.transactionPath, entry));
    return current.isFile() && statIdentity(current) === identity;
  });
}

function cleanupStage(stage, fs) {
  let failed = false;
  if (!closeOwnedDescriptor(stage, "fd", fs)) failed = true;
  if (stage.cleaned) return failed;
  if (stage.retainTransaction) {
    closeOwnedDescriptor(stage, "transactionFd", fs);
    return true;
  }
  try {
    if (failed || !validateTransactionContents(stage, fs)) {
      closeOwnedDescriptor(stage, "transactionFd", fs);
      return true;
    }
    // The only recursive deletion is the exclusively created mode-0700
    // transaction directory after every child has been isolated and rebound to
    // its retained identity. No lstat(path) -> unlink(path) ownership claim is
    // made for public stage or backup pathnames.
    fs.rmSync(stage.transactionPath, { force: false, recursive: true });
    if (!closeOwnedDescriptor(stage, "transactionFd", fs)) return true;
    if (lstatIfPresent(stage.transactionPath, fs) !== undefined) return true;
    stage.cleaned = true;
    return false;
  } catch {
    closeOwnedDescriptor(stage, "transactionFd", fs);
    return true;
  }
}

function cleanupStages(stages, fs) {
  let failed = false;
  for (const stage of stages) {
    if (cleanupStage(stage, fs)) failed = true;
  }
  return failed;
}

function syncTargetDirectories(staged, fs, phase) {
  const syncedDirectories = new Set();
  for (const stage of staged) {
    if (syncedDirectories.has(stage.directory)) continue;
    let directoryFd;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      directoryFd = fs.openSync(stage.directory, constants.O_RDONLY | noFollow);
      const directoryStat = fs.fstatSync(directoryFd);
      if (!directoryStat.isDirectory()) throw new Error("target parent is not a directory");
      fs.fsyncSync(directoryFd);
      fs.closeSync(directoryFd);
      directoryFd = undefined;
      syncedDirectories.add(stage.directory);
    } catch {
      if (directoryFd !== undefined) {
        try {
          fs.closeSync(directoryFd);
        } catch {
          // The failed close may already have released the descriptor.
        }
      }
      throw phaseError(phase, stage.targetIndex);
    }
  }
}

export function replaceTargets(
  staged,
  { fs = defaultFs, randomBytesFn = randomBytes } = {},
) {
  for (const stage of staged) {
    try {
      const current = fs.lstatSync(stage.targetPath);
      if (
        !current.isFile() ||
        statIdentity(current) !== stage.originalIdentity
      ) {
        throw new Error("target changed after preflight");
      }
      createTargetBackup(stage, fs);
      const currentAfterBackup = fs.lstatSync(stage.targetPath);
      if (
        !currentAfterBackup.isFile() ||
        statIdentity(currentAfterBackup) !== stage.originalIdentity
      ) {
        throw new Error("target changed while creating rollback backup");
      }
      const descriptorStat = fs.fstatSync(stage.fd);
      const stagePathStat = fs.lstatSync(stage.stagePath);
      if (
        !descriptorStat.isFile() ||
        !stagePathStat.isFile() ||
        statIdentity(descriptorStat) !== stage.stageIdentity ||
        statIdentity(stagePathStat) !== stage.stageIdentity
      ) {
        throw new Error("stage pathname no longer references the owned descriptor");
      }
      fs.renameSync(stage.stagePath, stage.targetPath);
      stage.installed = true;
      if (!validateInstalledTarget(stage, fs)) {
        restoreOriginalAfterMismatch(stage, fs, randomBytesFn);
        throw new Error("installed target does not reference the owned stage descriptor");
      }
    } catch {
      try {
        restoreOriginalAfterMismatch(stage, fs, randomBytesFn);
      } catch {
        stage.retainTransaction = true;
      }
      throw phaseError("replacement", stage.targetIndex);
    }
  }

  syncTargetDirectories(staged, fs, "replacement durability");

  // Descriptor close is deliberately before the last ownership check. A close
  // failure or a swap injected during/after close is therefore observable and
  // blocks backend finalization while both credentials remain active.
  for (const stage of staged) {
    if (!closeOwnedDescriptor(stage, "fd", fs)) {
      throw phaseError("replacement", stage.targetIndex);
    }
  }
  for (const stage of staged) {
    if (!validateInstalledTarget(stage, fs)) {
      try {
        restoreOriginalAfterMismatch(stage, fs, randomBytesFn);
      } catch {
        stage.retainTransaction = true;
      }
      throw phaseError("replacement", stage.targetIndex);
    }
  }

  // Cleanup is part of the commit gate, not a best-effort epilogue. Backups
  // stay isolated in their private directories until descriptors are closed;
  // any uncertain directory identity or residue blocks finalization.
  if (cleanupStages(staged, fs)) {
    throw new RotationError(
      "Credential rotation cleanup failed; secured transaction residue was retained and finalization was blocked.",
    );
  }
  syncTargetDirectories(staged, fs, "cleanup durability");

  // This is the final filesystem operation before the backend transition.
  // It detects swaps caused by descriptor close or transaction cleanup. If the
  // original backup was already removed, recovery recreates the original
  // active content in a new owner-only transaction and preserves the foreign
  // object there for inspection.
  for (const stage of staged) {
    if (!validateInstalledTargetWithDescriptor(stage, fs)) {
      try {
        restoreOriginalAfterMismatch(stage, fs, randomBytesFn);
      } catch {
        stage.retainTransaction = true;
      }
      throw phaseError("pre-finalization ownership", stage.targetIndex);
    }
  }
}

/**
 * Filesystem transaction with availability semantics: old and prepared keys
 * overlap until every atomic replacement succeeds and finalize returns.
 */
export function rotateTargets({
  finalize,
  fs = defaultFs,
  label,
  prepare,
  randomBytesFn = randomBytes,
  targetPaths,
  userId,
}) {
  const targets = preflightTargets(targetPaths, { fs });
  const prepared = prepare({ label, userId });
  const rawKey = prepared?.rawKey;
  const keyId = prepared?.keyId;
  const rotationId = prepared?.rotationId;
  const rotationNonce = prepared?.rotationNonce;
  if (
    typeof rawKey !== "string" ||
    rawKey.length < 32 ||
    typeof keyId !== "string" ||
    !keyId ||
    typeof rotationId !== "string" ||
    !rotationId ||
    typeof rotationNonce !== "string" ||
    rotationNonce.length < 32
  ) {
    throw new RotationError(
      "Credential preparation returned an invalid response; child output was suppressed.",
    );
  }

  let staged = [];
  try {
    staged = stageTargets(targets, rawKey, { fs, randomBytesFn });
    replaceTargets(staged, { fs, randomBytesFn });
    const finalized = finalize({
      keyId,
      label,
      rotationId,
      rotationNonce,
      userId,
    });
    if (
      finalized === null ||
      typeof finalized !== "object" ||
      !Number.isInteger(finalized.deactivated) ||
      finalized.deactivated < 0
    ) {
      throw new RotationError(
        "Credential finalization returned an invalid response; child output was suppressed.",
      );
    }
    return {
      deactivated: finalized.deactivated,
      fingerprint: createHash("sha256").update(rawKey).digest("hex").slice(0, 8),
      targetPaths: targets.map((target) => target.targetPath),
    };
  } finally {
    if (staged.some((stage) => !stage.cleaned) && cleanupStages(staged, fs)) {
      throw new RotationError(
        "Credential rotation cleanup failed; secured transaction residue was retained and finalization was blocked.",
      );
    }
  }
}

/**
 * Invoke an internal Convex function with admin auth.
 *
 * Arguments (including rotationNonce and any credential material) are supplied
 * only on the helper's stdin. argv is limited to the node binary, helper path,
 * and function name — never secrets. Successful JSON returns only on a
 * parent-owned anonymous pipe (fd 3). Child stdout/stderr are captured and
 * never replayed (including on success — stdout must stay empty of secrets).
 */
function runConvexJson({
  args,
  env,
  functionName,
  operation,
  adminRunHelper = process.env.MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER ||
    DEFAULT_ADMIN_RUN_HELPER,
  spawn = spawnSync,
  execPath = process.execPath,
}) {
  const result = spawn(execPath, [adminRunHelper, functionName], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
    input: JSON.stringify(args ?? {}),
    // fd 0 stdin, fd 1/2 captured (never replayed), fd 3 parent response pipe
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const status = Number.isInteger(result.status) ? result.status : "unknown";
    throw new RotationError(
      `Credential ${operation} failed (exit status ${status}); child output was suppressed.`,
    );
  }
  const responseChannel =
    Array.isArray(result.output) && typeof result.output[3] === "string"
      ? result.output[3]
      : "";
  try {
    return JSON.parse(responseChannel.trim());
  } catch {
    throw new RotationError(
      `Credential ${operation} returned invalid JSON; child output was suppressed.`,
    );
  }
}

export { runConvexJson };

export function main({
  argv = process.argv.slice(2),
  execArgv = process.execArgv,
} = {}) {
  // This must remain the first executable security decision in main.
  assertNoEnvFileOptions({ execArgv, scriptArgv: argv });
  const { allowLocal, label, targetPaths, userId } = parseCliArgs(argv);

  let target;
  try {
    target = resolveSelfHostedConvexEnv({ allowLocal });
  } catch (error) {
    throw new RotationError(
      error instanceof Error ? error.message : "Unable to resolve Convex credentials.",
    );
  }

  const result = rotateTargets({
    label,
    prepare: (args) =>
      runConvexJson({
        args,
        env: target.env,
        functionName: PREPARE_FUNCTION,
        operation: "preparation",
      }),
    finalize: (args) =>
      runConvexJson({
        args,
        env: target.env,
        functionName: FINALIZE_FUNCTION,
        operation: "finalization",
      }),
    targetPaths,
    userId,
  });

  process.stdout.write(
    `Rotated ${ENV_VAR} for label "${label}" (credential redacted; sha256:${result.fingerprint}).\n` +
      `  deactivated prior active keys with this label: ${result.deactivated}\n` +
      `  updated: ${result.targetPaths.join(", ")}\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    const message =
      error instanceof RotationError
        ? error.message
        : "Credential rotation failed; child output was suppressed.";
    process.stderr.write(`${message}\n`);
    process.exit(error instanceof RotationError ? error.exitCode : 2);
  }
}
