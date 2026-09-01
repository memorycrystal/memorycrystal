import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { applyDisciplineFooter, AUTO_RECALL_TIMEOUT_MS, buildChannel, buildSessionStartContext, classifyIntent, deriveProjectContext, DISCIPLINE_FOOTER, recall, resolveAgentId, resolvePlatform, resolveSessionKey, wake } from './crystal-hooks.mjs';

const require = createRequire(import.meta.url);
const {
  applyDisciplineFooter: applyBudgetDisciplineFooter,
  DISCIPLINE_FOOTER: BUDGET_DISCIPLINE_FOOTER,
  getInjectionBudget,
  INJECTION_CEILING_CHARS,
} = require('../../plugin/context-budget.js');

test('auto-recall hook timeout is 16s', () => {
  assert.equal(AUTO_RECALL_TIMEOUT_MS, 16_000);
});

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

test('deriveProjectContext uses a stable hashed id without exposing absolute paths', () => withTempDir((dir) => {
  const project = join(dir, 'cassai-v2');
  mkdirSync(project);
  const first = deriveProjectContext(project, { projectSalt: 'salt-1' });
  const second = deriveProjectContext(project, { projectSalt: 'salt-1' });

  assert.match(first.projectId, /^proj_[a-f0-9]{24}$/);
  assert.equal(first.projectId, second.projectId);
  assert.equal(first.repoSlug, 'cassai-v2');
  assert.equal(first.projectId.includes(project), false);
  assert.equal(JSON.stringify(first).includes(dir), false);
}));

test('resolveAgentId prefers explicit input and env/config fallback', () => {
  const original = process.env.MEMORY_CRYSTAL_AGENT_ID;
  try {
    process.env.MEMORY_CRYSTAL_AGENT_ID = 'env-agent';
    assert.equal(resolveAgentId({ agentId: 'config-agent' }, { agentId: 'input-agent' }), 'input-agent');
    assert.equal(resolveAgentId({ agentId: 'config-agent' }, { agent_id: 'snake-agent' }), 'snake-agent');
    assert.equal(resolveAgentId({ agentId: 'config-agent' }, {}), 'env-agent');
    delete process.env.MEMORY_CRYSTAL_AGENT_ID;
    // ILL-172: installer-populated config is a real source, not an empty default.
    assert.equal(resolveAgentId({ agentId: 'codex' }, {}), 'codex');
    assert.equal(resolveAgentId({ agentId: '  cursor  ' }, {}), 'cursor');
    assert.equal(resolveAgentId({ agentId: '' }, {}), undefined);
    assert.equal(resolveAgentId({ agentId: '   ' }, {}), undefined);
    process.env.MEMORY_CRYSTAL_AGENT_ID = 'env-override';
    assert.equal(resolveAgentId({ agentId: 'codex' }, {}), 'env-override');
  } finally {
    if (original === undefined) delete process.env.MEMORY_CRYSTAL_AGENT_ID;
    else process.env.MEMORY_CRYSTAL_AGENT_ID = original;
  }
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
  await recall(config, 'hello', { channel: 'codex:/repo', sessionKey: 'sess-1', agentId: 'codex', projectId: 'proj_abcdefabcdefabcdefabcdef', repoSlug: 'cassai-v2', limit: 7, mode: 'general' });
  await wake(config, { channel: 'codex:/repo', sessionKey: 'sess-1', agentId: 'codex', projectId: 'proj_abcdefabcdefabcdefabcdef', repoSlug: 'cassai-v2' });

  assert.deepEqual(calls[0], {
    url: 'https://example.com/api/mcp/recall',
    body: { query: 'hello', limit: 7, mode: 'general', channel: 'codex:/repo', sessionKey: 'sess-1', agentId: 'codex', projectId: 'proj_abcdefabcdefabcdefabcdef', repoSlug: 'cassai-v2' },
  });
  assert.deepEqual(calls[1], {
    url: 'https://example.com/api/mcp/wake',
    body: { channel: 'codex:/repo', sessionKey: 'sess-1', agentId: 'codex', projectId: 'proj_abcdefabcdefabcdefabcdef', repoSlug: 'cassai-v2' },
  });

  globalThis.fetch = originalFetch;
});

test('discipline footer matches context-budget.js and stays inside the injection ceiling', () => {
  assert.equal(DISCIPLINE_FOOTER, BUDGET_DISCIPLINE_FOOTER);
  assert.equal(DISCIPLINE_FOOTER.includes('\n'), false, 'footer must be one line');
  assert.ok(DISCIPLINE_FOOTER.length < 160, `footer too long: ${DISCIPLINE_FOOTER.length}`);
  const budget = getInjectionBudget('claude-sonnet');
  const oversized = 'm'.repeat(budget.maxChars);
  const fromHooks = applyDisciplineFooter(oversized, budget.maxChars);
  const fromBudget = applyBudgetDisciplineFooter(oversized, budget.maxChars);
  assert.ok(fromHooks.includes(DISCIPLINE_FOOTER));
  assert.ok(fromHooks.endsWith(DISCIPLINE_FOOTER));
  assert.ok(fromHooks.length <= budget.maxChars);
  assert.ok(fromHooks.length <= INJECTION_CEILING_CHARS);
  assert.equal(fromHooks.length, fromBudget.length);
  assert.ok(fromBudget.endsWith(BUDGET_DISCIPLINE_FOOTER));
});

test('empty recall still emits the discipline footer', () => {
  assert.equal(applyDisciplineFooter('', 8_000), DISCIPLINE_FOOTER);
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

import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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
  const logFile = join(dir, 'fetch-mock.log');
  const started = Date.now();
  const child = spawn(process.execPath, [
    '--import', new URL('./crystal-hooks.test-fetch-mock.mjs', import.meta.url).href,
    join(process.cwd(), 'plugins/shared/crystal-hooks.mjs'),
  ], {
    env: {
      ...process.env,
      MEMORY_CRYSTAL_API_KEY: 'test',
      MEMORY_CRYSTAL_URL: 'http://mock.local',
      CRYSTAL_MOCK_FETCH_LOG: logFile,
      CRYSTAL_TEST_FETCH_FIRST_DELAY_MS: '10000',
      GROK_HOOK_STOP_ENABLE: 'true',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, cwd: dir, session_id: 'stop-session' }));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const elapsed = Date.now() - started;
  const logLines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.equal(code, 0);
  assert.ok(elapsed < 6_500, `elapsed=${elapsed}`);
  assert.ok(logLines.length >= 1, `expected >= 1 mock fetch call, got ${logLines.length}`);
}));

async function runCrystalHook({ dir, env = {}, input }) {
  const logFile = join(dir, 'fetch-mock.log');
  const child = spawn(process.execPath, [
    '--import', new URL('./crystal-hooks.test-fetch-mock.mjs', import.meta.url).href,
    join(process.cwd(), 'plugins/shared/crystal-hooks.mjs'),
  ], {
    env: {
      ...process.env,
      MEMORY_CRYSTAL_API_KEY: 'test',
      MEMORY_CRYSTAL_URL: 'http://mock.local',
      CRYSTAL_MOCK_FETCH_LOG: logFile,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const logLines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  const entries = logLines.map((l) => JSON.parse(l));
  const paths = entries.map((e) => e.url);
  const bodies = entries.map((e) => e.body);
  return { code, stdout, paths, bodies, dir };
}


test('grok reads hookEventName, captures, and does not inject recall', async () => withTempDir(async (dir) => {
  const result = await runCrystalHook({
    dir,
    env: { CRYSTAL_PLATFORM: 'grok' },
    input: {
      hookEventName: 'UserPromptSubmit',
      sessionId: 'grok-sess',
      cwd: dir,
      workspaceRoot: dir,
      prompt: 'what do you know about deployment?',
    },
  });
  assert.equal(result.code, 0);
  assert.ok(result.paths.some((p) => p.includes('/api/mcp/log') || p.includes('/api/mcp/capture')), `expected capture/log, got ${result.paths.join(',')}`);
  assert.equal(result.paths.some((p) => p.includes('/api/mcp/recall')), false, 'Grok must not call recall');
  assert.equal(result.paths.some((p) => p.includes('/api/mcp/wake')), false, 'Grok must not call wake');
  assert.doesNotMatch(result.stdout, /hookSpecificOutput|additionalContext|should-not-inject/);
}));

test('grok official stdin envelope (snake_case hookEventName) captures without CRYSTAL_PLATFORM', async () => withTempDir(async (dir) => {
  const result = await runCrystalHook({
    dir,
    env: { GROK_HOOK_EVENT: 'user_prompt_submit' },
    input: {
      hookEventName: 'user_prompt_submit',
      sessionId: 'grok-sess',
      cwd: dir,
      workspaceRoot: dir,
      prompt: 'remember the deploy window is Friday',
    },
  });
  assert.equal(result.code, 0);
  assert.ok(
    result.paths.some((p) => p.includes('/api/mcp/log') || p.includes('/api/mcp/capture')),
    `Grok wire format must capture; got ${result.paths.join(',') || '(no requests)'}`,
  );
  assert.equal(result.paths.some((p) => p.includes('/api/mcp/recall')), false, 'Grok must not call recall');
  assert.doesNotMatch(result.stdout, /hookSpecificOutput|additionalContext|should-not-inject/);
}));

test('UserPromptSubmit injects recall plus the discipline footer within budget', async () => withTempDir(async (dir) => {
  const result = await runCrystalHook({
    dir,
    env: { CRYSTAL_PLATFORM: 'codex', MEMORY_CRYSTAL_INJECT_RECALL: 'true' },
    input: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex-sess',
      cwd: dir,
      prompt: 'what do you know about deployment?',
    },
  });
  assert.equal(result.code, 0);
  assert.ok(result.paths.some((p) => p.includes('/api/mcp/recall')), `expected recall, got ${result.paths.join(',')}`);
  const parsed = JSON.parse(result.stdout);
  const context = parsed?.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /should-not-inject/);
  assert.match(context, new RegExp(DISCIPLINE_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(context.endsWith(DISCIPLINE_FOOTER));
  assert.ok(context.length <= 8_000, `injected ${context.length} chars`);
}));

test('default-off captures without injecting recall', async () => withTempDir(async (dir) => {
  const result = await runCrystalHook({
    dir,
    env: { CRYSTAL_PLATFORM: 'codex' },
    input: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex-sess',
      cwd: dir,
      prompt: 'what do you know about deployment?',
    },
  });
  assert.equal(result.code, 0);
  assert.ok(result.paths.some((p) => p.includes('/api/mcp/log') || p.includes('/api/mcp/capture')), `expected capture/log, got ${result.paths.join(',')}`);
  assert.equal(result.paths.some((p) => p.includes('/api/mcp/recall')), false, 'must not call recall when default-off');
  assert.equal(result.paths.some((p) => p.includes('/api/mcp/wake')), false, 'must not call wake');
  // Capture still writes — no receivable stdout
  assert.doesNotMatch(result.stdout, /hookSpecificOutput|additionalContext/);
}));

test('grok Stop envelope captures lastAssistantMessage and does not inject', async () => withTempDir(async (dir) => {
  const result = await runCrystalHook({
    dir,
    env: { GROK_HOOK_EVENT: 'stop' },
    input: {
      hookEventName: 'stop',
      sessionId: 'grok-sess',
      cwd: dir,
      workspaceRoot: dir,
      reason: 'end_turn',
      stopHookActive: false,
      lastAssistantMessage: 'Deploy only after the Friday window.',
    },
  });
  assert.equal(result.code, 0);
  assert.ok(
    result.paths.some((p) => p.includes('/api/mcp/log') || p.includes('/api/mcp/capture')),
    `Grok Stop must capture lastAssistantMessage; got ${result.paths.join(',') || '(no requests)'}`,
  );
  assert.equal(result.paths.some((p) => p.includes('/api/mcp/recall')), false);
  assert.doesNotMatch(result.stdout, /hookSpecificOutput|additionalContext/);
}));
