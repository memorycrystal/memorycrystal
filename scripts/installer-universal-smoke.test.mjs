#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
run("bash", ["-n", "apps/web/public/uninstall.sh"]);
run("bash", ["-n", "test-local.sh"]);
run("bash", ["-n", "test-remote.sh"]);
run("node", ["--experimental-strip-types", "--check", "scripts/convex-local-import-auth.ts"]);
run("node", ["--experimental-strip-types", "--check", "scripts/web-backend-env.ts"]);
run("node", ["scripts/package-local-backend.mjs", "--dry-run", "--version", "test-smoke"]);
run("python3", ["-m", "unittest", "integrations/hermes/crystal-memory/test_crystal_memory.py"]);
run("node", ["--experimental-strip-types", "scripts/hermes-plugin-assets-route.test.mjs"]);

const installer = readFileSync(join(root, "apps/web/public/install.sh"), "utf8");
assert.ok(installer.indexOf("json_field()") > 0, "install.sh must define json_field");
assert.ok(installer.indexOf("json_field()") < installer.indexOf("start_browser_auth()"), "json_field must be defined before browser auth uses it");
assert.match(installer, /Enter Gemini API key for the self-hosted backend/);
assert.match(installer, /Enter OpenRouter API key for organic model features/);

const localUp = readFileSync(join(root, "scripts/convex-local-up.sh"), "utf8");
assert.match(localUp, /log\(\) \{ printf '\[convex-local-up\] %s\\n' "\$\*" >&2; \}/);
assert.doesNotMatch(localUp, /run_convex_env_set CONVEX_SITE_URL/);
assert.match(localUp, /run_convex_env_set SITE_URL "\$WEB_SITE_URL"/);
assert.match(localUp, /env -u CONVEX_DEPLOYMENT/);
assert.match(localUp, /--env-file "\$LOCAL_CONVEX_ENV_FILE"/);
assert.match(localUp, /Enter Gemini API key for backend embeddings/);
assert.match(localUp, /Enter OpenRouter API key for organic model features/);

const localAuthKeys = readFileSync(join(root, "scripts/convex-local-auth-keys.ts"), "utf8");
assert.doesNotMatch(localAuthKeys, /setEnv\("CONVEX_SITE_URL"/);
assert.match(localAuthKeys, /CONVEX_DEPLOYMENT: _ignoredDeployment/);
assert.match(localAuthKeys, /CRYSTAL_CONVEX_ENV_FILE/);

const localWriteEnv = readFileSync(join(root, "scripts/convex-local-write-env.ts"), "utf8");
assert.match(localWriteEnv, /local-auth\.json/);
assert.match(localWriteEnv, /values\.MEMORY_CRYSTAL_API_KEY = localInstallerToken/);

const localDoctor = readFileSync(join(root, "scripts/convex-local-doctor.sh"), "utf8");
assert.match(localDoctor, /MEMORY_CRYSTAL_API_KEY matches local auth bridge/);
assert.match(localDoctor, /scripts\/convex-local-write-env\.ts, then scripts\/convex-local-import-auth\.ts/);

const psInstaller = readFileSync(join(root, "apps/web/public/install.ps1"), "utf8");
assert.match(psInstaller, /\$seed = "\$script:ApiKey`:\$LocalBackendVersion`:memory-crystal-local"/);
assert.match(psInstaller, /Copy-Item -Path \(Join-Path \$source "\*"\)/);
assert.match(psInstaller, /Local Convex admin key:/);
assert.match(psInstaller, /Enter Gemini API key for the self-hosted backend/);
assert.match(psInstaller, /Enter OpenRouter API key for organic model features/);

const home = mkdtempSync(join(tmpdir(), "mc-installer-"));
try {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /opt/omx/codex-native-hook.js" }] }],
      Stop: [{ hooks: [{ type: "command", command: "node /opt/omx/codex-native-hook.js" }] }],
    },
  }, null, 2));

  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hermes"), "#!/usr/bin/env bash\nprintf 'hermes test stub\\n'\n");
  chmodSync(join(bin, "hermes"), 0o755);

  const cloudRun = run("bash", ["apps/web/public/install.sh", "--dry-run", "--yes", "--backend", "cloud", "--targets", "codex-cli,generic-mcp"], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), MEMORY_CRYSTAL_API_KEY: "mc_test_token" }
  });
  assert.doesNotMatch(cloudRun.stdout, /Configuring Detected/);
  assert.doesNotMatch(cloudRun.stdout, /Unsupported target: Detected/);
  const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /\[mcp_servers\.memory-crystal\]/);
  assert.match(codexConfig, /https:\/\/api\.memorycrystal\.ai\/mcp/);
  assert.match(codexConfig, /Bearer mc_test_token/);
  assert.match(codexConfig, /codex_hooks = true/);

  const codexHooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
  const hookBlob = JSON.stringify(codexHooks);
  assert.match(hookBlob, /codex-native-hook\.js/);
  assert.match(hookBlob, /crystal-hooks\.mjs/);
  const crystalConfig = JSON.parse(readFileSync(join(home, ".memory-crystal", "config.json"), "utf8"));
  assert.equal(crystalConfig.apiKey, "mc_test_token");
  assert.equal(crystalConfig.convexUrl, "https://convex.memorycrystal.ai");
  assert.equal(existsSync(join(home, ".memory-crystal", "crystal-hooks.mjs")), true);

  const genericPath = join(home, ".memorycrystal", "mcp-config.json");
  assert.equal(existsSync(genericPath), true);
  const generic = JSON.parse(readFileSync(genericPath, "utf8"));
  assert.equal(generic.mcpServers["memory-crystal"].url, "https://api.memorycrystal.ai/mcp");

  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(join(home, ".hermes", "config.yaml"), [
    "plugins:",
    "  enabled:",
    "    - existing-plugin",
    "  disabled:",
    "    - crystal-memory",
    "mcp_servers:",
    "  keep_me:",
    "    url: \"https://example.test/mcp\"",
    "  memory_crystal:",
    "    url: \"https://old.example/mcp\"",
    "",
  ].join("\n"));
  writeFileSync(join(home, ".hermes", ".env"), "KEEP_ME=1\nMEMORY_CRYSTAL_API_KEY=old\n");

  run("bash", ["apps/web/public/install.sh", "--dry-run", "--yes", "--backend", "cloud", "--targets", "hermes"], {
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: join(home, ".hermes"),
      PATH: `${bin}:${process.env.PATH}`,
      MEMORY_CRYSTAL_API_KEY: "mc_test_token",
    }
  });
  const hermesPlugin = join(home, ".hermes", "plugins", "crystal-memory");
  assert.equal(existsSync(join(hermesPlugin, "plugin.yaml")), true);
  assert.equal(existsSync(join(hermesPlugin, "__init__.py")), true);
  const hermesEnv = readFileSync(join(home, ".hermes", ".env"), "utf8");
  assert.match(hermesEnv, /KEEP_ME=1/);
  assert.doesNotMatch(hermesEnv, /MEMORY_CRYSTAL_API_KEY=old/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_API_KEY=mc_test_token/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_API_URL=https:\/\/convex\.memorycrystal\.ai/);
  const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
  assert.match(hermesConfig, /plugins:/);
  assert.match(hermesConfig, /- existing-plugin/);
  assert.match(hermesConfig, /- crystal-memory/);
  assert.doesNotMatch(hermesConfig, /disabled:\n    - crystal-memory/);
  assert.match(hermesConfig, /mcp_servers:/);
  assert.match(hermesConfig, /keep_me:/);
  assert.match(hermesConfig, /memory_crystal:/);
  assert.doesNotMatch(hermesConfig, /old\.example/);
  assert.match(hermesConfig, /url: "https:\/\/api\.memorycrystal\.ai\/mcp"/);
  assert.match(hermesConfig, /Authorization: "Bearer mc_test_token"/);

  writeFileSync(join(home, ".hermes", "config.yaml"), [
    "plugins:",
    "  enabled: [inline-existing]",
    "  disabled: [crystal-memory, noisy-plugin]",
    "mcp_servers:",
    "  memory-crystal:",
    "    url: \"https://old.example/mcp\"",
    "",
  ].join("\n"));
  run("bash", ["apps/web/public/install.sh", "--dry-run", "--yes", "--backend", "cloud", "--targets", "hermes"], {
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: join(home, ".hermes"),
      PATH: `${bin}:${process.env.PATH}`,
      MEMORY_CRYSTAL_API_KEY: "mc_test_token",
    }
  });
  const inlineHermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
  assert.match(inlineHermesConfig, /enabled:\n    - inline-existing\n    - crystal-memory/);
  assert.match(inlineHermesConfig, /disabled:\n    - noisy-plugin/);
  assert.doesNotMatch(inlineHermesConfig, /disabled:\s*\[crystal-memory/);
  assert.doesNotMatch(inlineHermesConfig, /old\.example/);

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

  writeFileSync(join(home, ".codex", "config.toml"), [
    "[mcp_servers.memory-crystal]",
    "url = \"http://127.0.0.1:3211/api/mcp\"",
    "",
    "[mcp_servers.keep-me]",
    "url = \"https://example.test/mcp\"",
    "",
  ].join("\n"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "memory-crystal": { url: "http://127.0.0.1:3211/api/mcp" }, other: { url: "https://example.test" } } }, null, 2));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ command: "node ~/.memory-crystal/crystal-hooks.mjs" }], Stop: [{ command: "echo keep" }] } }, null, 2));
  mkdirSync(join(home, ".memorycrystal", "local-backend", "0.8.1", "bin"), { recursive: true });
  writeFileSync(join(home, ".memorycrystal", "local-backend", "0.8.1", "bin", "down"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"$HOME/down-args.txt\"\n");
  chmodSync(join(home, ".memorycrystal", "local-backend", "0.8.1", "bin", "down"), 0o755);
  writeFileSync(join(home, ".memorycrystal", "mcp-config.json"), "{}\n");
  writeFileSync(join(home, ".memorycrystal", "local-auth.json"), "{}\n");
  run("bash", ["apps/web/public/uninstall.sh", "--targets", "codex-cli,claude-code,generic-mcp,local-backend", "--purge", "--no-restart"], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), MEMORY_CRYSTAL_HOME: join(home, ".memorycrystal") }
  });
  const postCodexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(postCodexConfig, /memory-crystal/);
  assert.match(postCodexConfig, /\[mcp_servers\.keep-me\]/);
  const postClaude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(postClaude.mcpServers["memory-crystal"], undefined);
  assert.equal(postClaude.mcpServers.other.url, "https://example.test");
  assert.equal(existsSync(join(home, ".memorycrystal", "mcp-config.json")), false);
  assert.equal(existsSync(join(home, ".memorycrystal", "local-auth.json")), false);
  assert.equal(existsSync(join(home, ".memorycrystal", "local-backend")), false);
  assert.equal(readFileSync(join(home, "down-args.txt"), "utf8").trim(), "");
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log("installer universal smoke tests passed");
