#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
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

run("bash", ["-n", "apps/web/public/install.sh"]);
run("bash", ["-n", "apps/web/public/install-openclaw-plugin.sh"]);
run("node", ["--experimental-strip-types", "--check", "scripts/convex-local-import-auth.ts"]);
run("node", ["scripts/package-local-backend.mjs", "--dry-run", "--version", "test-smoke"]);

const installer = readFileSync(join(root, "apps/web/public/install.sh"), "utf8");
assert.ok(installer.indexOf("json_field()") > 0, "install.sh must define json_field");
assert.ok(installer.indexOf("json_field()") < installer.indexOf("start_browser_auth()"), "json_field must be defined before browser auth uses it");

const psInstaller = readFileSync(join(root, "apps/web/public/install.ps1"), "utf8");
assert.match(psInstaller, /\$seed = "\$script:ApiKey`:\$LocalBackendVersion`:memory-crystal-local"/);
assert.match(psInstaller, /Copy-Item -Path \(Join-Path \$source "\*"\)/);

const home = mkdtempSync(join(tmpdir(), "mc-installer-"));
try {
  const cloudRun = run("bash", ["apps/web/public/install.sh", "--dry-run", "--yes", "--backend", "cloud", "--targets", "codex-cli,generic-mcp"], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), MEMORY_CRYSTAL_API_KEY: "mc_test_token" }
  });
  assert.doesNotMatch(cloudRun.stdout, /Configuring Detected/);
  assert.doesNotMatch(cloudRun.stdout, /Unsupported target: Detected/);
  const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /\[mcp_servers\.memory-crystal\]/);
  assert.match(codexConfig, /https:\/\/api\.memorycrystal\.ai\/mcp/);
  assert.match(codexConfig, /Bearer mc_test_token/);

  const genericPath = join(home, ".memorycrystal", "mcp-config.json");
  assert.equal(existsSync(genericPath), true);
  const generic = JSON.parse(readFileSync(genericPath, "utf8"));
  assert.equal(generic.mcpServers["memory-crystal"].url, "https://api.memorycrystal.ai/mcp");

  run("bash", ["apps/web/public/install.sh", "--dry-run", "--yes", "--backend", "local", "--targets", "generic-mcp", "--local-backend-version", "test-smoke"], {
    env: { ...process.env, HOME: home, MEMORY_CRYSTAL_API_KEY: "mc_test_token" }
  });
  const localAuth = JSON.parse(readFileSync(join(home, ".memorycrystal", "local-auth.json"), "utf8"));
  assert.equal(localAuth.backend, "local-convex");
  assert.match(localAuth.localToken, /^mc_local_/);
  assert.match(localAuth.localTokenSha256, /^[a-f0-9]{64}$/);

  const invalid = spawnSync("bash", ["apps/web/public/install.sh", "--dry-run", "--yes", "--backend", "cloud", "--targets", "Detected"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, MEMORY_CRYSTAL_API_KEY: "mc_test_token" }
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unsupported target: Detected/);
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log("installer universal smoke tests passed");
