import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

for (const file of ['_lib.mjs', 'crystal-hooks.mjs', 'crystal-hooks-sweep.mjs', 'install-sweep-launchd.mjs']) {
  test(`${file} stays byte-identical in apps/web public shared assets`, () => {
    const source = readFileSync(resolve(repoRoot, 'plugins/shared', file), 'utf8');
    const publicCopy = readFileSync(resolve(repoRoot, 'apps/web/public/plugins/shared', file), 'utf8');
    assert.equal(publicCopy, source);
  });
}
