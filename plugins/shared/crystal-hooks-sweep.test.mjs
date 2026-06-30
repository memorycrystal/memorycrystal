import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePidLock, extractFirstTurn, releasePidLock, sweepTranscripts } from './crystal-hooks-sweep.mjs';

function writeJsonl(dir, name, rows) {
  const path = join(dir, name);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

test('extractFirstTurn prefers queue-operation enqueue content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-sweep-'));
  const file = writeJsonl(dir, 'queue.jsonl', [
    { type: 'queue-operation', operation: 'enqueue', content: 'queued prompt' },
    { type: 'user', message: { role: 'user', content: '<command-message>wrapped</command-message>' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant reply' }, { type: 'tool_use', name: 'x' }] } },
  ]);

  assert.deepEqual(extractFirstTurn(file), {
    userText: 'queued prompt',
    userSource: 'queue-operation:enqueue',
    assistantText: 'assistant reply',
  });
});

test('extractFirstTurn handles text-array users and abandoned assistant transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-sweep-'));
  const file = writeJsonl(dir, 'abandoned.jsonl', [
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'skip' }, { type: 'text', text: 'hello from array' }] } },
  ]);

  assert.deepEqual(extractFirstTurn(file), {
    userText: 'hello from array',
    userSource: 'user-array',
    assistantText: null,
  });
});

test('sweepTranscripts posts user and assistant turns with stable turn indexes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-sweep-'));
  const project = join(dir, 'projects', '-repo');
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(project, { recursive: true }));
  writeJsonl(project, 'session-a.jsonl', [
    { type: 'queue-operation', operation: 'enqueue', content: 'queued prompt' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant reply' }] } },
  ]);
  writeJsonl(project, 'session-b.jsonl', [
    { type: 'user', message: { role: 'user', content: 'no assistant yet' } },
  ]);

  const fetchCalls = [];
  const result = await sweepTranscripts({
    projectsDir: join(dir, 'projects'),
    config: { apiKey: 'test', convexUrl: 'https://example.test', platform: 'claude-code' },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
    nowDate: new Date('2026-04-25T00:00:00Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.scanned, 2);
  assert.equal(result.captured, 2);
  assert.equal(result.partial, 1);
  assert.equal(fetchCalls.length, 6);
  assert.deepEqual(fetchCalls.filter((c) => c.url.endsWith('/api/mcp/log')).map((c) => [c.body.role, c.body.turnMessageIndex, c.body.sessionKey]), [
    ['user', 0, 'session-a'],
    ['assistant', 1, 'session-a'],
    ['user', 0, 'session-b'],
  ]);
  assert.ok(result.calls.some((call) => call.path === 'warning' && call.body.warning === 'abandoned-before-assistant'));
});

test('PID lock reports held lock and releases owner lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-sweep-lock-'));
  const lock = join(dir, 'sweep.lock');
  const first = acquirePidLock(lock);
  assert.equal(first.acquired, true);
  const second = acquirePidLock(lock);
  assert.equal(second.acquired, false);
  assert.equal(second.pid, process.pid);
  releasePidLock(lock);
  const third = acquirePidLock(lock);
  assert.equal(third.acquired, true);
  releasePidLock(lock);
});
