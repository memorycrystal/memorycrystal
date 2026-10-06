import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from './install-hooks.mjs';

test('installHooks copies hook support files into the target directory', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'mc-install-hooks-'));
  const result = installHooks({ targetDir, installLaunchd: false });
  assert.equal(result.targetDir, targetDir);
  assert.ok(existsSync(join(targetDir, '_lib.mjs')));
  assert.ok(existsSync(join(targetDir, 'crystal-hooks.mjs')));
  assert.ok(existsSync(join(targetDir, 'crystal-hooks-sweep.mjs')));
  assert.ok(existsSync(join(targetDir, 'install-sweep-launchd.mjs')));
  assert.ok(existsSync(join(targetDir, 'instructions.md')));
});

test('installHooks refuses to overwrite hooks inside a Claude Code session unless forced', () => {
  const originalSession = process.env.CLAUDE_SESSION_ID;
  const originalForce = process.env.CRYSTAL_FORCE_INSTALL;
  process.env.CLAUDE_SESSION_ID = 'sess-test';
  delete process.env.CRYSTAL_FORCE_INSTALL;
  try {
    assert.throws(() => installHooks({ targetDir: mkdtempSync(join(tmpdir(), 'mc-install-hooks-')), installLaunchd: false }), /Refusing to install hooks while inside a Claude Code session/);
    process.env.CRYSTAL_FORCE_INSTALL = '1';
    assert.doesNotThrow(() => installHooks({ targetDir: mkdtempSync(join(tmpdir(), 'mc-install-hooks-')), installLaunchd: false }));
  } finally {
    if (originalSession === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = originalSession;
    if (originalForce === undefined) delete process.env.CRYSTAL_FORCE_INSTALL;
    else process.env.CRYSTAL_FORCE_INSTALL = originalForce;
  }
});
