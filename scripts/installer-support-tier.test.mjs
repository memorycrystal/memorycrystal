#!/usr/bin/env node
// ILL-173 — installer prints Support Tier and skip lines for unclaimed layers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

test("install.sh and install.ps1 print Support Tier and skip unclaimed layers", () => {
  const installer = readFileSync(join(root, "apps/web/public/install.sh"), "utf8");
  const psInstallerSrc = readFileSync(join(root, "apps/web/public/install.ps1"), "utf8");
  assert.match(installer, /print_support_tier\(/);
  assert.match(installer, /Support Tier: \$target = \$tier/);
  assert.match(installer, /discipline: skipped for \$target \(no Managed Block target; instructions\.md not written\)/);
  assert.match(installer, /hooks: skipped for \$target \(not claimed\)/);
  assert.match(psInstallerSrc, /Support Tier: \$\{Target\} = \$tier/);
  assert.match(psInstallerSrc, /PowerShell does not write Managed Block or instructions\.md/);
  assert.match(psInstallerSrc, /hooks: skipped for \$\{Target\} \(not claimed\)/);
  assert.match(psInstallerSrc, /hooks\.shells excludes powershell|does not install shared hook runtime assets/);
});

test("bash dry-run prints harness Support Tier and skips tools-tier discipline", () => {
  const dryHome = mkdtempSync(join(tmpdir(), "mc-support-tier-dry-"));
  const dryStub = join(dryHome, "bin");
  mkdirSync(dryStub, { recursive: true });
  writeFileSync(join(dryStub, "hermes"), "#!/usr/bin/env bash\nprintf 'hermes test stub\\n'\n");
  chmodSync(join(dryStub, "hermes"), 0o755);
  try {
    const dryRun = run("bash", ["apps/web/public/install.sh", "--dry-run", "--yes", "--backend", "cloud", "--targets", "codex-cli,generic-mcp,claude-desktop,opencode,hermes"], {
      env: {
        ...process.env,
        HOME: dryHome,
        CODEX_HOME: join(dryHome, ".codex"),
        HERMES_HOME: join(dryHome, ".hermes"),
        XDG_CONFIG_HOME: join(dryHome, ".config"),
        PATH: `${dryStub}:${process.env.PATH}`,
        MEMORY_CRYSTAL_API_KEY: "mc_dry_token",
      },
    });
    assert.match(dryRun.stdout, /Support Tier: generic-mcp = tools/);
    assert.match(dryRun.stdout, /Support Tier: codex-cli = full/);
    assert.match(dryRun.stdout, /Support Tier: claude-desktop = tools/);
    assert.match(dryRun.stdout, /Support Tier: opencode = tools/);
    assert.match(dryRun.stdout, /Support Tier: hermes = full/);
    assert.match(dryRun.stdout, /hooks: skipped for generic-mcp \(not claimed\)/);
    assert.match(dryRun.stdout, /hooks: skipped for claude-desktop \(not claimed\)/);
    assert.match(dryRun.stdout, /hooks: skipped for opencode \(not claimed\)/);
    assert.match(dryRun.stdout, /discipline: skipped for generic-mcp \(no Managed Block target/);
    assert.match(dryRun.stdout, /discipline: skipped for claude-desktop \(no Managed Block target/);
    assert.match(dryRun.stdout, /discipline: skipped for opencode \(no Managed Block target/);
    assert.doesNotMatch(dryRun.stdout, /discipline: skipped for hermes/);
    assert.doesNotMatch(dryRun.stdout, /discipline: skipped for codex-cli/);
  } finally {
    rmSync(dryHome, { recursive: true, force: true });
  }
});

test("bash install prints tools-tier skips and keeps full-tier discipline", () => {
  const home = mkdtempSync(join(tmpdir(), "mc-support-tier-"));
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const cloudRun = run("bash", ["apps/web/public/install.sh", "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://smoke.convex.site", "--targets", "codex-cli,generic-mcp"], {
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), MEMORY_CRYSTAL_API_KEY: "mc_test_token" },
    });
    assert.match(cloudRun.stdout, /Support Tier: generic-mcp = tools/);
    assert.match(cloudRun.stdout, /Support Tier: codex-cli = full/);
    assert.match(cloudRun.stdout, /hooks: skipped for generic-mcp \(not claimed\)/);
    assert.match(cloudRun.stdout, /discipline: skipped for generic-mcp \(no Managed Block target/);
    assert.doesNotMatch(cloudRun.stdout, /discipline: skipped for codex-cli/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
