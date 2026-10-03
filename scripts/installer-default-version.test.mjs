#!/usr/bin/env node
// The installer defaults and the offline CI archive list name the same release.
// Both install.sh and install.ps1 must default to the highest version in the
// explicit list of the offline archive step, and that version's tar.gz and zip
// must be committed under apps/web/public/install-assets/local-backend/.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE_DIR = join(REPO_ROOT, "apps/web/public/install-assets/local-backend");

export function highestVersion(versions) {
  return [...versions].sort((left, right) => {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }).at(-1);
}

/** Explicit `for version in ...` list inside the offline archive step, not the step title. */
export function readOfflineArchiveVersions(workflowSource) {
  const marker = "archives pass unpack, smoke and typecheck (offline)";
  const start = workflowSource.indexOf(marker);
  if (start < 0) throw new Error("offline archive step not found in validate.yml");
  const next = workflowSource.indexOf("\n      - name:", start + marker.length);
  const step = workflowSource.slice(start, next === -1 ? undefined : next);
  const match = step.match(/for version in ([0-9][0-9. ]*);/);
  if (!match) throw new Error("explicit version list not found in the offline archive step");
  const versions = match[1].trim().split(/\s+/);
  if (versions.length === 0 || versions.some((version) => !/^\d+\.\d+\.\d+$/.test(version))) {
    throw new Error(`explicit version list is not dotted versions: ${match[1].trim()}`);
  }
  return versions;
}

export function readInstallShDefault(source) {
  const match = source.match(/^INSTALLER_VERSION="\$\{CRYSTAL_INSTALLER_VERSION:-(\d+\.\d+\.\d+)\}"/m);
  if (!match) throw new Error("install.sh INSTALLER_VERSION default not found");
  return match[1];
}

export function readInstallPs1Default(source) {
  const match = source.match(/\$LocalBackendVersion = \$\(if \(\$env:CRYSTAL_LOCAL_BACKEND_VERSION\) \{ \$env:CRYSTAL_LOCAL_BACKEND_VERSION \} else \{ "(\d+\.\d+\.\d+)" \}\)/);
  if (!match) throw new Error("install.ps1 LocalBackendVersion default not found");
  return match[1];
}

test("installer defaults track the highest version in the offline CI archive list", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/validate.yml"), "utf8");
  const versions = readOfflineArchiveVersions(workflow);
  const highest = highestVersion(versions);
  const shDefault = readInstallShDefault(readFileSync(join(REPO_ROOT, "apps/web/public/install.sh"), "utf8"));
  const ps1Default = readInstallPs1Default(readFileSync(join(REPO_ROOT, "apps/web/public/install.ps1"), "utf8"));
  assert.equal(shDefault, highest, `install.sh default ${shDefault} is not the highest CI archive ${highest} (${versions.join(" ")})`);
  assert.equal(ps1Default, highest, `install.ps1 default ${ps1Default} is not the highest CI archive ${highest} (${versions.join(" ")})`);
  for (const ext of ["tar.gz", "zip"]) {
    const name = `memorycrystal-local-backend-${highest}.${ext}`;
    assert.equal(existsSync(join(ARCHIVE_DIR, name)), true, `missing committed archive ${name}`);
  }
});
