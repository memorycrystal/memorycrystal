import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlist, installLaunchAgent } from './install-sweep-launchd.mjs';

test('buildPlist uses resolved node and sweeper paths with 60 second cadence', () => {
  const plist = buildPlist({ nodeBin: '/opt/homebrew/bin/node', scriptPath: '/Users/alice/.memory-crystal/crystal-hooks-sweep.mjs', username: 'alice' });
  assert.match(plist, /<string>com\.memory-crystal\.sweep<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/alice\/\.memory-crystal\/crystal-hooks-sweep\.mjs<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.doesNotMatch(plist, /EnvironmentVariables/);
});

test('installLaunchAgent dry-run returns plist without writing', () => {
  const result = installLaunchAgent({ dryRun: true, nodeBin: '/usr/bin/node', scriptPath: '/tmp/crystal-hooks-sweep.mjs', plistPath: '/tmp/com.memory-crystal.sweep.plist' });
  assert.equal(result.installed, false);
  assert.equal(result.plistPath, '/tmp/com.memory-crystal.sweep.plist');
  assert.match(result.plist, /crystal-hooks-sweep\.mjs/);
});
