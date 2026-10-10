import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ensure-codex-hooks-flag.mjs', import.meta.url));

function run(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-codexcfg-'));
  const file = join(dir, 'config.toml');
  writeFileSync(file, seed);
  execFileSync(process.execPath, [script, file]);
  return readFileSync(file, 'utf8');
}

test('adds codex_hooks inside an existing features table without duplicating the table', () => {
  const result = run(`[features]\nmulti_agent = true\nchild_agents_md = true\n\n[env]\nUSE_OMX_EXPLORE_CMD = "1"\n`);
  assert.match(result, /\[features\]\ncodex_hooks = true\nmulti_agent = true\nchild_agents_md = true/);
  assert.equal((result.match(/\[features\]/g) || []).length, 1);
});

test('appends a features table when one does not already exist', () => {
  const result = run(`[env]\nUSE_OMX_EXPLORE_CMD = "1"\n`);
  assert.match(result, /\n\[features\]\ncodex_hooks = true\n$/);
});

test('leaves the file unchanged when codex_hooks already exists', () => {
  const seed = `[features]\nmulti_agent = true\ncodex_hooks = true\n`;
  const result = run(seed);
  assert.equal(result, seed);
});

test('does not treat commented-out codex_hooks as already set', () => {
  const seed = `[features]\nmulti_agent = true\n# codex_hooks = true  (disabled)\n`;
  const result = run(seed);
  assert.match(result, /\[features\]\ncodex_hooks = true\nmulti_agent = true\n# codex_hooks = true/);
});

test('does not treat codex_hooks inside a string literal as already set', () => {
  const seed = `[metadata]\nnotes = "codex_hooks = true should be enabled"\n\n[env]\nFOO = "bar"\n`;
  const result = run(seed);
  assert.match(result, /\[features\]\ncodex_hooks = true/);
});

test('does not inject inside a multi-line basic string literal', () => {
  const seed = `[metadata]\ndocs = """\n[features]\nfake = true\n"""\n\n[env]\nFOO = "bar"\n`;
  const result = run(seed);
  // The triple-quoted block should be untouched — the `fake = true` line must still
  // live inside the docs string, NOT next to codex_hooks.
  assert.match(result, /docs = """\n\[features\]\nfake = true\n"""/);
  // And a fresh [features] table should be appended at EOF with codex_hooks inside it.
  assert.match(result, /\n\[features\]\ncodex_hooks = true\n$/);
});

test('rewrites are atomic and do not leave .tmp detritus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-codexcfg-atomic-'));
  const file = join(dir, 'config.toml');
  writeFileSync(file, `[features]\nmulti_agent = true\n`);
  execFileSync(process.execPath, [script, file]);
  const entries = readdirSync(dir);
  assert.deepEqual(entries.sort(), ['config.toml']);
});
