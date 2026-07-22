#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
run("node", ["scripts/local-backend-artifact-smoke.mjs"]);
run("python3", ["-m", "unittest", "integrations/hermes/crystal-memory/test_crystal_memory.py"]);
run("node", ["--experimental-strip-types", "scripts/hermes-plugin-assets-route.test.mjs"]);

const installer = readFileSync(join(root, "apps/web/public/install.sh"), "utf8");
assert.ok(installer.indexOf("json_field()") > 0, "install.sh must define json_field");
assert.ok(installer.indexOf("json_field()") < installer.indexOf("start_browser_auth()"), "json_field must be defined before browser auth uses it");
assert.match(installer, /Enter Gemini API key for the self-hosted backend/);
assert.match(installer, /Enter OpenRouter API key for organic model features/);
assert.match(installer, /stdin_prompt_allowed\(\)/);
assert.match(installer, /script -q \/dev\/null bash -c/);
const browserAuthBody = installer.slice(installer.indexOf("start_browser_auth()"), installer.indexOf("prompt_for_api_key_if_needed()"));
assert.doesNotMatch(browserAuthBody, /\[ -r \/dev\/tty \] \|\| return 1/);

const openclawInstaller = readFileSync(join(root, "apps/web/public/install-openclaw-plugin.sh"), "utf8");
const openclawPluginAssetRoute = readFileSync(join(root, "apps/web/app/install-assets/plugin/[...file]/route.ts"), "utf8");
assert.match(openclawInstaller, /cfg\.plugins\.allow = cfg\.plugins\.allow\.filter\(\(id\) => id !== 'crystal_status' && id !== 'crystal_doctor'\)/);
assert.doesNotMatch(openclawInstaller, /cfg\.plugins\.allow\.push\('crystal_status'\)/);
assert.doesNotMatch(openclawInstaller, /cfg\.plugins\.allow\.push\('crystal_doctor'\)/);
assert.match(openclawInstaller, /cfg\.plugins\.slots\.contextEngine === 'crystal-memory'/);
assert.match(openclawInstaller, /delete cfg\.plugins\.slots\.contextEngine/);
assert.match(openclawInstaller, /Preserved user context engine/);
assert.match(openclawInstaller, /Reset plugins\.slots\.contextEngine to OpenClaw default/);
assert.match(openclawInstaller, /Preserved plugins\.slots\.contextEngine/);
assert.doesNotMatch(openclawInstaller, /context-engine capability/);
assert.doesNotMatch(openclawInstaller, /context-engine: crystal-memory/);
assert.match(openclawPluginAssetRoute, /"openclaw-hook\.json"/);

const publicOpenClawUpdater = readFileSync(join(root, "apps/web/public/update.sh"), "utf8");
assert.match(publicOpenClawUpdater, /reset_openclaw_context_engine_slot\(\)/);
assert.match(publicOpenClawUpdater, /cfg\.plugins\.slots\.contextEngine === "crystal-memory"/);
assert.match(publicOpenClawUpdater, /delete cfg\.plugins\.slots\.contextEngine/);
assert.match(publicOpenClawUpdater, /Reset plugins\.slots\.contextEngine to OpenClaw default/);

const localUp = readFileSync(join(root, "scripts/convex-local-up.sh"), "utf8");
assert.match(localUp, /log\(\) \{ printf '\[convex-local-up\] %s\\n' "\$\*" >&2; \}/);
assert.doesNotMatch(localUp, /run_convex_env_set CONVEX_SITE_URL/);
assert.match(localUp, /run_convex_env_set SITE_URL "\$WEB_SITE_URL"/);
assert.match(localUp, /env -u CONVEX_DEPLOYMENT/);
assert.match(localUp, /--env-file "\$LOCAL_CONVEX_ENV_FILE"/);
assert.match(localUp, /Enter Gemini API key for backend embeddings/);
assert.match(localUp, /Enter OpenRouter API key for organic model features/);

const localAuthKeys = readFileSync(join(root, "scripts/convex-local-auth-keys.ts"), "utf8");
const mcpPackage = JSON.parse(readFileSync(join(root, "mcp-server/package.json"), "utf8"));
assert.match(mcpPackage.scripts.start, /--env-file-if-exists=\.env/);
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

  // --dry-run must be strictly read-only across EVERY target. It previously
  // wrote real configs (including the API key) into HOME; the Hermes lane was
  // still writing plugin files and .env after the first fix pass.
  const dryHome = mkdtempSync(join(tmpdir(), "mc-installer-dry-"));
  const dryStub = join(dryHome, "bin");
  mkdirSync(dryStub, { recursive: true });
  writeFileSync(join(dryStub, "hermes"), "#!/usr/bin/env bash\nprintf 'hermes test stub\\n'\n");
  chmodSync(join(dryStub, "hermes"), 0o755);
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
  assert.match(dryRun.stdout, /Dry-run: would/);
  const dryLeaks = [];
  const walkDry = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (full === dryStub || full.startsWith(`${dryStub}/`)) continue;
      if (entry.isDirectory()) walkDry(full);
      else dryLeaks.push(full.slice(dryHome.length));
    }
  };
  walkDry(dryHome);
  assert.deepEqual(dryLeaks, [], `--dry-run wrote files: ${dryLeaks.join(", ")}`);
  rmSync(dryHome, { recursive: true, force: true });

  const cloudRun = run("bash", ["apps/web/public/install.sh", "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://smoke.convex.site", "--targets", "codex-cli,generic-mcp"], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), MEMORY_CRYSTAL_API_KEY: "mc_test_token" }
  });
  assert.doesNotMatch(cloudRun.stdout, /Configuring Detected/);
  assert.doesNotMatch(cloudRun.stdout, /Unsupported target: Detected/);
  const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /\[mcp_servers\.memory-crystal\]/);
  assert.match(codexConfig, /https:\/\/smoke\.convex\.site\/api\/mcp/);
  assert.match(codexConfig, /Bearer mc_test_token/);
  assert.match(codexConfig, /codex_hooks = true/);

  const codexHooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
  const hookBlob = JSON.stringify(codexHooks);
  assert.match(hookBlob, /codex-native-hook\.js/);
  assert.match(hookBlob, /crystal-hooks\.mjs/);
  const crystalConfig = JSON.parse(readFileSync(join(home, ".memory-crystal", "config.json"), "utf8"));
  assert.equal(crystalConfig.apiKey, "mc_test_token");
  assert.equal(crystalConfig.convexUrl, "https://smoke.convex.site");
  assert.equal(existsSync(join(home, ".memory-crystal", "crystal-hooks.mjs")), true);

  const genericPath = join(home, ".memorycrystal", "mcp-config.json");
  assert.equal(existsSync(genericPath), true);
  const generic = JSON.parse(readFileSync(genericPath, "utf8"));
  assert.equal(generic.mcpServers["memory-crystal"].url, "https://smoke.convex.site/api/mcp");

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
  writeFileSync(join(home, ".hermes", ".env"), "KEEP_ME=1\nMEMORY_CRYSTAL_API_KEY=old\nMEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT=2.5\n");
  const existingProfilePlugin = join(home, ".hermes", "profiles", "marcus", "plugins", "crystal-memory");
  mkdirSync(existingProfilePlugin, { recursive: true });
  writeFileSync(join(existingProfilePlugin, "plugin.yaml"), "name: crystal-memory\nversion: 0.0.0\n");
  writeFileSync(join(existingProfilePlugin, "__init__.py"), "# old profile copy\n");
  mkdirSync(join(home, ".hermes", "profiles", "sarah"), { recursive: true });

  run("bash", ["apps/web/public/install.sh", "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://smoke.convex.site", "--targets", "hermes"], {
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: join(home, ".hermes"),
      HERMES_PROFILE: "active-new",
      PATH: `${bin}:${process.env.PATH}`,
      MEMORY_CRYSTAL_API_KEY: "mc_test_token",
      MEMORY_CRYSTAL_AGENT_SCOPE: "marcus",
    }
  });
  const hermesPlugin = join(home, ".hermes", "plugins", "crystal-memory");
  assert.equal(existsSync(join(hermesPlugin, "plugin.yaml")), true);
  assert.equal(existsSync(join(hermesPlugin, "__init__.py")), true);
  const activeProfilePlugin = join(home, ".hermes", "profiles", "active-new", "plugins", "crystal-memory");
  assert.equal(existsSync(join(activeProfilePlugin, "plugin.yaml")), true);
  assert.equal(existsSync(join(activeProfilePlugin, "__init__.py")), true);
  assert.equal(existsSync(join(home, ".hermes", "profiles", "sarah", "plugins", "crystal-memory")), false);
  assert.equal(readFileSync(join(existingProfilePlugin, "plugin.yaml"), "utf8"), readFileSync(join(hermesPlugin, "plugin.yaml"), "utf8"));
  assert.equal(readFileSync(join(existingProfilePlugin, "__init__.py"), "utf8"), readFileSync(join(hermesPlugin, "__init__.py"), "utf8"));
  const hermesEnv = readFileSync(join(home, ".hermes", ".env"), "utf8");
  assert.match(hermesEnv, /KEEP_ME=1/);
  assert.doesNotMatch(hermesEnv, /MEMORY_CRYSTAL_API_KEY=old/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_API_KEY=mc_test_token/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_API_URL=https:\/\/smoke\.convex\.site/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_HERMES_MODE=auto/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_CAPTURE_TURNS=true/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_INJECT_RECALL=true/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_ALLOW_GROUP_WRITES=true/);
  // Installer must strip stale AUTO_RECALL_TIMEOUT pins and NOT re-pin, so the plugin's shipped default applies.
  assert.doesNotMatch(hermesEnv, /MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_PROVIDER_TOOLS=fallback/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_CAPTURE_QUEUE_SIZE=100/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_CAPTURE_SHUTDOWN_FLUSH_TIMEOUT=2/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_AGENT_SCOPE=marcus/);
  const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
  assert.match(hermesConfig, /plugins:/);
  assert.match(hermesConfig, /- existing-plugin/);
  assert.match(hermesConfig, /- crystal-memory/);
  assert.doesNotMatch(hermesConfig, /disabled:\n    - crystal-memory/);
  assert.match(hermesConfig, /mcp_servers:/);
  assert.match(hermesConfig, /keep_me:/);
  assert.match(hermesConfig, /memory_crystal:/);
  assert.doesNotMatch(hermesConfig, /old\.example/);
  assert.match(hermesConfig, /url: "https:\/\/smoke\.convex\.site\/api\/mcp"/);
  assert.match(hermesConfig, /Authorization: "Bearer mc_test_token"/);
  assert.match(hermesConfig, /memory:\n  provider: crystal-memory/);

  writeFileSync(join(home, ".hermes", "config.yaml"), [
    "plugins:",
    "  enabled: [inline-existing]",
    "  disabled: [crystal-memory, noisy-plugin]",
    "memory:",
    "  provider: ''",
    "mcp_servers:",
    "  memory-crystal:",
    "    url: \"https://old.example/mcp\"",
    "",
  ].join("\n"));
  run("bash", ["apps/web/public/install.sh", "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://smoke.convex.site", "--targets", "hermes"], {
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
  assert.match(inlineHermesConfig, /memory:\n  provider: crystal-memory/);
  assert.doesNotMatch(inlineHermesConfig, /disabled:\s*\[crystal-memory/);
  assert.doesNotMatch(inlineHermesConfig, /old\.example/);

  run("bash", ["apps/web/public/uninstall.sh", "--targets", "hermes", "--purge"], {
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: join(home, ".hermes"),
    }
  });
  const uninstalledHermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
  assert.doesNotMatch(uninstalledHermesConfig, /crystal-memory/);
  assert.doesNotMatch(uninstalledHermesConfig, /memory_crystal:/);
  assert.match(uninstalledHermesConfig, /noisy-plugin/);
  const uninstalledHermesEnv = readFileSync(join(home, ".hermes", ".env"), "utf8");
  assert.match(uninstalledHermesEnv, /KEEP_ME=1/);
  assert.doesNotMatch(uninstalledHermesEnv, /MEMORY_CRYSTAL_API_KEY/);
  assert.doesNotMatch(uninstalledHermesEnv, /MEMORY_CRYSTAL_AGENT_SCOPE/);
  assert.doesNotMatch(uninstalledHermesEnv, /MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT/);
  assert.doesNotMatch(uninstalledHermesEnv, /MEMORY_CRYSTAL_PROVIDER_TOOLS/);
  assert.doesNotMatch(uninstalledHermesEnv, /MEMORY_CRYSTAL_CAPTURE_QUEUE_SIZE/);
  assert.doesNotMatch(uninstalledHermesEnv, /MEMORY_CRYSTAL_CAPTURE_SHUTDOWN_FLUSH_TIMEOUT/);
  assert.equal(existsSync(hermesPlugin), false);
  assert.equal(existsSync(existingProfilePlugin), false);
  assert.equal(existsSync(activeProfilePlugin), false);

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

  const stdinPromptRun = run("bash", ["apps/web/public/install.sh", "--dry-run", "--backend", "self-hosted", "--targets", "generic-mcp"], {
    input: "https://self-hosted.example\n\n\n",
    env: {
      ...process.env,
      HOME: home,
      MEMORY_CRYSTAL_API_KEY: "mc_test_token",
      MEMORY_CRYSTAL_ALLOW_STDIN_PROMPTS: "1",
    }
  });
  assert.match(stdinPromptRun.stderr, /Enter external Convex site URL/);
  assert.match(stdinPromptRun.stdout, /Backend: self-hosted/);

  const noTtyRun = spawnSync("bash", ["apps/web/public/install.sh", "--dry-run", "--backend", "self-hosted", "--targets", "generic-mcp"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, MEMORY_CRYSTAL_API_KEY: "mc_test_token" }
  });
  assert.notEqual(noTtyRun.status, 0);
  assert.match(noTtyRun.stderr, /no readable \/dev\/tty/);
  assert.match(noTtyRun.stderr, /script -q \/dev\/null bash -c/);

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
