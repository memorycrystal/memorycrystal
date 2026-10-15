import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { decideBuildInfo, renderBuildInfoModule, PLACEHOLDER_MODULE } from "./lib/deploy-build-info.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(repoRoot, "scripts/convex-deploy-self-hosted.mjs");

test("decideBuildInfo refuses a dirty tree unless --allow-dirty", () => {
  const clean = decideBuildInfo({ porcelain: "", allowDirty: false, commit: "abc", now: Date.parse("2026-09-26T00:00:00.000Z") });
  assert.equal(clean.ok, true);
  assert.equal(clean.info.dirty, false);
  assert.equal(clean.info.source, "generated");
  assert.match(renderBuildInfoModule(clean.info), /commit: "abc"/);
  const dirty = decideBuildInfo({ porcelain: " M convex/schema.ts\n", allowDirty: false, commit: "abc", now: 0 });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.code, 2);
  const allowed = decideBuildInfo({ porcelain: " M convex/schema.ts\n", allowDirty: true, commit: "abc", now: 0 });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.info.dirty, true);
});

test("dry-run restores the placeholder and a dirty tree does not write", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "mc-deploy-"));
  const bin = resolve(dir, "bin");
  mkdirSync(bin);
  const gitStub = resolve(bin, "git");
  writeFileSync(gitStub, '#!/bin/sh\ncase "$*" in *status*) printf "%s" "$TEST_PORCELAIN" ;; *rev-parse*) printf "abc123" ;; *) exit 99 ;; esac\n');
  chmodSync(gitStub, 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, TEST_PORCELAIN: "" };
  mkdirSync(resolve(dir, "convex/crystal"), { recursive: true });
  const modulePath = resolve(dir, "convex/crystal/buildInfo.generated.ts");
  writeFileSync(modulePath, PLACEHOLDER_MODULE);
  const before = readFileSync(modulePath);

  const clean = spawnSync(process.execPath, [script, "--dry-run", "--git-dir", dir, "--module-path", modulePath], { encoding: "utf8", env });
  assert.equal(clean.status, 0, clean.stderr);
  const stamped = JSON.parse(clean.stdout);
  assert.equal(stamped.source, "generated");
  assert.equal(stamped.dirty, false);
  assert.equal(stamped.commit.length > 0, true);
  assert.notEqual(stamped.commit, "unknown");
  assert.equal(readFileSync(modulePath, "utf8"), before.toString());

  env.TEST_PORCELAIN = "?? dirty.txt";
  const refused = spawnSync(process.execPath, [script, "--dry-run", "--git-dir", dir, "--module-path", modulePath], { encoding: "utf8", env });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /dirty tree/);
  assert.equal(readFileSync(modulePath, "utf8"), before.toString());

  const failedEnv = spawnSync(process.execPath, [script, "--allow-dirty", "--git-dir", dir, "--module-path", modulePath], {
    encoding: "utf8", env: { ...env, CONVEX_SELF_HOSTED_URL: "http://fixture.test" },
  });
  assert.equal(failedEnv.status, 2);
  assert.match(failedEnv.stderr, /partial self-hosted credentials/);
  assert.equal(readFileSync(modulePath, "utf8"), before.toString());

  const allowed = spawnSync(process.execPath, [script, "--dry-run", "--allow-dirty", "--git-dir", dir, "--module-path", modulePath], { encoding: "utf8", env });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).dirty, true);
  assert.equal(readFileSync(modulePath, "utf8"), before.toString());
});
