#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { findUnresolvedRelativeImports } from "./lib/relative-import-check.mjs";
import { findPublicArchiveLeaks } from "./lib/public-scrub.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");
const runPostgres = args.has("--postgres");
const install = args.has("--install") || args.has("--docker") || runPostgres;
const runDocker = args.has("--docker");

// CRYSTAL_TEST_ARTIFACT_ROOT=<unpacked archive dir> runs every assertion on an
// existing tree (for example the committed release archive, unpacked) instead
// of repackaging from the working tree. The Docker and Postgres variants
// receive the same root. The provided tree is never deleted.
const providedRoot = process.env.CRYSTAL_TEST_ARTIFACT_ROOT ? resolve(process.env.CRYSTAL_TEST_ARTIFACT_ROOT) : null;
const artifact = providedRoot ?? mkdtempSync(join(tmpdir(), "memorycrystal-local-artifact-"));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
  }
  return result;
}

try {
  if (providedRoot) {
    assert.ok(existsSync(providedRoot) && statSync(providedRoot).isDirectory(), `CRYSTAL_TEST_ARTIFACT_ROOT is not a directory: ${providedRoot}`);
    assert.ok(existsSync(join(providedRoot, "manifest.json")), `CRYSTAL_TEST_ARTIFACT_ROOT has no manifest.json: ${providedRoot}`);
    console.log(`Testing provided artifact root: ${providedRoot}`);
  } else {
    run("node", ["scripts/package-local-backend.mjs", "--version", "artifact-smoke", "--out", artifact]);
  }
  const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8"));
  assert.equal(manifest.name, "memorycrystal-local-backend");
  assert.ok(manifest.files.length > 100, "artifact manifest should contain the full local backend");
  assert.equal(existsSync(join(artifact, "convex/crystal/adminEmails.ts")), true);
  assert.equal(existsSync(join(artifact, "convex/crystal/adminSupport.ts")), true);
  assert.equal(existsSync(join(artifact, "convex/crystal/adminSettings/resolvers.ts")), true);
  assert.equal(existsSync(join(artifact, "convex/crystal/adminSettings/mutations.ts")), false);
  assert.equal(existsSync(join(artifact, "convex/crystal/adminSettings/queries.ts")), false);
  assert.equal(existsSync(join(artifact, "convex/crystal/polarWebhook.ts")), false);
  assert.equal(existsSync(join(artifact, "convex/crystal/polarUnmatchedEvents.ts")), false);
  assert.doesNotMatch(
    readFileSync(join(artifact, "convex/http.ts"), "utf8"),
    /polarWebhook|telemetryPushHandler|mcpPrivateMemoryImport/,
  );
  assert.doesNotMatch(
    readFileSync(join(artifact, "convex/crons.ts"), "utf8"),
    /internal\.cloud|adminSettings\.mutations\.pruneStaleStagingRows/,
  );
  // Hosted billing internals must not ship (product IDs are shape-checked so
  // this script carries none of them).
  for (const relPath of ["convex/crystal/userProfiles.ts", "convex/crystal/stats.ts"]) {
    assert.doesNotMatch(
      readFileSync(join(artifact, relPath), "utf8"),
      /PRODUCT_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/,
      `${relPath} still carries a hosted billing product ID`,
    );
  }
  assert.doesNotMatch(
    readFileSync(join(artifact, "convex/crystal/userProfiles.ts"), "utf8"),
    /getCurrentUserBillingInfo|getCurrentUserCheckoutContext|getByPolarCustomerInternal|getByPolarSubscriptionInternal|updateSubscriptionInternal/,
  );
  assert.doesNotMatch(
    readFileSync(join(artifact, "convex/schema.ts"), "utf8"),
    /crystalCostRateCards|crystalDailyCostLedger|crystalDailyBusinessLedger|crystalProviderReconciliation|polarUnmatchedEvents|by_polar_subscription|by_polar_customer/,
  );

  const missing = findUnresolvedRelativeImports(join(artifact, "convex"), { displayRoot: artifact })
    .map(({ file, specifier }) => `${file} -> ${specifier}`);
  assert.deepEqual(missing, [], `artifact has unresolved relative imports:\n${missing.join("\n")}`);

  const gate = await findPublicArchiveLeaks(artifact, {
    repoRoot,
    termsFile: process.env.CRYSTAL_CLIENT_TERMS_FILE || join(repoRoot, "scripts/client-terms.private.json"),
  });
  assert.deepEqual(gate.failures, [], `artifact privacy gate failed:\n${gate.failures.join("\n")}`);
  console.log(`Privacy gate passed (mirror needles: ${gate.coverage.mirrorNeedles ? "yes" : "unavailable"}, client stems: ${gate.coverage.clientStems})`);

  if (install) {
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: artifact, stdio: "inherit" });
  }

  if (runDocker || runPostgres) {
    const dockerInfo = spawnSync("docker", ["info"], { encoding: "utf8" });
    if (dockerInfo.status !== 0) {
      throw new Error("Docker artifact verification requested but Docker is unavailable");
    }
  }
  if (runDocker) {
    run("bash", ["scripts/local-backend-artifact-docker.test.sh"], {
      cwd: repoRoot,
      env: { ...process.env, CRYSTAL_TEST_ARTIFACT_ROOT: artifact },
      stdio: "inherit",
    });
  }
  if (runPostgres) {
    run("bash", ["scripts/local-backend-postgres.test.sh"], {
      cwd: repoRoot,
      env: { ...process.env, CRYSTAL_TEST_ARTIFACT_ROOT: artifact },
      stdio: "inherit",
    });
  }

  console.log(`Local backend artifact smoke passed: ${artifact}`);
} finally {
  if (!keep && !providedRoot) rmSync(artifact, { recursive: true, force: true });
}
