#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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

// ── Structural invariants (engine + table, not source-order trivia) ──────────
const installer = readFileSync(join(root, "apps/web/public/install.sh"), "utf8");
const platformsTable = JSON.parse(readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8"));
const expectedPlatforms = [
  "claude-code",
  "claude-desktop",
  "codex-cli",
  "codex-desktop",
  "opencode",
  "factory-droid",
  "hermes",
  "openclaw",
  "cursor",
  "grok",
  "generic-mcp",
];
assert.deepEqual(Object.keys(platformsTable.platforms).sort(), [...expectedPlatforms].sort());
assert.match(installer, /run_platform_engine\(/);
assert.match(installer, /platforms_table_path\(/);
assert.doesNotMatch(installer, /\bconfigure_(claude_code|codex|codex_desktop|hermes|openclaw|factory_droid|cursor)\b/, "no per-target configure_* remain");
assert.doesNotMatch(installer, /\bconfigure_cursor\b/);
const psInstallerSrc = readFileSync(join(root, "apps/web/public/install.ps1"), "utf8");
assert.match(psInstallerSrc, /Get-PlatformsTable|Invoke-PlatformEngine/);
assert.doesNotMatch(psInstallerSrc, /\bfunction Configure-Target\b/, "PowerShell must not keep Configure-Target switch");
assert.doesNotMatch(psInstallerSrc, /\bfunction Configure-Cursor\b|\bconfigure_cursor\b/);
// Expand-PathTemplate must use [regex]::Match (Index/Length), not $Matches hashtable.
assert.match(psInstallerSrc, /\[regex\]::Match\(\$s,/);
assert.doesNotMatch(psInstallerSrc, /\$Matches\.Index|\$Matches\.Length/);
// Node-less table reads: python3-first, then generic awk table walker — no per-target mirror.
assert.match(installer, /have_json_reader|require_json_reader|run_json_prog/);
assert.match(installer, /have_table_reader|json_table_query/);
assert.match(installer, /KNOWN_PLATFORM_IDS=/);
assert.match(installer, /\bcursor_app_present\(/);
assert.match(installer, /install_cursor_local_plugin\(/);
assert.equal(platformsTable.platforms.cursor.tier, "full");
assert.equal(platformsTable.platforms.cursor.hooks.host, "cursor");
assert.equal(platformsTable.platforms.cursor.hooks.inject, true);
assert.equal(platformsTable.platforms.cursor.mcp.method, "json-mcpServers");
assert.equal(platformsTable.platforms.cursor.uninstall.plugin.path, "${HOME}/.cursor/plugins/local/memory-crystal");
assert.equal(platformsTable.platforms.cursor.uninstall.skills.path, "${HOME}/.cursor/skills");
assert.deepEqual(platformsTable.platforms.cursor.uninstall.skills.dirs, [
  "crystal-brief",
  "crystal-kb",
  "crystal-architect",
  "crystal-hygiene",
  "crystal-checkpoint",
]);
assert.equal(platformsTable.platforms.grok.tier, "capture");
assert.equal(platformsTable.platforms.grok.hooks.inject, false);
assert.equal(platformsTable.platforms.grok.hooks.host, "grok");
assert.equal(platformsTable.platforms.grok.hooks.method, "shared");
assert.equal(platformsTable.platforms.grok.hooks.path, "${GROK_HOME:-${HOME}/.grok}/hooks/memory-crystal.json");
assert.equal(platformsTable.platforms.grok.mcp.method, "cli-or-toml");
assert.equal(platformsTable.platforms.grok.mcp.tomlHeadersKey, "headers");
assert.equal(platformsTable.platforms.grok.agentsFile, "${HOME}/.grok/AGENTS.md");
assert.equal(platformsTable.platforms.grok.uninstall.hooks.method, "file-remove");
assert.equal(platformsTable.platforms.grok.uninstall.mcp.method, "cli-or-toml");
assert.match(JSON.stringify(platformsTable.platforms.grok.postNotes), /Capture tier/);
assert.match(JSON.stringify(platformsTable.platforms.grok.postNotes), /no automatic recall/);
assert.doesNotMatch(installer, /\bconfigure_grok\b/);
assert.doesNotMatch(psInstallerSrc, /\bfunction Configure-Grok\b|\bconfigure_grok\b/);
assert.match(installer, /strip_managed_toml_mcp_tables\(/);
assert.match(installer, /mcp_servers\\.memory-crystal\(\\\]|\\\.\)/);
assert.match(psInstallerSrc, /\^\\\[mcp_servers\\\.memory-crystal\(\\\]|\\\.\)/);
assert.doesNotMatch(
  installer,
  /\^\\\[mcp_servers\\\.memory-crystal\\\]\/ \{ skip=1/,
  "toml rewrite must strip dotted child tables, not only the parent",
);
const dedicatedCodexInstall = readFileSync(join(root, "apps/web/public/install-codex-mcp.sh"), "utf8");
const dedicatedCodexUninstall = readFileSync(join(root, "apps/web/public/uninstall-codex-mcp.sh"), "utf8");
assert.match(dedicatedCodexInstall, /mcp_servers\\.memory-crystal\(\\\]|\\\.\)/);
assert.match(dedicatedCodexUninstall, /mcp_servers\\.memory-crystal\(\\\]|\\\.\)/);
for (const id of expectedPlatforms) {
  assert.equal(typeof platformsTable.platforms[id].agentId, "string", `${id} must declare agentId`);
  assert.ok(platformsTable.platforms[id].agentId.trim().length > 0, `${id} agentId must be non-empty`);
}
assert.equal(platformsTable.platforms["claude-code"].agentId, "claude-code");
assert.equal(platformsTable.platforms["codex-cli"].agentId, "codex");
assert.equal(platformsTable.platforms["codex-desktop"].agentId, "codex");
assert.equal(platformsTable.platforms.cursor.agentId, "cursor");
assert.equal(platformsTable.platforms.grok.agentId, "grok");
assert.equal(platformsTable.platforms.hermes.agentId, "hermes");
assert.equal(platformsTable.platforms.openclaw.agentId, "openclaw");
assert.match(installer, /write_crystal_runtime_config\(/);
assert.match(installer, /install_declared_identity\(/);
assert.match(installer, /print_kb_reach_report\(/);
assert.doesNotMatch(installer, /JSON\.stringify\(\{apiKey, convexUrl, platform\}/);
assert.match(psInstallerSrc, /Write-CrystalRuntimeConfig/);
assert.match(psInstallerSrc, /Install-DeclaredIdentity/);
assert.match(psInstallerSrc, /Write-KbReachReport/);
assert.equal(platformsTable.platforms["claude-code"].hooks.method, "shared");
assert.equal(platformsTable.platforms["claude-code"].hooks.host, "claude");
assert.equal(platformsTable.platforms["claude-code"].hooks.inject, true);
assert.equal(platformsTable.platforms["claude-code"].hooks.path, "${HOME}/.claude/settings.json");
assert.equal(platformsTable.platforms["claude-code"].hooks.enableFlag, false);
assert.deepEqual(platformsTable.platforms["claude-code"].hooks.shells, ["bash"]);
assert.equal(platformsTable.platforms.openclaw.skills.method, "dirs");
assert.equal(platformsTable.platforms.openclaw.skills.path, "${OPENCLAW_DIR:-${HOME}/.openclaw}/skills");
assert.deepEqual(platformsTable.platforms.openclaw.uninstall.skills.dirs, [
  "crystal-brief",
  "crystal-kb",
  "crystal-architect",
  "crystal-hygiene",
  "crystal-checkpoint",
]);
assert.equal(platformsTable.platforms.hermes.skills.method, "dirs");
assert.equal(platformsTable.platforms.hermes.skills.path, "${HERMES_HOME:-${HOME}/.hermes}/skills");
assert.deepEqual(platformsTable.platforms.hermes.uninstall.skills.dirs, [
  "crystal-brief",
  "crystal-kb",
  "crystal-architect",
  "crystal-hygiene",
  "crystal-checkpoint",
]);
assert.doesNotMatch(installer, /run_platform_engine_readerless|install_crystal_skills_readerless|run_mcp_cli_readerless/,
  "no hardcoded reader-less per-target path/method mirror");
assert.match(installer, /cleanup_platforms_table_on_exit|BASH_SUBSHELL/);
assert.match(psInstallerSrc, /Test-HooksShellSupported/);
assert.doesNotMatch(psInstallerSrc, /Install-SharedHooksFromRow/,
  "PowerShell must not keep the incomplete shared-hooks writer");
assert.doesNotMatch(psInstallerSrc, /Write-JsonConfig.*hooks|New-Item.*crystal-hooks/,
  "PowerShell must not write incomplete hook configs or claim asset install");
assert.match(psInstallerSrc, /hooks\.shells excludes powershell|does not install shared hook runtime assets/);
assert.match(installer, /print_support_tier\(/);
assert.match(installer, /Support Tier: \$target = \$tier/);
assert.match(installer, /discipline: skipped for \$target \(no Managed Block target; instructions\.md not written\)/);
assert.match(installer, /hooks: skipped for \$target \(not claimed\)/);
assert.match(psInstallerSrc, /Support Tier: \$\{Target\} = \$tier/);
assert.match(psInstallerSrc, /PowerShell does not write Managed Block or instructions\.md/);
assert.match(psInstallerSrc, /hooks: skipped for \$\{Target\} \(not claimed\)/);

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

assert.match(psInstallerSrc, /\$seed = "\$script:ApiKey`:\$LocalBackendVersion`:memory-crystal-local"/);
assert.match(psInstallerSrc, /Copy-Item -Path \(Join-Path \$source "\*"\)/);
assert.match(psInstallerSrc, /Local Convex admin key:/);
assert.match(psInstallerSrc, /Enter Gemini API key for the self-hosted backend/);
assert.match(psInstallerSrc, /Enter OpenRouter API key for organic model features/);
assert.match(psInstallerSrc, /install-assets\/platforms\.json/);

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
  assert.match(cloudRun.stdout, /Support Tier: generic-mcp = tools/);
  assert.match(cloudRun.stdout, /Support Tier: codex-cli = full/);
  assert.match(cloudRun.stdout, /hooks: skipped for generic-mcp \(not claimed\)/);
  assert.match(cloudRun.stdout, /discipline: skipped for generic-mcp \(no Managed Block target/);
  assert.doesNotMatch(cloudRun.stdout, /discipline: skipped for codex-cli/);
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
  assert.equal(crystalConfig.agentId, "codex");
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
  for (const skill of ["crystal-brief", "crystal-kb", "crystal-architect", "crystal-hygiene", "crystal-checkpoint"]) {
    assert.equal(existsSync(join(home, ".hermes", "skills", skill, "SKILL.md")), true,
      `hermes install must place ${skill} on the ~/.hermes/skills surface`);
  }
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
  assert.doesNotMatch(hermesEnv, /MEMORY_CRYSTAL_INJECT_RECALL/);
  assert.match(hermesEnv, /MEMORY_CRYSTAL_ALLOW_GROUP_WRITES=true/);
  // Installer must strip stale AUTO_RECALL_TIMEOUT pins (2.5s and 8s) and NOT
  // re-pin a lower value, so the plugin's shipped 16s default applies.
  assert.doesNotMatch(hermesEnv, /MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT/);
  assert.match(
    readFileSync(join(hermesPlugin, "__init__.py"), "utf8"),
    /DEFAULT_AUTO_RECALL_TIMEOUT = 16\.0/,
  );
  assert.match(
    readFileSync(join(hermesPlugin, "plugin.yaml"), "utf8"),
    /MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT[\s\S]*default: "16"/,
  );
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
  for (const skill of ["crystal-brief", "crystal-kb", "crystal-architect", "crystal-hygiene", "crystal-checkpoint"]) {
    assert.equal(existsSync(join(home, ".hermes", "skills", skill)), false,
      `hermes uninstall must remove ${skill} from the ~/.hermes/skills surface`);
  }

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

  // Behavioural replacements for former source-text assertions:
  // - stdin_prompt_allowed + Gemini/OpenRouter prompts
  // - no-tty error still teaches script -q /dev/null bash -c
  // - json_field still parses browser-auth style JSON
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

  // Provider keys via env (the non-interactive path). Prompt copy is still present
  // in the installer and is reached when keys are missing under a real TTY.
  const providerKeyHome = mkdtempSync(join(tmpdir(), "mc-installer-keys-"));
  try {
    const providerKeysRun = run("bash", ["apps/web/public/install.sh", "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://smoke.convex.site", "--targets", "generic-mcp"], {
      env: {
        ...process.env,
        HOME: providerKeyHome,
        MEMORY_CRYSTAL_API_KEY: "mc_test_token",
        GEMINI_API_KEY: "gemini-test-key",
        OPENROUTER_API_KEY: "openrouter-test-key",
      },
    });
    assert.match(providerKeysRun.stdout, /Gemini backend key captured for self-hosted setup notes/);
    assert.match(providerKeysRun.stdout, /OpenRouter backend key captured for self-hosted setup notes/);
    // Prompt strings must remain available for interactive self-hosted installs.
    assert.match(installer, /Enter Gemini API key for the self-hosted backend/);
    assert.match(installer, /Enter OpenRouter API key for organic model features/);
  } finally {
    rmSync(providerKeyHome, { recursive: true, force: true });
  }

  const noTtyRun = spawnSync("bash", ["apps/web/public/install.sh", "--dry-run", "--backend", "self-hosted", "--targets", "generic-mcp"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, MEMORY_CRYSTAL_API_KEY: "mc_test_token" }
  });
  assert.notEqual(noTtyRun.status, 0);
  assert.match(noTtyRun.stderr, /no readable \/dev\/tty/);
  assert.match(noTtyRun.stderr, /script -q \/dev\/null bash -c/);

  // json_field must still parse device-auth style payloads (was ordered before start_browser_auth).
  const jsonFieldRun = run("bash", ["-c", `
    eval "$(sed -n '/^json_field()/,/^}/p' apps/web/public/install.sh)"
    printf '%s' '{"apiKey":"mc_browser_key","status":"complete","device_code":"abc"}' | json_field apiKey
    printf '\\n'
    printf '%s' '{"apiKey":"mc_browser_key","status":"complete"}' | json_field status
  `], { cwd: root });
  assert.match(jsonFieldRun.stdout, /mc_browser_key/);
  assert.match(jsonFieldRun.stdout, /complete/);

  // Behavioral coverage: extract and execute real start_browser_auth with stubbed
  // HTTP + open_url, under a no-readable-TTY condition. Historical regression was
  // bailing solely because /dev/tty was missing — success path must complete.
  {
    const authTmp = mkdtempSync(join(tmpdir(), "mc-browser-auth-"));
    const serverJs = join(authTmp, "server.mjs");
    const portFile = join(authTmp, "port.txt");
    const openLog = join(authTmp, "open-url.txt");
    const wrapper = join(authTmp, "wrapper.sh");
    const extractPy = join(authTmp, "extract.py");
    writeFileSync(serverJs, `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && req.url === "/api/device/start") {
    res.end(JSON.stringify({
      device_code: "smoke-device",
      user_code: "SMOKE-OK",
      verification_url: "http://127.0.0.1/verify-smoke",
    }));
    return;
  }
  if (req.method === "GET" && req.url && req.url.startsWith("/api/device/status")) {
    res.end(JSON.stringify({ status: "complete", apiKey: "mc_browser_auth_ok" }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
}).listen(0, "127.0.0.1", function () {
  writeFileSync(process.argv[2], String(this.address().port));
});
`);
    spawnSync("bash", ["-c",
      `node ${JSON.stringify(serverJs)} ${JSON.stringify(portFile)} </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(join(authTmp, "pid"))}; ` +
      `for i in $(seq 1 40); do [ -s ${JSON.stringify(portFile)} ] && break; sleep 0.1; done`],
      { encoding: "utf8" });
    try {
      const port = Number(readFileSync(portFile, "utf8").trim());
      assert.ok(port > 0, "browser-auth stub did not publish a port");
      // Extract real json_field + start_browser_auth and stub only their external
      // dependencies. The function body itself is executed without rewriting.
      writeFileSync(extractPy, `
import re, sys
src = open(sys.argv[1]).read()
def grab(name):
    m = re.search(r"(" + re.escape(name) + r"\\(\\) \\{.*?\\n\\})", src, re.DOTALL)
    if not m:
        sys.exit("could not find function " + name)
    return m.group(1)
body = grab("json_field") + "\\n" + grab("start_browser_auth")
open(sys.argv[2], "w").write(body)
`);
      const fnsFile = join(authTmp, "fns.sh");
      run("python3", [extractPy, join(root, "apps/web/public/install.sh"), fnsFile]);
      writeFileSync(wrapper, `#!/usr/bin/env bash
set -euo pipefail
CLOUD_CONVEX_URL="http://127.0.0.1:${port}"
DRY_RUN=0
NONINTERACTIVE=0
API_KEY=""
API_KEY_SOURCE=""
log() { printf '  %s\\n' "$*"; }
ok() { printf '  [ok] %s\\n' "$*"; }
warn() { printf '  (i) %s\\n' "$*"; }
fail() { printf '  [err] %s\\n' "$*" >&2; exit 1; }
open_url() { printf '%s\\n' "$1" >> ${JSON.stringify(openLog)}; return 0; }
sleep() { :; }
# shellcheck disable=SC1090
source ${JSON.stringify(fnsFile)}
# Observable precondition for the historical regression: /dev/tty cannot be
# opened in this detached session, even though its filesystem mode may be readable.
if : </dev/tty 2>/dev/null; then
  printf '  [err] fixture still has a usable /dev/tty; expected detached session\\n' >&2
  exit 97
fi
start_browser_auth
printf 'API_KEY=%s\\n' "$API_KEY"
printf 'API_KEY_SOURCE=%s\\n' "$API_KEY_SOURCE"
`);
      chmodSync(wrapper, 0o755);
      // Detach from the controlling terminal so opening /dev/tty fails (Python
      // os.setsid works on macOS and Linux; setsid(1) is Linux-only).
      const launcher = join(authTmp, "launch.py");
      writeFileSync(launcher, `
import os, sys
wrapper = sys.argv[1]
pid = os.fork()
if pid == 0:
    os.setsid()  # new session → no controlling tty
    os.execvp("bash", ["bash", wrapper])
    raise SystemExit(1)
_pid, status = os.waitpid(pid, 0)
if hasattr(os, "waitstatus_to_exitcode"):
    code = os.waitstatus_to_exitcode(status)
elif os.WIFEXITED(status):
    code = os.WEXITSTATUS(status)
else:
    code = 1
sys.exit(code)
`);
      const authRun = spawnSync("python3", [launcher, wrapper], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb" },
      });
      const authOut = `${authRun.stdout || ""}${authRun.stderr || ""}`;
      assert.equal(authRun.status, 0, `start_browser_auth failed without readable TTY\\n${authOut}`);
      assert.match(authOut, /Browser sign-in complete/,
        `expected browser auth success message without TTY\\n${authOut}`);
      assert.match(authOut, /API_KEY=mc_browser_auth_ok/);
      assert.match(authOut, /API_KEY_SOURCE=browser/);
      assert.equal(existsSync(openLog), true, "open_url stub was not invoked");
      assert.match(readFileSync(openLog, "utf8"), /verify-smoke/,
        "open_url must receive the verification URL from the start payload");
      console.log("start_browser_auth behavioral (no TTY + stubbed HTTP/open_url): ok");
    } finally {
      spawnSync("bash", ["-c", `kill $(cat ${JSON.stringify(join(authTmp, "pid"))}) 2>/dev/null || true`]);
      rmSync(authTmp, { recursive: true, force: true });
    }
  }

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

  // ── Fixture row: table-only platform with no engine code change ───────────
  const fixtureTablePath = join(home, "platforms-fixture.json");
  const fixtureTable = structuredClone(platformsTable);
  fixtureTable.platforms["fixture-mcp"] = {
    id: "fixture-mcp",
    tier: "tools",
    testedWith: null,
    mcp: {
      method: "generic-json",
      path: "${HOME}/.fixture-mcp/mcp-config.json",
      successMessage: "Generic MCP config written: {path}",
    },
    hooks: { method: "none", inject: false, path: null },
    skills: { method: "none" },
    agentsFile: null,
    verify: null,
    plugin: { method: "none" },
    postNotes: [],
    uninstall: {
      mcp: { method: "file-remove", path: "${HOME}/.fixture-mcp/mcp-config.json" },
      hooks: { paths: [] },
    },
  };
  writeFileSync(fixtureTablePath, JSON.stringify(fixtureTable, null, 2));
  const fixtureHome = mkdtempSync(join(tmpdir(), "mc-fixture-"));
  try {
    run("bash", ["apps/web/public/install.sh", "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://fixture.convex.site", "--targets", "fixture-mcp"], {
      env: {
        ...process.env,
        HOME: fixtureHome,
        MEMORY_CRYSTAL_API_KEY: "mc_fixture_token",
        CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
      },
    });
    const fixtureCfg = JSON.parse(readFileSync(join(fixtureHome, ".fixture-mcp", "mcp-config.json"), "utf8"));
    assert.equal(fixtureCfg.mcpServers["memory-crystal"].url, "https://fixture.convex.site/api/mcp");
    assert.match(fixtureCfg.mcpServers["memory-crystal"].headers.Authorization, /Bearer mc_fixture_token/);
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
  // ── Node-less regression: targets that must work without node on PATH ─────
  // generic-mcp, hermes, factory-droid, openclaw (non-cloud → generic snippet).
  // Simulate by stripping every PATH entry that contains a `node` binary.
  function pathWithoutNode(basePath) {
    return basePath
      .split(":")
      .filter((dir) => dir && !existsSync(join(dir, "node")) && !existsSync(join(dir, "node.exe")))
      .join(":");
  }
  const noNodePath = pathWithoutNode(process.env.PATH || "");
  assert.ok(noNodePath.length > 0, "PATH without node is empty — cannot run node-less test");
  // Sanity: node must not resolve on that PATH.
  const nodeProbe = spawnSync("bash", ["-c", "command -v node || true"], {
    encoding: "utf8",
    env: { ...process.env, PATH: noNodePath },
  });
  assert.equal((nodeProbe.stdout || "").trim(), "", `node still on PATH for node-less test: ${nodeProbe.stdout}`);

  const nodeLessTargets = [
    {
      target: "generic-mcp",
      seed(h) { /* no stubs */ },
      assertOk(h) {
        const p = join(h, ".memorycrystal", "mcp-config.json");
        assert.equal(existsSync(p), true, "generic-mcp wrote mcp-config.json without node");
        const cfg = JSON.parse(readFileSync(p, "utf8"));
        assert.equal(cfg.mcpServers["memory-crystal"].url, "https://nodeless.convex.site/api/mcp");
      },
    },
    {
      target: "hermes",
      seed(h) {
        const b = join(h, "bin");
        mkdirSync(b, { recursive: true });
        writeFileSync(join(b, "hermes"), "#!/usr/bin/env bash\nprintf 'hermes test stub\\n'\n");
        chmodSync(join(b, "hermes"), 0o755);
        mkdirSync(join(h, ".hermes"), { recursive: true });
      },
      assertOk(h) {
        assert.equal(existsSync(join(h, ".hermes", "plugins", "crystal-memory", "plugin.yaml")), true);
        assert.equal(existsSync(join(h, ".hermes", "config.yaml")), true);
        assert.equal(existsSync(join(h, ".hermes", ".env")), true);
      },
    },
    {
      target: "factory-droid",
      seed(h) {
        const b = join(h, "bin");
        mkdirSync(b, { recursive: true });
        // Pure-bash droid stub — no node dependency.
        writeFileSync(join(b, "droid"), `#!/usr/bin/env bash
set -e
if [ "$1" = "mcp" ] && [ "$2" = "remove" ]; then exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  shift 2; name="$1"; shift; url="$1"; shift
  header=""
  while [ $# -gt 0 ]; do
    case "$1" in --type) shift 2 ;; --header) header="$2"; shift 2 ;; *) shift ;; esac
  done
  key="\${header#Authorization: Bearer }"
  mkdir -p "$HOME/.factory" "$HOME/.droid"
  cat > "$HOME/.factory/config.json" <<EOF
{"mcpServers":{"memory-crystal":{"type":"http","url":"$url","headers":{"Authorization":"Bearer $key"}}}}
EOF
  cp "$HOME/.factory/config.json" "$HOME/.droid/config.json"
  exit 0
fi
exit 0
`);
        chmodSync(join(b, "droid"), 0o755);
      },
      assertOk(h) {
        assert.equal(existsSync(join(h, ".factory", "config.json")), true, "factory-droid wrote config without node");
      },
    },
    {
      target: "openclaw",
      seed(h) { /* non-cloud falls back to generic-mcp snippet */ },
      assertOk(h) {
        const p = join(h, ".memorycrystal", "mcp-config.json");
        assert.equal(existsSync(p), true, "openclaw non-cloud wrote generic mcp snippet without node");
        for (const skill of ["crystal-brief", "crystal-kb", "crystal-architect", "crystal-hygiene", "crystal-checkpoint"]) {
          assert.equal(existsSync(join(h, ".openclaw", "skills", skill, "SKILL.md")), true,
            `openclaw install must place ${skill} on the ~/.openclaw/skills surface`);
        }
      },
    },
  ];

  for (const { target, seed, assertOk } of nodeLessTargets) {
    const nlHome = mkdtempSync(join(tmpdir(), `mc-nodeless-${target}-`));
    try {
      seed(nlHome);
      const bin = join(nlHome, "bin");
      if (existsSync(bin)) {
        // already seeded
      }
      const result = spawnSync("bash", [
        "apps/web/public/install.sh",
        "--yes",
        "--backend", "self-hosted",
        "--self-hosted-url", "https://nodeless.convex.site",
        "--targets", target,
      ], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: nlHome,
          CODEX_HOME: join(nlHome, ".codex"),
          HERMES_HOME: join(nlHome, ".hermes"),
          XDG_CONFIG_HOME: join(nlHome, ".config"),
          MEMORY_CRYSTAL_HOME: join(nlHome, ".memorycrystal"),
          PATH: existsSync(bin) ? `${bin}:${noNodePath}` : noNodePath,
          MEMORY_CRYSTAL_API_KEY: "mc_nodeless_token",
        },
      });
      assert.equal(
        result.status,
        0,
        `node-less install failed for ${target} (status=${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.doesNotMatch(
        `${result.stdout}\n${result.stderr}`,
        /Unsupported target:/,
        `node-less ${target} must not cascade as Unsupported target`,
      );
      assertOk(nlHome);
    } finally {
      rmSync(nlHome, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

// ── PowerShell Expand-PathTemplate executable assertions ────────────────────
// No PowerShell runtime on some agents: skip LOUDLY (clear message) so a green
// run never silently means "we did not execute". When pwsh/powershell exists,
// assert CODEX_HOME set/unset + nested ${HOME} default expansion.
{
  const psRuntime = ["pwsh", "powershell"].find((cmd) => {
    const r = spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
    return r.status === 0;
  });
  if (!psRuntime) {
    console.warn(
      "SKIP (loud): no PowerShell runtime (pwsh/powershell) on PATH — Expand-PathTemplate executable assertions were NOT run. Install pwsh to execute them.",
    );
  } else {
    // Extract Expand-PathTemplate into a standalone snippet and assert.
    const expandFn = psInstallerSrc.match(/function Expand-PathTemplate[\s\S]*?\n\}/);
    assert.ok(expandFn, "Expand-PathTemplate function must exist in install.ps1");
    const harness = `
$ErrorActionPreference = 'Stop'
${expandFn[0]}
$env:HOME = '/Users/testuser'
Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
$unset = Expand-PathTemplate '\${CODEX_HOME:-\${HOME}/.codex}/config.toml'
if ($unset -ne '/Users/testuser/.codex/config.toml') {
  Write-Error "unset CODEX_HOME expected /Users/testuser/.codex/config.toml got: $unset"
  exit 2
}
$env:CODEX_HOME = '/custom/codex-home'
$set = Expand-PathTemplate '\${CODEX_HOME:-\${HOME}/.codex}/config.toml'
if ($set -ne '/custom/codex-home/config.toml') {
  Write-Error "set CODEX_HOME expected /custom/codex-home/config.toml got: $set"
  exit 3
}
# Nested default only: \${HOME} inside default branch
Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
$nested = Expand-PathTemplate '\${CODEX_HOME:-\${HOME}/.codex}/hooks.json'
if ($nested -ne '/Users/testuser/.codex/hooks.json') {
  Write-Error "nested HOME default expected /Users/testuser/.codex/hooks.json got: $nested"
  exit 4
}
Write-Output 'Expand-PathTemplate assertions passed'
exit 0
`;
    const psRun = spawnSync(psRuntime, ["-NoProfile", "-Command", harness], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(
      psRun.status,
      0,
      `PowerShell Expand-PathTemplate assertions failed via ${psRuntime}\nstdout:\n${psRun.stdout}\nstderr:\n${psRun.stderr}`,
    );
    assert.match(psRun.stdout, /Expand-PathTemplate assertions passed/);
    console.log(`PowerShell Expand-PathTemplate assertions passed (${psRuntime})`);
  }
}

// ── install.ps1 executed end-to-end for every PowerShell target ─────────────
// Expand-PathTemplate alone is not enough. `Set-StrictMode -Version Latest` makes
// ANY read of an absent property throw, and most rows omit optional table fields
// (only claude-desktop has mcp.pathByOs; only four rows have mcp.path). A version
// of this file shipped twice where 7 of 8 targets died on the first such read,
// undetected because nothing ever executed the script. Run the real thing.
//
// A local pwsh is preferred; otherwise Docker supplies one. Skip LOUDLY when
// neither exists — a green run must never mean "we did not execute".
{
  const psTargets = [
    "generic-mcp", "codex-cli", "codex-desktop", "opencode",
    "claude-code", "claude-desktop", "factory-droid", "openclaw", "cursor",
  ];
  const localPs = ["pwsh", "powershell"].find(
    (cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0,
  );
  const dockerOk =
    !localPs &&
    spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;

  const runTarget = (target) => {
    const args = [
      "-NoProfile", "-File", "apps/web/public/install.ps1",
      "-Backend", "self-hosted", "-SelfHostedUrl", "https://golden.convex.site",
      "-Targets", target, "-Yes", "-DryRun",
    ];
    if (localPs) {
      return spawnSync(localPs, args, {
        cwd: root, encoding: "utf8", env: { ...process.env, MEMORY_CRYSTAL_API_KEY: "mc_ps_token" },
      });
    }
    return spawnSync("docker", [
      "run", "--rm", "-v", `${root}:/repo`, "-w", "/repo",
      "-e", "MEMORY_CRYSTAL_API_KEY=mc_ps_token",
      "mcr.microsoft.com/powershell:latest", "pwsh", ...args,
    ], { encoding: "utf8" });
  };

  if (!localPs && !dockerOk) {
    console.warn(
      "SKIP (loud): no PowerShell runtime and no usable Docker — install.ps1 was NOT executed for any target. Install pwsh or start Docker to run these.",
    );
  } else {
    for (const target of psTargets) {
      const r = runTarget(target);
      const combined = `${r.stdout || ""}${r.stderr || ""}`;
      assert.equal(
        r.status, 0,
        `install.ps1 failed for target ${target} under ${localPs || "docker pwsh"}\n${combined}`,
      );
      // StrictMode property faults surface as a PropertyNotFoundException rather
      // than a non-zero exit in some hosts; assert on the text too.
      assert.doesNotMatch(
        combined, /cannot be found on this object|PropertyNotFoundException/,
        `install.ps1 hit a StrictMode property fault for target ${target}\n${combined}`,
      );
      assert.match(
        combined,
        new RegExp(`Support Tier: ${target} = `),
        `install.ps1 must print Support Tier for ${target}\n${combined}`,
      );
      assert.match(
        combined,
        /PowerShell does not write Managed Block or instructions\.md/,
        `install.ps1 must skip discipline for ${target}\n${combined}`,
      );
    }
    console.log(
      `install.ps1 executed cleanly for ${psTargets.length} targets (${localPs || "docker pwsh"})`,
    );
  }
}

// ── Golden-output equivalence vs pre-refactor installer on main ─────────────
function walkFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else out.push(relative(base, full));
  }
  return out.sort();
}

function normalizeTree(homeDir) {
  const files = walkFiles(homeDir);
  const map = {};
  for (const rel of files) {
    // Backups are timestamped — ignore for equivalence.
    if (rel.includes(".memory-crystal.") && rel.endsWith(".bak")) continue;
    if (rel.endsWith(".memory-crystal.bak")) continue;
    let body = readFileSync(join(homeDir, rel), "utf8");
    // Hook commands embed absolute HOME paths; normalize so sandboxes compare.
    body = body.split(homeDir).join("__HOME__");
    map[rel] = createHash("sha256").update(body).digest("hex");
  }
  return map;
}

function seedInstallHome(homeDir, { withHermes = false, withClaudeStub = false, withDroidStub = false } = {}) {
  const bin = join(homeDir, "bin");
  mkdirSync(bin, { recursive: true });
  if (withHermes) {
    writeFileSync(join(bin, "hermes"), "#!/usr/bin/env bash\nprintf 'hermes test stub\\n'\n");
    chmodSync(join(bin, "hermes"), 0o755);
    mkdirSync(join(homeDir, ".hermes"), { recursive: true });
  }
  if (withClaudeStub) {
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
# minimal claude mcp stub for golden tests
set -e
cmd="$1"; shift || true
if [ "$cmd" = "mcp" ]; then
  sub="$1"; shift || true
  if [ "$sub" = "remove" ]; then exit 0; fi
  if [ "$sub" = "add" ]; then
    # claude mcp add --scope user memory-crystal --transport http URL --header "Authorization: Bearer KEY"
    url=""; header=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --scope|--transport) shift 2 ;;
        --header) header="$2"; shift 2 ;;
        http*|https*) url="$1"; shift ;;
        *) shift ;;
      esac
    done
    mkdir -p "$HOME"
    key="\${header#Authorization: Bearer }"
    node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude.json";let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};c.mcpServers=c.mcpServers||{};c.mcpServers["memory-crystal"]={type:"http",url:process.argv[1],headers:{Authorization:"Bearer "+process.argv[2]}};fs.writeFileSync(p,JSON.stringify(c,null,2)+"\\n");' "$url" "$key"
    exit 0
  fi
fi
exit 0
`);
    chmodSync(join(bin, "claude"), 0o755);
  }
  if (withDroidStub) {
    writeFileSync(join(bin, "droid"), `#!/usr/bin/env bash
set -e
if [ "$1" = "mcp" ] && [ "$2" = "remove" ]; then exit 0; fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  # droid mcp add memory-crystal URL --type http --header "Authorization: Bearer KEY"
  url=""; header=""
  shift 2
  name="$1"; shift
  url="$1"; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --type) shift 2 ;;
      --header) header="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  key="\${header#Authorization: Bearer }"
  mkdir -p "$HOME/.factory" "$HOME/.droid"
  node -e 'const fs=require("fs");const c={mcpServers:{"memory-crystal":{type:"http",url:process.argv[1],headers:{Authorization:"Bearer "+process.argv[2]}}}};fs.writeFileSync(process.env.HOME+"/.factory/config.json",JSON.stringify(c,null,2)+"\\n");fs.writeFileSync(process.env.HOME+"/.droid/config.json",JSON.stringify(c,null,2)+"\\n");' "$url" "$key"
  exit 0
fi
exit 0
`);
    chmodSync(join(bin, "droid"), 0o755);
  }
  return bin;
}

function installEnv(homeDir, bin) {
  return {
    ...process.env,
    HOME: homeDir,
    CODEX_HOME: join(homeDir, ".codex"),
    HERMES_HOME: join(homeDir, ".hermes"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    MEMORY_CRYSTAL_HOME: join(homeDir, ".memorycrystal"),
    PATH: `${bin}:${process.env.PATH}`,
    MEMORY_CRYSTAL_API_KEY: "mc_golden_token",
  };
}

// Extract pre-refactor installer from main for byte-equivalence.
const baselineDir = mkdtempSync(join(tmpdir(), "mc-baseline-installer-"));
const baselineInstaller = join(baselineDir, "install.sh");
const show = spawnSync("git", ["show", "main:apps/web/public/install.sh"], { cwd: root, encoding: "utf8" });
if (show.status !== 0) {
  console.warn("skipping golden-output: could not read main:apps/web/public/install.sh");
} else {
  writeFileSync(baselineInstaller, show.stdout);
  chmodSync(baselineInstaller, 0o755);

  const goldenTargets = [
    { target: "generic-mcp", opts: {} },
    { target: "codex-cli", opts: {} },
    { target: "codex-desktop", opts: {} },
    { target: "claude-desktop", opts: {} },
    { target: "opencode", opts: {} },
    { target: "claude-code", opts: { withClaudeStub: true } },
    { target: "factory-droid", opts: { withDroidStub: true } },
    { target: "hermes", opts: { withHermes: true } },
    // openclaw non-cloud falls back to generic-mcp snippet on both installers
    { target: "openclaw", opts: {} },
  ];

  for (const { target, opts } of goldenTargets) {
    const oldHome = mkdtempSync(join(tmpdir(), `mc-golden-old-${target}-`));
    const newHome = mkdtempSync(join(tmpdir(), `mc-golden-new-${target}-`));
    try {
      const oldBin = seedInstallHome(oldHome, opts);
      const newBin = seedInstallHome(newHome, opts);
      const args = ["--yes", "--backend", "self-hosted", "--self-hosted-url", "https://golden.convex.site", "--targets", target];
      run("bash", [baselineInstaller, ...args], { env: installEnv(oldHome, oldBin) });
      run("bash", ["apps/web/public/install.sh", ...args], { env: installEnv(newHome, newBin) });
      const oldTree = normalizeTree(oldHome);
      const newTree = normalizeTree(newHome);
      // Drop stub bin/ from comparison — identical by construction.
      // ILL-172 adds ~/.memory-crystal/config.json (or adds agentId to the
      // hooks-written copy). Compare the rest of the tree; assert identity
      // separately so the narrowing write is visible rather than golden-locked out.
      const runtimeRel = ".memory-crystal/config.json";
      for (const tree of [oldTree, newTree]) {
        for (const k of Object.keys(tree)) {
          if (k.startsWith("bin/")) delete tree[k];
        }
        delete tree[runtimeRel];
      }
      assert.deepEqual(newTree, oldTree, `golden-output mismatch for target ${target}\nold=${JSON.stringify(oldTree, null, 2)}\nnew=${JSON.stringify(newTree, null, 2)}`);
      const newRuntimePath = join(newHome, runtimeRel);
      assert.equal(existsSync(newRuntimePath), true, `${target} must write ${runtimeRel}`);
      const newRuntime = JSON.parse(readFileSync(newRuntimePath, "utf8"));
      assert.equal(newRuntime.agentId, platformsTable.platforms[target].agentId, `${target} agentId`);
      assert.equal(newRuntime.apiKey, "mc_golden_token");
      assert.equal(newRuntime.convexUrl, "https://golden.convex.site");
    } finally {
      rmSync(oldHome, { recursive: true, force: true });
      rmSync(newHome, { recursive: true, force: true });
    }
  }
  rmSync(baselineDir, { recursive: true, force: true });
}

// ── OpenClaw cloud-mode legacy installer URL ────────────────────────────────
// The golden harness runs every target with --backend self-hosted, so the cloud
// branch that fetches the legacy OpenClaw installer is never exercised. A default
// written as ${legacy_tmpl:-{installBase}/...} shipped once: bash ends the
// expansion at the first unescaped '}', producing a URL curl rejects outright.
// Assert the built URL against a stub origin instead of trusting the source text.
// Extract the REAL function from install.sh and run it. An earlier version of
// this block re-implemented the fixed line inside its own bash string and
// asserted on that, so restoring the defect in install.sh left it green — a test
// that cannot fail is worse than no test.
{
  const ocRun = spawnSync("bash", ["-c", `
    set -uo pipefail
    INSTALL_BASE="https://example.invalid"
    DRY_RUN=1
    BACKEND_MODE="cloud"
    log() { :; }; ok() { :; }; fail() { printf 'FAIL:%s\\n' "$*"; exit 1; }
    warn() { printf '%s\\n' "$*"; }
    platform_json_get() { printf ''; }
    expand_path_template() { printf '%s' "$1"; }
    write_generic_mcp() { :; }
    eval "$(sed -n '/^substitute_placeholders()/,/^}/p' apps/web/public/install.sh)"
    eval "$(sed -n '/^install_openclaw_plugin_platform()/,/^}/p' apps/web/public/install.sh)"
    install_openclaw_plugin_platform "https://mcp.example/mcp" "mc_test_key" ""
  `], { cwd: root, encoding: "utf8" });
  assert.equal(ocRun.status, 0, `openclaw dry-run failed: ${ocRun.stdout}${ocRun.stderr}`);
  const ocUrl = (ocRun.stdout.match(/installer from (\S+)/) || [])[1] || "";
  assert.ok(ocUrl, `could not read the legacy installer URL from output: ${ocRun.stdout}`);
  assert.doesNotMatch(
    ocUrl, /[{}]/,
    "openclaw legacy installer URL contains brace characters — bash ends ${x:-...} at the first '}', so the default must not be written inline. Got: " + ocUrl,
  );
  assert.equal(
    ocUrl, "https://example.invalid/install-openclaw-plugin.sh",
    `openclaw legacy installer URL is malformed. Got: ${ocUrl}`,
  );
}

// ── Reader-less host: neither node nor python3 ──────────────────────────────
// Pre-refactor install.sh configured pure-bash targets (generic-mcp, etc.)
// without a JSON interpreter. Head must preserve that; targets that always
// needed node/python still fail with a truthful diagnostic.
{
  const binDir = mkdtempSync(join(tmpdir(), "mc-nointerp-bin-"));
  const needed = ["bash", "sh", "env", "cat", "sed", "awk", "grep", "curl", "mktemp",
    "dirname", "basename", "chmod", "mkdir", "printf", "date", "tr", "head", "tail",
    "cut", "sort", "uname", "id", "rm", "mv", "cp", "touch", "openssl", "cmp", "find",
    "ln", "true", "false"];
  for (const tool of needed) {
    const which = spawnSync("command", ["-v", tool], { shell: true, encoding: "utf8" });
    const p = (which.stdout || "").trim();
    if (p) { try { symlinkSync(p, join(binDir, tool)); } catch {} }
  }
  const probe = spawnSync("bash", ["-c", "command -v node || command -v python3 || true"], {
    encoding: "utf8", env: { PATH: binDir },
  });
  if ((probe.stdout || "").trim()) {
    console.warn("SKIP (loud): could not build an interpreter-free PATH — reader-less assertions were NOT run.");
  } else {
    // Base-vs-head parity: pre-refactor installer must succeed for generic-mcp.
    const preRefactor = spawnSync("git", ["show", "7bc057e^:apps/web/public/install.sh"], {
      cwd: root, encoding: "utf8",
    });
    assert.equal(preRefactor.status, 0, "could not load pre-refactor install.sh for parity");
    const baseScript = join(tmpdir(), `mc-install-base-${process.pid}.sh`);
    writeFileSync(baseScript, preRefactor.stdout);
    const baseHome = mkdtempSync(join(tmpdir(), "mc-nointerp-base-"));
    const baseRun = spawnSync("bash", [baseScript,
      "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://x.convex.site",
      "--targets", "generic-mcp"], {
      encoding: "utf8",
      env: { PATH: binDir, HOME: baseHome, MEMORY_CRYSTAL_API_KEY: "mc_nointerp_token" },
    });
    assert.equal(baseRun.status, 0, `pre-refactor reader-less generic-mcp failed\n${baseRun.stdout}${baseRun.stderr}`);
    assert.equal(
      existsSync(join(baseHome, ".memorycrystal", "mcp-config.json")), true,
      "pre-refactor reader-less generic-mcp must write mcp-config.json",
    );

    const home = mkdtempSync(join(tmpdir(), "mc-nointerp-home-"));
    const r = spawnSync("bash", [join(root, "apps/web/public/install.sh"),
      "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://x.convex.site",
      "--targets", "generic-mcp"], {
      cwd: root, encoding: "utf8",
      env: { PATH: binDir, HOME: home, MEMORY_CRYSTAL_API_KEY: "mc_nointerp_token" },
    });
    const combined = `${r.stdout || ""}${r.stderr || ""}`;
    assert.equal(r.status, 0, `reader-less generic-mcp must succeed (base parity)\n${combined}`);
    assert.doesNotMatch(combined, /Unsupported target/,
      `reader-less failure must not masquerade as an unknown target\n${combined}`);
    const cfgPath = join(home, ".memorycrystal", "mcp-config.json");
    assert.equal(existsSync(cfgPath), true, "reader-less generic-mcp must write mcp-config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.mcpServers["memory-crystal"].url, "https://x.convex.site/api/mcp");
    const runtimePath = join(home, ".memory-crystal", "config.json");
    assert.equal(existsSync(runtimePath), true, "reader-less generic-mcp must still declare agentId");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
    assert.equal(runtime.agentId, "generic-mcp");

    // Targets that always needed an interpreter still name the real problem.
    const needReader = spawnSync("bash", [join(root, "apps/web/public/install.sh"),
      "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://x.convex.site",
      "--targets", "claude-desktop"], {
      cwd: root, encoding: "utf8",
      env: { PATH: binDir, HOME: home, MEMORY_CRYSTAL_API_KEY: "mc_nointerp_token" },
    });
    const needCombined = `${needReader.stdout || ""}${needReader.stderr || ""}`;
    assert.notEqual(needReader.status, 0, "claude-desktop must fail without an interpreter");
    assert.match(needCombined, /python3 or node/,
      `interpreter-required target must name the missing interpreter\n${needCombined}`);
    assert.doesNotMatch(needCombined, /Unsupported target/,
      `must not masquerade as an unknown target\n${needCombined}`);

    // Table remains the SoT: reader-less path must come from platforms.json via awk,
    // not a hardcoded mirror (mutation-sensitive invariants).
    assert.equal(
      platformsTable.platforms["generic-mcp"].mcp.path,
      "${MEMORY_CRYSTAL_HOME:-${HOME}/.memorycrystal}/mcp-config.json",
    );
    assert.equal(platformsTable.platforms["generic-mcp"].mcp.method, "generic-json");
    assert.equal(platformsTable.platforms["codex-cli"].mcp.method, "toml-mcp");
    assert.equal(
      platformsTable.platforms["codex-cli"].mcp.path,
      "${CODEX_HOME:-${HOME}/.codex}/config.toml",
    );
    // codex-cli via awk table must still write toml (proves generic engine, not mirror).
    const codexHome = mkdtempSync(join(tmpdir(), "mc-nointerp-codex-"));
    const codexRun = spawnSync("bash", [join(root, "apps/web/public/install.sh"),
      "--yes", "--backend", "self-hosted", "--self-hosted-url", "https://x.convex.site",
      "--targets", "codex-cli", "--no-skills"], {
      cwd: root, encoding: "utf8",
      env: {
        PATH: binDir, HOME: codexHome, CODEX_HOME: join(codexHome, ".codex"),
        MEMORY_CRYSTAL_API_KEY: "mc_nointerp_token",
      },
    });
    assert.equal(codexRun.status, 0, `reader-less codex-cli via table failed\n${codexRun.stdout}${codexRun.stderr}`);
    const codexToml = readFileSync(join(codexHome, ".codex", "config.toml"), "utf8");
    assert.match(codexToml, /\[mcp_servers\.memory-crystal\]/);
    assert.match(codexToml, /https:\/\/x\.convex\.site\/api\/mcp/);

    rmSync(home, { recursive: true, force: true });
    rmSync(baseHome, { recursive: true, force: true });
    rmSync(baseScript, { force: true });
    rmSync(codexHome, { recursive: true, force: true });
    console.log("reader-less host base-vs-head parity asserted");
  }
  rmSync(binDir, { recursive: true, force: true });
}

// ── Table-cache poisoning: predictable $$ path must be ignored ──────────────
// A local attacker can prepopulate ${TMPDIR}/memory-crystal-platforms.$$.json.
// resolve_platforms_table must use a secure mktemp path and never trust that
// deterministic name. Mutation-sensitive: if the old path is re-read, poison wins.
{
  // Source invariant: the install script must not reintroduce the predictable path
  // as executable code (assignment or -s test). Comments alone are not enough.
  assert.doesNotMatch(
    installer,
    /^\s*[^#\n]*memory-crystal-platforms\.\$\$/m,
    "install.sh must not use the poisonable memory-crystal-platforms.$$ path in code",
  );
  assert.match(
    installer,
    /mktemp "\$\{TMPDIR:-\/tmp\}\/memory-crystal-platforms\.XXXXXX"/,
    "install.sh must create the downloaded table via mktemp",
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), "mc-poison-tmp-"));
  const origin = mkdtempSync(join(tmpdir(), "mc-poison-origin-"));
  mkdirSync(join(origin, "install-assets"), { recursive: true });
  const realTable = readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8");
  writeFileSync(join(origin, "install-assets", "platforms.json"), realTable);
  const portFile = join(origin, "port.txt");
  const serverJs = join(origin, "server.mjs");
  writeFileSync(serverJs, `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const table = readFileSync(process.argv[2] + "/install-assets/platforms.json");
createServer((req, res) => {
  if (req.url.includes("platforms.json")) { res.end(table); return; }
  res.statusCode = 404; res.end("");
}).listen(0, "127.0.0.1", function () { writeFileSync(process.argv[3], String(this.address().port)); });
`);
  spawnSync("bash", ["-c",
    `node ${serverJs} ${origin} ${portFile} </dev/null >/dev/null 2>&1 & echo $! > ${origin}/pid; ` +
    `for i in $(seq 1 40); do [ -s ${portFile} ] && break; sleep 0.25; done`],
    { encoding: "utf8" });
  try {
    const port = Number(readFileSync(portFile, "utf8").trim());
    // Run resolve in the SAME shell that writes the poison file so $$ matches.
    const harness = `
set -euo pipefail
export TMPDIR=${JSON.stringify(tmpRoot)}
export INSTALL_BASE=${JSON.stringify(`http://127.0.0.1:${port}`)}
export CRYSTAL_PLATFORMS_TABLE=""
PLATFORMS_TABLE_PATH=""
PLATFORMS_TABLE_TMP=""
fail() { printf '%s\\n' "$*" >&2; exit 1; }
have_json_reader() {
  command -v python3 >/dev/null 2>&1 && return 0
  command -v node >/dev/null 2>&1 && return 0
  return 1
}
# Pull the real resolver (no main) from install.sh.
eval "$(sed -n '/^find_local_platforms_table()/,/^platforms_table_path()/{ /^platforms_table_path()/q; p; }' ${JSON.stringify(join(root, "apps/web/public/install.sh"))})"
eval "$(sed -n '/^platforms_table_path()/,/^have_json_reader()/{ /^have_json_reader()/q; p; }' ${JSON.stringify(join(root, "apps/web/public/install.sh"))})"
# Neutralize local discovery so the download branch runs.
find_local_platforms_table() { return 1; }
poison="\${TMPDIR}/memory-crystal-platforms.\$\$.json"
printf '%s' '{"platforms":{"generic-mcp":{"mcp":{"method":"generic-json","path":"\${HOME}/.poisoned-mcp/mcp-config.json","successMessage":"POISONED"}}}}' > "\$poison"
resolve_platforms_table
[ -n "\$PLATFORMS_TABLE_PATH" ] || fail "resolve left PLATFORMS_TABLE_PATH empty"
[ "\$PLATFORMS_TABLE_PATH" != "\$poison" ] || fail "resolver trusted the poisonable \$\$ path"
if grep -q POISONED "\$PLATFORMS_TABLE_PATH" 2>/dev/null; then
  fail "resolved table contains poison content"
fi
# Real table must have been fetched (generic-mcp path is the safe default).
grep -q 'memorycrystal' "\$PLATFORMS_TABLE_PATH" || fail "resolved table is not the real platforms.json"
cleanup_platforms_table
[ ! -f "\$PLATFORMS_TABLE_TMP" ] || [ -z "\${PLATFORMS_TABLE_TMP}" ] || fail "cleanup left residue"
# Poison file may still exist (attacker-owned); we just must not have used it.
[ -f "\$poison" ] || true
printf 'poison-ignored\\n'
`;
    const r = spawnSync("bash", ["-c", harness], { encoding: "utf8", cwd: tmpRoot });
    assert.equal(r.status, 0, `poison-path resolver check failed\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /poison-ignored/);
    console.log("table-cache poison path ignored");
  } finally {
    spawnSync("bash", ["-c", `kill $(cat ${origin}/pid) 2>/dev/null || true`]);
    rmSync(origin, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── PowerShell non-none hooks fixture (shells + exclusion/unsupported) ──────
// Production codex rows declare shells:["bash"] so PS skips by table policy.
// A fixture with hooks.method=shared + shells:["powershell"] must FAIL loudly
// (engine does not install crystal-hooks.mjs). Exclusion must not be silent.
{
  const localPs = ["pwsh", "powershell"].find(
    (cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0,
  );
  const dockerOk =
    !localPs &&
    spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
  const runHooksFixture = (fixtureHome, fixtureTablePath, target) => {
    const args = [
      "-NoProfile", "-File", "apps/web/public/install.ps1",
      "-Backend", "self-hosted", "-SelfHostedUrl", "https://hooks.convex.site",
      "-Targets", target, "-Yes",
    ];
    if (localPs) {
      return spawnSync(localPs, args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixtureHome,
          CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
          MEMORY_CRYSTAL_API_KEY: "mc_ps_hooks_token",
        },
      });
    }
    return spawnSync("docker", [
      "run", "--rm",
      "-v", `${root}:/repo`,
      "-v", `${fixtureHome}:/fixture-home`,
      "-w", "/repo",
      "-e", "HOME=/fixture-home",
      "-e", `CRYSTAL_PLATFORMS_TABLE=/fixture-home/${relative(fixtureHome, fixtureTablePath)}`,
      "-e", "MEMORY_CRYSTAL_API_KEY=mc_ps_hooks_token",
      "mcr.microsoft.com/powershell:latest", "pwsh", ...args,
    ], { encoding: "utf8" });
  };
  if (!localPs && !dockerOk) {
    console.warn("SKIP (loud): no PowerShell runtime and no usable Docker — hooks fixture was NOT executed.");
  } else {
    // Mutation-sensitive: production codex shells must still exclude powershell.
    assert.deepEqual(platformsTable.platforms["codex-cli"].hooks.shells, ["bash"]);
    assert.deepEqual(platformsTable.platforms["codex-desktop"].hooks.shells, ["bash"]);

    // 1) shells:["powershell"] → loud fail (unsupported implementation)
    const fixtureHome = mkdtempSync(join(tmpdir(), "mc-ps-hooks-"));
    const fixtureTablePath = join(fixtureHome, "platforms-hooks-fixture.json");
    const fixtureTable = structuredClone(platformsTable);
    fixtureTable.platforms["fixture-hooks"] = {
      id: "fixture-hooks",
      tier: "tools",
      testedWith: null,
      mcp: {
        method: "generic-json",
        path: "${HOME}/.fixture-hooks/mcp-config.json",
        successMessage: "Generic MCP config written: {path}",
      },
      hooks: {
        method: "shared",
        host: "codex",
        inject: true,
        path: "${HOME}/.fixture-hooks/hooks.json",
        enableFlag: false,
        dryRunMessage: "Dry-run: would install hooks to {path}",
        shells: ["powershell"],
      },
      skills: { method: "none" },
      agentsFile: null,
      verify: null,
      plugin: { method: "none" },
      postNotes: [],
      uninstall: { mcp: { method: "file-remove", path: "${HOME}/.fixture-hooks/mcp-config.json" }, hooks: { paths: [] } },
    };
    writeFileSync(fixtureTablePath, JSON.stringify(fixtureTable, null, 2));
    const psFail = runHooksFixture(fixtureHome, fixtureTablePath, "fixture-hooks");
    const failCombined = `${psFail.stdout || ""}${psFail.stderr || ""}`;
    assert.notEqual(psFail.status, 0, `PowerShell must fail loudly when shells includes powershell without runtime assets\n${failCombined}`);
    assert.match(failCombined, /does not install shared hook runtime assets|crystal-hooks\.mjs/i,
      `unsupported PowerShell hooks must be consumed with a loud error\n${failCombined}`);
    assert.equal(existsSync(join(fixtureHome, ".fixture-hooks", "hooks.json")), false,
      "must not write incomplete hooks pointing at a missing crystal-hooks.mjs");

    // 2) shells:["bash"] exclusion → explicit skip log, MCP still installs
    const exclHome = mkdtempSync(join(tmpdir(), "mc-ps-hooks-excl-"));
    const exclTablePath = join(exclHome, "platforms-hooks-excl.json");
    const exclTable = structuredClone(platformsTable);
    exclTable.platforms["fixture-excl"] = {
      id: "fixture-excl",
      tier: "tools",
      testedWith: null,
      mcp: {
        method: "generic-json",
        path: "${HOME}/.fixture-excl/mcp-config.json",
        successMessage: "Generic MCP config written: {path}",
      },
      hooks: {
        method: "shared",
        host: "codex",
        inject: true,
        path: "${HOME}/.fixture-excl/hooks.json",
        enableFlag: false,
        dryRunMessage: "Dry-run: would install hooks to {path}",
        shells: ["bash"],
      },
      skills: { method: "none" },
      agentsFile: null,
      verify: null,
      plugin: { method: "none" },
      postNotes: [],
      uninstall: { mcp: { method: "file-remove", path: "${HOME}/.fixture-excl/mcp-config.json" }, hooks: { paths: [] } },
    };
    writeFileSync(exclTablePath, JSON.stringify(exclTable, null, 2));
    const psExcl = runHooksFixture(exclHome, exclTablePath, "fixture-excl");
    const exclCombined = `${psExcl.stdout || ""}${psExcl.stderr || ""}`;
    assert.equal(psExcl.status, 0, `PowerShell exclusion fixture failed\n${exclCombined}`);
    assert.match(exclCombined, /hooks\.shells excludes powershell|skipping shared hooks/i,
      `explicit shells exclusion must be logged, not silent\n${exclCombined}`);
    assert.equal(existsSync(join(exclHome, ".fixture-excl", "mcp-config.json")), true);
    assert.equal(existsSync(join(exclHome, ".fixture-excl", "hooks.json")), false);

    rmSync(fixtureHome, { recursive: true, force: true });
    rmSync(exclHome, { recursive: true, force: true });
    console.log("PowerShell hooks shells exclusion/unsupported fixture asserted");
  }
}

// ── Mutation: unknown nonempty mcp.method must fail (Bash + PowerShell) ────
// typo-json is not a declared method. Bash already fails; PowerShell previously
// treated switch default as empty, exited 0, wrote nothing, and printed complete.
// Supported no-ops (none, plugin-owned) must remain silent successes.
{
  const typoHome = mkdtempSync(join(tmpdir(), "mc-typo-mcp-"));
  const typoTablePath = join(typoHome, "platforms-typo.json");
  const typoTable = structuredClone(platformsTable);
  typoTable.platforms["fixture-typo-json"] = {
    id: "fixture-typo-json",
    tier: "tools",
    testedWith: null,
    mcp: {
      method: "typo-json",
      path: "${HOME}/.fixture-typo/mcp-config.json",
      successMessage: "should not write",
    },
    hooks: { method: "none", inject: false, path: null },
    skills: { method: "none" },
    agentsFile: null,
    verify: null,
    plugin: { method: "none" },
    postNotes: [],
    uninstall: {
      mcp: { method: "file-remove", path: "${HOME}/.fixture-typo/mcp-config.json" },
      hooks: { paths: [] },
    },
  };
  // Preserve supported no-op methods: openclaw/hermes rows use plugin-owned MCP.
  assert.equal(platformsTable.platforms.openclaw.mcp.method, "plugin-owned");
  assert.equal(platformsTable.platforms.hermes.mcp.method, "plugin-owned");
  writeFileSync(typoTablePath, JSON.stringify(typoTable, null, 2));

  const bashTypo = spawnSync("bash", [
    "apps/web/public/install.sh",
    "--yes", "--backend", "self-hosted",
    "--self-hosted-url", "https://typo.convex.site",
    "--targets", "fixture-typo-json",
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: typoHome,
      MEMORY_CRYSTAL_API_KEY: "mc_typo_token",
      CRYSTAL_PLATFORMS_TABLE: typoTablePath,
    },
  });
  const bashTypoOut = `${bashTypo.stdout || ""}${bashTypo.stderr || ""}`;
  assert.notEqual(bashTypo.status, 0, `Bash must reject mcp.method=typo-json\n${bashTypoOut}`);
  assert.match(bashTypoOut, /Unsupported mcp\.method|typo-json/i);
  assert.equal(existsSync(join(typoHome, ".fixture-typo", "mcp-config.json")), false,
    "Bash typo-json must not write an artifact");

  const localPsTypo = ["pwsh", "powershell"].find(
    (cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0,
  );
  const dockerOkTypo =
    !localPsTypo &&
    spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
  if (!localPsTypo && !dockerOkTypo) {
    console.warn("SKIP (loud): no PowerShell runtime and no usable Docker — typo-json PS fixture was NOT executed.");
  } else {
    const psArgs = [
      "-NoProfile", "-File", "apps/web/public/install.ps1",
      "-Backend", "self-hosted", "-SelfHostedUrl", "https://typo.convex.site",
      "-Targets", "fixture-typo-json", "-Yes", "-NoSkills",
    ];
    let psTypo;
    if (localPsTypo) {
      psTypo = spawnSync(localPsTypo, psArgs, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: typoHome,
          CRYSTAL_PLATFORMS_TABLE: typoTablePath,
          MEMORY_CRYSTAL_API_KEY: "mc_typo_token",
        },
      });
    } else {
      psTypo = spawnSync("docker", [
        "run", "--rm",
        "-v", `${root}:/repo`,
        "-v", `${typoHome}:/fixture-home`,
        "-w", "/repo",
        "-e", "HOME=/fixture-home",
        "-e", `CRYSTAL_PLATFORMS_TABLE=/fixture-home/${relative(typoHome, typoTablePath)}`,
        "-e", "MEMORY_CRYSTAL_API_KEY=mc_typo_token",
        "mcr.microsoft.com/powershell:latest", "pwsh", ...psArgs,
      ], { encoding: "utf8" });
    }
    const psTypoOut = `${psTypo.stdout || ""}${psTypo.stderr || ""}`;
    assert.notEqual(psTypo.status, 0, `PowerShell must reject mcp.method=typo-json\n${psTypoOut}`);
    assert.match(psTypoOut, /Unsupported mcp\.method|typo-json/i,
      `PowerShell unknown mcp.method must fail loudly\n${psTypoOut}`);
    assert.doesNotMatch(psTypoOut, /Memory Crystal installer complete/,
      `PowerShell must not print installer-complete after unknown mcp.method\n${psTypoOut}`);
    assert.equal(existsSync(join(typoHome, ".fixture-typo", "mcp-config.json")), false,
      "PowerShell typo-json must not write an artifact");
    console.log(`PowerShell typo-json mutation fixture: nonzero exit, no artifact (${localPsTypo || "docker"})`);
  }
  rmSync(typoHome, { recursive: true, force: true });
}

// ── Install-layer preflight: every dispatch selector is whole-set atomic ───
// Every selected row must validate before the first target dispatch. These are
// real Bash and PowerShell executions: putting fixture-valid first makes the
// mixed cases mutation-sensitive to a target-by-target validation regression.
{
  const fixtureHome = mkdtempSync(join(tmpdir(), "mc-install-preflight-"));
  try {
    const fixtureTablePath = join(fixtureHome, "platforms-install-preflight.json");
    const fixtureTable = structuredClone(platformsTable);
    const row = (id, overrides = {}) => ({
      id,
      tier: "tools",
      testedWith: null,
      mcp: {
        method: "generic-json",
        path: `\${HOME}/.fixture-preflight/${id}.json`,
        successMessage: "fixture write",
      },
      hooks: { method: "none", inject: false, path: null },
      skills: { method: "none" },
      agentsFile: null,
      verify: null,
      plugin: { method: "none" },
      postNotes: [],
      uninstall: { mcp: { method: "file-remove", path: `\${HOME}/.fixture-preflight/${id}.json` }, hooks: { paths: [] } },
      ...overrides,
    });
    fixtureTable.platforms["fixture-valid"] = row("fixture-valid", {
      mcp: {
        method: "generic-json",
        path: "${HOME}/.fixture-preflight/valid.json",
        successMessage: "fixture write",
      },
    });
    fixtureTable.platforms["fixture-typo-plugin"] = row("fixture-typo-plugin", {
      plugin: { method: "typo-plugin" },
    });
    fixtureTable.platforms["fixture-typo-skills"] = row("fixture-typo-skills", {
      skills: { method: "typo-skills", path: "${HOME}/.fixture-preflight/skills" },
    });
    fixtureTable.platforms["fixture-typo-fallback"] = row("fixture-typo-fallback", {
      plugin: { method: "openclaw", nonCloudFallback: "typo-fallback" },
    });
    fixtureTable.platforms["fixture-fallback-toml-missing-path"] = row("fixture-fallback-toml-missing-path", {
      mcp: { method: "plugin-owned" },
      plugin: { method: "openclaw", nonCloudFallback: "toml-mcp" },
    });
    fixtureTable.platforms["fixture-fallback-mcp-servers-missing-path"] = row("fixture-fallback-mcp-servers-missing-path", {
      mcp: { method: "plugin-owned" },
      plugin: { method: "openclaw", nonCloudFallback: "json-mcpServers" },
    });
    fixtureTable.platforms["fixture-fallback-json-mcp-missing-path"] = row("fixture-fallback-json-mcp-missing-path", {
      mcp: { method: "plugin-owned" },
      plugin: { method: "openclaw", nonCloudFallback: "json-mcp" },
    });
    fixtureTable.platforms["fixture-fallback-cli-missing-binary"] = row("fixture-fallback-cli-missing-binary", {
      mcp: { method: "plugin-owned", addArgs: ["mcp", "add", "{mcpUrl}"] },
      plugin: { method: "openclaw", nonCloudFallback: "cli" },
    });
    fixtureTable.platforms["fixture-fallback-cli-missing-add-args"] = row("fixture-fallback-cli-missing-add-args", {
      mcp: { method: "plugin-owned", binary: "fixture-cli" },
      plugin: { method: "openclaw", nonCloudFallback: "cli" },
    });
    fixtureTable.platforms["fixture-ps-hooks"] = row("fixture-ps-hooks", {
      hooks: {
        method: "shared",
        host: "codex",
        path: "${HOME}/.fixture-preflight/ps-hooks.json",
        shells: ["powershell"],
      },
    });
    fixtureTable.platforms["fixture-ps-hermes"] = row("fixture-ps-hermes", {
      plugin: { method: "hermes", home: "${HOME}/.fixture-preflight/hermes" },
    });
    fixtureTable.platforms["fixture-noops-empty"] = row("fixture-noops-empty", {
      mcp: { method: "" }, hooks: { method: "" }, skills: { method: "" }, plugin: { method: "" },
    });
    fixtureTable.platforms["fixture-noops-none"] = row("fixture-noops-none", {
      mcp: { method: "none" }, hooks: { method: "none" }, skills: { method: "none" }, plugin: { method: "none" },
    });
    writeFileSync(fixtureTablePath, JSON.stringify(fixtureTable, null, 2));

    const validArtifact = join(fixtureHome, ".fixture-preflight", "valid.json");
    const invalidCases = [
      { targets: "fixture-typo-plugin", pattern: /Unsupported plugin\.method.*typo-plugin/i },
      { targets: "fixture-typo-skills", pattern: /Unsupported skills\.method.*typo-skills/i },
      { targets: "fixture-typo-fallback", pattern: /Unsupported openclaw plugin\.nonCloudFallback[\s\S]*typo-fallback/i },
      { targets: "fixture-valid,fixture-typo-plugin", pattern: /Unsupported plugin\.method.*typo-plugin/i },
      { targets: "fixture-valid,fixture-typo-skills", pattern: /Unsupported skills\.method.*typo-skills/i },
      { targets: "fixture-valid,fixture-typo-fallback", pattern: /Unsupported openclaw plugin\.nonCloudFallback[\s\S]*typo-fallback/i },
      { targets: "fixture-valid,fixture-fallback-toml-missing-path", pattern: /mcp\.method=toml-mcp[\s\S]*mcp\.pathByOs/i },
      { targets: "fixture-valid,fixture-fallback-mcp-servers-missing-path", pattern: /mcp\.method=json-mcpServers[\s\S]*mcp\.pathByOs/i },
      { targets: "fixture-valid,fixture-fallback-json-mcp-missing-path", pattern: /mcp\.method=json-mcp[\s\S]*mcp\.pathByOs/i },
      { targets: "fixture-valid,fixture-fallback-cli-missing-binary", pattern: /mcp\.method=cli requires mcp\.binary/i },
      { targets: "fixture-valid,fixture-fallback-cli-missing-add-args", pattern: /mcp\.method=cli requires a non-empty mcp\.addArgs array/i },
    ];
    const psOnlyInvalidCases = [
      { targets: "fixture-valid,fixture-ps-hooks", pattern: /hooks\.method=shared declares PowerShell support/i },
      { targets: "fixture-valid,fixture-ps-hermes", pattern: /Unsupported plugin\.method.*hermes/i },
    ];
    const assertRejectedWithoutWrites = (result, fixture, engine) => {
      const output = `${result.stdout || ""}${result.stderr || ""}`;
      assert.notEqual(result.status, 0, `${engine} must reject ${fixture.targets}\n${output}`);
      assert.match(output, fixture.pattern, `${engine} must identify the invalid install-layer method\n${output}`);
      assert.doesNotMatch(output, /Memory Crystal installer complete/,
        `${engine} must not print completion after failed method preflight\n${output}`);
      assert.equal(existsSync(validArtifact), false,
        `${engine} mixed-target preflight must fail before the valid target writes ${validArtifact}`);
      assert.equal(existsSync(join(fixtureHome, ".fixture-preflight", "fixture-typo-plugin.json")), false);
      assert.equal(existsSync(join(fixtureHome, ".fixture-preflight", "fixture-typo-skills.json")), false);
      assert.equal(existsSync(join(fixtureHome, ".fixture-preflight", "fixture-typo-fallback.json")), false);
    };

    for (const fixture of invalidCases) {
      const result = spawnSync("bash", [
        "apps/web/public/install.sh", "--yes", "--backend", "self-hosted",
        "--self-hosted-url", "https://preflight.convex.site", "--targets", fixture.targets,
      ], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixtureHome,
          CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
          MEMORY_CRYSTAL_API_KEY: "mc_preflight_token",
        },
      });
      assertRejectedWithoutWrites(result, fixture, "Bash");
    }
    const bashNoops = spawnSync("bash", [
      "apps/web/public/install.sh", "--yes", "--backend", "self-hosted",
      "--self-hosted-url", "https://preflight.convex.site",
      "--targets", "fixture-noops-empty,fixture-noops-none",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixtureHome,
        CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
        MEMORY_CRYSTAL_API_KEY: "mc_preflight_token",
      },
    });
    assert.equal(bashNoops.status, 0, `${bashNoops.stdout}${bashNoops.stderr}`);
    assert.match(`${bashNoops.stdout}${bashNoops.stderr}`, /Memory Crystal installer complete/);

    const localPs = ["pwsh", "powershell"].find(
      (cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0,
    );
    const dockerOk = !localPs && spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
    if (!localPs && !dockerOk) {
      console.warn("SKIP (loud): no PowerShell runtime and no usable Docker — install-layer preflight PS fixtures were NOT executed.");
    } else {
      const runPs = (targets) => {
        const args = [
          "-NoProfile", "-File", "apps/web/public/install.ps1",
          "-Backend", "self-hosted", "-SelfHostedUrl", "https://preflight.convex.site",
          "-Targets", targets, "-Yes",
        ];
        if (localPs) {
          return spawnSync(localPs, args, {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: fixtureHome,
              CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
              MEMORY_CRYSTAL_API_KEY: "mc_preflight_token",
            },
          });
        }
        return spawnSync("docker", [
          "run", "--rm",
          "-v", `${root}:/repo`,
          "-v", `${fixtureHome}:/fixture-home`,
          "-w", "/repo",
          "-e", "HOME=/fixture-home",
          "-e", `CRYSTAL_PLATFORMS_TABLE=/fixture-home/${relative(fixtureHome, fixtureTablePath)}`,
          "-e", "MEMORY_CRYSTAL_API_KEY=mc_preflight_token",
          "mcr.microsoft.com/powershell:latest", "pwsh", ...args,
        ], { encoding: "utf8" });
      };
      for (const fixture of invalidCases) {
        assertRejectedWithoutWrites(runPs(fixture.targets), fixture, "PowerShell");
      }
      for (const fixture of psOnlyInvalidCases) {
        assertRejectedWithoutWrites(runPs(fixture.targets), fixture, "PowerShell");
      }
      const psNoops = runPs("fixture-noops-empty,fixture-noops-none");
      assert.equal(psNoops.status, 0, `${psNoops.stdout}${psNoops.stderr}`);
      assert.match(`${psNoops.stdout}${psNoops.stderr}`, /Memory Crystal installer complete/);
      console.log(`install selector preflight: Bash + ${localPs || "Docker PowerShell"} rejected nested fallback, missing MCP path/CLI metadata, and incompatible specialized/hook selectors with no partial writes`);
    }
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
}

// ── Specialized plugins continue through every compatible declared layer ──
// Both fixture rows are table-only. Bash proves Hermes and OpenClaw do not
// return before MCP/hooks/skills; PowerShell proves OpenClaw routes its declared
// fallback method through the row's custom MCP path and still installs skills.
{
  const fixtureHome = mkdtempSync(join(tmpdir(), "mc-specialized-multilayer-"));
  try {
    const fixtureTablePath = join(fixtureHome, "platforms-specialized-multilayer.json");
    const fixtureTable = structuredClone(platformsTable);
    fixtureTable.platforms["fixture-hermes-multilayer"] = {
      ...structuredClone(platformsTable.platforms.hermes),
      id: "fixture-hermes-multilayer",
      plugin: { method: "hermes", home: "${HOME}/hermes-multilayer" },
      mcp: { method: "generic-json", path: "${HOME}/layers/hermes-mcp.json" },
      hooks: {
        method: "shared",
        host: "codex",
        path: "${HOME}/layers/hermes-hooks.json",
        shells: ["bash"],
      },
      skills: { method: "dirs", path: "${HOME}/layers/hermes-skills" },
    };
    fixtureTable.platforms["fixture-openclaw-multilayer"] = {
      ...structuredClone(platformsTable.platforms.openclaw),
      id: "fixture-openclaw-multilayer",
      plugin: {
        method: "openclaw",
        legacyInstaller: "{installBase}/install-openclaw-plugin.sh",
        nonCloudFallback: "generic-json",
      },
      mcp: { method: "json-mcp", path: "${HOME}/layers/openclaw-mcp.json" },
      hooks: {
        method: "shared",
        host: "codex",
        path: "${HOME}/layers/openclaw-hooks.json",
        shells: ["bash"],
      },
      skills: { method: "dirs", path: "${HOME}/layers/openclaw-skills" },
    };
    writeFileSync(fixtureTablePath, JSON.stringify(fixtureTable, null, 2));

    const bashHome = join(fixtureHome, "bash-home");
    mkdirSync(bashHome, { recursive: true });
    const bashEnv = {
      ...process.env,
      HOME: bashHome,
      HERMES_HOME: "",
      CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
      MEMORY_CRYSTAL_API_KEY: "mc_specialized_bash_token",
    };
    for (const target of ["fixture-hermes-multilayer", "fixture-openclaw-multilayer"]) {
      const installed = spawnSync("bash", [
        "apps/web/public/install.sh", "--yes", "--backend", "self-hosted",
        "--self-hosted-url", "https://specialized.convex.site", "--targets", target,
      ], { cwd: root, encoding: "utf8", env: bashEnv });
      assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
      assert.match(`${installed.stdout}${installed.stderr}`, /Memory Crystal installer complete/);
    }
    assert.equal(existsSync(join(bashHome, "hermes-multilayer", "plugins", "crystal-memory", "plugin.yaml")), true);
    assert.equal(existsSync(join(bashHome, "hermes-multilayer", "config.yaml")), true);
    assert.equal(existsSync(join(bashHome, "hermes-multilayer", ".env")), true);
    for (const target of ["hermes", "openclaw"]) {
      assert.equal(existsSync(join(bashHome, "layers", `${target}-mcp.json`)), true, `${target} declared MCP artifact missing`);
      assert.equal(existsSync(join(bashHome, "layers", `${target}-hooks.json`)), true, `${target} declared hooks artifact missing`);
      assert.equal(existsSync(join(bashHome, "layers", `${target}-skills`, "crystal-brief", "SKILL.md")), true,
        `${target} declared skills artifact missing`);
    }
    const bashOpenClawMcp = JSON.parse(readFileSync(join(bashHome, "layers", "openclaw-mcp.json"), "utf8"));
    assert.equal(bashOpenClawMcp.mcp["memory-crystal"].type, "remote",
      "Bash OpenClaw must dispatch the declared mcp.method instead of its generic fallback");

    const localPs = ["pwsh", "powershell"].find(
      (cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0,
    );
    const dockerOk = !localPs && spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
    if (!localPs && !dockerOk) {
      console.warn("SKIP (loud): no PowerShell runtime and no usable Docker — specialized multilayer PowerShell fixture was NOT executed.");
    } else {
      const psHome = join(fixtureHome, "ps-home");
      mkdirSync(psHome, { recursive: true });
      const args = [
        "-NoProfile", "-File", "apps/web/public/install.ps1",
        "-Backend", "self-hosted", "-SelfHostedUrl", "https://specialized.convex.site",
        "-Targets", "fixture-openclaw-multilayer", "-Yes",
      ];
      const psInstalled = localPs
        ? spawnSync(localPs, args, {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: psHome,
            CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
            MEMORY_CRYSTAL_API_KEY: "mc_specialized_ps_token",
          },
        })
        : spawnSync("docker", [
          "run", "--rm",
          "-v", `${root}:/repo`,
          "-v", `${fixtureHome}:/fixture-home`,
          "-w", "/repo",
          "-e", "HOME=/fixture-home/ps-home",
          "-e", "CRYSTAL_PLATFORMS_TABLE=/fixture-home/platforms-specialized-multilayer.json",
          "-e", "MEMORY_CRYSTAL_API_KEY=mc_specialized_ps_token",
          "mcr.microsoft.com/powershell:latest", "pwsh", ...args,
        ], { encoding: "utf8" });
      const psOut = `${psInstalled.stdout || ""}${psInstalled.stderr || ""}`;
      assert.equal(psInstalled.status, 0, psOut);
      assert.match(psOut, /Memory Crystal installer complete/);
      assert.equal(existsSync(join(psHome, "layers", "openclaw-mcp.json")), true,
        "PowerShell OpenClaw fallback must honor the declared MCP path");
      const psOpenClawMcp = JSON.parse(readFileSync(join(psHome, "layers", "openclaw-mcp.json"), "utf8"));
      assert.equal(psOpenClawMcp.mcp["memory-crystal"].type, "remote",
        "PowerShell OpenClaw must dispatch the declared mcp.method instead of a hard-coded generic writer");
      assert.equal(existsSync(join(psHome, "layers", "openclaw-skills", "crystal-brief", "SKILL.md")), true,
        "PowerShell OpenClaw must continue into the declared skills layer");
      assert.equal(existsSync(join(psHome, ".memorycrystal", "mcp-config.json")), false,
        "PowerShell OpenClaw fallback must not use the hard-coded generic default path");
      console.log(`specialized multilayer fixture: Bash Hermes/OpenClaw + ${localPs || "Docker PowerShell"} OpenClaw created declared artifacts`);
    }
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
}

// ── Uninstall mutation: reject unknown methods; generic table purge ────────
// A typo in uninstall.mcp.method must fail before touching its declared MCP or
// hook artifacts and before printing completion. Explicit no-ops remain valid.
// purge.launchdPlist must dispatch from any table row, without a target-name case.
{
  const fixtureHome = mkdtempSync(join(tmpdir(), "mc-uninstall-mutations-"));
  try {
    const fixtureTablePath = join(fixtureHome, "platforms-uninstall-mutations.json");
    const fixtureTable = structuredClone(platformsTable);
    fixtureTable.platforms["fixture-typo-remove"] = {
      id: "fixture-typo-remove",
      tier: "tools",
      testedWith: null,
      mcp: { method: "none" },
      hooks: { method: "none", inject: false, path: null },
      skills: { method: "none" },
      agentsFile: null,
      verify: null,
      plugin: { method: "none" },
      postNotes: [],
      uninstall: {
        mcp: { method: "typo-remove", path: "${HOME}/.fixture-uninstall/managed.txt" },
        hooks: { paths: ["${HOME}/.fixture-uninstall/hooks.json"] },
      },
    };
    fixtureTable.platforms["fixture-uninstall-none"] = {
      id: "fixture-uninstall-none",
      tier: "tools",
      testedWith: null,
      mcp: { method: "none" },
      hooks: { method: "none", inject: false, path: null },
      skills: { method: "none" },
      agentsFile: null,
      verify: null,
      plugin: { method: "none" },
      postNotes: [],
      uninstall: { mcp: { method: "none" }, hooks: { paths: [] } },
    };
    fixtureTable.platforms["fixture-uninstall-plugin-owned"] = {
      id: "fixture-uninstall-plugin-owned",
      tier: "tools",
      testedWith: null,
      mcp: { method: "none" },
      hooks: { method: "none", inject: false, path: null },
      skills: { method: "none" },
      agentsFile: null,
      verify: null,
      plugin: { method: "none" },
      postNotes: [],
      uninstall: { mcp: { method: "plugin-owned" }, hooks: { paths: [] } },
    };
    fixtureTable.platforms["fixture-generic-purge"] = {
      id: "fixture-generic-purge",
      tier: "tools",
      testedWith: null,
      mcp: { method: "none" },
      hooks: { method: "none", inject: false, path: null },
      skills: { method: "none" },
      agentsFile: null,
      verify: null,
      plugin: { method: "none" },
      postNotes: [],
      uninstall: {
        mcp: { method: "none" },
        hooks: { paths: [] },
        purge: { launchdPlist: "${HOME}/Library/LaunchAgents/com.fixture-generic-purge.plist" },
      },
    };
    writeFileSync(fixtureTablePath, JSON.stringify(fixtureTable, null, 2));

    const managedDir = join(fixtureHome, ".fixture-uninstall");
    mkdirSync(managedDir, { recursive: true });
    const managedPath = join(managedDir, "managed.txt");
    const hooksPath = join(managedDir, "hooks.json");
    const managedBefore = "declared artifact must remain byte-identical\n";
    const hooksBefore = JSON.stringify({
      hooks: { UserPromptSubmit: [{ command: "node ~/.memory-crystal/crystal-hooks.mjs" }] },
      sibling: "preserve",
    }, null, 2) + "\n";
    writeFileSync(managedPath, managedBefore);
    writeFileSync(hooksPath, hooksBefore);

    const baseEnv = {
      ...process.env,
      HOME: fixtureHome,
      CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
    };
    const typo = spawnSync("bash", [
      "apps/web/public/uninstall.sh", "--targets", "fixture-typo-remove", "--no-restart",
    ], { cwd: root, encoding: "utf8", env: baseEnv });
    const typoOut = `${typo.stdout || ""}${typo.stderr || ""}`;
    assert.notEqual(typo.status, 0, `uninstall must reject typo-remove\n${typoOut}`);
    assert.match(typoOut, /Unsupported uninstall\.mcp\.method.*typo-remove/i,
      `unknown uninstall method must fail loudly\n${typoOut}`);
    assert.doesNotMatch(typoOut, /Memory Crystal uninstall complete/,
      `unknown uninstall method must not print completion\n${typoOut}`);
    assert.equal(readFileSync(managedPath, "utf8"), managedBefore,
      "unknown uninstall method must leave its declared artifact untouched");
    assert.equal(readFileSync(hooksPath, "utf8"), hooksBefore,
      "unknown uninstall method must fail before later hook cleanup");

    const noops = spawnSync("bash", [
      "apps/web/public/uninstall.sh", "--targets",
      "fixture-uninstall-none,fixture-uninstall-plugin-owned", "--no-restart",
    ], { cwd: root, encoding: "utf8", env: baseEnv });
    const noopsOut = `${noops.stdout || ""}${noops.stderr || ""}`;
    assert.equal(noops.status, 0, `supported uninstall no-ops must remain valid\n${noopsOut}`);
    assert.match(noopsOut, /Memory Crystal uninstall complete/);

    const launchAgents = join(fixtureHome, "Library", "LaunchAgents");
    const plistPath = join(launchAgents, "com.fixture-generic-purge.plist");
    const launchctlLog = join(fixtureHome, "launchctl.log");
    const binDir = join(fixtureHome, "bin");
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "launchctl"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$HOME/launchctl.log\"\n");
    chmodSync(join(binDir, "launchctl"), 0o755);
    const purgeEnv = { ...baseEnv, PATH: `${binDir}:${process.env.PATH}` };

    writeFileSync(plistPath, "fixture plist\n");
    const withoutPurge = spawnSync("bash", [
      "apps/web/public/uninstall.sh", "--targets", "fixture-generic-purge", "--no-restart",
    ], { cwd: root, encoding: "utf8", env: purgeEnv });
    assert.equal(withoutPurge.status, 0, `${withoutPurge.stdout}${withoutPurge.stderr}`);
    assert.equal(existsSync(plistPath), true, "purge declaration must require --purge");
    assert.equal(existsSync(launchctlLog), false, "launchctl must not run without --purge");

    const dryRun = spawnSync("bash", [
      "apps/web/public/uninstall.sh", "--targets", "fixture-generic-purge",
      "--purge", "--dry-run", "--no-restart",
    ], { cwd: root, encoding: "utf8", env: purgeEnv });
    const dryRunOut = `${dryRun.stdout || ""}${dryRun.stderr || ""}`;
    assert.equal(dryRun.status, 0, dryRunOut);
    assert.match(dryRunOut, /Would remove .*com\.fixture-generic-purge\.plist/);
    assert.equal(existsSync(plistPath), true, "dry-run must retain declared purge plist");
    assert.equal(existsSync(launchctlLog), false, "dry-run must not invoke launchctl");

    const purge = spawnSync("bash", [
      "apps/web/public/uninstall.sh", "--targets", "fixture-generic-purge",
      "--purge", "--no-restart",
    ], { cwd: root, encoding: "utf8", env: purgeEnv });
    const purgeOut = `${purge.stdout || ""}${purge.stderr || ""}`;
    assert.equal(purge.status, 0, purgeOut);
    assert.equal(existsSync(plistPath), false,
      "table-only fixture purge.launchdPlist must be removed generically");
    assert.equal(readFileSync(launchctlLog, "utf8"), `unload ${plistPath}\n`,
      "generic purge must retain launchctl unload behavior before removal");
    assert.match(purgeOut, /Memory Crystal uninstall complete/);
    console.log("uninstall mutations: typo rejected safely; no-ops preserved; generic purge removed plist");
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
}

// ── Table-only Hermes install/purge honors every redirected row path ───────
{
  const fixtureHome = mkdtempSync(join(tmpdir(), "mc-hermes-redirected-"));
  try {
    const fixtureTablePath = join(fixtureHome, "platforms-hermes-redirected.json");
    const fixtureTable = structuredClone(platformsTable);
    const hermesSkillSuite = [
      "crystal-brief",
      "crystal-kb",
      "crystal-architect",
      "crystal-hygiene",
      "crystal-checkpoint",
    ];
    fixtureTable.platforms["fixture-hermes-redirected"] = {
      ...structuredClone(platformsTable.platforms.hermes),
      id: "fixture-hermes-redirected",
      plugin: {
        method: "hermes",
        home: "${HOME}/declared/hermes-home",
        pluginDir: "${HOME}/declared/plugin-bundle",
        config: "${HOME}/declared/config/hermes.yaml",
        env: "${HOME}/declared/secrets/hermes.env",
      },
      skills: { method: "dirs", path: "${HOME}/declared/hermes-home/skills" },
      uninstall: {
        ...structuredClone(platformsTable.platforms.hermes.uninstall),
        skills: { path: "${HOME}/declared/hermes-home/skills", dirs: hermesSkillSuite },
      },
    };
    fixtureTable.platforms["fixture-hermes-home-only"] = {
      ...structuredClone(platformsTable.platforms.hermes),
      id: "fixture-hermes-home-only",
      plugin: {
        method: "hermes",
        home: "${HOME}/declared/home-only",
      },
      skills: { method: "dirs", path: "${HOME}/declared/home-only/skills" },
      uninstall: {
        ...structuredClone(platformsTable.platforms.hermes.uninstall),
        skills: { path: "${HOME}/declared/home-only/skills", dirs: hermesSkillSuite },
      },
    };
    fixtureTable.platforms["fixture-hermes-mixed"] = {
      ...structuredClone(platformsTable.platforms.hermes),
      id: "fixture-hermes-mixed",
      plugin: {
        method: "hermes",
        home: "${HOME}/declared/mixed-home",
        pluginDir: "${HOME}/declared/mixed-plugin",
        env: "${HOME}/declared/mixed.env",
      },
      skills: { method: "dirs", path: "${HOME}/declared/mixed-home/skills" },
      uninstall: {
        ...structuredClone(platformsTable.platforms.hermes.uninstall),
        skills: { path: "${HOME}/declared/mixed-home/skills", dirs: hermesSkillSuite },
      },
    };
    writeFileSync(fixtureTablePath, JSON.stringify(fixtureTable, null, 2));

    const declaredHome = join(fixtureHome, "declared", "hermes-home");
    const declaredPlugin = join(fixtureHome, "declared", "plugin-bundle");
    const declaredConfig = join(fixtureHome, "declared", "config", "hermes.yaml");
    const declaredEnv = join(fixtureHome, "declared", "secrets", "hermes.env");
    const declaredProfilePlugin = join(declaredHome, "profiles", "custom", "plugins", "crystal-memory");
    const defaultSentinel = join(fixtureHome, ".hermes", "default-must-remain.txt");
    mkdirSync(declaredProfilePlugin, { recursive: true });
    writeFileSync(join(declaredProfilePlugin, "old.txt"), "old profile plugin\n");
    mkdirSync(join(fixtureHome, ".hermes"), { recursive: true });
    writeFileSync(defaultSentinel, "hard-coded default was not required\n");

    const baseEnv = {
      ...process.env,
      HOME: fixtureHome,
      HERMES_HOME: "",
      CRYSTAL_PLATFORMS_TABLE: fixtureTablePath,
      MEMORY_CRYSTAL_API_KEY: "mc_hermes_redirected_token",
    };
    const installed = spawnSync("bash", [
      "apps/web/public/install.sh", "--yes", "--backend", "self-hosted",
      "--self-hosted-url", "https://hermes-redirected.convex.site",
      "--targets", "fixture-hermes-redirected",
    ], { cwd: root, encoding: "utf8", env: baseEnv });
    assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
    assert.equal(existsSync(join(declaredPlugin, "plugin.yaml")), true, "declared pluginDir must receive the bundle");
    assert.equal(existsSync(join(declaredProfilePlugin, "plugin.yaml")), true, "declared home must drive profile updates");
    assert.match(readFileSync(declaredConfig, "utf8"), /crystal-memory|memory_crystal/);
    assert.match(readFileSync(declaredEnv, "utf8"), /MEMORY_CRYSTAL_API_KEY/);
    assert.equal(readFileSync(defaultSentinel, "utf8"), "hard-coded default was not required\n");

    const purged = spawnSync("bash", [
      "apps/web/public/uninstall.sh", "--targets", "fixture-hermes-redirected",
      "--purge", "--no-restart",
    ], { cwd: root, encoding: "utf8", env: baseEnv });
    const purgeOut = `${purged.stdout || ""}${purged.stderr || ""}`;
    assert.equal(purged.status, 0, purgeOut);
    assert.equal(existsSync(declaredPlugin), false, "declared pluginDir must be purged");
    assert.equal(existsSync(declaredProfilePlugin), false, "declared home must drive profile bundle purge");
    assert.doesNotMatch(readFileSync(declaredConfig, "utf8"), /crystal-memory|memory_crystal/,
      "declared config must have all Memory Crystal wiring removed");
    assert.doesNotMatch(readFileSync(declaredEnv, "utf8"), /MEMORY_CRYSTAL|CRYSTAL_CONVEX/,
      "declared env must have all Memory Crystal keys removed");
    assert.equal(readFileSync(defaultSentinel, "utf8"), "hard-coded default was not required\n",
      "redirected uninstall must not depend on or purge the hard-coded ~/.hermes default");
    assert.match(purgeOut, /Memory Crystal uninstall complete/);

    const assertHermesRoundTrip = ({ target, plugin, config, env }) => {
      const installResult = spawnSync("bash", [
        "apps/web/public/install.sh", "--yes", "--backend", "self-hosted",
        "--self-hosted-url", "https://hermes-derived.convex.site", "--targets", target,
      ], { cwd: root, encoding: "utf8", env: baseEnv });
      assert.equal(installResult.status, 0, `${installResult.stdout}${installResult.stderr}`);
      assert.equal(existsSync(join(plugin, "plugin.yaml")), true, `${target} plugin path was not installed`);
      assert.match(readFileSync(config, "utf8"), /crystal-memory|memory_crystal/, `${target} config path was not installed`);
      assert.match(readFileSync(env, "utf8"), /MEMORY_CRYSTAL_API_KEY/, `${target} env path was not installed`);

      const purgeResult = spawnSync("bash", [
        "apps/web/public/uninstall.sh", "--targets", target, "--purge", "--no-restart",
      ], { cwd: root, encoding: "utf8", env: baseEnv });
      const output = `${purgeResult.stdout || ""}${purgeResult.stderr || ""}`;
      assert.equal(purgeResult.status, 0, output);
      assert.equal(existsSync(plugin), false, `${target} plugin path was not purged`);
      assert.doesNotMatch(readFileSync(config, "utf8"), /crystal-memory|memory_crystal/,
        `${target} config path was not cleaned`);
      assert.doesNotMatch(readFileSync(env, "utf8"), /MEMORY_CRYSTAL|CRYSTAL_CONVEX/,
        `${target} env path was not cleaned`);
      assert.match(output, /Memory Crystal uninstall complete/);
    };
    const homeOnly = join(fixtureHome, "declared", "home-only");
    assertHermesRoundTrip({
      target: "fixture-hermes-home-only",
      plugin: join(homeOnly, "plugins", "crystal-memory"),
      config: join(homeOnly, "config.yaml"),
      env: join(homeOnly, ".env"),
    });
    const mixedHome = join(fixtureHome, "declared", "mixed-home");
    assertHermesRoundTrip({
      target: "fixture-hermes-mixed",
      plugin: join(fixtureHome, "declared", "mixed-plugin"),
      config: join(mixedHome, "config.yaml"),
      env: join(fixtureHome, "declared", "mixed.env"),
    });
    assert.equal(readFileSync(defaultSentinel, "utf8"), "hard-coded default was not required\n");
    console.log("table-only Hermes install/purge: explicit, home-only, and mixed explicit/default paths honored symmetrically");
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
}

// ── Piped install fetches the table once and leaves nothing behind ─────────
// On the documented `curl -fsSL .../crystal | bash` path there is no local
// platforms.json, so the table is downloaded. platforms_table_path is reached
// only from command substitutions, so it cannot memoize into a variable: an
// mktemp-per-call version fetched the table 9 times and orphaned 9 temp files
// for a two-target install, and could abort mid-loop on a transient failure,
// leaving a half-configured machine. Assert one fetch and no residue.
{
  const origin = mkdtempSync(join(tmpdir(), "mc-origin-"));
  mkdirSync(join(origin, "install-assets"), { recursive: true });
  writeFileSync(
    join(origin, "install-assets", "platforms.json"),
    readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8"),
  );
  const counter = join(origin, "count.txt");
  const serverJs = join(origin, "server.mjs");
  writeFileSync(serverJs, `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
let n = 0;
const table = readFileSync(process.argv[2] + "/install-assets/platforms.json");
createServer((req, res) => {
  if (req.url.includes("platforms.json")) { n += 1; writeFileSync(process.argv[3], String(n)); res.end(table); return; }
  res.statusCode = 404; res.end("");
}).listen(0, "127.0.0.1", function () { writeFileSync(process.argv[4], String(this.address().port)); });
`);
  const portFile = join(origin, "port.txt");
  const server = spawnSync("bash", ["-c",
    `node ${serverJs} ${origin} ${counter} ${portFile} </dev/null >/dev/null 2>&1 & echo $! > ${origin}/pid; ` +
    `for i in $(seq 1 40); do [ -s ${portFile} ] && break; sleep 0.25; done`],
    { encoding: "utf8" });
  assert.equal(server.status, 0, "could not start the stub origin");
  assert.ok(existsSync(portFile), "stub origin never reported a port");
  const port = Number(readFileSync(portFile, "utf8").trim());
  assert.ok(port > 0, "stub origin reported an invalid port");
  try {
    writeFileSync(counter, "0");
    const neutral = mkdtempSync(join(tmpdir(), "mc-neutral-"));
    const home = mkdtempSync(join(tmpdir(), "mc-piped-home-"));
    const before = readdirSync(tmpdir()).length;
    const piped = spawnSync("bash", ["-c",
      `cd ${neutral} && cat ${join(root, "apps/web/public/install.sh")} | bash -s -- ` +
      `--yes --backend self-hosted --self-hosted-url https://x.convex.site --targets generic-mcp,codex-cli`],
      { encoding: "utf8", env: { ...process.env, CRYSTAL_INSTALL_BASE: `http://127.0.0.1:${port}`, HOME: home, MEMORY_CRYSTAL_API_KEY: "mc_piped_token" } });
    const after = readdirSync(tmpdir()).length;
    assert.equal(piped.status, 0, `piped install failed\n${piped.stdout}${piped.stderr}`);
    const fetches = Number(readFileSync(counter, "utf8").trim());
    assert.equal(fetches, 1, `piped install fetched platforms.json ${fetches} times; it must resolve the table once`);
    assert.ok(after - before <= 0, `piped install left ${after - before} files in the temp directory`);
    assert.equal(
      readdirSync(tmpdir()).filter((f) => f.startsWith("memory-crystal-platforms.")).length, 0,
      "piped install left a downloaded platforms.json behind",
    );
    rmSync(neutral, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    console.log("piped install: one table fetch, no residue");
  } finally {
    spawnSync("bash", ["-c", `kill $(cat ${origin}/pid) 2>/dev/null || true`]);
    rmSync(origin, { recursive: true, force: true });
  }
}


// ── Failing install must still remove the secure mktemp table copy ──────────
// Parent EXIT trap (BASH_SUBSHELL-guarded) must clean PLATFORMS_TABLE_TMP on
// fail()/early exit — not only on the happy path at the end of main.
{
  const origin = mkdtempSync(join(tmpdir(), "mc-fail-origin-"));
  mkdirSync(join(origin, "install-assets"), { recursive: true });
  writeFileSync(
    join(origin, "install-assets", "platforms.json"),
    readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8"),
  );
  const portFile = join(origin, "port.txt");
  const serverJs = join(origin, "server.mjs");
  writeFileSync(serverJs, `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const table = readFileSync(process.argv[2] + "/install-assets/platforms.json");
createServer((req, res) => {
  if (req.url.includes("platforms.json")) { res.end(table); return; }
  res.statusCode = 404; res.end("");
}).listen(0, "127.0.0.1", function () { writeFileSync(process.argv[3], String(this.address().port)); });
`);
  spawnSync("bash", ["-c",
    `node ${serverJs} ${origin} ${portFile} </dev/null >/dev/null 2>&1 & echo $! > ${origin}/pid; ` +
    `for i in $(seq 1 40); do [ -s ${portFile} ] && break; sleep 0.25; done`],
    { encoding: "utf8" });
  try {
    const port = Number(readFileSync(portFile, "utf8").trim());
    const tmpRoot = mkdtempSync(join(tmpdir(), "mc-fail-tmp-"));
    const neutral = mkdtempSync(join(tmpdir(), "mc-fail-neutral-"));
    const home = mkdtempSync(join(tmpdir(), "mc-fail-home-"));
    // Force a post-resolve failure: invalid backend + no local table (piped path).
    const failed = spawnSync("bash", ["-c",
      `cd ${neutral} && cat ${join(root, "apps/web/public/install.sh")} | bash -s -- ` +
      `--yes --backend self-hosted --self-hosted-url https://x.convex.site --targets definitely-not-a-platform`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CRYSTAL_INSTALL_BASE: `http://127.0.0.1:${port}`,
          HOME: home,
          TMPDIR: tmpRoot,
          MEMORY_CRYSTAL_API_KEY: "mc_fail_token",
        },
      });
    assert.notEqual(failed.status, 0, "expected unsupported-target failure");
    const residue = readdirSync(tmpRoot).filter((f) => f.startsWith("memory-crystal-platforms."));
    assert.deepEqual(residue, [], `failing install left table residue: ${residue.join(", ")}\n${failed.stdout}${failed.stderr}`);
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(neutral, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    console.log("failing install: secure mktemp table cleaned");
  } finally {
    spawnSync("bash", ["-c", `kill $(cat ${origin}/pid) 2>/dev/null || true`]);
    rmSync(origin, { recursive: true, force: true });
  }
}

// ── Streamed multi-target uninstall: one table fetch, zero residue ─────────
// curl | bash (or cat | bash) has no BASH_SOURCE file and no local table, so
// the capability table is downloaded. platform_row_json reads via command
// substitution; if resolve lives there, multi-target uninstall re-fetches and
// orphans one mktemp per target. Parent resolve + export + EXIT cleanup must
// fetch exactly once and leave nothing behind.
{
  const uninstaller = readFileSync(join(root, "apps/web/public/uninstall.sh"), "utf8");
  assert.match(uninstaller, /strip_managed_toml_mcp_tables\(/);
  assert.match(uninstaller, /mcp_servers\\.memory-crystal\(\\\]|\\\.\)/);
  assert.doesNotMatch(
    uninstaller,
    /\^\\\[mcp_servers\\\.memory-crystal\\\]\/ \{ skip=1/,
    "uninstall toml-section must strip dotted child tables, not only the parent",
  );
  assert.match(uninstaller, /uninstall\.skills/, "uninstall.sh must remove table-declared skill directories");
  assert.match(uninstaller, /cursor-hooks\.mjs/, "uninstall --purge must remove the Cursor hook adapter");
  assert.match(uninstaller, /resolve_platforms_table/, "uninstall.sh must resolve the table in the parent shell");
  assert.match(uninstaller, /cleanup_platforms_table_on_exit|BASH_SUBSHELL/, "uninstall.sh must parent-guard EXIT cleanup");
  assert.match(
    uninstaller,
    /mktemp "\$\{TMPDIR:-\/tmp\}\/memory-crystal-platforms\.XXXXXX"/,
    "uninstall.sh must create the downloaded table via secure mktemp",
  );
  // Readers must not download (no curl inside platforms_table_path).
  const readerBody = uninstaller.match(/platforms_table_path\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(readerBody, "platforms_table_path function must exist in uninstall.sh");
  assert.doesNotMatch(readerBody[0], /\bcurl\b/, "platforms_table_path must not download");

  const origin = mkdtempSync(join(tmpdir(), "mc-un-origin-"));
  mkdirSync(join(origin, "install-assets"), { recursive: true });
  writeFileSync(
    join(origin, "install-assets", "platforms.json"),
    readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8"),
  );
  const counter = join(origin, "count.txt");
  const portFile = join(origin, "port.txt");
  const serverJs = join(origin, "server.mjs");
  writeFileSync(serverJs, `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
let n = 0;
const table = readFileSync(process.argv[2] + "/install-assets/platforms.json");
createServer((req, res) => {
  if (req.url.includes("platforms.json")) { n += 1; writeFileSync(process.argv[3], String(n)); res.end(table); return; }
  res.statusCode = 404; res.end("");
}).listen(0, "127.0.0.1", function () { writeFileSync(process.argv[4], String(this.address().port)); });
`);
  spawnSync("bash", ["-c",
    `node ${serverJs} ${origin} ${counter} ${portFile} </dev/null >/dev/null 2>&1 & echo $! > ${origin}/pid; ` +
    `for i in $(seq 1 40); do [ -s ${portFile} ] && break; sleep 0.25; done`],
    { encoding: "utf8" });
  try {
    const port = Number(readFileSync(portFile, "utf8").trim());
    writeFileSync(counter, "0");
    const tmpRoot = mkdtempSync(join(tmpdir(), "mc-un-tmp-"));
    const neutral = mkdtempSync(join(tmpdir(), "mc-un-neutral-"));
    const home = mkdtempSync(join(tmpdir(), "mc-un-home-"));
    // Seed configs so uninstall has real work (and still needs the table for paths).
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.memory-crystal]\nurl = \"https://x\"\n");
    mkdirSync(join(home, ".memorycrystal"), { recursive: true });
    writeFileSync(join(home, ".memorycrystal", "mcp-config.json"), JSON.stringify({
      mcpServers: { "memory-crystal": { type: "http", url: "https://x" } },
    }));
    const piped = spawnSync("bash", ["-c",
      `cd ${neutral} && cat ${join(root, "apps/web/public/uninstall.sh")} | bash -s -- ` +
      `--targets codex-cli,generic-mcp --no-restart`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CRYSTAL_INSTALL_BASE: `http://127.0.0.1:${port}`,
          HOME: home,
          TMPDIR: tmpRoot,
          // Ensure no CRYSTAL_PLATFORMS_TABLE / CRYSTAL_ROOT bleed from the parent.
          CRYSTAL_PLATFORMS_TABLE: "",
          CRYSTAL_ROOT: "",
        },
      });
    assert.equal(piped.status, 0, `streamed multi-target uninstall failed\n${piped.stdout}${piped.stderr}`);
    const fetches = Number(readFileSync(counter, "utf8").trim() || "0");
    assert.equal(fetches, 1, `streamed uninstall fetched platforms.json ${fetches} times; must be exactly once`);
    const residue = readdirSync(tmpRoot).filter((f) => f.startsWith("memory-crystal-platforms."));
    assert.deepEqual(residue, [], `streamed uninstall left table residue: ${residue.join(", ")}`);
    // Uninstall actually did work (toml section stripped; generic-mcp file-remove).
    assert.doesNotMatch(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /memory-crystal/);
    assert.equal(
      existsSync(join(home, ".memorycrystal", "mcp-config.json")),
      false,
      "generic-mcp uninstall must remove the managed snippet file",
    );

    // Failure path: parent EXIT trap must clean the owned mktemp after a
    // post-resolve abort (same trap uninstall.sh installs).
    const failHarness = `
set -euo pipefail
export TMPDIR=${JSON.stringify(tmpRoot)}
export INSTALL_BASE=${JSON.stringify(`http://127.0.0.1:${port}`)}
export CRYSTAL_PLATFORMS_TABLE=""
export CRYSTAL_ROOT=""
PLATFORMS_TABLE_PATH=""
PLATFORMS_TABLE_TMP=""
fail() { printf '%s\\n' "$*" >&2; exit 1; }
eval "$(sed -n '/^find_local_platforms_table()/,/^platforms_table_path()/{ /^platforms_table_path()/q; p; }' ${JSON.stringify(join(root, "apps/web/public/uninstall.sh"))})"
eval "$(sed -n '/^platforms_table_path()/,/^platform_row_json()/{ /^platform_row_json()/q; p; }' ${JSON.stringify(join(root, "apps/web/public/uninstall.sh"))})"
find_local_platforms_table() { return 1; }
trap 'cleanup_platforms_table_on_exit' EXIT
resolve_platforms_table
[ -n "\$PLATFORMS_TABLE_TMP" ] || fail "expected owned tmp after download"
# Simulate a post-resolve failure (unsupported target / mid-loop abort).
fail "simulated post-resolve failure"
`;
    const failedUn = spawnSync("bash", ["-c", failHarness], { encoding: "utf8" });
    assert.notEqual(failedUn.status, 0, "expected simulated failure");
    const failResidue = readdirSync(tmpRoot).filter((f) => f.startsWith("memory-crystal-platforms."));
    assert.deepEqual(failResidue, [], `failing uninstall left table residue: ${failResidue.join(", ")}\n${failedUn.stdout}${failedUn.stderr}`);

    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(neutral, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    console.log("streamed multi-target uninstall: one table fetch, no residue");
  } finally {
    spawnSync("bash", ["-c", `kill $(cat ${origin}/pid) 2>/dev/null || true`]);
    rmSync(origin, { recursive: true, force: true });
  }
}

// ── Offline local-backend-only uninstall (streamed, no local table, no origin) ─
// local-backend is not table-driven. Unconditional resolve_platforms_table aborts
// streamed/no-asset/unreachable-origin installs before dispatch. Resolve only
// when a table-driven target is present; this fixture executes the real bin/down.
{
  const neutral = mkdtempSync(join(tmpdir(), "mc-un-lb-neutral-"));
  const home = mkdtempSync(join(tmpdir(), "mc-un-lb-home-"));
  const tmpRoot = mkdtempSync(join(tmpdir(), "mc-un-lb-tmp-"));
  try {
    mkdirSync(join(home, ".memorycrystal", "local-backend", "0.8.1", "bin"), { recursive: true });
    writeFileSync(
      join(home, ".memorycrystal", "local-backend", "0.8.1", "bin", "down"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"$HOME/down-args.txt\"\n",
    );
    chmodSync(join(home, ".memorycrystal", "local-backend", "0.8.1", "bin", "down"), 0o755);

    // Streamed (cat | bash): no BASH_SOURCE file path → no sibling platforms.json.
    // Unreachable origin + empty CRYSTAL_PLATFORMS_TABLE / CRYSTAL_ROOT.
    const offline = spawnSync("bash", ["-c",
      `cd ${neutral} && cat ${join(root, "apps/web/public/uninstall.sh")} | bash -s -- ` +
      `--targets local-backend --no-restart`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CRYSTAL_INSTALL_BASE: "http://127.0.0.1:1", // closed port — must not be required
          HOME: home,
          MEMORY_CRYSTAL_HOME: join(home, ".memorycrystal"),
          TMPDIR: tmpRoot,
          CRYSTAL_PLATFORMS_TABLE: "",
          CRYSTAL_ROOT: "",
        },
      });
    const offlineOut = `${offline.stdout || ""}${offline.stderr || ""}`;
    assert.equal(offline.status, 0, `offline local-backend-only uninstall failed\n${offlineOut}`);
    assert.match(offlineOut, /Stopped local backend; Docker volumes preserved/,
      `expected real local backend down command to run\n${offlineOut}`);
    assert.equal(existsSync(join(home, "down-args.txt")), true,
      `local backend down command was not executed\n${offlineOut}`);
    assert.equal(readFileSync(join(home, "down-args.txt"), "utf8"), "\n",
      "local-backend uninstall must preserve volumes by omitting --wipe");
    assert.doesNotMatch(offlineOut, /Could not load platform capability table/,
      `local-backend-only must not require platforms.json\n${offlineOut}`);
    assert.match(offlineOut, /Memory Crystal uninstall complete/,
      `expected uninstall completion banner\n${offlineOut}`);
    const residue = readdirSync(tmpRoot).filter((f) => f.startsWith("memory-crystal-platforms."));
    assert.deepEqual(residue, [], `local-backend-only left table residue: ${residue.join(", ")}`);
    console.log("offline local-backend-only uninstall (streamed, no table, unreachable origin): ok");
  } finally {
    rmSync(neutral, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ── Dynamically invoked PowerShell installer leaves zero table residue ────
// Equivalent to `irm .../install.ps1 | iex`: no install-assets sibling, no
// local table, Get-PlatformsTable downloads mc-platforms-<guid>.json into
// TEMP. Ownership tracking must remove it after parse; user-provided tables
// pointed at by CRYSTAL_PLATFORMS_TABLE must not be deleted.
{
  assert.match(psInstallerSrc, /PlatformsTableOwnedPath|Remove-OwnedPlatformsTable/,
    "install.ps1 must track ownership of downloaded platforms tables");
  assert.match(psInstallerSrc, /finally\s*\{\s*Remove-OwnedPlatformsTable/,
    "install.ps1 must clean owned tables in a top-level finally");

  const localPs = ["pwsh", "powershell"].find(
    (cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0,
  );
  const dockerOk =
    !localPs &&
    spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
  if (!localPs && !dockerOk) {
    console.warn("SKIP (loud): no PowerShell runtime and no usable Docker — dynamic PS residue check was NOT executed.");
  } else {
    const origin = mkdtempSync(join(tmpdir(), "mc-ps-origin-"));
    mkdirSync(join(origin, "install-assets"), { recursive: true });
    writeFileSync(
      join(origin, "install-assets", "platforms.json"),
      readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8"),
    );
    const counter = join(origin, "count.txt");
    const portFile = join(origin, "port.txt");
    const serverJs = join(origin, "server.mjs");
    // Bind 0.0.0.0 so the Docker PowerShell lane can reach the stub via
    // host.docker.internal (127.0.0.1-only binds are invisible from the VM).
    writeFileSync(serverJs, `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
let n = 0;
const table = readFileSync(process.argv[2] + "/install-assets/platforms.json");
createServer((req, res) => {
  if (req.url && req.url.includes("platforms.json")) {
    n += 1; writeFileSync(process.argv[3], String(n));
    res.setHeader("Content-Type", "application/json");
    res.end(table);
    return;
  }
  res.statusCode = 404; res.end("");
}).listen(0, "0.0.0.0", function () { writeFileSync(process.argv[4], String(this.address().port)); });
`);
    spawnSync("bash", ["-c",
      `node ${serverJs} ${origin} ${counter} ${portFile} </dev/null >/dev/null 2>&1 & echo $! > ${origin}/pid; ` +
      `for i in $(seq 1 40); do [ -s ${portFile} ] && break; sleep 0.25; done`],
      { encoding: "utf8" });
    try {
      const port = Number(readFileSync(portFile, "utf8").trim());
      writeFileSync(counter, "0");
      const fixtureHome = mkdtempSync(join(tmpdir(), "mc-ps-dyn-home-"));
      const tempRoot = mkdtempSync(join(tmpdir(), "mc-ps-dyn-temp-"));
      const userTable = join(fixtureHome, "user-platforms.json");
      writeFileSync(userTable, readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8"));
      const scriptPath = join(root, "apps/web/public/install.ps1");

      // Dynamic path: copy install.ps1 to a TEMP location with no install-assets
      // sibling (same as irm|iex regarding local discovery), then invoke it.
      let psRun;
      if (localPs) {
        const psCommand = [
          `$env:TEMP = ${JSON.stringify(tempRoot)}`,
          `$env:TMP = ${JSON.stringify(tempRoot)}`,
          `$env:CRYSTAL_INSTALL_BASE = ${JSON.stringify(`http://127.0.0.1:${port}`)}`,
          `$env:HOME = ${JSON.stringify(fixtureHome)}`,
          `$env:MEMORY_CRYSTAL_HOME = ${JSON.stringify(join(fixtureHome, ".memorycrystal"))}`,
          `$env:MEMORY_CRYSTAL_API_KEY = 'mc_ps_dyn_token'`,
          `Remove-Item Env:CRYSTAL_PLATFORMS_TABLE -ErrorAction SilentlyContinue`,
          `Remove-Item Env:CRYSTAL_ROOT -ErrorAction SilentlyContinue`,
          `Set-Location ${JSON.stringify(tempRoot)}`,
          `$dyn = Join-Path ${JSON.stringify(tempRoot)} 'install-dyn.ps1'`,
          `Copy-Item -LiteralPath ${JSON.stringify(scriptPath)} -Destination $dyn -Force`,
          `& $dyn -Backend self-hosted -SelfHostedUrl 'https://dyn.convex.site' -Targets generic-mcp -Yes -NoSkills`,
        ].join("; ");
        psRun = spawnSync(localPs, ["-NoProfile", "-Command", psCommand], {
          encoding: "utf8",
          cwd: tempRoot,
          env: {
            ...process.env,
            TEMP: tempRoot,
            TMP: tempRoot,
            HOME: fixtureHome,
            CRYSTAL_PLATFORMS_TABLE: "",
            CRYSTAL_ROOT: "",
            CRYSTAL_INSTALL_BASE: `http://127.0.0.1:${port}`,
            MEMORY_CRYSTAL_API_KEY: "mc_ps_dyn_token",
            MEMORY_CRYSTAL_HOME: join(fixtureHome, ".memorycrystal"),
          },
        });
      } else {
        psRun = spawnSync("docker", [
          "run", "--rm",
          "-v", `${root}:/repo:ro`,
          "-v", `${fixtureHome}:/fixture-home`,
          "-v", `${tempRoot}:/fixture-temp`,
          "-w", "/fixture-temp",
          "-e", "HOME=/fixture-home",
          "-e", "TEMP=/fixture-temp",
          "-e", "TMP=/fixture-temp",
          "-e", `CRYSTAL_INSTALL_BASE=http://host.docker.internal:${port}`,
          "-e", "MEMORY_CRYSTAL_API_KEY=mc_ps_dyn_token",
          "-e", "MEMORY_CRYSTAL_HOME=/fixture-home/.memorycrystal",
          "--add-host", "host.docker.internal:host-gateway",
          "mcr.microsoft.com/powershell:latest",
          "pwsh", "-NoProfile", "-Command",
          [
            "Copy-Item -LiteralPath /repo/apps/web/public/install.ps1 -Destination /fixture-temp/install-dyn.ps1 -Force",
            "Remove-Item Env:CRYSTAL_PLATFORMS_TABLE -ErrorAction SilentlyContinue",
            "Remove-Item Env:CRYSTAL_ROOT -ErrorAction SilentlyContinue",
            "& /fixture-temp/install-dyn.ps1 -Backend self-hosted -SelfHostedUrl 'https://dyn.convex.site' -Targets generic-mcp -Yes -NoSkills",
          ].join("; "),
        ], { encoding: "utf8" });
      }

      const combined = `${psRun.stdout || ""}${psRun.stderr || ""}`;
      assert.equal(psRun.status, 0, `dynamic PowerShell installer failed\n${combined}`);
      assert.match(combined, /installer complete|Generic MCP config written/i, combined);

      const tempResidue = readdirSync(tempRoot).filter((f) => f.startsWith("mc-platforms-") && f.endsWith(".json"));
      assert.deepEqual(tempResidue, [], `dynamic PS install left downloaded table residue: ${tempResidue.join(", ")}\n${combined}`);

      // Local user-provided table must not be deleted when used as the source.
      assert.equal(existsSync(userTable), true, "user-provided platforms table must not be deleted");
      let userProtect;
      if (localPs) {
        userProtect = spawnSync(localPs, ["-NoProfile", "-Command", [
          `$env:TEMP = ${JSON.stringify(tempRoot)}`,
          `$env:TMP = ${JSON.stringify(tempRoot)}`,
          `$env:CRYSTAL_PLATFORMS_TABLE = ${JSON.stringify(userTable)}`,
          `$env:HOME = ${JSON.stringify(fixtureHome)}`,
          `$env:MEMORY_CRYSTAL_HOME = ${JSON.stringify(join(fixtureHome, ".memorycrystal-user"))}`,
          `$env:MEMORY_CRYSTAL_API_KEY = 'mc_ps_user_token'`,
          `Set-Location ${JSON.stringify(tempRoot)}`,
          `$dyn = Join-Path ${JSON.stringify(tempRoot)} 'install-dyn-user.ps1'`,
          `Copy-Item -LiteralPath ${JSON.stringify(scriptPath)} -Destination $dyn -Force`,
          `& $dyn -Backend self-hosted -SelfHostedUrl 'https://user.convex.site' -Targets generic-mcp -Yes -NoSkills`,
          `if (-not (Test-Path -LiteralPath ${JSON.stringify(userTable)})) { throw 'user table deleted' }`,
          `Write-Output 'user-table-preserved'`,
        ].join("; ")], {
          encoding: "utf8",
          env: {
            ...process.env,
            TEMP: tempRoot,
            TMP: tempRoot,
            HOME: fixtureHome,
            CRYSTAL_PLATFORMS_TABLE: userTable,
            MEMORY_CRYSTAL_API_KEY: "mc_ps_user_token",
            MEMORY_CRYSTAL_HOME: join(fixtureHome, ".memorycrystal-user"),
          },
        });
      } else {
        userProtect = spawnSync("docker", [
          "run", "--rm",
          "-v", `${root}:/repo:ro`,
          "-v", `${fixtureHome}:/fixture-home`,
          "-v", `${tempRoot}:/fixture-temp`,
          "-w", "/fixture-temp",
          "-e", "HOME=/fixture-home",
          "-e", "TEMP=/fixture-temp",
          "-e", "TMP=/fixture-temp",
          "-e", "CRYSTAL_PLATFORMS_TABLE=/fixture-home/user-platforms.json",
          "-e", "MEMORY_CRYSTAL_API_KEY=mc_ps_user_token",
          "-e", "MEMORY_CRYSTAL_HOME=/fixture-home/.memorycrystal-user",
          "mcr.microsoft.com/powershell:latest",
          "pwsh", "-NoProfile", "-Command",
          [
            "Copy-Item -LiteralPath /repo/apps/web/public/install.ps1 -Destination /fixture-temp/install-dyn-user.ps1 -Force",
            "& /fixture-temp/install-dyn-user.ps1 -Backend self-hosted -SelfHostedUrl 'https://user.convex.site' -Targets generic-mcp -Yes -NoSkills",
            "if (-not (Test-Path -LiteralPath /fixture-home/user-platforms.json)) { throw 'user table deleted' }",
            "Write-Output 'user-table-preserved'",
          ].join("; "),
        ], { encoding: "utf8" });
      }
      const userCombined = `${userProtect.stdout || ""}${userProtect.stderr || ""}`;
      assert.equal(userProtect.status, 0, `user-table preserve check failed\n${userCombined}`);
      assert.match(userCombined, /user-table-preserved/);
      assert.equal(existsSync(userTable), true);

      rmSync(fixtureHome, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
      console.log(`dynamic PowerShell install: no table residue (${localPs || "docker"})`);
    } finally {
      spawnSync("bash", ["-c", `kill $(cat ${origin}/pid) 2>/dev/null || true`]);
      rmSync(origin, { recursive: true, force: true });
    }
  }
}

{
  const claudeHome = mkdtempSync(join(tmpdir(), "mc-claude-hooks-"));
  try {
    const bin = join(claudeHome, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
set -e
cmd="$1"; shift || true
if [ "$cmd" = "mcp" ]; then
  sub="$1"; shift || true
  if [ "$sub" = "remove" ]; then exit 0; fi
  if [ "$sub" = "add" ]; then
    url=""; header=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --scope|--transport) shift 2 ;;
        --header) header="$2"; shift 2 ;;
        http*|https*) url="$1"; shift ;;
        *) shift ;;
      esac
    done
    mkdir -p "$HOME"
    key="\${header#Authorization: Bearer }"
    node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude.json";let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};c.mcpServers=c.mcpServers||{};c.mcpServers["memory-crystal"]={type:"http",url:process.argv[1],headers:{Authorization:"Bearer "+process.argv[2]}};fs.writeFileSync(p,JSON.stringify(c,null,2)+"\\n");' "$url" "$key"
    exit 0
  fi
fi
exit 0
`);
    chmodSync(join(bin, "claude"), 0o755);
    mkdirSync(join(claudeHome, ".claude"), { recursive: true });
    writeFileSync(join(claudeHome, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "keep-pre" }] }],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "other-hook", timeout: 5 }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: "keep-stop", timeout: 5 }] },
        ],
      },
    }, null, 2));

    const claudeEnv = {
      ...process.env,
      HOME: claudeHome,
      PATH: `${bin}:${process.env.PATH}`,
      MEMORY_CRYSTAL_HOME: join(claudeHome, ".memorycrystal"),
      MEMORY_CRYSTAL_API_KEY: "mc_claude_token",
    };
    const installArgs = [
      "apps/web/public/install.sh",
      "--yes",
      "--backend", "self-hosted",
      "--self-hosted-url", "https://claude-smoke.convex.site",
      "--targets", "claude-code",
    ];
    run("bash", installArgs, { env: claudeEnv });
    run("bash", installArgs, { env: claudeEnv });

    const settings = JSON.parse(readFileSync(join(claudeHome, ".claude", "settings.json"), "utf8"));
    const crystalOn = (event) => (settings.hooks[event] || []).filter((entry) =>
      Array.isArray(entry?.hooks) && entry.hooks.some((candidate) =>
        typeof candidate?.command === "string" && /crystal-hooks\.mjs/.test(candidate.command),
      ),
    );
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      assert.equal(crystalOn(event).length, 1, `${event} must have exactly one Memory Crystal hook after two installs`);
      assert.equal(crystalOn(event)[0].matcher, undefined, `${event} must not use a Codex SessionStart matcher`);
      assert.equal(crystalOn(event)[0].hooks[0].type, "command");
    }
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "keep-pre");
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "other-hook");
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "keep-stop");

    const uninstalled = run("bash", [
      "apps/web/public/uninstall.sh",
      "--targets", "claude-code",
      "--no-restart",
    ], { env: claudeEnv });
    assert.match(`${uninstalled.stdout}\n${uninstalled.stderr}`, /Memory Crystal uninstall complete/);

    const settingsAfter = JSON.parse(readFileSync(join(claudeHome, ".claude", "settings.json"), "utf8"));
    assert.equal(settingsAfter.hooks.PreToolUse[0].hooks[0].command, "keep-pre");
    assert.equal(settingsAfter.hooks.UserPromptSubmit.length, 1);
    assert.equal(settingsAfter.hooks.UserPromptSubmit[0].hooks[0].command, "other-hook");
    assert.equal(settingsAfter.hooks.Stop.length, 1);
    assert.equal(settingsAfter.hooks.Stop[0].hooks[0].command, "keep-stop");
    assert.equal(settingsAfter.hooks.SessionStart, undefined);
    assert.doesNotMatch(JSON.stringify(settingsAfter), /crystal-hooks\.mjs/);
  } finally {
    rmSync(claudeHome, { recursive: true, force: true });
  }
}

{
  const cursorHome = mkdtempSync(join(tmpdir(), "mc-cursor-"));
  try {
    mkdirSync(join(cursorHome, ".cursor"), { recursive: true });
    writeFileSync(join(cursorHome, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: {
        keep_me: { url: "https://example.test/keep" },
      },
    }, null, 2));
    writeFileSync(join(cursorHome, ".cursor", "hooks.json"), JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: "existing-session" }],
      },
    }, null, 2));
    mkdirSync(join(cursorHome, ".cursor", "skills", "user-skill"), { recursive: true });
    writeFileSync(join(cursorHome, ".cursor", "skills", "user-skill", "SKILL.md"), "keep\n");

    const cursorEnv = {
      ...process.env,
      HOME: cursorHome,
      MEMORY_CRYSTAL_HOME: join(cursorHome, ".memorycrystal"),
      MEMORY_CRYSTAL_API_KEY: "mc_cursor_token",
    };
    const installArgs = [
      "apps/web/public/install.sh",
      "--yes",
      "--backend", "self-hosted",
      "--self-hosted-url", "https://cursor-smoke.convex.site",
      "--targets", "cursor",
    ];
    const first = run("bash", installArgs, { env: cursorEnv });
    assert.doesNotMatch(`${first.stdout}\n${first.stderr}`, /Unsupported target:/);
    const second = run("bash", installArgs, { env: cursorEnv });
    assert.doesNotMatch(`${second.stdout}\n${second.stderr}`, /Unsupported target:/);

    const mcp = JSON.parse(readFileSync(join(cursorHome, ".cursor", "mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.keep_me.url, "https://example.test/keep");
    assert.equal(mcp.mcpServers["memory-crystal"].url, "https://cursor-smoke.convex.site/api/mcp");
    assert.match(mcp.mcpServers["memory-crystal"].headers.Authorization, /Bearer mc_cursor_token/);
    assert.equal(Object.keys(mcp.mcpServers).sort().join(","), "keep_me,memory-crystal");

    const hooks = JSON.parse(readFileSync(join(cursorHome, ".cursor", "hooks.json"), "utf8"));
    assert.equal(hooks.version, 1);
    assert.equal(hooks.hooks.SessionStart, undefined);
    assert.equal(hooks.hooks.UserPromptSubmit, undefined);
    const crystalOn = (event) => (hooks.hooks[event] || []).filter((entry) =>
      typeof entry?.command === "string" && /cursor-hooks\.mjs|crystal-hooks\.mjs/.test(entry.command),
    );
    for (const event of ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "postToolUse"]) {
      assert.ok(Array.isArray(hooks.hooks[event]), `${event} must be a command array`);
      assert.equal(crystalOn(event).length, 1, `${event} must have exactly one Memory Crystal command after two installs`);
      assert.equal(crystalOn(event)[0].hooks, undefined, `${event} must use Cursor command objects, not Claude nesting`);
    }
    assert.equal(hooks.hooks.sessionStart[0].command, "existing-session");

    const pluginRoot = join(cursorHome, ".cursor", "plugins", "local", "memory-crystal");
    assert.equal(existsSync(join(pluginRoot, ".cursor-plugin", "plugin.json")), true);
    assert.equal(existsSync(join(pluginRoot, "rules", "crystal-memory.mdc")), true);
    for (const skill of ["crystal-brief", "crystal-kb", "crystal-architect", "crystal-hygiene", "crystal-checkpoint"]) {
      assert.equal(existsSync(join(cursorHome, ".cursor", "skills", skill, "SKILL.md")), true);
      assert.equal(existsSync(join(pluginRoot, "skills", skill, "SKILL.md")), true);
    }
    assert.equal(readFileSync(join(cursorHome, ".cursor", "skills", "user-skill", "SKILL.md"), "utf8"), "keep\n");

    const uninstalled = run("bash", [
      "apps/web/public/uninstall.sh",
      "--targets", "cursor",
      "--no-restart",
    ], { env: cursorEnv });
    assert.match(`${uninstalled.stdout}\n${uninstalled.stderr}`, /Memory Crystal uninstall complete/);

    const mcpAfter = JSON.parse(readFileSync(join(cursorHome, ".cursor", "mcp.json"), "utf8"));
    assert.equal(mcpAfter.mcpServers.keep_me.url, "https://example.test/keep");
    assert.equal(mcpAfter.mcpServers["memory-crystal"], undefined);

    const hooksAfter = JSON.parse(readFileSync(join(cursorHome, ".cursor", "hooks.json"), "utf8"));
    assert.equal(hooksAfter.hooks.sessionStart.length, 1);
    assert.equal(hooksAfter.hooks.sessionStart[0].command, "existing-session");
    for (const event of ["beforeSubmitPrompt", "afterAgentResponse", "stop", "postToolUse"]) {
      assert.equal(hooksAfter.hooks[event], undefined);
    }
    assert.equal(existsSync(pluginRoot), false);
    for (const skill of ["crystal-brief", "crystal-kb", "crystal-architect", "crystal-hygiene", "crystal-checkpoint"]) {
      assert.equal(existsSync(join(cursorHome, ".cursor", "skills", skill)), false);
    }
    assert.equal(readFileSync(join(cursorHome, ".cursor", "skills", "user-skill", "SKILL.md"), "utf8"), "keep\n");
  } finally {
    rmSync(cursorHome, { recursive: true, force: true });
  }
}

{
  const grokHome = mkdtempSync(join(tmpdir(), "mc-grok-"));
  const grokPreamble = "# User standing orders\nNever deploy on Fridays.\nUNIQUE_USER_PREAMBLE_ILL171\n";
  try {
    mkdirSync(join(grokHome, ".grok"), { recursive: true });
    writeFileSync(join(grokHome, ".grok", "config.toml"), "[features]\nexample = true\n");
    writeFileSync(join(grokHome, ".grok", "AGENTS.md"), grokPreamble);
    mkdirSync(join(grokHome, ".grok", "skills", "user-skill"), { recursive: true });
    writeFileSync(join(grokHome, ".grok", "skills", "user-skill", "SKILL.md"), "keep\n");

    const pathWithoutGrok = (process.env.PATH || "")
      .split(":")
      .filter((dir) => dir && !existsSync(join(dir, "grok")))
      .join(":");
    const grokEnv = {
      ...process.env,
      HOME: grokHome,
      PATH: pathWithoutGrok,
      MEMORY_CRYSTAL_HOME: join(grokHome, ".memorycrystal"),
      MEMORY_CRYSTAL_API_KEY: "mc_grok_token",
    };
    const installArgs = [
      "apps/web/public/install.sh",
      "--yes",
      "--backend", "self-hosted",
      "--self-hosted-url", "https://grok-smoke.convex.site",
      "--targets", "grok",
    ];
    const first = run("bash", installArgs, { env: grokEnv });
    assert.doesNotMatch(`${first.stdout}\n${first.stderr}`, /Unsupported target:/);
    assert.match(`${first.stdout}\n${first.stderr}`, /Capture tier/);
    assert.match(`${first.stdout}\n${first.stderr}`, /no automatic recall/);
    const second = run("bash", installArgs, { env: grokEnv });
    assert.doesNotMatch(`${second.stdout}\n${second.stderr}`, /Unsupported target:/);

    const toml = readFileSync(join(grokHome, ".grok", "config.toml"), "utf8");
    assert.match(toml, /\[features\]/);
    assert.match(toml, /example = true/);
    assert.match(toml, /\[mcp_servers\.memory-crystal\]/);
    assert.match(toml, /url = "https:\/\/grok-smoke\.convex\.site\/api\/mcp"/);
    assert.match(toml, /headers = \{ "Authorization" = "Bearer mc_grok_token" \}/);
    assert.doesNotMatch(toml, /http_headers/);

    const hookFile = join(grokHome, ".grok", "hooks", "memory-crystal.json");
    assert.equal(existsSync(hookFile), true);
    const hooks = JSON.parse(readFileSync(hookFile, "utf8"));
    const crystalOn = (event) => (hooks.hooks[event] || []).filter((entry) =>
      Array.isArray(entry?.hooks) && entry.hooks.some((candidate) =>
        typeof candidate?.command === "string" && /crystal-hooks\.mjs/.test(candidate.command),
      ),
    );
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      assert.equal(crystalOn(event).length, 1, `${event} must have exactly one Memory Crystal hook`);
      assert.equal(crystalOn(event)[0].matcher, undefined, `${event} must not carry a matcher`);
      assert.equal(Object.prototype.hasOwnProperty.call(crystalOn(event)[0], "matcher"), false);
    }
    assert.equal(hooks.hooks.PreToolUse, undefined);
    assert.doesNotMatch(JSON.stringify(hooks), /"matcher"/);

    const runtime = JSON.parse(readFileSync(join(grokHome, ".memory-crystal", "config.json"), "utf8"));
    assert.equal(runtime.platform, "grok");
    assert.equal(runtime.agentId, "grok");

    for (const skill of ["crystal-brief", "crystal-kb", "crystal-architect", "crystal-hygiene", "crystal-checkpoint"]) {
      assert.equal(existsSync(join(grokHome, ".grok", "skills", skill, "SKILL.md")), true);
    }
    assert.equal(readFileSync(join(grokHome, ".grok", "skills", "user-skill", "SKILL.md"), "utf8"), "keep\n");

    const agents = readFileSync(join(grokHome, ".grok", "AGENTS.md"), "utf8");
    assert.match(agents, /UNIQUE_USER_PREAMBLE_ILL171/);
    assert.match(agents, /crystal_preflight/);
    assert.doesNotMatch(agents, /mc_grok_token/);

    const uninstalled = run("bash", [
      "apps/web/public/uninstall.sh",
      "--targets", "grok",
      "--no-restart",
    ], { env: grokEnv });
    assert.match(`${uninstalled.stdout}\n${uninstalled.stderr}`, /Memory Crystal uninstall complete/);
    assert.equal(existsSync(hookFile), false, "uninstall must delete the dedicated Grok hook file");
    const tomlAfter = readFileSync(join(grokHome, ".grok", "config.toml"), "utf8");
    assert.match(tomlAfter, /\[features\]/);
    assert.doesNotMatch(tomlAfter, /mcp_servers\.memory-crystal/);
    const agentsAfter = readFileSync(join(grokHome, ".grok", "AGENTS.md"), "utf8");
    assert.equal(agentsAfter, grokPreamble);
    for (const skill of ["crystal-brief", "crystal-kb", "crystal-architect", "crystal-hygiene", "crystal-checkpoint"]) {
      assert.equal(existsSync(join(grokHome, ".grok", "skills", skill)), false);
    }
    assert.equal(readFileSync(join(grokHome, ".grok", "skills", "user-skill", "SKILL.md"), "utf8"), "keep\n");
  } finally {
    rmSync(grokHome, { recursive: true, force: true });
  }
}

{
  const grokCliHome = mkdtempSync(join(tmpdir(), "mc-grok-cli-"));
  const bin = mkdtempSync(join(tmpdir(), "mc-grok-bin-"));
  try {
    writeFileSync(join(bin, "grok"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.grok"
echo "$0 $*" >> "$HOME/.grok/grok-cli.log"
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "add" ]; then
  cat >> "$HOME/.grok/config.toml" <<EOF

[mcp_servers.memory-crystal]
url = "from-cli"
headers = { "Authorization" = "Bearer from-cli" }
EOF
fi
if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "remove" ]; then
  echo removed >> "$HOME/.grok/grok-cli.log"
fi
`);
    chmodSync(join(bin, "grok"), 0o755);
    const grokEnv = {
      ...process.env,
      HOME: grokCliHome,
      PATH: `${bin}:${process.env.PATH}`,
      MEMORY_CRYSTAL_HOME: join(grokCliHome, ".memorycrystal"),
      MEMORY_CRYSTAL_API_KEY: "mc_grok_cli_token",
    };
    const installed = run("bash", [
      "apps/web/public/install.sh",
      "--yes",
      "--backend", "self-hosted",
      "--self-hosted-url", "https://grok-cli.convex.site",
      "--targets", "grok",
    ], { env: grokEnv });
    assert.match(`${installed.stdout}\n${installed.stderr}`, /Grok MCP server registered/);
    const cliLog = readFileSync(join(grokCliHome, ".grok", "grok-cli.log"), "utf8");
    assert.match(cliLog, /mcp add --transport http memory-crystal https:\/\/grok-cli\.convex\.site\/api\/mcp --header Authorization: Bearer mc_grok_cli_token/);
    assert.doesNotMatch(readFileSync(join(grokCliHome, ".grok", "config.toml"), "utf8"), /http_headers/);

    run("bash", [
      "apps/web/public/uninstall.sh",
      "--targets", "grok",
      "--no-restart",
    ], { env: grokEnv });
    const afterLog = readFileSync(join(grokCliHome, ".grok", "grok-cli.log"), "utf8");
    assert.match(afterLog, /mcp remove memory-crystal/);
  } finally {
    rmSync(grokCliHome, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}

{
  // ILL-172: fresh install writes platform-slug agentId; re-run preserves a
  // user-set value; reach report prints reachable-of-total plus the grant remedy.
  const identityHome = mkdtempSync(join(tmpdir(), "mc-identity-"));
  const origin = mkdtempSync(join(tmpdir(), "mc-identity-origin-"));
  const portFile = join(origin, "port.txt");
  const serverJs = join(origin, "server.mjs");
  writeFileSync(serverJs, `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const names = [
  "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta",
  "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi",
];
const all = names.map((name, index) => ({
  _id: "kb" + index,
  name,
  agentIds: index < 3 ? undefined : ["main"],
}));
createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/api/knowledge-bases") {
    res.statusCode = 404;
    res.end("");
    return;
  }
  const agentId = url.searchParams.get("agentId");
  const rows = agentId
    ? all.filter((kb) => kb.agentIds === undefined || kb.agentIds.includes("*") || kb.agentIds.includes(agentId))
    : all;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ knowledgeBases: rows }));
}).listen(0, "127.0.0.1", function () {
  writeFileSync(process.argv[2], String(this.address().port));
});
`);
  spawnSync("bash", ["-c",
    `node ${JSON.stringify(serverJs)} ${JSON.stringify(portFile)} </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(join(origin, "pid"))}; ` +
    `for i in $(seq 1 40); do [ -s ${JSON.stringify(portFile)} ] && break; sleep 0.25; done`],
    { encoding: "utf8" });
  try {
    const port = Number(readFileSync(portFile, "utf8").trim());
    assert.ok(Number.isInteger(port) && port > 0, "identity reach-report mock must bind a port");
    const backend = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      HOME: identityHome,
      MEMORY_CRYSTAL_API_KEY: "mc_identity_token",
    };
    const first = run("bash", [
      "apps/web/public/install.sh",
      "--yes",
      "--backend", "self-hosted",
      "--self-hosted-url", backend,
      "--targets", "generic-mcp",
    ], { env });
    const configPath = join(identityHome, ".memory-crystal", "config.json");
    const firstCfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(firstCfg.agentId, "generic-mcp");
    assert.equal(firstCfg.apiKey, "mc_identity_token");
    assert.equal(firstCfg.convexUrl, backend);
    const firstOut = `${first.stdout}\n${first.stderr}`;
    assert.match(firstOut, /Declared agent identity: generic-mcp/);
    assert.match(firstOut, /3 of 14/);
    assert.match(firstOut, /Reachable: Alpha, Beta, Gamma/);
    assert.match(firstOut, /Unreachable:/);
    assert.match(firstOut, /crystal_set_knowledge_base_access/);
    assert.match(firstOut, /action=add and agentId=generic-mcp/);
    assert.doesNotMatch(firstOut, /chunkCount|description|memories/);

    writeFileSync(configPath, `${JSON.stringify({
      apiKey: "old-key",
      convexUrl: "https://old.example",
      platform: "codex",
      agentId: "nest-alpha",
      projectSalt: "keep-me",
    }, null, 2)}\n`);
    const second = run("bash", [
      "apps/web/public/install.sh",
      "--yes",
      "--backend", "self-hosted",
      "--self-hosted-url", backend,
      "--targets", "generic-mcp",
    ], { env });
    const secondCfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(secondCfg.agentId, "nest-alpha", "re-run must preserve a user-set agentId");
    assert.equal(secondCfg.apiKey, "mc_identity_token");
    assert.equal(secondCfg.convexUrl, backend);
    assert.equal(secondCfg.projectSalt, "keep-me");
    assert.match(`${second.stdout}\n${second.stderr}`, /Declared agent identity: nest-alpha/);
    assert.match(`${second.stdout}\n${second.stderr}`, /3 of 14/);

    const codexHome = mkdtempSync(join(tmpdir(), "mc-identity-codex-"));
    try {
      const codex = run("bash", [
        "apps/web/public/install.sh",
        "--yes",
        "--backend", "self-hosted",
        "--self-hosted-url", backend,
        "--targets", "codex-cli",
      ], { env: { ...process.env, HOME: codexHome, CODEX_HOME: join(codexHome, ".codex"), MEMORY_CRYSTAL_API_KEY: "mc_identity_token" } });
      const codexCfg = JSON.parse(readFileSync(join(codexHome, ".memory-crystal", "config.json"), "utf8"));
      assert.equal(codexCfg.agentId, "codex");
      assert.match(`${codex.stdout}\n${codex.stderr}`, /Declared agent identity: codex/);
      assert.match(`${codex.stdout}\n${codex.stderr}`, /3 of 14/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  } finally {
    spawnSync("bash", ["-c", `kill $(cat ${JSON.stringify(join(origin, "pid"))}) 2>/dev/null || true`]);
    rmSync(origin, { recursive: true, force: true });
    rmSync(identityHome, { recursive: true, force: true });
  }
}

{
  const home = mkdtempSync(join(tmpdir(), "mc-codex-child-toml-"));
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `# keep me
[mcp_servers.greptile]
command = "npx"

[mcp_servers.greptile.http_headers]
X-Keep = "yes"

[mcp_servers.memory-crystal]
url = "https://old.example/api/mcp"

[mcp_servers.memory-crystal.http_headers]
Authorization = "Bearer old_token"

[mcp_servers.memory-crystal.tools.crystal_recall]
enabled = true

[mcp_servers.memory-crystal-other]
url = "https://other.example"
`);
    run("bash", [
      "apps/web/public/install.sh",
      "--yes",
      "--backend", "self-hosted",
      "--self-hosted-url", "https://rewrite.convex.site",
      "--targets", "codex-cli",
      "--no-skills",
    ], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        MEMORY_CRYSTAL_API_KEY: "mc_rewrite_token",
      },
    });
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(toml, /# keep me/);
    assert.match(toml, /\[mcp_servers\.greptile\]/);
    assert.match(toml, /\[mcp_servers\.greptile\.http_headers\]/);
    assert.match(toml, /X-Keep = "yes"/);
    assert.match(toml, /\[mcp_servers\.memory-crystal-other\]/);
    assert.match(toml, /url = "https:\/\/rewrite\.convex\.site\/api\/mcp"/);
    assert.match(toml, /http_headers = \{ "Authorization" = "Bearer mc_rewrite_token" \}/);
    assert.doesNotMatch(toml, /\[mcp_servers\.memory-crystal\.http_headers\]/);
    assert.doesNotMatch(toml, /\[mcp_servers\.memory-crystal\.tools/);
    assert.doesNotMatch(toml, /old_token/);
    const parsed = spawnSync("python3", [
      "-c",
      "import tomllib,sys; tomllib.load(open(sys.argv[1],'rb'))",
      join(home, ".codex", "config.toml"),
    ], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `rewritten Codex TOML must parse\n${parsed.stderr}`);

    run("bash", [
      "apps/web/public/uninstall.sh",
      "--targets", "codex-cli",
      "--no-restart",
    ], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
      },
    });
    const after = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(after, /\[mcp_servers\.greptile\]/);
    assert.match(after, /\[mcp_servers\.memory-crystal-other\]/);
    assert.doesNotMatch(after, /\[mcp_servers\.memory-crystal\]/);
    assert.doesNotMatch(after, /\[mcp_servers\.memory-crystal\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

{
  const pluginManifest = JSON.parse(readFileSync(join(root, "plugins/cursor/memory-crystal/.cursor-plugin/plugin.json"), "utf8"));
  const pluginMcp = JSON.parse(readFileSync(join(root, "plugins/cursor/memory-crystal/mcp.json"), "utf8"));
  const pluginHooks = JSON.parse(readFileSync(join(root, "plugins/cursor/memory-crystal/hooks/hooks.json"), "utf8"));
  assert.equal(pluginManifest.name, "memory-crystal");
  assert.ok(pluginManifest.variables.properties.MEMORY_CRYSTAL_API_KEY);
  assert.match(pluginMcp.mcpServers["memory-crystal"].headers.Authorization, /\$\{MEMORY_CRYSTAL_API_KEY\}/);
  assert.doesNotMatch(JSON.stringify(pluginMcp), /sk-|mc_[A-Za-z0-9]{8,}/);
  assert.equal(pluginHooks.version, 1);
  assert.ok(pluginHooks.hooks.sessionStart[0].command.includes("cursor-hooks.mjs"));
  assert.equal(existsSync(join(root, "plugins/cursor/memory-crystal/rules/crystal-memory.mdc")), true);
  for (const skill of ["crystal-brief", "crystal-kb", "crystal-architect", "crystal-hygiene", "crystal-checkpoint"]) {
    assert.equal(existsSync(join(root, "plugins/cursor/memory-crystal/skills", skill, "SKILL.md")), true);
  }
}

console.log("installer universal smoke tests passed");
