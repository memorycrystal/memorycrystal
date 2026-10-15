import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHookHosts } from "./hook-host-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const installer = join(root, "plugins/shared/install-hook-config.mjs");
const legacyCommand = 'node "/home/fixture/.memory-crystal/crystal-hooks.mjs"';

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "mc-hook-host-check-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function legacyHooks(command = legacyCommand) {
  return { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } };
}

const env = {};

test("warns when a managed hook command lacks --host and config.platform is shared by several hosts", () => withHome((home) => {
  writeJson(join(home, ".memory-crystal", "config.json"), { apiKey: "test-fake-key", platform: "grok" });
  writeJson(join(home, ".claude", "settings.json"), legacyHooks());
  writeJson(join(home, ".codex", "hooks.json"), legacyHooks());
  const results = checkHookHosts({ home, env });
  const warnings = results.filter((r) => r.level === "warn").map((r) => r.message);
  assert.equal(warnings.length, 3, warnings.join("\n"));
  assert.match(warnings[0], /^claude-code: 1 Memory Crystal hook command\(s\) .* lack --host/);
  assert.match(warnings[1], /^codex: /);
  assert.match(warnings[2], /config\.platform is "grok" but Memory Crystal hooks are installed for 2 hosts \(claude-code, codex\)/);
  assert.doesNotMatch(JSON.stringify(results), /test-fake-key/, "the check must never echo the API key");
}));

test("installer-written commands pass; a legacy single-host install only warns about the missing --host", () => withHome((home) => {
  writeJson(join(home, ".memory-crystal", "config.json"), { platform: "grok" });
  const settings = join(home, ".claude", "settings.json");
  execFileSync(process.execPath, [installer, "claude", settings, legacyCommand]);
  assert.deepEqual(checkHookHosts({ home, env }).map((r) => r.level), ["ok"]);

  const grokHooks = join(home, ".grok", "hooks", "memory-crystal.json");
  writeJson(grokHooks, legacyHooks());
  const results = checkHookHosts({ home, env });
  assert.deepEqual(results.map((r) => r.level), ["ok", "warn", "warn"]);
  assert.match(results[1].message, /^grok: .*lack --host/);
}));

test("no hooks installed is informational only", () => withHome((home) => {
  assert.deepEqual(checkHookHosts({ home, env }).map((r) => r.level), ["info"]);
}));

test("crystal-doctor.sh runs the hook host check and maps WARN lines to warnings", () => {
  const doctor = readFileSync(join(root, "scripts/crystal-doctor.sh"), "utf8");
  assert.match(doctor, /node "\$SCRIPT_DIR\/hook-host-check\.mjs"/);
  assert.match(doctor, /WARN\) warn "\$rest" ;;/);
});
