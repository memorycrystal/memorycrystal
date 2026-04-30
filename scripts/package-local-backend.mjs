#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
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

const version = arg("--version", process.env.CRYSTAL_LOCAL_BACKEND_VERSION || readPackageVersion() || "0.0.0-dev");
const out = arg("--out", join(process.env.HOME || repoRoot, ".memorycrystal", "local-backend", version));
const dryRun = args.includes("--dry-run");
const rootPackage = readJson(join(repoRoot, "package.json"));
const webPackage = readJson(join(repoRoot, "apps/web/package.json"));
const convexVersion = rootPackage.devDependencies?.convex ?? webPackage.dependencies?.convex ?? "^1.35.1";
const convexAuthVersion = webPackage.dependencies?.["@convex-dev/auth"] ?? "0.0.91";
const standardWebhooksVersion = "^1.0.0";

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
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
  ["scripts/convex-local-auth-keys.ts", "scripts/convex-local-auth-keys.ts"],
  ["scripts/convex-local-import-auth.ts", "scripts/convex-local-import-auth.ts"],
  ["scripts/convex-local-provision-env.ts", "scripts/convex-local-provision-env.ts"],
  ["scripts/convex-local-write-env.ts", "scripts/convex-local-write-env.ts"],
];

if (!dryRun) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
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

function stripPrivateHttpRoutes(content) {
  return content
    .replace(/^import \{ polarWebhook \} from "\.\/crystal\/polarWebhook";\n/m, "")
    .replace(/^http\.route\(\{ path: "\/api\/polar\/webhook".*\n/m, "");
}

const privatePackagePaths = [
  "convex/crystal/__tests__",
  "convex/crystal/admin.ts",
  "convex/crystal/adminCostAnalytics.ts",
  "convex/crystal/adminDelete.ts",
  "convex/crystal/adminEmails.ts",
  "convex/crystal/adminSupport.ts",
  "convex/crystal/planPricing.ts",
  "convex/crystal/polarWebhook.ts",
];
for (const relPath of privatePackagePaths) removePackagedPath(relPath);
rewritePackagedText("convex/http.ts", stripPrivateHttpRoutes);

function pruneIgnored(dir) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.name === ".DS_Store") {
      if (!dryRun) rmSync(p, { force: true });
      continue;
    }
    if (ent.isDirectory()) pruneIgnored(p);
  }
}
if (!dryRun) pruneIgnored(out);

if (!dryRun) {
  writeFileSync(join(out, "package.json"), JSON.stringify({
    name: "memorycrystal-local-backend",
    version,
    private: true,
    engines: rootPackage.engines,
    dependencies: {
      "@convex-dev/auth": convexAuthVersion,
      convex: convexVersion,
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
  createdAt: new Date().toISOString(),
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
  files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path))
};
if (!dryRun) writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Local backend artifact ${dryRun ? "dry-run" : "created"}: ${out}`);
console.log(`Version: ${version}`);
console.log(`Files checksummed: ${manifestFiles.length}`);
