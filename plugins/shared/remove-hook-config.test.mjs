import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./remove-hook-config.mjs', import.meta.url));

function run(host, seed) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-unhookcfg-'));
  const file = join(dir, `${host}.json`);
  writeFileSync(file, JSON.stringify(seed, null, 2));
  execFileSync(process.execPath, [script, host, file]);
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('codex helper removes Memory Crystal hook entries and broken top-level duplicates while preserving unrelated hooks', () => {
  const result = run('codex', {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'node ~/.memory-crystal/crystal-hooks.mjs', timeout: 10 }] },
        { hooks: [{ type: 'command', command: 'other-hook', timeout: 5 }] },
      ],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing' }] }],
    },
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'old broken' }] }],
  });
  assert.equal(result.UserPromptSubmit, undefined);
  assert.equal(result.Stop, undefined);
  assert.equal(result.SessionStart, undefined);
  assert.equal(result.hooks.UserPromptSubmit.length, 1);
  assert.equal(result.hooks.UserPromptSubmit[0].hooks[0].command, 'other-hook');
  assert.equal(result.hooks.PreToolUse[0].hooks[0].command, 'existing');
});

test('claude helper deletes empty events after removing Memory Crystal hooks', () => {
  const result = run('claude', {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.memory-crystal/crystal-hooks.mjs', timeout: 15 }] }],
    },
  });
  assert.equal(result.hooks.SessionStart, undefined);
});
