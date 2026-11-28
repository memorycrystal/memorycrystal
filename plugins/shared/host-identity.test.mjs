// ILL-480 — host identity comes from the hook invocation, not the shared
// ~/.memory-crystal/config.json every host on a machine reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCodexTurn,
  hostAgentId,
  parseHostArg,
  resolveAgentId,
  resolveHostIdentity,
} from './_lib.mjs';

const HOOK = fileURLToPath(new URL('./crystal-hooks.mjs', import.meta.url));
const INSTALLER = fileURLToPath(new URL('./install-hook-config.mjs', import.meta.url));
const FETCH_MOCK = new URL('./crystal-hooks.test-fetch-mock.mjs', import.meta.url).href;
const CODEX_ROLLOUT = fileURLToPath(new URL('./fixtures/codex-rollout.synthetic.jsonl', import.meta.url));
const CODEX_STOP_PAYLOAD = fileURLToPath(new URL('./fixtures/codex-stop-payload.synthetic.json', import.meta.url));
const SHARED_GROK_CONFIG = { apiKey: 'test-fake-key', convexUrl: 'http://mock.local', platform: 'grok', agentId: 'grok' };
const HOST_ENV_KEYS = ['CRYSTAL_PLATFORM', 'GROK_HOOK_EVENT', 'MEMORY_CRYSTAL_AGENT_ID', 'MEMORY_CRYSTAL_API_KEY', 'MEMORY_CRYSTAL_INJECT_RECALL', 'CODEX_HOME', 'GROK_HOME'];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of HOST_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of HOST_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function withHome(config, fn) {
  const home = mkdtempSync(join(tmpdir(), 'mc-host-id-'));
  try {
    mkdirSync(join(home, '.memory-crystal'), { recursive: true });
    writeFileSync(join(home, '.memory-crystal', 'config.json'), JSON.stringify(config));
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function claudeTranscript(dir) {
  const path = join(dir, 'claude-session.jsonl');
  writeFileSync(path, [
    { type: 'user', message: { role: 'user', content: 'Synthetic claude prompt' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic claude answer' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  return path;
}

function codexStopInput(dir) {
  const transcript = join(dir, 'rollout-2026-01-01T00-00-00-00000000-0000-4000-8000-000000000001.jsonl');
  copyFileSync(CODEX_ROLLOUT, transcript);
  const payload = JSON.parse(readFileSync(CODEX_STOP_PAYLOAD, 'utf8'));
  return { ...payload, transcript_path: transcript, cwd: dir };
}

async function runHook({ home, args = [], env = {}, input }) {
  const logFile = join(home, 'fetch-mock.log');
  const childEnv = { ...process.env, HOME: home, CRYSTAL_MOCK_FETCH_LOG: logFile };
  for (const key of HOST_ENV_KEYS) delete childEnv[key];
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, ['--import', FETCH_MOCK, HOOK, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  rmSync(logFile, { force: true });
  const turns = lines.map((line) => JSON.parse(line)).filter((entry) => entry.url.endsWith('/api/mcp/turn'));
  return { code, turns, calls: lines.map((line) => JSON.parse(line)) };
}

async function stopTurn({ home, args, env, input }) {
  const result = await runHook({ home, args, env, input });
  assert.equal(result.code, 0);
  assert.equal(result.turns.length, 1, 'Stop must capture exactly one turn');
  return result.turns[0].body;
}

// ── Precedence (unit) ──────────────────────────────────────────────────────

test('host argument beats CRYSTAL_PLATFORM, detection, and a shared grok config.platform', () => withEnv({ CRYSTAL_PLATFORM: 'cursor' }, () => {
  const identity = resolveHostIdentity(SHARED_GROK_CONFIG, { transcript_path: '/x/rollout-a.jsonl' }, { host: 'claude-code' });
  assert.deepEqual(identity, { platform: 'claude-code', source: 'host-arg' });
  assert.equal(resolveHostIdentity(SHARED_GROK_CONFIG, {}, { host: 'claude' }).platform, 'claude-code');
  assert.equal(resolveHostIdentity(SHARED_GROK_CONFIG, {}, { host: 'codex' }).platform, 'codex');
  assert.equal(resolveHostIdentity(SHARED_GROK_CONFIG, {}, { host: 'factory' }).platform, 'factory-droid');
}));

test('GROK_HOOK_EVENT labels grok even when Grok runs a command written for Claude Code', () => withEnv({ GROK_HOOK_EVENT: 'stop' }, () => {
  const identity = resolveHostIdentity({ ...SHARED_GROK_CONFIG, platform: 'claude-code' }, {}, { host: 'claude-code' });
  assert.deepEqual(identity, { platform: 'grok', source: 'detected' });
  assert.equal(resolveAgentId({ agentId: 'claude-code' }, {}, { hostAgentId: hostAgentId(identity) }), 'grok');
}));

test('without a host argument: env, then detection, then config.platform, then default', () => withEnv({}, () => {
  assert.deepEqual(resolveHostIdentity(SHARED_GROK_CONFIG, {}, {}), { platform: 'grok', source: 'config' });
  assert.deepEqual(resolveHostIdentity({}, {}, {}), { platform: 'claude-code', source: 'default' });
  assert.deepEqual(
    resolveHostIdentity(SHARED_GROK_CONFIG, { transcript_path: '/home/u/.codex/sessions/2026/01/01/rollout-x.jsonl' }, {}),
    { platform: 'codex', source: 'detected' },
  );
  process.env.CRYSTAL_PLATFORM = 'cursor';
  assert.deepEqual(resolveHostIdentity(SHARED_GROK_CONFIG, { transcript_path: '/x/rollout-a.jsonl' }, {}), { platform: 'cursor', source: 'env' });
}));

test('agentId: explicit input, then MEMORY_CRYSTAL_AGENT_ID, then per-host slug, then config.agentId', () => withEnv({}, () => {
  const known = { hostAgentId: hostAgentId({ platform: 'codex', source: 'host-arg' }) };
  assert.equal(resolveAgentId(SHARED_GROK_CONFIG, { agentId: 'explicit' }, known), 'explicit');
  assert.equal(resolveAgentId(SHARED_GROK_CONFIG, {}, known), 'codex');
  assert.equal(resolveAgentId(SHARED_GROK_CONFIG, {}, { hostAgentId: hostAgentId({ platform: 'grok', source: 'config' }) }), 'grok');
  assert.equal(hostAgentId({ platform: 'codex', source: 'config' }), undefined, 'config.platform is not a known host');
  assert.equal(hostAgentId({ platform: 'codex', source: 'env' }), undefined);
  process.env.MEMORY_CRYSTAL_AGENT_ID = 'env-agent';
  assert.equal(resolveAgentId(SHARED_GROK_CONFIG, {}, known), 'env-agent');
}));

test('parseHostArg reads both --host forms', () => {
  assert.equal(parseHostArg(['--host', 'codex']), 'codex');
  assert.equal(parseHostArg(['--host=claude-code']), 'claude-code');
  assert.equal(parseHostArg([]), undefined);
});

// ── Codex transcript shape ─────────────────────────────────────────────────

test('extractCodexTurn returns the latest Codex prompt and answer and skips injected context', () => {
  const turn = extractCodexTurn(CODEX_ROLLOUT);
  assert.equal(turn.userText, 'Synthetic prompt beta');
  assert.equal(turn.assistantText, 'Synthetic answer beta');
  assert.equal(turn.status, 'complete');

  const dir = mkdtempSync(join(tmpdir(), 'mc-codex-items-'));
  try {
    const itemsOnly = join(dir, 'items.jsonl');
    writeFileSync(itemsOnly, readFileSync(CODEX_ROLLOUT, 'utf8').split('\n').filter((line) => !line.includes('"event_msg"')).join('\n'));
    const fromItems = extractCodexTurn(itemsOnly);
    assert.equal(fromItems.userText, 'Synthetic prompt beta');
    assert.equal(fromItems.assistantText, 'Synthetic answer beta');
    assert.equal(extractCodexTurn(claudeTranscript(dir)), null, 'Claude transcripts are not Codex-shaped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── End to end with one shared config.platform=grok ────────────────────────

test('shared grok config: Claude Code with --host captures under claude-code:', () => withHome(SHARED_GROK_CONFIG, async (home) => {
  const body = await stopTurn({
    home,
    args: ['--host', 'claude-code'],
    input: { hook_event_name: 'Stop', session_id: 'claude-sess', cwd: home, transcript_path: claudeTranscript(home) },
  });
  assert.equal(body.channel, `claude-code:${home}`);
  assert.equal(body.platform, 'claude-code');
  assert.equal(body.agentId, 'claude-code');
  assert.equal(body.userMessage, 'Synthetic claude prompt');
}));

test('shared grok config: Codex Stop with --host captures under codex: and includes the user prompt', () => withHome(SHARED_GROK_CONFIG, async (home) => {
  const body = await stopTurn({ home, args: ['--host', 'codex'], input: codexStopInput(home) });
  assert.equal(body.channel, `codex:${home}`);
  assert.equal(body.platform, 'codex');
  assert.equal(body.agentId, 'codex');
  assert.equal(body.userMessage, 'Synthetic prompt beta');
  assert.equal(body.assistantMessage, 'Synthetic answer beta');
  assert.equal(body.turnId, 'synthetic-turn-beta');
}));

test('shared grok config: a legacy Codex command without --host is detected from the rollout transcript', () => withHome(SHARED_GROK_CONFIG, async (home) => {
  const body = await stopTurn({ home, input: codexStopInput(home) });
  assert.equal(body.channel, `codex:${home}`);
  assert.equal(body.userMessage, 'Synthetic prompt beta');
}));

test('shared grok config: a Grok invocation captures under grok:', () => withHome(SHARED_GROK_CONFIG, async (home) => {
  const body = await stopTurn({
    home,
    args: ['--host', 'grok'],
    env: { GROK_HOOK_EVENT: 'stop' },
    input: { hookEventName: 'stop', sessionId: 'grok-sess', cwd: home, lastAssistantMessage: 'Synthetic grok answer' },
  });
  assert.equal(body.channel, `grok:${home}`);
  assert.equal(body.agentId, 'grok');
}));

test('the explicit --host beats CRYSTAL_PLATFORM and config.platform end to end', () => withHome(SHARED_GROK_CONFIG, async (home) => {
  const body = await stopTurn({
    home,
    args: ['--host', 'codex'],
    env: { CRYSTAL_PLATFORM: 'cursor' },
    input: { hook_event_name: 'Stop', session_id: 's', cwd: home, transcript_path: claudeTranscript(home) },
  });
  assert.equal(body.channel, `codex:${home}`);
}));

test('a legacy single-host command without --host keeps config.platform and config.agentId', () => withHome(
  { ...SHARED_GROK_CONFIG, platform: 'factory-droid', agentId: 'legacy-agent' },
  async (home) => {
    const body = await stopTurn({
      home,
      input: { hook_event_name: 'Stop', session_id: 's', cwd: home, transcript_path: claudeTranscript(home) },
    });
    assert.equal(body.channel, `factory-droid:${home}`);
    assert.equal(body.platform, 'factory-droid');
    assert.equal(body.agentId, 'legacy-agent');
  },
));

test('Grok reading Claude-compatible settings runs the installed claude command and still labels grok', () => withHome(SHARED_GROK_CONFIG, async (home) => {
  const settings = join(home, '.claude', 'settings.json');
  execFileSync(process.execPath, [INSTALLER, 'claude', settings, `node "${HOOK}"`]);
  const command = JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command;
  const args = command.slice(command.indexOf('crystal-hooks.mjs"') + 'crystal-hooks.mjs"'.length).trim().split(/\s+/);
  assert.deepEqual(args, ['--host', 'claude-code']);

  const asClaude = await stopTurn({
    home,
    args,
    input: { hook_event_name: 'Stop', session_id: 's', cwd: home, transcript_path: claudeTranscript(home) },
  });
  assert.equal(asClaude.channel, `claude-code:${home}`);

  const asGrok = await stopTurn({
    home,
    args,
    env: { GROK_HOOK_EVENT: 'stop' },
    input: { hookEventName: 'stop', sessionId: 'grok-sess', cwd: home, lastAssistantMessage: 'Synthetic grok answer' },
  });
  assert.equal(asGrok.channel, `grok:${home}`);
  assert.equal(asGrok.agentId, 'grok');
}));

// ── Recall injection under a shared grok config ─────────────────────────────
const RECALL_PROMPT = { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'What did we decide about the staging database migration last week?' };
const recallCalls = (calls) => calls.filter((call) => call.url.includes('/api/mcp/recall')).length;

test('a legacy command under a shared grok config.platform keeps opt-in recall injection', () => withHome({ ...SHARED_GROK_CONFIG, injectRecall: true }, async (home) => {
  const { code, calls } = await runHook({ home, input: { ...RECALL_PROMPT, cwd: home } });
  assert.equal(code, 0);
  assert.equal(recallCalls(calls), 1, 'a grok label from the shared config must not disable another host\'s injection');
}));

test('a real Grok host never injects recall, even with injection enabled', () => withHome({ ...SHARED_GROK_CONFIG, injectRecall: true }, async (home) => {
  for (const variant of [{ args: ['--host', 'grok'] }, { env: { GROK_HOOK_EVENT: 'UserPromptSubmit' } }]) {
    const { code, calls } = await runHook({ home, ...variant, input: { ...RECALL_PROMPT, cwd: home } });
    assert.equal(code, 0);
    assert.equal(recallCalls(calls), 0);
  }
}));
