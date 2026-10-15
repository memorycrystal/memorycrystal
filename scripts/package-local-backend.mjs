#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  stripHostedControlPlaneCrons,
  stripPrivateHttpRoutes,
} from "./lib/convex-source-sanitizers.mjs";
import {
  applySubstitutionsCounted,
  assertScrubRewriteSet,
  findPublicArchiveLeaks,
  formatRedactedGateFailures,
  isProbablyText,
  loadCheckoutScrubExpectations,
  loadPrivateScrubTerms,
  loadPublicLeakNeedles,
  stripAdminSettingsTables,
  stripCloudControlPlaneTables,
  stripHostedBillingFunctions,
  stripHostedBillingProductIds,
  stripPolarLookupIndexes,
  stripPrivateFinancialTables,
} from "./lib/public-scrub.mjs";
import { collectArchiveEntries, createTarGz, createZip } from "./lib/deterministic-archive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const PACKAGER_OUTPUT_MARKER = ".memorycrystal-packager-output";

function isPackagerEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/** Drop the packager marker at any path depth. walk() and the sanitizer skip that name the same way. */
export function omitPackagerMarkerEntries(entries) {
  return entries.filter((entry) => !entry.archivePath.split("/").includes(PACKAGER_OUTPUT_MARKER));
}

async function main() {
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function readPackageVersion() {
  try { return JSON.parse(readFileSync(join(repoRoot, "plugin/openclaw.plugin.json"), "utf8")).version; } catch { return null; }
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const dryRun = args.includes("--dry-run");
const outArg = arg("--out", null);
if (!outArg && !dryRun) {
  console.error("usage: node scripts/package-local-backend.mjs --out <dir> [--version <version>] [--archive-dir <dir>] [--dry-run]");
  process.exit(2);
}
const version = arg("--version", process.env.CRYSTAL_LOCAL_BACKEND_VERSION || readPackageVersion() || "0.0.0-dev");
// Dry-run never creates or removes `out`; it only prints paths. A missing
// --out is allowed and uses a placeholder that is not a home-directory path.
const out = outArg || "<out>";
const archiveDir = arg("--archive-dir", null);
const measureScrub = arg("--measure-scrub", null);
const rootPackage = readJson(join(repoRoot, "package.json"));
const webPackage = readJson(join(repoRoot, "apps/web/package.json"));
const convexVersion = rootPackage.devDependencies?.convex ?? webPackage.dependencies?.convex ?? "^1.35.1";
const convexAuthVersion = webPackage.dependencies?.["@convex-dev/auth"] ?? "0.0.91";
const standardWebhooksVersion = "^1.0.0";
const fflateVersion = rootPackage.dependencies?.fflate ?? "^0.8.2";

// Reproducible builds: SOURCE_DATE_EPOCH (https://reproducible-builds.org/specs/source-date-epoch/)
// stamps manifest.json and every archive member. When unset, the head commit
// time is used so two builds of the same commit still agree; the wall clock is
// the last resort. The value used is printed and recorded in manifest.json.
function resolveSourceDateEpoch() {
  const fromEnv = process.env.SOURCE_DATE_EPOCH;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!/^\d+$/.test(fromEnv)) throw new Error(`SOURCE_DATE_EPOCH must be an integer number of seconds, got: ${fromEnv}`);
    return { epoch: Number(fromEnv), source: "SOURCE_DATE_EPOCH" };
  }
  const git = spawnSync("git", ["-C", repoRoot, "log", "-1", "--format=%ct"], { encoding: "utf8" });
  if (git.status === 0 && /^\d+\s*$/.test(git.stdout)) return { epoch: Number(git.stdout.trim()), source: "git head commit time" };
  return { epoch: Math.floor(Date.now() / 1000), source: "current time (not reproducible)" };
}
const { epoch: sourceDateEpoch, source: epochSource } = resolveSourceDateEpoch();
const buildTime = new Date(sourceDateEpoch * 1000);

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function copy(src, dest) {
  if (!existsSync(src)) throw new Error(`Missing packaging source: ${relative(repoRoot, src)}`);
  if (dryRun) { console.log(`copy ${relative(repoRoot, src)} -> ${relative(out, dest)}`); return; }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
}

const files = [
  ["infra/convex/docker-compose.yml", "infra/convex/docker-compose.yml"],
  ["infra/convex/.env.local.template", "infra/convex/.env.local.template"],
  ["infra/convex/deployment-env.template.json", "infra/convex/deployment-env.template.json"],
  ["convex", "convex"],
  ["shared", "shared"],
  ["scripts/convex-local-up.sh", "scripts/convex-local-up.sh"],
  ["scripts/convex-local-down.sh", "scripts/convex-local-down.sh"],
  ["scripts/convex-local-doctor.sh", "scripts/convex-local-doctor.sh"],
  ["scripts/convex-local-backup.sh", "scripts/convex-local-backup.sh"],
  ["scripts/convex-local-restore.sh", "scripts/convex-local-restore.sh"],
  ["scripts/convex-local-auth-keys.ts", "scripts/convex-local-auth-keys.ts"],
  ["scripts/convex-local-import-auth.ts", "scripts/convex-local-import-auth.ts"],
  ["scripts/convex-local-provision-env.ts", "scripts/convex-local-provision-env.ts"],
  ["scripts/convex-local-write-env.ts", "scripts/convex-local-write-env.ts"],
];

if (!dryRun) {
  let existing;
  try {
    existing = lstatSync(out);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    let names = null;
    if (existing.isDirectory()) names = readdirSync(out);
    const reusable = names !== null && (names.length === 0 || names.includes(PACKAGER_OUTPUT_MARKER));
    if (!reusable) {
      console.error(`[package-local-backend] refusing to remove ${out}`);
      process.exit(3);
    }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, PACKAGER_OUTPUT_MARKER), "");
}
for (const [src, dest] of files) copy(join(repoRoot, src), join(out, dest));

function removePackagedPath(relPath) {
  if (dryRun) {
    console.log(`remove ${relPath}`);
    return;
  }
  rmSync(join(out, relPath), { recursive: true, force: true });
}

function rewritePackagedText(relPath, rewriteFn) {
  const target = join(out, relPath);
  if (dryRun || !existsSync(target)) return;
  writeFileSync(target, rewriteFn(readFileSync(target, "utf8")));
}

function installSelfHostedOverride(sourceRelPath, targetRelPath) {
  if (dryRun) {
    console.log(`override ${targetRelPath} <- ${sourceRelPath}`);
    return;
  }
  const source = join(out, sourceRelPath);
  const target = join(out, targetRelPath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { force: true });
}

// Schema rewrite for the shipped copy. The self-hosted runtime still reads the
// user-profile entitlement fields (subscriptionStatus/plan/roles: localAuth.ts,
// capacityPolicy, impersonation) and emailCrons uses by_subscription_status, so
// those stay. What goes is hosted-only: finance tables, the Polar lookup
// indexes whose only callers are removed below, cloud control-plane tables and
// the admin settings staging tables. Same rules as the public mirror.
function stripPrivateSchemaTables(content) {
  content = stripPrivateFinancialTables(content);
  content = stripPolarLookupIndexes(content);
  content = stripCloudControlPlaneTables(content);
  content = stripAdminSettingsTables(content);
  return content;
}

// userProfiles.ts ships (deriveTier under CRYSTAL_BACKEND=local, listAllUserIds
// for background jobs), minus the Polar product IDs and the webhook-only
// billing functions; their only callers (polarWebhook.ts, apps/web) do not ship.
function stripHostedBillingFromUserProfiles(content) {
  return stripHostedBillingFunctions(stripHostedBillingProductIds(content));
}

const privatePackagePaths = [
  "convex/cloud",
  "convex/crystal/__tests__",
  // Recall eval harness + gold set. This archive is a PUBLIC download and the
  // gold set carries client-specific channel names; only convex/crystal/__tests__
  // (also removed here) imports these modules, so the self-hosted runtime does
  // not need them. Mirrored by the same exclusion in scripts/sync-public.mjs.
  "convex/crystal/eval",
  // Contributor-only agent notes; excluded from the public mirror as well.
  "convex/AGENTS.md",
  // Production operator tooling (ILL-347); never part of the self-hosted archive.
  // The archive copies individual scripts, so this is an explicit belt-and-braces
  // exclusion mirrored by scripts/sync-public.mjs.
  "scripts/ops",
  "convex/crystal/accountEmailRepair.ts",
  "convex/crystal/admin.ts",
  "convex/crystal/adminKnowledgeBaseCopy.ts",
  "convex/crystal/adminSettings",
  "convex/crystal/adminCostAnalytics.ts",
  "convex/crystal/adminDelete.ts",
  "convex/crystal/adminEmails.ts",
  "convex/crystal/adminGrantTier.ts",
  "convex/crystal/adminSupport.ts",
  "convex/crystal/planPricing.ts",
  "convex/crystal/polarWebhook.ts",
  "convex/crystal/polarUnmatchedEvents.ts",
  "convex/crystal/privateMemoryImport.ts",
];
for (const relPath of privatePackagePaths) removePackagedPath(relPath);
rewritePackagedText("convex/http.ts", stripPrivateHttpRoutes);
rewritePackagedText("convex/crons.ts", stripHostedControlPlaneCrons);
rewritePackagedText("convex/schema.ts", stripPrivateSchemaTables);
rewritePackagedText("convex/crystal/userProfiles.ts", stripHostedBillingFromUserProfiles);
rewritePackagedText("convex/crystal/stats.ts", stripHostedBillingProductIds);
installSelfHostedOverride("convex/selfHosted/adminEmails.ts", "convex/crystal/adminEmails.ts");
installSelfHostedOverride("convex/selfHosted/adminSupport.ts", "convex/crystal/adminSupport.ts");
installSelfHostedOverride("convex/selfHosted/adminSettingsResolvers.ts", "convex/crystal/adminSettings/resolvers.ts");

// This archive is a PUBLIC download, so it needs the same client-name scrubbing
// the git mirror applies in scripts/sync-public.mjs. Without it the archive
// shipped hardcoded client channel names from convex/crystal/knowledgeBases.ts
// and convex/crystal/mcp.ts — present in the 0.8.20 and 0.8.21 archives.
//
// The substitution pairs and the case-insensitive stems live in an excluded
// private data file rather than inline, so this script carries no literal
// client names and can stay on the public mirror. A public checkout has no such
// file, and needs none: the mirrored source is already sanitized, so the pass
// correctly no-ops.
//
// Must run BEFORE walk() so the manifest checksums cover the sanitized bytes.
const CLIENT_TERMS_FILE = process.env.CRYSTAL_CLIENT_TERMS_FILE || join(repoRoot, "scripts/client-terms.private.json");
function sanitizeClientNames(dir, substitutions, root = dir, report = []) {
  if (!substitutions.length) return report;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === PACKAGER_OUTPUT_MARKER) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { sanitizeClientNames(p, substitutions, root, report); continue; }
    const buffer = readFileSync(p);
    if (!isProbablyText(buffer)) continue;
    const before = buffer.toString("utf8");
    const exact = applySubstitutionsCounted(before, substitutions);
    if (exact.text !== before) {
      writeFileSync(p, exact.text);
      report.push({ path: relative(root, p).replaceAll("\\", "/"), count: exact.count });
    }
  }
  return report;
}
const privateTerms = dryRun ? null : loadPrivateScrubTerms(CLIENT_TERMS_FILE);
let scrubbedFiles = [];
if (!dryRun) {
  // A private checkout (one that carries scripts/sync-public.mjs) must have the
  // terms file with at least one stem: without it the scrub is a silent no-op
  // and the gate below has nothing to look for. Fail closed. A public checkout
  // has neither file and needs neither: the mirrored source is already scrubbed.
  const privateCheckout = existsSync(join(repoRoot, "scripts/sync-public.mjs"));
  if (privateCheckout && !privateTerms) {
    console.error(`[package-local-backend] private checkout without a client terms file: ${CLIENT_TERMS_FILE} is missing (restore it, or point CRYSTAL_CLIENT_TERMS_FILE at it). Refusing to build an unscrubbed archive.`);
    process.exit(1);
  }
  if (privateCheckout && privateTerms.stems.length === 0) {
    console.error(`[package-local-backend] private checkout with no client stems: the "stems" list in ${CLIENT_TERMS_FILE} is empty, so the privacy gate could not see a leak. Refusing to build.`);
    process.exit(1);
  }
  if (privateTerms?.substitutions.length) scrubbedFiles = sanitizeClientNames(out, privateTerms.substitutions);
  else console.warn("[package-local-backend] no client-term substitutions loaded (expected on a public checkout)");
  scrubbedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Measurement for the expectation updater. It exits before any archive, and
  // it does not compare, so the file can be regenerated when it is stale.
  if (!measureScrub && privateCheckout) {
    let expectations;
    try {
      expectations = loadCheckoutScrubExpectations(repoRoot, process.env);
    } catch (error) {
      console.error(error.lines?.[0] || error.message);
      process.exit(1);
    }
    if (expectations) {
      try {
        assertScrubRewriteSet(scrubbedFiles, expectations.localBackendArchive, {
          needles: await loadPublicLeakNeedles(repoRoot),
          substitutions: privateTerms?.substitutions ?? [],
          stems: privateTerms?.stems ?? [],
        });
      } catch (error) {
        console.error("[package-local-backend] public scrub rewrite set mismatch");
        for (const line of error.lines ?? []) console.error(line);
        process.exit(1);
      }
    }
  }
}

function pruneIgnored(dir) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory() && ent.name === "__tests__") {
      if (!dryRun) rmSync(p, { recursive: true, force: true });
      continue;
    }
    if (ent.name === ".DS_Store") {
      if (!dryRun) rmSync(p, { force: true });
      continue;
    }
    if (ent.isDirectory()) pruneIgnored(p);
  }
}
if (!dryRun) pruneIgnored(out);

// Privacy gate on the scrubbed tree, before anything is checksummed or archived.
// Reuses the mirror's leak needles (when this checkout has scripts/sync-public.mjs)
// and the private client stems (when the terms file exists); the secret-pattern
// and hosted-path scans always run. Fails closed: a hit aborts the build.
if (!dryRun) {
  const gate = await findPublicArchiveLeaks(out, { repoRoot, termsFile: CLIENT_TERMS_FILE });
  if (gate.failures.length) {
    const needles = await loadPublicLeakNeedles(repoRoot);
    const lines = formatRedactedGateFailures(gate.failures, {
      needles,
      substitutions: privateTerms?.substitutions ?? [],
      stems: privateTerms?.stems ?? [],
    });
    console.error("[package-local-backend] privacy gate failed; refusing to build a leaking archive:");
    console.error(`gate_failures ${gate.failures.length}`);
    for (const line of lines) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`Privacy gate passed (mirror needles: ${gate.coverage.mirrorNeedles ? "yes" : "unavailable on this checkout"}, client stems: ${gate.coverage.clientStems})`);
}

if (measureScrub && !dryRun) {
  const replacements = scrubbedFiles.reduce((sum, file) => sum + file.count, 0);
  writeFileSync(measureScrub, JSON.stringify(scrubbedFiles, null, 2) + "\n");
  console.log(`localBackendArchive files ${scrubbedFiles.length} replacements ${replacements}`);
  process.exit(0);
}

if (!dryRun) {
  writeFileSync(join(out, "package.json"), JSON.stringify({
    name: "memorycrystal-local-backend",
    version,
    private: true,
    engines: rootPackage.engines,
    dependencies: {
      "@convex-dev/auth": convexAuthVersion,
      convex: convexVersion,
      fflate: fflateVersion,
      standardwebhooks: standardWebhooksVersion,
    },
  }, null, 2) + "\n");
}

const binDir = join(out, "bin");
if (!dryRun) mkdirSync(binDir, { recursive: true });
const shellLauncher = `#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ARTIFACT_ROOT"
case "$(basename "$0")" in
  install|install.sh) exec bash scripts/convex-local-up.sh "$@" ;;
  doctor|doctor.sh) exec bash scripts/convex-local-doctor.sh "$@" ;;
  rollback|down|down.sh) exec bash scripts/convex-local-down.sh "$@" ;;
  upgrade|upgrade.sh) echo "Download the newer Memory Crystal local-backend artifact, then run its bin/install." ;;
  *) echo "Unknown local-backend entrypoint: $0" >&2; exit 2 ;;
esac
`;
const psLauncher = `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
$ErrorActionPreference = "Stop"
$ArtifactRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ArtifactRoot
$cmd = Split-Path -Leaf $MyInvocation.MyCommand.Path
switch -Regex ($cmd) {
  'install' { bash scripts/convex-local-up.sh @Rest; break }
  'doctor' { bash scripts/convex-local-doctor.sh @Rest; break }
  'rollback|down' { bash scripts/convex-local-down.sh @Rest; break }
  'upgrade' { Write-Host "Download the newer Memory Crystal local-backend artifact, then run its bin/install.ps1."; break }
  default { throw "Unknown local-backend entrypoint: $cmd" }
}
`;
if (!dryRun) {
  for (const name of ["install", "install.sh", "doctor", "doctor.sh", "rollback", "down", "down.sh", "upgrade", "upgrade.sh"]) {
    const p = join(binDir, name); writeFileSync(p, shellLauncher, { mode: 0o755 });
  }
  for (const name of ["install.ps1", "doctor.ps1", "rollback.ps1", "down.ps1", "upgrade.ps1"]) writeFileSync(join(binDir, name), psLauncher);
}

const manifestFiles = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.name === PACKAGER_OUTPUT_MARKER) continue;
    if (ent.isDirectory()) walk(p);
    else if (!p.endsWith("manifest.json")) manifestFiles.push({ path: relative(out, p).replaceAll("\\", "/"), sha256: sha256(p) });
  }
}
if (!dryRun) walk(out);
const manifest = {
  schemaVersion: 1,
  name: "memorycrystal-local-backend",
  version,
  installerCompatibility: ">=0.8.0-local-first",
  createdAt: buildTime.toISOString(),
  sourceDateEpoch,
  requiredPorts: [3210, 3211, 6791],
  endpoints: {
    convexApi: "http://127.0.0.1:3210",
    convexSite: "http://127.0.0.1:3211",
    dashboard: "http://127.0.0.1:6791"
  },
  entrypoints: {
    install: "bin/install",
    doctor: "bin/doctor",
    upgrade: "bin/upgrade",
    rollback: "bin/rollback",
    powershellInstall: "bin/install.ps1",
    powershellDoctor: "bin/doctor.ps1",
    powershellRollback: "bin/rollback.ps1"
  },
  // Code-unit order, not localeCompare: the manifest must not depend on the builder's locale.
  files: manifestFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
};
if (!dryRun) writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Local backend artifact ${dryRun ? "dry-run" : "created"}: ${out}`);
console.log(`Version: ${version}`);
console.log(`SOURCE_DATE_EPOCH: ${sourceDateEpoch} (${epochSource}; ${buildTime.toISOString()})`);
console.log(`Files checksummed: ${manifestFiles.length}`);

// Archives: one top-level directory, sorted members, owner 0/0, mtime = epoch,
// modes normalized to 0644/0755 so bin/install, bin/doctor and scripts/*.sh
// keep their executable bit in both formats.
if (archiveDir && !dryRun) {
  const topLevelName = `memorycrystal-local-backend-${version}`;
  const entries = omitPackagerMarkerEntries(collectArchiveEntries(out, topLevelName));
  mkdirSync(archiveDir, { recursive: true });
  const tarPath = join(archiveDir, `${topLevelName}.tar.gz`);
  const zipPath = join(archiveDir, `${topLevelName}.zip`);
  const tarBytes = createTarGz(entries, { mtime: buildTime });
  const zipBytes = await createZip(entries, { mtime: buildTime });
  writeFileSync(tarPath, tarBytes);
  writeFileSync(zipPath, zipBytes);
  console.log(`Archive: ${tarPath} sha256=${sha256Bytes(tarBytes)} (${tarBytes.length} bytes, ${entries.length} members)`);
  console.log(`Archive: ${zipPath} sha256=${sha256Bytes(zipBytes)} (${zipBytes.length} bytes, ${entries.length} members)`);
} else if (archiveDir) {
  console.log(`archive ${archiveDir}/memorycrystal-local-backend-${version}.{tar.gz,zip}`);
}
}

if (isPackagerEntryPoint()) {
  await main();
}
