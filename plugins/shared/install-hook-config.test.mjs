import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./install-hook-config.mjs', import.meta.url));

function run(host, seed) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-hookcfg-'));
  const file = join(dir, `${host}.json`);
  writeFileSync(file, JSON.stringify(seed, null, 2));
  execFileSync(process.execPath, [script, host, file, 'node ~/.memory-crystal/crystal-hooks.mjs']);
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('codex helper nests hooks under top-level hooks and removes broken top-level duplicates', () => {
  const result = run('codex', {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing' }] }] },
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'old broken' }] }],
  });
  assert.ok(result.hooks);
  assert.ok(Array.isArray(result.hooks.UserPromptSubmit));
  assert.ok(Array.isArray(result.hooks.Stop));
  assert.ok(Array.isArray(result.hooks.SessionStart));
  assert.equal(result.UserPromptSubmit, undefined);
  assert.equal(result.Stop, undefined);
  assert.equal(result.SessionStart, undefined);
  assert.equal(result.hooks.PreToolUse[0].hooks[0].command, 'existing');
  assert.match(result.hooks.UserPromptSubmit[0].hooks[0].command, /crystal-hooks\.mjs$/);
});

test('claude helper preserves unrelated hooks while replacing Memory Crystal hook entries', () => {
  const result = run('claude', {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'node ~/.memory-crystal/crystal-hooks.mjs', timeout: 10 }] },
        { hooks: [{ type: 'command', command: 'other-hook', timeout: 5 }] },
      ],
    },
  });
  assert.equal(result.hooks.UserPromptSubmit.length, 2);
  assert.equal(result.hooks.UserPromptSubmit[0].hooks[0].command, 'other-hook');
  assert.match(result.hooks.UserPromptSubmit[1].hooks[0].command, /crystal-hooks\.mjs$/);
});
