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
