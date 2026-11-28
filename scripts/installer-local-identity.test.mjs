#!/usr/bin/env node
// Installer local-identity stability (ILL-336, Requirement 5).
//
// Before this change `provision_local_auth_bridge` rewrote local-auth.json on
// every run from "$API_KEY:$LOCAL_BACKEND_VERSION:memory-crystal-local", so an
// upgrade minted a new local user whose token could not see the previous user's
// memories. The contract now: an existing usable identity is kept verbatim, new
// identities derive from the API key only, and no version ever enters the seed.
//
// Round 2 additions: a stranded rotation (the pre-fix 0.9.0 installer rotated
// the identity and then failed on the missing archive) is restored from the
// automatic backup; --dry-run never writes the identity file; a UTF-8 BOM does
// not make a valid file unusable.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SH = "apps/web/public/install.sh";
const INSTALL_PS1 = "apps/web/public/install.ps1";
const API_KEY = "mc_test_api_key_for_identity";

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/** The API-key-only derivation the installer must implement. */
function deriveIdentity(apiKey) {
  const seed = `${apiKey}:memory-crystal-local`;
  const localToken = `mc_local_${sha256Hex(seed).slice(0, 40)}`;
  return { userId: `local_${sha256Hex(`user:${seed}`).slice(0, 24)}`, localToken, localTokenSha256: sha256Hex(localToken) };
}

/** The version-bound derivation installers before 0.9.0 used (never minted any more; only recognised). */
function deriveLegacyVersionedIdentity(apiKey, version) {
  const seed = `${apiKey}:${version}:memory-crystal-local`;
  const localToken = `mc_local_${sha256Hex(seed).slice(0, 40)}`;
  return { userId: `local_${sha256Hex(`user:${seed}`).slice(0, 24)}`, localToken, localTokenSha256: sha256Hex(localToken) };
}

function bridgeFile(identity, createdBy = "memory-crystal installer 0.8.22") {
  return `${JSON.stringify({
    schemaVersion: 1,
    backend: "local-convex",
    userId: identity.userId,
    localToken: identity.localToken,
    localTokenSha256: identity.localTokenSha256,
    hostedEntitlement: "validated-before-local-provisioning",
    createdBy,
  }, null, 2)}\n`;
}

function tmpHome(t) {
  const home = mkdtempSync(join(tmpdir(), "mc-local-identity-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".memorycrystal"), { recursive: true });
  return home;
}

function authPath(home) {
  return join(home, ".memorycrystal", "local-auth.json");
}

function backupPath(home, stamp) {
  return join(home, ".memorycrystal", `.local-auth.json.memory-crystal.${stamp}.bak`);
}

function listBackups(home) {
  return readdirSync(join(home, ".memorycrystal")).filter((name) => /^\.local-auth\.json\.memory-crystal\..*\.bak$/.test(name)).sort();
}

function runInstaller(home, extraArgs = [], { apiKey = API_KEY } = {}) {
  const result = spawnSync(
    "bash",
    [INSTALL_SH, "--dry-run", "--yes", "--backend", "local", "--targets", "generic-mcp", ...extraArgs],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, HOME: home, MEMORY_CRYSTAL_HOME: join(home, ".memorycrystal"), MEMORY_CRYSTAL_API_KEY: apiKey },
    },
  );
  assert.equal(result.status, 0, `install.sh failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function readAuth(home) {
  return JSON.parse(readFileSync(authPath(home), "utf8"));
}

/**
 * Run the real provision_local_auth_bridge (and its helpers) extracted from
 * install.sh so the resulting API_KEY, which the dry run never writes anywhere,
 * can be observed directly. This is also the only path that writes the file:
 * the full installer is exercised in --dry-run, which is read-only for identity.
 */
function runProvisionFunction(home, { apiKey = API_KEY, version = "0.9.0", dryRun = false } = {}) {
  // The auth functions include a heredoc, so they must be sourced as one block
  // rather than eval'd individually. The range have_json_reader through
  // install_local_backend_artifact covers every callee and direct dependency.
  const script = `
    set -uo pipefail
    DRY_RUN=${dryRun ? 1 : 0}
    source <(sed -n '/^json_field()/,/^install_local_backend_artifact()/{ /^install_local_backend_artifact()/q; p; }' "${INSTALL_SH}")
    BACKEND_MODE=local
    LOCAL_ROOT="$MEMORY_CRYSTAL_HOME"
    LOCAL_BACKEND_ROOT="$LOCAL_ROOT/local-backend"
    LOCAL_BACKEND_VERSION="${version}"
    INSTALLER_VERSION="${version}"
    API_KEY="${apiKey}"
    log() { :; }; ok() { printf 'OK:%s\\n' "$*"; }; warn() { printf 'WARN:%s\\n' "$*"; }
    fail() { printf 'FAIL:%s\\n' "$*"; exit 1; }
    provision_local_auth_bridge
    printf 'API_KEY=%s\\n' "$API_KEY"
  `;
  const result = spawnSync("bash", ["-c", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: home, MEMORY_CRYSTAL_HOME: join(home, ".memorycrystal") },
  });
  assert.equal(result.status, 0, `provision_local_auth_bridge failed\\n${result.stdout}\\n${result.stderr}`);
  const apiKeyLine = result.stdout.split("\n").find((line) => line.startsWith("API_KEY="));
  return { stdout: result.stdout, apiKey: apiKeyLine ? apiKeyLine.slice("API_KEY=".length) : null };
}

test("new identities derive from the API key only, never from the local backend version", (t) => {
  const expected = deriveIdentity(API_KEY);
  const oldVersionHome = tmpHome(t);
  runProvisionFunction(oldVersionHome, { version: "0.8.22" });
  const atOld = readAuth(oldVersionHome);
  assert.equal(atOld.userId, expected.userId, "userId must be the API-key-only derivation");
  assert.equal(atOld.localToken, expected.localToken, "localToken must be the API-key-only derivation");
  assert.equal(atOld.localTokenSha256, expected.localTokenSha256);
  assert.equal(atOld.backend, "local-convex");

  const newVersionHome = tmpHome(t);
  runProvisionFunction(newVersionHome, { version: "0.9.0" });
  const atNew = readAuth(newVersionHome);
  assert.equal(atNew.userId, atOld.userId, "the same API key must give the same local user at every version");
  assert.equal(atNew.localToken, atOld.localToken);

  const otherKeyHome = tmpHome(t);
  runProvisionFunction(otherKeyHome, { apiKey: "mc_other_key_entirely" });
  assert.notEqual(readAuth(otherKeyHome).userId, atOld.userId, "a different API key must give a different local user");

  // The full installer in --dry-run derives the same identity but writes nothing.
  const dryHome = tmpHome(t);
  const dry = runInstaller(dryHome, ["--local-backend-version", "0.9.0"]);
  assert.match(dry.stdout, new RegExp(`Dry-run: would provision local credential bridge at .*local-auth\\.json \\(local user ${expected.userId}\\)`));
  assert.equal(existsSync(authPath(dryHome)), false, "dry-run must not create local-auth.json");
});

test("re-running the installer at the same or a newer version keeps local-auth.json byte-for-byte", (t) => {
  const home = tmpHome(t);
  runProvisionFunction(home, { version: "0.8.22" });
  const first = readFileSync(authPath(home), "utf8");
  const again = runProvisionFunction(home, { version: "0.8.22" });
  assert.match(again.stdout, /Kept existing local credential bridge/);
  assert.equal(readFileSync(authPath(home), "utf8"), first);
  const upgraded = runProvisionFunction(home, { version: "0.9.0" });
  assert.match(upgraded.stdout, /Kept existing local credential bridge/);
  assert.equal(readFileSync(authPath(home), "utf8"), first, "an upgrade must not touch the identity file");
  const dryUpgrade = runInstaller(home, ["--local-backend-version", "0.9.0"]);
  assert.match(dryUpgrade.stdout, /Kept existing local credential bridge/);
  assert.equal(readFileSync(authPath(home), "utf8"), first, "a dry-run upgrade must not touch the identity file");
  assert.deepEqual(readdirSync(join(home, ".memorycrystal")).filter((name) => name.includes("local-auth.json")), ["local-auth.json"], "no backup means no rewrite happened");
});

test("an existing local-auth.json with a valid userId and localToken is kept, even one this installer did not derive", (t) => {
  const home = tmpHome(t);
  const legacyToken = "mc_local_0123456789abcdef0123456789abcdef01234567";
  const legacy = {
    schemaVersion: 1,
    backend: "local-convex",
    userId: "local_legacyidentity00000001",
    localToken: legacyToken,
    localTokenSha256: sha256Hex(legacyToken),
    hostedEntitlement: "validated-before-local-provisioning",
    createdBy: "memory-crystal installer 0.8.22",
  };
  const original = `${JSON.stringify(legacy, null, 2)}\n`;
  writeFileSync(authPath(home), original);

  const result = runInstaller(home, ["--local-backend-version", "0.9.0"]);
  assert.match(result.stdout, /Kept existing local credential bridge/);
  assert.equal(readFileSync(authPath(home), "utf8"), original, "a legacy identity must be kept verbatim");

  const provisioned = runProvisionFunction(home);
  assert.equal(provisioned.apiKey, legacyToken, "the installer must continue with the kept token as API_KEY");
  assert.match(provisioned.stdout, /OK:Kept existing local credential bridge/);
});

test("a kept identity with a missing or stale token hash is repaired without rotating userId or token", (t) => {
  const home = tmpHome(t);
  const token = "mc_local_fedcba9876543210fedcba9876543210fedcba98";
  writeFileSync(authPath(home), `${JSON.stringify({ backend: "local-convex", userId: "local_needsrepair0000000001", localToken: token }, null, 2)}\n`);
  const provisioned = runProvisionFunction(home);
  assert.match(provisioned.stdout, /Kept existing local identity .* repaired its token hash/);
  const repaired = readAuth(home);
  assert.equal(repaired.userId, "local_needsrepair0000000001");
  assert.equal(repaired.localToken, token);
  assert.equal(repaired.localTokenSha256, sha256Hex(token));
  const backups = readdirSync(join(home, ".memorycrystal")).filter((name) => /^\.local-auth\.json\.memory-crystal\..*\.bak$/.test(name));
  assert.equal(backups.length, 1, "the pre-repair file must be backed up, never deleted");
});

test("an unusable local-auth.json is replaced by a fresh derived identity and the old file is backed up", (t) => {
  const home = tmpHome(t);
  writeFileSync(authPath(home), "{}\n");
  const provisioned = runProvisionFunction(home);
  assert.match(provisioned.stdout, /has no usable local identity/);
  assert.match(provisioned.stdout, /backed up next to it first/, "the backup claim is made only on the writing path");
  const fresh = readAuth(home);
  assert.deepEqual(
    { userId: fresh.userId, localToken: fresh.localToken, localTokenSha256: fresh.localTokenSha256 },
    deriveIdentity(API_KEY),
  );
  const backups = readdirSync(join(home, ".memorycrystal")).filter((name) => /^\.local-auth\.json\.memory-crystal\..*\.bak$/.test(name));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, ".memorycrystal", backups[0]), "utf8"), "{}\n");
});

// ── Stranded rotation (round 2, P2) ───────────────────────────────────────────
//
// The live installer asked for backend 0.9.0 from 2026-09-08 while the archive
// was missing. It rotated local-auth.json to the version-bound 0.9.0 identity
// (B) and backed the previous one (A, holding the memories) up, then failed on
// the 404. Keep-existing alone would keep B; the installer must restore A.

const STRANDED_VERSION = "0.9.0";
const identityA = deriveLegacyVersionedIdentity(API_KEY, "0.8.22");
const identityB = deriveLegacyVersionedIdentity(API_KEY, STRANDED_VERSION);

function seedStrandedRotation(home, { backups = { "20260910T120000Z": identityA }, current = identityB } = {}) {
  for (const [stamp, identity] of Object.entries(backups)) writeFileSync(backupPath(home, stamp), bridgeFile(identity));
  writeFileSync(authPath(home), bridgeFile(current, "memory-crystal installer 0.9.0"));
}

test("(i) a stranded 0.9.0 rotation is restored from the newest differing backup and logged", (t) => {
  const home = tmpHome(t);
  // Newest backup is a copy of B (a second failed re-run backs up the rotated
  // file); the older one is A. The newest backup with a DIFFERENT usable
  // identity wins, so A is restored.
  seedStrandedRotation(home, { backups: { "20260910T120000Z": identityA, "20260911T090000Z": identityB } });
  const backupA = backupPath(home, "20260910T120000Z");
  const backupABytes = readFileSync(backupA, "utf8");
  const backupBBytes = readFileSync(backupPath(home, "20260911T090000Z"), "utf8");
  const strandedBytes = readFileSync(authPath(home), "utf8");

  const provisioned = runProvisionFunction(home, { version: STRANDED_VERSION });
  assert.match(
    provisioned.stdout,
    new RegExp(`OK:Restored your previous local identity from ${backupA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(a failed 0\\.9\\.0 install had rotated it\\)`),
  );
  const restored = readAuth(home);
  assert.equal(restored.userId, identityA.userId, "the pre-rotation user must be restored");
  assert.equal(restored.localToken, identityA.localToken);
  assert.equal(restored.localTokenSha256, identityA.localTokenSha256);
  assert.equal(provisioned.apiKey, identityA.localToken, "the installer must continue with the restored token");

  const backups = listBackups(home);
  assert.equal(backups.length, 3, "the stranded file is backed up by the normal writer; nothing is deleted");
  assert.equal(readFileSync(backupA, "utf8"), backupABytes, "backups are only read");
  assert.equal(readFileSync(backupPath(home, "20260911T090000Z"), "utf8"), backupBBytes);
  const newBackup = backups.find((name) => !["20260910T120000Z", "20260911T090000Z"].some((stamp) => name.includes(stamp)));
  assert.equal(readFileSync(join(home, ".memorycrystal", newBackup), "utf8"), strandedBytes, "the stranded identity is preserved as a backup");

  // A second run now keeps the restored identity: the restore is not repeated.
  const again = runProvisionFunction(home, { version: STRANDED_VERSION });
  assert.match(again.stdout, /OK:Kept existing local credential bridge/);
  assert.equal(readAuth(home).userId, identityA.userId);
  assert.equal(listBackups(home).length, 3);
});

test("(ii) the rotated identity is kept when this version's backend was actually installed", (t) => {
  const home = tmpHome(t);
  seedStrandedRotation(home);
  mkdirSync(join(home, ".memorycrystal", "local-backend", STRANDED_VERSION, "bin"), { recursive: true });
  writeFileSync(join(home, ".memorycrystal", "local-backend", STRANDED_VERSION, "bin", "doctor"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  const before = readFileSync(authPath(home), "utf8");
  const provisioned = runProvisionFunction(home, { version: STRANDED_VERSION });
  assert.match(provisioned.stdout, /OK:Kept existing local credential bridge/);
  assert.doesNotMatch(provisioned.stdout, /Restored your previous local identity/);
  assert.equal(readFileSync(authPath(home), "utf8"), before);
  assert.equal(provisioned.apiKey, identityB.localToken);
  assert.equal(listBackups(home).length, 1, "no rewrite, so no new backup");
});

test("(iii) the rotated identity is kept when no backup holds a different usable identity", (t) => {
  const noBackupHome = tmpHome(t);
  seedStrandedRotation(noBackupHome, { backups: {} });
  const noBackup = runProvisionFunction(noBackupHome, { version: STRANDED_VERSION });
  assert.match(noBackup.stdout, /OK:Kept existing local credential bridge/);
  assert.equal(readAuth(noBackupHome).userId, identityB.userId);

  const sameIdHome = tmpHome(t);
  seedStrandedRotation(sameIdHome, { backups: { "20260911T090000Z": identityB } });
  const before = readFileSync(authPath(sameIdHome), "utf8");
  const sameId = runProvisionFunction(sameIdHome, { version: STRANDED_VERSION });
  assert.match(sameId.stdout, /OK:Kept existing local credential bridge/);
  assert.equal(readFileSync(authPath(sameIdHome), "utf8"), before);

  const unusableHome = tmpHome(t);
  seedStrandedRotation(unusableHome, { backups: {} });
  writeFileSync(backupPath(unusableHome, "20260910T120000Z"), "{}\n");
  const unusable = runProvisionFunction(unusableHome, { version: STRANDED_VERSION });
  assert.match(unusable.stdout, /OK:Kept existing local credential bridge/);
  assert.equal(readAuth(unusableHome).userId, identityB.userId);
});

test("(iv) an identity that is not the legacy derivation for the target version is kept even with a differing backup", (t) => {
  const apiKeyOnlyHome = tmpHome(t);
  seedStrandedRotation(apiKeyOnlyHome, { current: deriveIdentity(API_KEY) });
  const before = readFileSync(authPath(apiKeyOnlyHome), "utf8");
  const kept = runProvisionFunction(apiKeyOnlyHome, { version: STRANDED_VERSION });
  assert.match(kept.stdout, /OK:Kept existing local credential bridge/);
  assert.equal(readFileSync(authPath(apiKeyOnlyHome), "utf8"), before);

  // B is the 0.9.0 derivation, but the target is 0.9.1: not a stranded 0.9.1 rotation.
  const otherVersionHome = tmpHome(t);
  seedStrandedRotation(otherVersionHome);
  const otherVersion = runProvisionFunction(otherVersionHome, { version: "0.9.1" });
  assert.match(otherVersion.stdout, /OK:Kept existing local credential bridge/);
  assert.equal(readAuth(otherVersionHome).userId, identityB.userId);

  // Same file, but a different hosted key was passed: the derivation does not match.
  const otherKeyHome = tmpHome(t);
  seedStrandedRotation(otherKeyHome);
  const otherKey = runProvisionFunction(otherKeyHome, { version: STRANDED_VERSION, apiKey: "mc_other_key_entirely" });
  assert.match(otherKey.stdout, /OK:Kept existing local credential bridge/);
  assert.equal(readAuth(otherKeyHome).userId, identityB.userId);
});

test("(v) --dry-run is read-only for identity in every case", (t) => {
  const cases = {
    stranded: (home) => seedStrandedRotation(home),
    "hash repair needed": (home) => writeFileSync(authPath(home), `${JSON.stringify({ backend: "local-convex", userId: "local_needsrepair0000000001", localToken: "mc_local_fedcba9876543210fedcba9876543210fedcba98" })}\n`),
    unusable: (home) => writeFileSync(authPath(home), "{}\n"),
    "valid with BOM": (home) => writeFileSync(authPath(home), `﻿${bridgeFile(deriveIdentity(API_KEY))}`),
    missing: () => {},
  };
  const expectedLog = {
    stranded: /WARN:Dry-run: would restore your previous local identity from .*\.local-auth\.json\.memory-crystal\.20260910T120000Z\.bak \(a failed 0\.9\.0 install had rotated it/,
    "hash repair needed": /WARN:Dry-run: would keep the local identity in .* and repair its token hash/,
    unusable: /WARN:Dry-run: existing .* has no usable local identity; would back it up next to itself and provision/,
    "valid with BOM": /OK:Kept existing local credential bridge/,
    missing: /WARN:Dry-run: would provision local credential bridge at/,
  };
  for (const [name, seed] of Object.entries(cases)) {
    const home = tmpHome(t);
    seed(home);
    const before = existsSync(authPath(home)) ? readFileSync(authPath(home)) : null;
    const backupsBefore = listBackups(home);
    const dry = runProvisionFunction(home, { version: STRANDED_VERSION, dryRun: true });
    assert.match(dry.stdout, expectedLog[name], `case ${name}: dry-run must log what would happen`);
    assert.doesNotMatch(dry.stdout, /backed up next to it/, `case ${name}: dry-run must not claim a backup it did not create`);
    if (before === null) assert.equal(existsSync(authPath(home)), false, `case ${name}: dry-run must not create local-auth.json`);
    else assert.deepEqual(readFileSync(authPath(home)), before, `case ${name}: dry-run must leave local-auth.json bytes unchanged`);
    assert.deepEqual(listBackups(home), backupsBefore, `case ${name}: dry-run must not create backups`);
    if (name === "stranded") assert.equal(dry.apiKey, identityA.localToken, "dry-run continues with the identity it would restore");

    // The full installer's --dry-run path agrees.
    const full = runInstaller(home, ["--local-backend-version", STRANDED_VERSION]);
    if (before === null) assert.equal(existsSync(authPath(home)), false, `case ${name}: full dry-run must not create local-auth.json`);
    else assert.deepEqual(readFileSync(authPath(home)), before, `case ${name}: full dry-run must leave local-auth.json bytes unchanged`);
    assert.deepEqual(listBackups(home), backupsBefore);
    assert.match(full.stdout, expectedLog[name].source.startsWith("WARN:") || expectedLog[name].source.startsWith("OK:") ? new RegExp(expectedLog[name].source.replace(/^(WARN|OK):/, "")) : expectedLog[name]);
  }
});

test("(vi) a BOM-prefixed valid local-auth.json is kept, not treated as unusable", (t) => {
  const home = tmpHome(t);
  const identity = deriveIdentity(API_KEY);
  const original = `﻿${bridgeFile(identity)}`;
  writeFileSync(authPath(home), original);
  assert.deepEqual([...readFileSync(authPath(home)).subarray(0, 3)], [0xef, 0xbb, 0xbf], "fixture must carry a UTF-8 BOM");
  const provisioned = runProvisionFunction(home, { version: STRANDED_VERSION });
  assert.match(provisioned.stdout, /OK:Kept existing local credential bridge/);
  assert.doesNotMatch(provisioned.stdout, /no usable local identity/);
  assert.equal(provisioned.apiKey, identity.localToken);
  assert.equal(readFileSync(authPath(home), "utf8"), original, "a kept file is left byte-for-byte, BOM included");
  assert.deepEqual(listBackups(home), []);

  // A BOM-prefixed backup is readable for the stranded-rotation restore too.
  const strandedHome = tmpHome(t);
  seedStrandedRotation(strandedHome, { backups: {} });
  writeFileSync(backupPath(strandedHome, "20260910T120000Z"), `﻿${bridgeFile(identityA)}`);
  const restored = runProvisionFunction(strandedHome, { version: STRANDED_VERSION });
  assert.match(restored.stdout, /OK:Restored your previous local identity/);
  assert.equal(readAuth(strandedHome).userId, identityA.userId);
});

test("the identity file survives a reader-less host (no python3/node on PATH)", (t) => {
  const home = tmpHome(t);
  const token = "mc_local_0000111122223333444455556666777788889999";
  const original = `${JSON.stringify({ schemaVersion: 1, backend: "local-convex", userId: "local_readerlesshost00000001", localToken: token, localTokenSha256: sha256Hex(token) }, null, 2)}\n`;
  writeFileSync(authPath(home), original);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  // Only the tools install.sh needs for hashing and text handling; no JSON interpreter.
  for (const tool of ["bash", "sed", "grep", "cut", "head", "cat", "mkdir", "mktemp", "mv", "rm", "chmod", "dirname", "basename", "awk", "printf", "cp", "shasum", "sha256sum", "openssl", "date", "tr", "sort", "uniq", "wc", "find", "env", "ls", "touch", "tail", "expr", "id", "uname", "true", "false", "test", "["]) {
    const found = spawnSync("bash", ["-lc", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found && !existsSync(join(bin, tool))) spawnSync("ln", ["-s", found, join(bin, tool)]);
  }
  // Source the whole identity block (json_field .. install_local_backend_artifact)
  // as one unit: write_local_auth_bridge carries a heredoc whose JSON closing
  // brace sits in column 0, so a per-function `/^name()/,/^}/` extraction would
  // truncate it and the write path would silently not exist.
  const run = (extra = "") => spawnSync("bash", ["-c", `
    set -uo pipefail
    DRY_RUN=0
    source <(sed -n '/^json_field()/,/^install_local_backend_artifact()/{ /^install_local_backend_artifact()/q; p; }' "${INSTALL_SH}")
    BACKEND_MODE=local; LOCAL_ROOT="$MEMORY_CRYSTAL_HOME"; LOCAL_BACKEND_ROOT="$LOCAL_ROOT/local-backend"; LOCAL_BACKEND_VERSION=0.9.0; INSTALLER_VERSION=0.9.0; API_KEY="${API_KEY}"
    log() { :; }; ok() { printf 'OK:%s\\n' "$*"; }; warn() { printf 'WARN:%s\\n' "$*"; }; fail() { printf 'FAIL:%s\\n' "$*"; exit 1; }
    command -v node >/dev/null 2>&1 && { echo "node still on PATH"; exit 3; }
    command -v python3 >/dev/null 2>&1 && { echo "python3 still on PATH"; exit 3; }
    ${extra}
    provision_local_auth_bridge
    printf 'API_KEY=%s\\n' "$API_KEY"
  `], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { HOME: home, MEMORY_CRYSTAL_HOME: join(home, ".memorycrystal"), PATH: bin, TMPDIR: home },
  });
  const result = run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK:Kept existing local credential bridge/);
  assert.match(result.stdout, new RegExp(`API_KEY=${token}`));
  assert.equal(readFileSync(authPath(home), "utf8"), original);

  // The stranded-rotation restore also works without a JSON interpreter.
  seedStrandedRotation(home);
  const restored = run();
  assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
  assert.match(restored.stdout, /OK:Restored your previous local identity from .* \(a failed 0\.9\.0 install had rotated it\)/);
  assert.match(restored.stdout, new RegExp(`API_KEY=${identityA.localToken}`));
  assert.equal(readAuth(home).userId, identityA.userId);
});

test("install.ps1 mirrors the identity contract", (t) => {
  const ps1 = readFileSync(join(REPO_ROOT, INSTALL_PS1), "utf8");
  assert.match(ps1, /\$seed = "\$script:ApiKey`:memory-crystal-local"/, "ps1 seed must be API-key-only");
  assert.doesNotMatch(ps1, /\$LocalBackendVersion`:memory-crystal-local"\n\s+\$token/, "ps1 seed must not carry the version");
  assert.match(ps1, /function Test-LocalAuthIdentityUsable\(\[string\]\$UserId, \[string\]\$Token\)/);
  assert.match(ps1, /'\^local_\[A-Za-z0-9_-\]\{8,\}\$'/, "ps1 must accept the same userId shape as convex-local-import-auth.ts");
  assert.match(ps1, /if \(Test-Path -LiteralPath \$path\) \{[\s\S]*Get-LocalAuthField \$existing "localToken"[\s\S]*Kept existing local credential bridge/);
  assert.match(ps1, /Kept existing local identity in \$path and repaired its token hash/);
  assert.doesNotMatch(ps1, /Remove-Item[^\n]*local-auth\.json/, "ps1 must never delete local-auth.json");

  // Stranded rotation (round 2): the same three conditions, the same restore path.
  assert.match(ps1, /function Get-LegacyVersionedLocalUserId\(\[string\]\$Key, \[string\]\$Version\) \{\n\s+return "local_" \+ \(New-Sha256 "user:\$Key`:\$Version`:memory-crystal-local"\)\.Substring\(0, 24\)/, "ps1 must recognise the legacy version-bound derivation");
  assert.match(ps1, /function Test-LocalBackendVersionInstalled \{[\s\S]*"local-backend\/\$LocalBackendVersion"[\s\S]*@\("bin\/doctor", "bin\/doctor\.sh", "bin\/doctor\.ps1"\)/, "ps1 must check this version's backend dir for a doctor entrypoint");
  assert.match(ps1, /function Find-StrandedLocalAuthBackup\(\[string\]\$Path, \[string\]\$CurrentUserId\) \{[\s\S]*-Filter "\.\$name\.memory-crystal\.\*\.bak"[\s\S]*Sort-Object -Property Name -Descending[\s\S]*\$userId -ne \$CurrentUserId -and \(Test-LocalAuthIdentityUsable \$userId \$token\)/, "ps1 must pick the newest Protect-Config backup with a different usable identity");
  assert.match(ps1, /if \(\$existingUserId -eq \(Get-LegacyVersionedLocalUserId \(\[string\]\$script:ApiKey\) \$LocalBackendVersion\) -and -not \(Test-LocalBackendVersionInstalled\)\) \{\n\s+\$stranded = Find-StrandedLocalAuthBackup \$path \$existingUserId/, "ps1 must gate the restore on all three conditions");
  assert.match(ps1, /Write-LocalAuthBridge \$path \$stranded\.UserId \$stranded\.Token \(New-Sha256 \$stranded\.Token\)\n\s+Ok "Restored your previous local identity from \$\(\$stranded\.Path\) \(a failed \$LocalBackendVersion install had rotated it\)"\n\s+\}\n\s+\$script:ApiKey = \$stranded\.Token/, "ps1 must restore through the normal writer, log it and continue with the restored token");
  assert.doesNotMatch(ps1, /Remove-Item[^\n]*\.bak/, "ps1 must never delete backups");

  // Dry-run is read-only for identity; the backup claim is conditional.
  assert.match(ps1, /if \(\$DryRun\) \{\n\s+Warn "Dry-run: would restore your previous local identity from/);
  assert.match(ps1, /if \(\$DryRun\) \{\n\s+Warn "Dry-run: would keep the local identity in \$path and repair its token hash \(local user \$existingUserId\)"\n\s+return\n\s+\}\n\s+Write-LocalAuthBridge/);
  assert.match(ps1, /if \(\$DryRun\) \{\n\s+Warn "Dry-run: existing \$path has no usable local identity; would back it up next to itself and provision a new local credential bridge"\n\s+\} else \{\n\s+Warn "Existing \$path has no usable local identity; provisioning a new local credential bridge \(the previous file is backed up next to it first\)"/);
  assert.match(ps1, /if \(\$DryRun\) \{\n\s+Warn "Dry-run: would provision local credential bridge at \$path \(local user \$userId\)"\n\s+\$script:ApiKey = \$token\n\s+return\n\s+\}\n\s+Write-LocalAuthBridge \$path \$userId \$token \$hash/);
  const provisionBody = ps1.slice(ps1.indexOf("function Provision-LocalAuthBridge {"), ps1.indexOf("function Complete-LocalBackendGate {"));
  for (const match of provisionBody.matchAll(/Write-LocalAuthBridge/g)) {
    const preceding = provisionBody.slice(0, match.index);
    const lastDryCheck = preceding.lastIndexOf("if ($DryRun)");
    assert.ok(lastDryCheck >= 0, "every ps1 identity write must sit behind a dry-run check");
  }

  // BOM tolerance.
  assert.match(ps1, /function Read-LocalAuthFile\(\[string\]\$Path\) \{[\s\S]*\[int\]\[char\]\$raw\[0\] -eq 0xFEFF\) \{ \$raw = \$raw\.Substring\(1\) \}/, "ps1 must strip a leading BOM before parsing");
  assert.match(ps1, /\$existing = Read-LocalAuthFile \$path/);

  const sh = readFileSync(join(REPO_ROOT, INSTALL_SH), "utf8");
  assert.match(sh, /seed="\$\{API_KEY:-dry-run\}:memory-crystal-local"/);
  assert.doesNotMatch(sh, /\$LOCAL_BACKEND_VERSION:memory-crystal-local/);
  assert.doesNotMatch(sh, /rm -f[^\n]*local-auth\.json/, "install.sh must never delete local-auth.json");
  assert.doesNotMatch(sh, /rm -f[^\n]*\.bak/, "install.sh must never delete backups");

  const pwsh = ["pwsh", "powershell"].find((cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0);
  if (!pwsh) {
    console.warn("SKIP (loud): no PowerShell runtime on PATH — install.ps1 identity behaviour was asserted at source level only");
    return;
  }
  const home = tmpHome(t);
  const env = { ...process.env, HOME: home, USERPROFILE: home, MEMORY_CRYSTAL_HOME: join(home, ".memorycrystal"), MEMORY_CRYSTAL_API_KEY: API_KEY };
  const args = ["-NoProfile", "-File", INSTALL_PS1, "-DryRun", "-Yes", "-Backend", "local", "-Targets", "generic-mcp"];
  const first = spawnSync(pwsh, [...args, "-LocalBackendVersion", "0.8.22"], { cwd: REPO_ROOT, encoding: "utf8", env });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, new RegExp(`Dry-run: would provision local credential bridge at .*local-auth\\.json \\(local user ${deriveIdentity(API_KEY).userId}\\)`));
  assert.equal(existsSync(authPath(home)), false, "ps1 dry-run must not create local-auth.json");
  const written = bridgeFile(deriveIdentity(API_KEY));
  writeFileSync(authPath(home), written);
  const second = spawnSync(pwsh, [...args, "-LocalBackendVersion", "0.9.0"], { cwd: REPO_ROOT, encoding: "utf8", env });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /Kept existing local credential bridge/);
  assert.equal(readFileSync(authPath(home), "utf8"), written);
  seedStrandedRotation(home);
  const strandedBytes = readFileSync(authPath(home), "utf8");
  const third = spawnSync(pwsh, [...args, "-LocalBackendVersion", "0.9.0"], { cwd: REPO_ROOT, encoding: "utf8", env });
  assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
  assert.match(third.stdout, /Dry-run: would restore your previous local identity from .*\.local-auth\.json\.memory-crystal\.20260910T120000Z\.bak \(a failed 0\.9\.0 install had rotated it/);
  assert.equal(readFileSync(authPath(home), "utf8"), strandedBytes, "ps1 dry-run must not restore");
});

for (const installer of [
  "apps/web/public/install-claude-mcp.sh",
  "apps/web/public/install-codex-mcp.sh",
  "apps/web/public/install-droid-mcp.sh",
  "apps/web/public/install-openclaw-plugin.sh",
  "scripts/install-openclaw.sh",
]) {
  test(`${installer}: device cap refusal exits immediately with dashboard guidance`, (t) => {
    const home = tmpHome(t);
    const source = readFileSync(join(REPO_ROOT, installer), "utf8");
    const flow = source.match(/^(?:start_)?device_auth_flow\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(flow, "device flow function must be found");
    // Run the shipped function with an in-process status server; no HTTP or browser.
    const harness = `
set -eu
_CRYSTAL_JSON_TOOL=node
DEVICE_START_URL=start
DEVICE_STATUS_URL=status
curl() {
  case "$*" in
    *status*) printf '%s' '{"status":"api_key_limit"}' ;;
    *) printf '%s' '{"device_code":"test","user_code":"TEST","verification_url":"https://example.invalid"}' ;;
  esac
}
json_get() { node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.parse(s)[process.argv[1]]||""))' "$1"; }
open_url() { return 0; }
open_authorization_url() { return 0; }
sleep() { echo unexpected-poll-retry; exit 99; }
${flow}
if ! ${flow.startsWith("start_") ? "start_device_auth_flow" : "device_auth_flow"}; then echo unexpected-manual-key-fallback; fi
echo unexpected-success
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Too many active API keys; revoke unused keys in the dashboard/);
    assert.doesNotMatch(result.stdout, /unexpected-/);
  });
}

test("PowerShell device cap refusal uses Fail with dashboard guidance", (t) => {
  const source = readFileSync(join(REPO_ROOT, INSTALL_PS1), "utf8");
  const flow = source.match(/^function Start-BrowserAuth \{[\s\S]*?^\}/m)?.[0];
  assert.ok(flow);
  assert.match(flow, /if \(\$status.status -eq "api_key_limit"\) \{ Fail "Too many active API keys; revoke unused keys in the dashboard" \}/);
  const pwsh = ["pwsh", "powershell"].find((cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0);
  if (!pwsh) { t.diagnostic("PowerShell unavailable; static assertion used"); return; }
  const home = tmpHome(t);
  const result = spawnSync(pwsh, ["-NoProfile", "-Command", `
$DryRun = $false
$Yes = $false
function Info { param($Message) }
function Start-Process { }
function Start-Sleep { }
function Fail { param($Message) Write-Output $Message; exit 1 }
function Invoke-RestMethod { return @{ status = 'api_key_limit'; device_code = 'test'; verification_url = 'https://example.invalid' } }
${flow}
Start-BrowserAuth
`], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, USERPROFILE: home } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Too many active API keys; revoke unused keys in the dashboard/);
});
