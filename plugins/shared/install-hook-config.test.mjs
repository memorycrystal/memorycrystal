import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./install-hook-config.mjs', import.meta.url));
const cursorHooksSrc = fileURLToPath(new URL('./cursor-hooks.mjs', import.meta.url));

function crystalCommandOn(hooksRoot, event) {
  return (hooksRoot[event] || []).filter((entry) =>
    typeof entry?.command === 'string' && /cursor-hooks\.mjs|crystal-hooks\.mjs/.test(entry.command),
  );
}

/**
 * Case labels whose shared switch body calls recall(). Fall-through groups
 * (several `case` labels, one block) all inherit that body's calls.
 */
function cursorEventsThatCallRecall(src) {
  const header = src.match(/switch\s*\(\s*input\.hook_event_name\s*\)\s*\{/);
  assert.ok(header, 'cursor-hooks.mjs must switch on hook_event_name');
  const start = src.indexOf(header[0]) + header[0].length;
  let depth = 1;
  let end = start;
  while (end < src.length && depth > 0) {
    if (src[end] === '{') depth += 1;
    else if (src[end] === '}') depth -= 1;
    end += 1;
  }
  const body = src.slice(start, end - 1);
  const events = [];
  let pending = [];
  const tokenRe = /case\s+"([^"]+)":|\{/g;
  let match;
  while ((match = tokenRe.exec(body))) {
    if (match[0].startsWith('case')) {
      pending.push(match[1]);
      continue;
    }
    let blockDepth = 1;
    let i = match.index + 1;
    while (i < body.length && blockDepth > 0) {
      if (body[i] === '{') blockDepth += 1;
      else if (body[i] === '}') blockDepth -= 1;
      i += 1;
    }
    const block = body.slice(match.index + 1, i - 1);
    if (/\brecall\s*\(/.test(block)) events.push(...pending);
    pending = [];
    tokenRe.lastIndex = i;
  }
  return events;
}

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
  assert.equal(
    result.hooks.UserPromptSubmit[0].hooks[0].timeout,
    16,
    "UserPromptSubmit host timeout must wait the 16s auto-recall budget",
  );
  assert.ok(
    result.hooks.UserPromptSubmit[0].hooks[0].timeout >= 16,
    "UserPromptSubmit must not abort auto-recall before 16s",
  );
});

test('cursor helper writes native versioned command arrays and no Claude nesting', () => {
  const result = run('cursor', {
    version: 1,
    hooks: {
      sessionStart: [{ command: 'existing-session' }],
    },
  });
  assert.equal(result.version, 1);
  assert.ok(Array.isArray(result.hooks.sessionStart));
  assert.equal(result.hooks.sessionStart[0].command, 'existing-session');
  assert.match(result.hooks.sessionStart[1].command, /crystal-hooks\.mjs$/);
  assert.equal(result.hooks.sessionStart[1].hooks, undefined);
  assert.ok(Array.isArray(result.hooks.beforeSubmitPrompt));
  assert.ok(Array.isArray(result.hooks.afterAgentResponse));
  assert.ok(Array.isArray(result.hooks.stop));
  assert.ok(Array.isArray(result.hooks.postToolUse));
  assert.equal(result.hooks.SessionStart, undefined);
  assert.equal(result.hooks.UserPromptSubmit, undefined);
});

test('Cursor host timeout is 16s for every event that calls recall() (ILL-272)', () => {
  const src = readFileSync(cursorHooksSrc, 'utf8');
  const recallEvents = cursorEventsThatCallRecall(src);
  assert.deepEqual(
    recallEvents,
    ['postToolUse'],
    'cursor-hooks.mjs recall-calling events changed — update installer timeouts',
  );

  const result = run('cursor', { version: 1, hooks: {} });
  for (const event of recallEvents) {
    const crystal = crystalCommandOn(result.hooks, event);
    assert.equal(crystal.length, 1, `${event} must be installed`);
    assert.notEqual(
      crystal[0].timeout,
      10,
      `${event} calls recall() but installer still writes host timeout 10`,
    );
    assert.ok(
      crystal[0].timeout >= 16,
      `${event} calls recall() but host timeout ${crystal[0].timeout}s aborts before the 16s auto-recall budget`,
    );
  }

  for (const event of ['beforeSubmitPrompt', 'afterAgentResponse', 'stop']) {
    assert.equal(
      crystalCommandOn(result.hooks, event)[0].timeout,
      10,
      `${event} is capture-only and must stay at host timeout 10`,
    );
  }

  const pluginHooks = JSON.parse(readFileSync(fileURLToPath(new URL('../cursor/memory-crystal/hooks/hooks.json', import.meta.url)), 'utf8'));
  for (const event of recallEvents) {
    const timeout = pluginHooks.hooks[event]?.[0]?.timeout;
    assert.notEqual(timeout, 10, `plugin hooks.json ${event} must not stay at timeout 10`);
    assert.ok(timeout >= 16, `plugin hooks.json ${event} host timeout ${timeout}s aborts before 16s`);
  }
});

test('cursor helper is idempotent — one Memory Crystal command per owned event after two installs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-hookcfg-'));
  const file = join(dir, 'cursor.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    hooks: {
      sessionStart: [{ command: 'existing-session' }],
    },
  }, null, 2));
  const command = 'node ~/.memory-crystal/cursor-hooks.mjs';
  execFileSync(process.execPath, [script, 'cursor', file, command]);
  execFileSync(process.execPath, [script, 'cursor', file, command]);
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const crystalOn = (event) => (result.hooks[event] || []).filter((entry) =>
    typeof entry?.command === 'string' && /cursor-hooks\.mjs|crystal-hooks\.mjs/.test(entry.command),
  );
  for (const event of ['sessionStart', 'beforeSubmitPrompt', 'afterAgentResponse', 'stop', 'postToolUse']) {
    assert.equal(crystalOn(event).length, 1, `${event} should have exactly one Memory Crystal command`);
    assert.equal(crystalOn(event)[0].hooks, undefined);
  }
  assert.equal(result.hooks.sessionStart[0].command, 'existing-session');
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

test('claude helper registers SessionStart, UserPromptSubmit, and Stop without a Codex matcher', () => {
  const result = run('claude', {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'keep-me' }] }],
    },
  });
  const crystalOn = (event) => (result.hooks[event] || []).filter((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((candidate) =>
      typeof candidate?.command === 'string' && /crystal-hooks\.mjs/.test(candidate.command),
    ),
  );
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    assert.equal(crystalOn(event).length, 1, `${event} should have exactly one Memory Crystal hook`);
    assert.equal(crystalOn(event)[0].matcher, undefined, `${event} must not use a Codex SessionStart matcher`);
    assert.equal(crystalOn(event)[0].hooks[0].type, 'command');
  }
  assert.equal(
    crystalOn('UserPromptSubmit')[0].hooks[0].timeout,
    16,
    "Claude UserPromptSubmit host timeout must wait the 16s auto-recall budget",
  );
  assert.ok(crystalOn('UserPromptSubmit')[0].hooks[0].timeout >= 16);
  assert.equal(result.hooks.PreToolUse[0].hooks[0].command, 'keep-me');
});

test('grok helper registers SessionStart, UserPromptSubmit, and Stop with no matcher on any lifecycle event', () => {
  const result = run('grok', {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'keep-me' }] }],
    },
  });
  const crystalOn = (event) => (result.hooks[event] || []).filter((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((candidate) =>
      typeof candidate?.command === 'string' && /crystal-hooks\.mjs/.test(candidate.command),
    ),
  );
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    assert.equal(crystalOn(event).length, 1, `${event} should have exactly one Memory Crystal hook`);
    assert.equal(crystalOn(event)[0].matcher, undefined, `${event} must not carry a matcher (Grok lifecycle events reject one)`);
    assert.equal(Object.prototype.hasOwnProperty.call(crystalOn(event)[0], 'matcher'), false);
    assert.equal(crystalOn(event)[0].hooks[0].type, 'command');
  }
  assert.equal(result.hooks.PreToolUse[0].hooks[0].command, 'keep-me');
  const crystalPre = (result.hooks.PreToolUse || []).filter((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((candidate) =>
      typeof candidate?.command === 'string' && /crystal-hooks\.mjs/.test(candidate.command),
    ),
  );
  assert.equal(crystalPre.length, 0, 'must not add PreToolUse (that would emulate recall)');
});

test('grok helper is idempotent and never invents a matcher on reinstall', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-hookcfg-'));
  const file = join(dir, 'grok.json');
  writeFileSync(file, JSON.stringify({ hooks: {} }, null, 2));
  const command = 'node ~/.memory-crystal/crystal-hooks.mjs';
  execFileSync(process.execPath, [script, 'grok', file, command]);
  execFileSync(process.execPath, [script, 'grok', file, command]);
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /"matcher"/);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const crystal = (result.hooks[event] || []).filter((entry) =>
      Array.isArray(entry?.hooks) && entry.hooks.some((candidate) =>
        typeof candidate?.command === 'string' && /crystal-hooks\.mjs/.test(candidate.command),
      ),
    );
    assert.equal(crystal.length, 1, `${event} should have exactly one Memory Crystal hook after two installs`);
    assert.equal(crystal[0].matcher, undefined);
  }
});

test('claude helper is idempotent — one Memory Crystal command per owned event after two installs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-hookcfg-'));
  const file = join(dir, 'claude.json');
  writeFileSync(file, JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'other-hook', timeout: 5 }] },
      ],
      Stop: [
        { hooks: [{ type: 'command', command: 'keep-stop', timeout: 5 }] },
      ],
    },
  }, null, 2));
  const command = 'node ~/.memory-crystal/crystal-hooks.mjs';
  execFileSync(process.execPath, [script, 'claude', file, command]);
  execFileSync(process.execPath, [script, 'claude', file, command]);
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const crystalOn = (event) => (result.hooks[event] || []).filter((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((candidate) =>
      typeof candidate?.command === 'string' && /crystal-hooks\.mjs/.test(candidate.command),
    ),
  );
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    assert.equal(crystalOn(event).length, 1, `${event} should have exactly one Memory Crystal hook after two installs`);
    assert.equal(crystalOn(event)[0].matcher, undefined);
  }
  assert.equal(result.hooks.UserPromptSubmit[0].hooks[0].command, 'other-hook');
  assert.equal(result.hooks.Stop[0].hooks[0].command, 'keep-stop');
});
