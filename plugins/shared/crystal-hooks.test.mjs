import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChannel, buildSessionStartContext, classifyIntent, recall, resolvePlatform, resolveSessionKey, wake } from './crystal-hooks.mjs';

test('resolvePlatform prefers env, then config, then default', () => {
  const original = process.env.CRYSTAL_PLATFORM;
  process.env.CRYSTAL_PLATFORM = 'codex';
  assert.equal(resolvePlatform({ platform: 'factory-droid' }, {}), 'codex');
  delete process.env.CRYSTAL_PLATFORM;
  assert.equal(resolvePlatform({ platform: 'factory-droid' }, {}), 'factory-droid');
  assert.equal(resolvePlatform({}, {}), 'claude-code');
  if (original) process.env.CRYSTAL_PLATFORM = original;
});

test('resolveSessionKey prefers explicit id and falls back to transcript basename', () => {
  assert.equal(resolveSessionKey({ session_id: 'sess-123' }), 'sess-123');
  assert.equal(resolveSessionKey({ transcript_path: '/tmp/foo/bar/session-9f.jsonl' }), 'session-9f');
  assert.equal(resolveSessionKey({}), undefined);
});

test('buildChannel scopes by platform and cwd', () => {
  assert.equal(buildChannel('codex', '/repo/project'), 'codex:/repo/project');
});

test('classifyIntent identifies memory-oriented prompts', () => {
  assert.equal(classifyIntent('what do you know about deployment?'), 'recall');
  assert.equal(classifyIntent('who owns billing'), 'people');
  assert.equal(classifyIntent('save this preference'), 'store');
});

test('recall and wake propagate channel and sessionKey to backend calls', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        if (String(url).endsWith('/api/mcp/recall')) return { memories: [] };
        return { briefing: 'ok' };
      },
    };
  };

  const config = { apiKey: 'k', convexUrl: 'https://example.com', platform: 'codex' };
  await recall(config, 'hello', { channel: 'codex:/repo', sessionKey: 'sess-1', limit: 7, mode: 'general' });
  await wake(config, { channel: 'codex:/repo', sessionKey: 'sess-1' });

  assert.deepEqual(calls[0], {
    url: 'https://example.com/api/mcp/recall',
    body: { query: 'hello', limit: 7, mode: 'general', channel: 'codex:/repo', sessionKey: 'sess-1' },
  });
  assert.deepEqual(calls[1], {
    url: 'https://example.com/api/mcp/wake',
    body: { channel: 'codex:/repo', sessionKey: 'sess-1' },
  });

  globalThis.fetch = originalFetch;
});

test('buildSessionStartContext stays compact while preserving useful startup cues', () => {
  const context = buildSessionStartContext(
    {
      lastCheckpoint: { label: 'checkpoint-1' },
      recentMessages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
      recentMemories: [{ title: 'Family birthdays' }, { title: 'Deployment rule' }],
    },
    '# Memory Crystal\n\nLong-form instructions that should not be dumped verbatim.',
  );

  assert.match(context, /Memory is active for this session\./);
  assert.match(context, /Recent conversation available \(2 messages\)\./);
  assert.match(context, /Recent memory: Family birthdays; Deployment rule/);
  assert.match(context, /Last checkpoint: checkpoint-1/);
  assert.match(context, /Use crystal_recall for past facts or decisions/);
  assert.equal(context.includes('## Memory Crystal — Session Briefing'), false);
  assert.equal(context.includes('Long-form instructions'), false);
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { extractFirstTurn } from './crystal-hooks.mjs';
import { acquireSweepLock } from './crystal-hooks-sweep.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-hooks-'));
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(() => rmSync(dir, { recursive: true, force: true }));
    }
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function writeJsonl(dir, name, rows) {
  const file = join(dir, name);
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('extractFirstTurn prefers queue-operation enqueue content and first assistant text', () => withTempDir((dir) => {
  const file = writeJsonl(dir, 'queue.jsonl', [
    { type: 'queue-operation', operation: 'enqueue', content: 'queued prompt', sessionId: 'sess-q' },
    { type: 'user', message: { role: 'user', content: 'fallback user' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant answer' }, { type: 'tool_use', name: 'x' }] } },
  ]);

  assert.deepEqual(extractFirstTurn(file), {
    userText: 'queued prompt',
    assistantText: 'assistant answer',
    source: 'jsonl',
    userSource: 'queue-operation',
    assistantSource: 'assistant-message',
    sessionId: 'sess-q',
    status: 'complete',
  });
}));

test('extractFirstTurn handles slash-command, plain Q&A, and abandoned transcripts', () => withTempDir((dir) => {
  const slash = writeJsonl(dir, 'slash.jsonl', [
    { type: 'user', message: { role: 'user', content: '<command-name>/plan</command-name>\n<command-message>ship it</command-message>' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'planned' }] } },
  ]);
  const plain = writeJsonl(dir, 'plain.jsonl', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  ]);
  const abandoned = writeJsonl(dir, 'abandoned.jsonl', [
    { type: 'user', message: { role: 'user', content: 'only user' } },
  ]);

  assert.equal(extractFirstTurn(slash).userSource, 'user-string-cmd');
  assert.equal(extractFirstTurn(slash).assistantText, 'planned');
  assert.equal(extractFirstTurn(plain).userText, 'hello');
  assert.equal(extractFirstTurn(plain).assistantText, 'hi there');
  assert.equal(extractFirstTurn(abandoned).status, 'abandoned-before-assistant');
  assert.equal(extractFirstTurn(abandoned).assistantText, undefined);
}));

test('sweeper PID lock exits when another live process holds the lock', () => withTempDir((dir) => {
  const lockPath = join(dir, 'sweep.lock');
  writeFileSync(lockPath, `${process.pid}\n`);
  const lock = acquireSweepLock(lockPath);
  assert.equal(lock.acquired, false);
  assert.equal(lock.pid, process.pid);
}));

test('Stop hook keeps all user and assistant writes in flight without exceeding hook timeout', async () => await withTempDir(async (dir) => {
  const transcript = writeJsonl(dir, 'stop.jsonl', [
    { type: 'queue-operation', operation: 'enqueue', content: 'queued prompt', sessionId: 'stop-session' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant answer' }] } },
  ]);
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 10_000);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const started = Date.now();
  const child = spawn(process.execPath, [join(process.cwd(), 'plugins/shared/crystal-hooks.mjs')], {
    env: { ...process.env, MEMORY_CRYSTAL_API_KEY: 'test', MEMORY_CRYSTAL_URL: `http://127.0.0.1:${port}` },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, cwd: dir, session_id: 'stop-session' }));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  server.closeAllConnections?.();
  server.close();
  const elapsed = Date.now() - started;
  assert.equal(code, 0);
  assert.ok(elapsed < 6_500, `elapsed=${elapsed}`);
  assert.ok(requestCount >= 1);
}));
