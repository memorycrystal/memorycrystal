#!/usr/bin/env node
/**
 * ILL-170 adversarial checks for the table-driven Managed Block writer.
 * Behavioral: does not prescribe marker syntax or helper names.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const installerSrc = readFileSync(join(root, "apps/web/public/install.sh"), "utf8");
const uninstallSrc = readFileSync(join(root, "apps/web/public/uninstall.sh"), "utf8");
const psSrc = readFileSync(join(root, "apps/web/public/install.ps1"), "utf8");
const platformsTable = JSON.parse(
  readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8"),
);
const instructions = readFileSync(
  join(root, "plugins/shared/MEMORY_CRYSTAL_INSTRUCTIONS.md"),
  "utf8",
);
const FINGERPRINT = "crystal_preflight";
const USER_PREAMBLE = [
  "# User standing orders",
  "Never deploy on Fridays.",
  "UNIQUE_USER_PREAMBLE_ILL170",
  "",
].join("\n");
const SECRET = "mc_secret_ILL170_do_not_leak";

const NULL_AGENT_SURFACES = [
  "openclaw",
  "cursor",
  "claude-desktop",
  "opencode",
  "factory-droid",
  "generic-mcp",
];

function serializeAgentsFile(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isNullAgentsFile(value) {
  return value == null || value === "" || value === "null";
}

function pathLike(value) {
  const text = serializeAgentsFile(value);
  return text;
}

function insertedRegion(before, after) {
  if (after === before) return null;
  let i = 0;
  const max = Math.min(before.length, after.length);
  while (i < max && before[i] === after[i]) i += 1;
  let j = 0;
  while (j < max - i && before[before.length - 1 - j] === after[after.length - 1 - j]) j += 1;
  return after.slice(i, after.length - j);
}

function markerLines(inserted) {
  const lines = inserted.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;
  return { start: lines[0], end: lines[lines.length - 1] };
}

function writeClaudeStub(bin) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env bash
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
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(bin, "hermes"), "#!/usr/bin/env bash\nprintf 'hermes test stub\\n'\n");
  chmodSync(join(bin, "hermes"), 0o755);
}

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "mc-ill170-"));
  const bin = join(home, "bin");
  writeClaudeStub(bin);
  return {
    home,
    bin,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      HERMES_HOME: join(home, ".hermes"),
      OPENCLAW_DIR: join(home, ".openclaw"),
      XDG_CONFIG_HOME: join(home, ".config"),
      MEMORY_CRYSTAL_HOME: join(home, ".memorycrystal"),
      PATH: `${bin}:${process.env.PATH}`,
      MEMORY_CRYSTAL_API_KEY: SECRET,
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function runScript(script, args, env) {
  return spawnSync("bash", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

function install(env, targets, extraArgs = []) {
  return runScript(
    "apps/web/public/install.sh",
    [
      "--yes",
      "--backend", "self-hosted",
      "--self-hosted-url", "https://ill170.convex.site",
      "--targets", targets,
      ...extraArgs,
    ],
    env,
  );
}

function uninstall(env, targets) {
  return runScript(
    "apps/web/public/uninstall.sh",
    ["--targets", targets, "--no-restart"],
    env,
  );
}

function managedBackups(filePath) {
  const dir = dirname(filePath);
  const base = basename(filePath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (name) => name.startsWith(`.${base}.memory-crystal.`) && name.endsWith(".bak"),
  );
}

function listNamed(home, names) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (names.has(entry.name)) found.push(full.slice(home.length) || "/");
    }
  };
  walk(home);
  return found.sort();
}

function assertManagedWrite(path, original) {
  assert.equal(existsSync(path), true, `managed agents file missing: ${path}`);
  const after = readFileSync(path, "utf8");
  assert.notEqual(after, original, `installer did not mutate ${path}`);
  assert.match(after, new RegExp(FINGERPRINT), `${path} must embed MEMORY_CRYSTAL_INSTRUCTIONS.md`);
  assert.match(after, /UNIQUE_USER_PREAMBLE_ILL170/, `${path} must preserve user bytes`);
  assert.doesNotMatch(after, new RegExp(SECRET), `${path} must not contain the API key`);
  assert.doesNotMatch(after, /Authorization: Bearer/i, `${path} must not contain Authorization headers`);
  assert.doesNotMatch(after, /CONVEX_SELF_HOSTED_ADMIN_KEY|sk-proj-|sk-live-/);
  return after;
}

test("check 1: platforms.json agentsFile only on verified surfaces", () => {
  const { platforms } = platformsTable;
  const claude = platforms["claude-code"].agentsFile;
  const claudeText = pathLike(claude);
  assert.equal(isNullAgentsFile(claude), false, "claude-code agentsFile must be set");
  assert.match(claudeText, /\$\{HOME\}\/\.claude\/CLAUDE\.md/);

  for (const id of ["codex-cli", "codex-desktop"]) {
    const value = platforms[id].agentsFile;
    const text = pathLike(value);
    assert.equal(isNullAgentsFile(value), false, `${id} agentsFile must be set`);
    assert.match(
      text,
      /(\$\{HOME\}\/\.codex\/AGENTS\.md|\$\{CODEX_HOME:-\$\{HOME\}\/\.codex\}\/AGENTS\.md)/,
      `${id} agentsFile must be the Codex AGENTS.md path`,
    );
  }

  const grok = platforms.grok.agentsFile;
  const grokText = pathLike(grok);
  assert.equal(isNullAgentsFile(grok), false, "grok agentsFile must be set");
  assert.equal(grokText, "${HOME}/.grok/AGENTS.md", "grok agentsFile must be ~/.grok/AGENTS.md only");

  const hermes = platforms.hermes.agentsFile;
  const hermesText = pathLike(hermes);
  assert.equal(isNullAgentsFile(hermes), false, "hermes agentsFile must be set");
  assert.match(hermesText, /profiles/i);
  assert.match(hermesText, /AGENTS\.md/);
  assert.doesNotMatch(hermesText, /SOUL\.md/);

  for (const id of NULL_AGENT_SURFACES) {
    assert.equal(
      platforms[id].agentsFile,
      null,
      `${id} agentsFile must stay null (do not invent a path)`,
    );
  }

  assert.equal(platforms.grok.tier, "capture");
  assert.equal(platforms.grok.hooks.inject, false);
});

test("check 2: OpenClaw/Cursor do not grow invented instruction files", () => {
  assert.doesNotMatch(installerSrc, /\$HOME\/\.openclaw\/AGENTS\.md|~\/\.openclaw\/AGENTS\.md/);
  assert.doesNotMatch(installerSrc, /\$HOME\/\.cursor\/AGENTS\.md|~\/\.cursor\/AGENTS\.md/);
  assert.doesNotMatch(installerSrc, /\$HOME\/\.cursor\/CLAUDE\.md|~\/\.cursor\/CLAUDE\.md/);
  assert.doesNotMatch(uninstallSrc, /\$HOME\/\.openclaw\/AGENTS\.md|~\/\.cursor\/AGENTS\.md/);

  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".cursor"), { recursive: true });
    mkdirSync(join(box.home, ".openclaw"), { recursive: true });
    const cursor = install(box.env, "cursor");
    assert.equal(cursor.status, 0, `cursor install failed\n${cursor.stdout}\n${cursor.stderr}`);
    assert.match(cursor.stdout, /Support Tier: cursor = full/);
    assert.match(cursor.stdout, /Managed Block: skipped for cursor \(no agentsFile\)/);
    assert.doesNotMatch(cursor.stdout, /discipline: skipped for cursor/);
    const openclaw = install(box.env, "openclaw");
    assert.equal(openclaw.status, 0, `openclaw install failed\n${openclaw.stdout}\n${openclaw.stderr}`);
    assert.match(openclaw.stdout, /Support Tier: openclaw = full/);
    assert.match(openclaw.stdout, /discipline: skipped for openclaw \(no Managed Block target/);
    assert.doesNotMatch(openclaw.stdout, /hooks: skipped for openclaw/);

    const invented = listNamed(box.home, new Set(["AGENTS.md", "CLAUDE.md", "SOUL.md"]))
      .filter((rel) => !rel.includes("/skills/"));
    assert.deepEqual(
      invented,
      [],
      `OpenClaw/Cursor must not invent instruction files, found: ${invented.join(", ")}`,
    );
  } finally {
    box.cleanup();
  }
});

test("check 3+5: byte-identical install×2 + uninstall; no secrets in the block", () => {
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const agentsPath = join(box.home, ".codex", "AGENTS.md");
    writeFileSync(agentsPath, USER_PREAMBLE);
    const original = readFileSync(agentsPath);

    const first = install(box.env, "codex-cli");
    assert.equal(first.status, 0, `codex-cli install failed\n${first.stdout}\n${first.stderr}`);
    const afterFirst = assertManagedWrite(agentsPath, USER_PREAMBLE);

    const second = install(box.env, "codex-cli");
    assert.equal(second.status, 0, `codex-cli reinstall failed\n${second.stdout}\n${second.stderr}`);
    const afterSecond = readFileSync(agentsPath, "utf8");
    assert.equal(afterSecond, afterFirst, "second install must be byte-identical to the first");

    const removed = uninstall(box.env, "codex-cli");
    assert.equal(removed.status, 0, `codex-cli uninstall failed\n${removed.stdout}\n${removed.stderr}`);
    const restored = readFileSync(agentsPath);
    assert.equal(
      Buffer.compare(restored, original),
      0,
      `uninstall must restore original user bytes\ngot:\n${restored.toString("utf8")}`,
    );
  } finally {
    box.cleanup();
  }
});

test("check 3: claude-code CLAUDE.md install×2 + uninstall restores user bytes", () => {
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    const claudeMd = join(box.home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, USER_PREAMBLE);
    const original = readFileSync(claudeMd);

    const first = install(box.env, "claude-code");
    assert.equal(first.status, 0, `claude-code install failed\n${first.stdout}\n${first.stderr}`);
    const afterFirst = assertManagedWrite(claudeMd, USER_PREAMBLE);
    const second = install(box.env, "claude-code");
    assert.equal(second.status, 0, `claude-code reinstall failed\n${second.stdout}\n${second.stderr}`);
    assert.equal(readFileSync(claudeMd, "utf8"), afterFirst);

    const removed = uninstall(box.env, "claude-code");
    assert.equal(removed.status, 0, `claude-code uninstall failed\n${removed.stdout}\n${removed.stderr}`);
    assert.equal(Buffer.compare(readFileSync(claudeMd), original), 0);
  } finally {
    box.cleanup();
  }
});

test("check 3: grok AGENTS.md install×2 + uninstall restores user bytes", () => {
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".grok"), { recursive: true });
    const agentsPath = join(box.home, ".grok", "AGENTS.md");
    writeFileSync(agentsPath, USER_PREAMBLE);
    const original = readFileSync(agentsPath);

    const first = install(box.env, "grok");
    assert.equal(first.status, 0, `grok install failed\n${first.stdout}\n${first.stderr}`);
    const afterFirst = assertManagedWrite(agentsPath, USER_PREAMBLE);
    const second = install(box.env, "grok");
    assert.equal(second.status, 0, `grok reinstall failed\n${second.stdout}\n${second.stderr}`);
    assert.equal(readFileSync(agentsPath, "utf8"), afterFirst);

    const removed = uninstall(box.env, "grok");
    assert.equal(removed.status, 0, `grok uninstall failed\n${removed.stdout}\n${removed.stderr}`);
    assert.equal(Buffer.compare(readFileSync(agentsPath), original), 0);
  } finally {
    box.cleanup();
  }
});

test("check 4: corrupted marker fail-safe leaves the file untouched", () => {
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const agentsPath = join(box.home, ".codex", "AGENTS.md");
    writeFileSync(agentsPath, USER_PREAMBLE);
    const first = install(box.env, "codex-cli");
    assert.equal(first.status, 0, `setup install failed\n${first.stdout}\n${first.stderr}`);
    const healthy = readFileSync(agentsPath, "utf8");
    const inserted = insertedRegion(USER_PREAMBLE, healthy);
    assert.ok(inserted && inserted.includes(FINGERPRINT), "could not isolate the managed block");
    const markers = markerLines(inserted);
    assert.ok(markers && markers.start !== markers.end, "managed block must have distinct start/end markers");

    const corrupted = healthy.replace(markers.end, "");
    assert.notEqual(corrupted, healthy, "corruption fixture must actually drop the end marker");
    writeFileSync(agentsPath, corrupted);
    const before = readFileSync(agentsPath);

    const retry = install(box.env, "codex-cli");
    assert.notEqual(retry.status, 0, `corrupted markers must fail closed\n${retry.stdout}\n${retry.stderr}`);
    assert.equal(
      Buffer.compare(readFileSync(agentsPath), before),
      0,
      "fail-safe must not rewrite a file with corrupted markers",
    );
  } finally {
    box.cleanup();
  }
});

test("check 6: no new configure_* function", () => {
  assert.doesNotMatch(
    installerSrc,
    /\bconfigure_[A-Za-z0-9_]+\s*\(/,
    "install.sh must not grow a configure_* function; use table rows",
  );
  assert.doesNotMatch(
    uninstallSrc,
    /\bconfigure_[A-Za-z0-9_]+\s*\(/,
    "uninstall.sh must not grow a configure_* function",
  );
  assert.doesNotMatch(psSrc, /\bfunction Configure-[A-Za-z0-9]+\b/);
  assert.match(installerSrc, /\bsafe_backup_file\s*\(/);
  assert.match(installerSrc, /\bsafe_write_file\s*\(/);
  assert.match(
    installerSrc,
    /agentsFile/,
    "run_platform_engine must consume platforms.json agentsFile (table rows, not a per-target function)",
  );
});

test("hermes: profile AGENTS.md, root only if present, never SOUL.md", () => {
  const box = sandbox();
  try {
    const hermesHome = join(box.home, ".hermes");
    mkdirSync(join(hermesHome, "profiles", "alpha"), { recursive: true });
    mkdirSync(join(hermesHome, "profiles", "beta"), { recursive: true });
    mkdirSync(join(hermesHome, "profiles", "gamma"), { recursive: true });
    const alpha = join(hermesHome, "profiles", "alpha", "AGENTS.md");
    const beta = join(hermesHome, "profiles", "beta", "AGENTS.md");
    const rootAgents = join(hermesHome, "AGENTS.md");
    const soul = join(hermesHome, "SOUL.md");
    const alphaSoul = join(hermesHome, "profiles", "alpha", "SOUL.md");
    writeFileSync(alpha, USER_PREAMBLE);
    writeFileSync(beta, USER_PREAMBLE);
    writeFileSync(soul, "keep soul\n");
    writeFileSync(alphaSoul, "profile soul\n");
    writeFileSync(join(hermesHome, "config.yaml"), "plugins:\n  enabled: []\n");

    const first = install(box.env, "hermes");
    assert.equal(first.status, 0, `hermes install failed\n${first.stdout}\n${first.stderr}`);
    assertManagedWrite(alpha, USER_PREAMBLE);
    assertManagedWrite(beta, USER_PREAMBLE);
    assert.ok(
      managedBackups(alpha).length >= 1,
      `Hermes profile AGENTS.md must get a .bak, found: ${managedBackups(alpha).join(", ") || "(none)"}`,
    );
    assert.ok(
      managedBackups(beta).length >= 1,
      `Hermes profile AGENTS.md must get a .bak, found: ${managedBackups(beta).join(", ") || "(none)"}`,
    );
    assert.equal(existsSync(rootAgents), false, "must not create root AGENTS.md");
    assert.equal(readFileSync(soul, "utf8"), "keep soul\n");
    assert.equal(readFileSync(alphaSoul, "utf8"), "profile soul\n");

    writeFileSync(rootAgents, USER_PREAMBLE);
    const second = install(box.env, "hermes");
    assert.equal(second.status, 0, `hermes reinstall failed\n${second.stdout}\n${second.stderr}`);
    assertManagedWrite(rootAgents, USER_PREAMBLE);
    assert.ok(
      managedBackups(rootAgents).length >= 1,
      `Hermes root AGENTS.md must get a .bak when present, found: ${managedBackups(rootAgents).join(", ") || "(none)"}`,
    );

    const removed = uninstall(box.env, "hermes");
    assert.equal(removed.status, 0, `hermes uninstall failed\n${removed.stdout}\n${removed.stderr}`);
    assert.equal(readFileSync(alpha, "utf8"), USER_PREAMBLE);
    assert.equal(readFileSync(beta, "utf8"), USER_PREAMBLE);
    assert.equal(readFileSync(rootAgents, "utf8"), USER_PREAMBLE);
    assert.equal(readFileSync(soul, "utf8"), "keep soul\n");
    assert.equal(readFileSync(alphaSoul, "utf8"), "profile soul\n");
  } finally {
    box.cleanup();
  }
});

test("install×uninstall is byte-identical when the file has no final newline", () => {
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const agentsPath = join(box.home, ".codex", "AGENTS.md");
    const original = "# User standing orders\nNever deploy on Fridays.\nUNIQUE_USER_PREAMBLE_ILL170";
    writeFileSync(agentsPath, original);
    const first = install(box.env, "codex-cli");
    assert.equal(first.status, 0, `codex-cli install failed\n${first.stdout}\n${first.stderr}`);
    assertManagedWrite(agentsPath, original);
    const removed = uninstall(box.env, "codex-cli");
    assert.equal(removed.status, 0, `codex-cli uninstall failed\n${removed.stdout}\n${removed.stderr}`);
    assert.equal(
      Buffer.compare(readFileSync(agentsPath), Buffer.from(original)),
      0,
      "must not invent a terminating newline the user did not have",
    );
  } finally {
    box.cleanup();
  }
});

test("source: managed block is sourced from plugins/shared/MEMORY_CRYSTAL_INSTRUCTIONS.md", () => {
  assert.match(instructions, new RegExp(FINGERPRINT));
  assert.doesNotMatch(instructions, new RegExp(SECRET));
  assert.doesNotMatch(instructions, /sk-proj-|sk-live-|Bearer [A-Za-z0-9]/);
  const publicCopy = readFileSync(
    join(root, "apps/web/public/plugins/shared/MEMORY_CRYSTAL_INSTRUCTIONS.md"),
    "utf8",
  );
  assert.equal(publicCopy, instructions, "public mirror must match plugins/shared source");
});
